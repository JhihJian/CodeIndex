import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJavaScript } from './javascript.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_FILES = 64;

function partialResult(entry, error) {
  return { path: entry.path, status: 'partial', error, symbols: [], relations: [] };
}

function parseBatch(entries, language, onResult) {
  const valid = [];
  for (const entry of entries) {
    try {
      valid.push({ path: entry.path, language: entry.language, source: entry.source ?? fs.readFileSync(entry.absolute, 'utf8') });
    } catch (error) {
      onResult(partialResult(entry, `source-read:${error.code || error.message}`));
    }
  }
  if (!valid.length) return;
  const python = language === 'python';
  const result = spawnSync(python ? 'python3' : process.execPath, [path.join(HERE, python ? 'python_ast.py' : 'c-worker.js')], {
    input: JSON.stringify(valid), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  let parsed;
  if (result.status === 0) {
    try { parsed = JSON.parse(result.stdout); }
    catch (error) { parsed = valid.map((entry) => partialResult(entry, `${language}-output:${error.message}`)); }
  } else {
    parsed = valid.map((entry) => partialResult(entry, `${language}-parser:${result.error?.message || result.stderr || result.signal || result.status}`));
  }
  // Storage errors must propagate; only parser output decoding is caught above.
  for (const record of parsed) onResult(record);
}

function parseOne(entry) {
  if (!['javascript', 'typescript'].includes(entry.language)) {
    return { path: entry.path, status: 'unsupported', error: `unsupported-language:${entry.language}`, symbols: [], relations: [] };
  }
  try {
    return parseJavaScript({ ...entry, source: entry.source ?? fs.readFileSync(entry.absolute, 'utf8') });
  } catch (error) {
    return partialResult(entry, `javascript-parser:${error.message}`);
  }
}

export function parseEntriesBatched(entries, onResult) {
  let batch = [];
  let bytes = 0;
  let batchLanguage;
  function flush() {
    if (batch.length) parseBatch(batch, batchLanguage, onResult);
    batch = [];
    bytes = 0;
  }
  for (const entry of entries) {
    const language = entry.language === 'python' ? 'python' : ['c', 'cpp'].includes(entry.language) ? 'c' : null;
    if (!language) { flush(); onResult(parseOne(entry)); continue; }
    const size = entry.bytes ?? Buffer.byteLength(entry.source || '');
    if (batch.length && (language !== batchLanguage || batch.length >= MAX_BATCH_FILES || bytes + size > MAX_BATCH_BYTES)) flush();
    batchLanguage = language;
    batch.push(entry);
    bytes += size;
  }
  flush();
}

export function parseEntries(entries) {
  const results = new Map();
  parseEntriesBatched(entries, (result) => results.set(result.path, result));
  return results;
}
