import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { indexRepository, loadIndex } from '../src/lib/indexer.js';
import { queryIndex } from '../src/lib/query.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-repo-'));
  fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg', 'service.py'), `class Base:\n    pass\n\nclass Service(Base):\n    \"\"\"Service entry.\"\"\"\n    def run(self, value):\n        return helper(value)\n\ndef helper(value):\n    return value + 1\n`);
  fs.writeFileSync(path.join(root, 'pkg', 'consumer.py'), `from pkg.service import Service\n\ndef use(value):\n    return Service().run(value)\n`);
  fs.writeFileSync(path.join(root, 'pkg', 'web.ts'), `export class WebService extends Service {\n  async run(value) { return helper(value); }\n}\nexport function helper(value) { return value; }\n`);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'codeindex-tests@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'CodeIndex Tests']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  return root;
}

test('indexes symbols, containment and resolved call relations with immutable evidence', async () => {
  const repo = fixture();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-store-'));
  const built = await indexRepository(repo, store);
  const index = loadIndex(store);
  assert.equal(built.manifest.status, 'published');
  assert.ok([...index.iterSymbols()].some((symbol) => symbol.name === 'Service'));
  assert.ok([...index.iterSymbols()].some((symbol) => symbol.name === 'run'));
  assert.ok([...index.iterContainment()].some((node) => node.nodeType === 'directory'));
  assert.ok([...index.iterStoredRelations()].some((relation) => relation.type === 'calls' && relation.status === 'resolved'));
  const result = queryIndex(index, 'who calls helper');
  assert.equal(result.snapshotId, index.manifest.snapshotId);
  assert.ok(result.evidence.length > 0);
  assert.ok(result.evidence.every((item) => item.source.includes('helper')));
  assert.ok(result.evidence.every((item) => item.blobDigest));
  const metadataOnly = queryIndex(index, 'who calls helper', { includeSource: false });
  assert.ok(metadataOnly.candidates.length > 0);
  assert.equal(metadataOnly.evidence.length, 0);
  assert.ok(metadataOnly.metrics.contextBytes === 0);

  let symbolBatchCalls = 0;
  let fileBatchCalls = 0;
  const getSymbols = index.getSymbols.bind(index);
  const getFiles = index.getFiles.bind(index);
  index.getSymbols = (ids) => { symbolBatchCalls += 1; return getSymbols(ids); };
  index.getFiles = (ids) => { fileBatchCalls += 1; return getFiles(ids); };
  index.getSymbol = () => { throw new Error('candidate query must use batched symbols'); };
  const batched = queryIndex(index, 'helper');
  assert.ok(batched.evidence.length > 0);
  assert.equal(symbolBatchCalls, 1);
  assert.equal(fileBatchCalls, 1);
});

test('update reuses unchanged parse results and publishes a new snapshot', async () => {
  const repo = fixture();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-store-'));
  const first = await indexRepository(repo, store);
  fs.appendFileSync(path.join(repo, 'pkg', 'consumer.py'), '\n\ndef extra(value):\n    return value\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'update']);
  const second = await indexRepository(repo, store, { incremental: true });
  assert.notEqual(first.manifest.snapshotId, second.manifest.snapshotId);
  assert.equal(second.stats.changedFiles, 1);
  assert.ok(second.stats.reusedFiles >= 2);
  const index = loadIndex(store);
  assert.ok([...index.iterSymbols()].some((symbol) => symbol.name === 'extra'));
  const originalReadFileSync = fs.readFileSync;
  const jsonlReads = [];
  fs.readFileSync = (...args) => {
    if (typeof args[0] === 'string' && args[0].endsWith('.jsonl')) jsonlReads.push(args[0]);
    return originalReadFileSync(...args);
  };
  let unchanged;
  try {
    unchanged = await indexRepository(repo, store, { incremental: true });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(unchanged.stats.noOp, true);
  assert.equal(unchanged.stats.changedFiles, 0);
  assert.equal(unchanged.manifest.snapshotId, second.manifest.snapshotId);
  assert.deepEqual(jsonlReads, []);
});
