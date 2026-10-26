import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../lib/build-jobs.js';
import { parseJavaScript } from './javascript.js';
import { resolvePythonRuntime } from './python-runtime.js';

const PYTHON_SCRIPT = fileURLToPath(new URL('./python_ast.py', import.meta.url));
export const SCRIPT_LANGUAGES = new Set(['python', 'javascript', 'typescript']);

export function* parserBatches(entries) {
  let batch = [], bytes = 0, language;
  for (const entry of entries) {
    const size = entry.bytes ?? Buffer.byteLength(entry.source || '');
    if (batch.length && (batch.length >= 64 || bytes + size > 4 * 1024 * 1024 || entry.language !== language)) {
      yield batch; batch = []; bytes = 0;
    }
    batch.push(entry); bytes += size; language = entry.language;
  }
  if (batch.length) yield batch;
}

export function validateRecords(entries, records) {
  if (!Array.isArray(records) || records.length !== entries.length) throw new Error('parser-protocol: result count differs');
  const expected = new Set(entries.map(entry => entry.path));
  if (expected.size !== entries.length) throw new Error('parser-protocol: duplicate input path');
  for (const record of records) {
    if (!record || !expected.delete(record.path) || !['complete', 'partial', 'unsupported'].includes(record.status)
      || !Array.isArray(record.symbols) || !Array.isArray(record.relations)) throw new Error('parser-protocol: invalid or duplicate result');
    const keys = new Set();
    for (const symbol of record.symbols) {
      const span = symbol.span;
      if (typeof symbol.key !== 'string' || keys.has(symbol.key) || typeof symbol.name !== 'string' || !symbol.name
        || typeof symbol.kind !== 'string' || !span || !Number.isInteger(span.startLine) || span.startLine < 1
        || !Number.isInteger(span.endLine) || span.endLine < span.startLine
        || !Number.isInteger(span.startColumn) || span.startColumn < 0
        || !Number.isInteger(span.endColumn) || span.endColumn < 0) throw new Error('parser-protocol: invalid symbol');
      keys.add(symbol.key);
    }
    for (const relation of record.relations) {
      if (typeof relation.sourceKey !== 'string' || typeof relation.type !== 'string' || typeof relation.targetName !== 'string'
        || !Number.isInteger(relation.line) || relation.line < 1) throw new Error('parser-protocol: invalid relation');
    }
  }
  return records;
}

export function pythonJobContext(runtime, signal) {
  const timeout = Number(process.env.CODEINDEX_PARSER_TIMEOUT_MS || 180000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('CODEINDEX_PARSER_TIMEOUT_MS must be a positive integer');
  return { runtime, signal, deadline: performance.now() + timeout, retries: 0, healthProbe: null };
}

export async function parsePythonBatch(entries, context) {
  // Source I/O errors are build failures, not parse failures.
  const inputs = entries.map(entry => ({ path: entry.path, source: entry.source ?? fs.readFileSync(entry.absolute, 'utf8') }));
  async function invoke(batch, retry = false) {
    context.signal?.throwIfAborted();
    if (retry && ++context.retries > 128) throw new Error('Python isolation retry limit exceeded');
    const timeout = Math.floor(context.deadline - performance.now());
    if (timeout <= 0) throw new Error('Python parser total time budget exhausted');
    const { stdout } = await runProcess(context.runtime.path, ['-I', PYTHON_SCRIPT], {
      input: JSON.stringify(batch), timeout, maxBuffer: 128 * 1024 * 1024, signal: context.signal,
    });
    let records;
    try { records = JSON.parse(stdout); }
    catch (cause) { throw new Error('parser-protocol: invalid Python JSON', { cause }); }
    return validateRecords(batch, records);
  }
  async function isolate(batch, retry = false) {
    try { return await invoke(batch, retry); }
    catch (error) {
      if (error.kind !== 'exit' || error.signal !== 'SIGSEGV') throw error;
      if (batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        return [...await isolate(batch.slice(0, middle), true), ...await isolate(batch.slice(middle), true)];
      }
      context.healthProbe ??= invoke([{ path: '__codeindex_health__.py', source: 'def codeindex_health(): return 1\n' }], true).then(records => {
        if (records[0].status !== 'complete' || !records[0].symbols.some(symbol => symbol.name === 'codeindex_health')) throw new Error('Python parser health probe failed');
      });
      await context.healthProbe;
      return [{ path: batch[0].path, status: 'partial', error: 'python-parser-crash:SIGSEGV', symbols: [], relations: [] }];
    }
  }
  return isolate(inputs);
}

export async function parseEntriesBatched(entries, onResult, { pythonRuntime, signal } = {}) {
  const python = entries.some(entry => entry.language === 'python')
    ? pythonJobContext(pythonRuntime || resolvePythonRuntime(), signal) : null;
  for (const batch of parserBatches(entries)) {
    signal?.throwIfAborted();
    const records = batch[0].language === 'python' ? await parsePythonBatch(batch, python) : batch.map(entry => {
      if (!SCRIPT_LANGUAGES.has(entry.language)) return { path: entry.path, status: 'unsupported', error: `unsupported-language:${entry.language}`, symbols: [], relations: [] };
      return parseJavaScript({ ...entry, source: entry.source ?? fs.readFileSync(entry.absolute, 'utf8') });
    });
    validateRecords(batch, records);
    for (const record of records) { signal?.throwIfAborted(); onResult(record); }
  }
}

export async function parseEntries(entries, options) {
  const results = new Map();
  await parseEntriesBatched(entries, record => results.set(record.path, record), options);
  return results;
}
