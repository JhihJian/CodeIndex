// Run with: node --max-old-space-size=128 benchmarks/streaming-memory.mjs
// A resource regression check, not a wall-clock benchmark against real projects.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { indexRepository, loadIndex } from '../src/lib/indexer.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-memory-'));
const repo = path.join(root, 'repo');
const store = path.join(root, 'store');
fs.mkdirSync(repo);
const files = 500;
const functionsPerFile = 200;
try {
  for (let file = 0; file < files; file++) {
    const source = Array.from({ length: functionsPerFile }, (_, i) => `def function_${file}_${i}():\n    return ${i === 0 ? '0' : `function_${file}_${i - 1}()`}\n`).join('\n');
    fs.writeFileSync(path.join(repo, `file_${file}.py`), source);
  }
  const full = await indexRepository(repo, store, { incremental: false });
  assert.equal(full.stats.symbols, files * (functionsPerFile + 1));
  assert.equal(full.stats.relations, files * (functionsPerFile - 1));
  fs.appendFileSync(path.join(repo, 'file_0.py'), '\ndef added():\n    return 42\n');
  const update = await indexRepository(repo, store);
  assert.equal(update.stats.changedFiles, 1);
  assert.equal(update.stats.reusedFiles, files - 1);
  assert.equal(update.stats.symbols, full.stats.symbols + 1);
  assert.equal(update.stats.relations, full.stats.relations);
  const index = loadIndex(store);
  try { assert.ok(index.searchNodes('added').some((row) => row.name === 'added')); }
  finally { index.close(); }
  console.log(JSON.stringify({ files, functionsPerFile, heapLimitMiB: v8.getHeapStatistics().heap_size_limit / 1024 / 1024, full: full.stats, update: update.stats, maxRssKiB: process.resourceUsage().maxRSS }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
