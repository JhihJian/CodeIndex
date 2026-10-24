import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseC } from './c.js';
import { parseJavaScript } from './javascript.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_HELPER = path.join(HERE, 'python_ast.py');
const C_HELPER = path.join(HERE, 'c-worker.js');
const PYTHON_BATCH_SIZE = 64;
const C_BATCH_SIZE = 256;

function entryWithSource(entry) {
  if (typeof entry.source === 'string') return entry;
  try {
    return { ...entry, source: fs.readFileSync(entry.absolute, 'utf8') };
  } catch (error) {
    return { ...entry, sourceError: error };
  }
}

function partialResult(entry, error) {
  return { path: entry.path, status: 'partial', error, symbols: [], relations: [] };
}

function parsePythonBatch(entries, results) {
  const sourceEntries = entries.map(entryWithSource);
  const invalid = sourceEntries.filter((entry) => entry.sourceError);
  for (const entry of invalid) results.set(entry.path, partialResult(entry, `source-read:${entry.sourceError.code || entry.sourceError.message}`));
  const valid = sourceEntries.filter((entry) => !entry.sourceError);
  if (!valid.length) return;
  const result = spawnSync('python3', [PYTHON_HELPER], {
    input: JSON.stringify(valid.map(({ path: filePath, source }) => ({ path: filePath, source }))),
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status === 0) {
    try {
      for (const parsed of JSON.parse(result.stdout)) results.set(parsed.path, parsed);
    } catch (error) {
      for (const entry of valid) results.set(entry.path, partialResult(entry, `python-output:${error.message}`));
    }
  } else {
    for (const entry of valid) results.set(entry.path, partialResult(entry, `python-parser:${result.stderr || result.status}`));
  }
}

function parseCWorkerBatch(entries, results) {
  const sourceEntries = entries.map(entryWithSource);
  const invalid = sourceEntries.filter((entry) => entry.sourceError);
  for (const entry of invalid) results.set(entry.path, partialResult(entry, `source-read:${entry.sourceError.code || entry.sourceError.message}`));
  const valid = sourceEntries.filter((entry) => !entry.sourceError);
  if (!valid.length) return;
  const result = spawnSync(process.execPath, [C_HELPER], {
    input: JSON.stringify(valid.map(({ path: filePath, language, source }) => ({ path: filePath, language, source }))),
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status === 0) {
    try {
      for (const parsed of JSON.parse(result.stdout)) results.set(parsed.path, parsed);
    } catch (error) {
      for (const entry of valid) results.set(entry.path, partialResult(entry, `c-output:${error.message}`));
    }
  } else {
    for (const entry of valid) results.set(entry.path, partialResult(entry, `c-parser-process:${result.stderr || result.status}`));
  }
}

function parseOne(entry) {
  const sourceEntry = entryWithSource(entry);
  if (sourceEntry.sourceError) return partialResult(entry, `source-read:${sourceEntry.sourceError.code || sourceEntry.sourceError.message}`);
  try {
    if (entry.language === 'c' || entry.language === 'cpp') return parseC(sourceEntry);
    if (entry.language === 'javascript' || entry.language === 'typescript') return parseJavaScript(sourceEntry);
    return { path: entry.path, status: 'unsupported', error: `unsupported-language:${entry.language}`, symbols: [], relations: [] };
  } catch (error) {
    const parserName = entry.language === 'c' || entry.language === 'cpp' ? 'c-parser' : entry.language === 'javascript' || entry.language === 'typescript' ? 'javascript-parser' : 'parser';
    return partialResult(entry, `${parserName}:${error.message}`);
  }
}

export function parseEntries(entries) {
  const results = new Map();
  const pythonEntries = entries.filter((entry) => entry.language === 'python');
  for (let start = 0; start < pythonEntries.length; start += PYTHON_BATCH_SIZE) parsePythonBatch(pythonEntries.slice(start, start + PYTHON_BATCH_SIZE), results);
  const cEntries = entries.filter((entry) => entry.language === 'c' || entry.language === 'cpp');
  for (let start = 0; start < cEntries.length; start += C_BATCH_SIZE) parseCWorkerBatch(cEntries.slice(start, start + C_BATCH_SIZE), results);
  for (const entry of entries) {
    if (results.has(entry.path)) continue;
    results.set(entry.path, parseOne(entry));
  }
  return results;
}
