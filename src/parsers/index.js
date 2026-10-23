import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJavaScript } from './javascript.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_HELPER = path.join(HERE, 'python_ast.py');

export function parseEntries(entries) {
  const results = new Map();
  const pythonEntries = entries.filter((entry) => entry.language === 'python');
  if (pythonEntries.length) {
    const result = spawnSync('python3', [PYTHON_HELPER], {
      input: JSON.stringify(pythonEntries.map(({ path: filePath, source }) => ({ path: filePath, source }))),
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    });
    if (result.status === 0) {
      try {
        for (const parsed of JSON.parse(result.stdout)) results.set(parsed.path, parsed);
      } catch (error) {
        for (const entry of pythonEntries) results.set(entry.path, { path: entry.path, status: 'partial', error: `python-output:${error.message}`, symbols: [], relations: [] });
      }
    } else {
      for (const entry of pythonEntries) results.set(entry.path, { path: entry.path, status: 'partial', error: `python-parser:${result.stderr || result.status}`, symbols: [], relations: [] });
    }
  }
  for (const entry of entries) {
    if (results.has(entry.path)) continue;
    if (entry.language === 'javascript' || entry.language === 'typescript') {
      try { results.set(entry.path, parseJavaScript(entry)); }
      catch (error) { results.set(entry.path, { path: entry.path, status: 'partial', error: `javascript-parser:${error.message}`, symbols: [], relations: [] }); }
    } else {
      results.set(entry.path, { path: entry.path, status: 'unsupported', error: `unsupported-language:${entry.language}`, symbols: [], relations: [] });
    }
  }
  return results;
}
