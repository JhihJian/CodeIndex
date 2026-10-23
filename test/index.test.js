import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { indexRepository, loadIndex } from '../src/lib/indexer.js';
import { queryIndex } from '../src/lib/query.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-repo-'));
  fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg', 'service.py'), `class Base:\n    pass\n\nclass Service(Base):\n    \"\"\"Service entry.\"\"\"\n    def run(self, value):\n        return helper(value)\n\ndef helper(value):\n    return value + 1\n`);
  fs.writeFileSync(path.join(root, 'pkg', 'consumer.py'), `from pkg.service import Service\n\ndef use(value):\n    return Service().run(value)\n`);
  fs.writeFileSync(path.join(root, 'pkg', 'web.ts'), `export class WebService extends Service {\n  async run(value) { return helper(value); }\n}\nexport function helper(value) { return value; }\n`);
  return root;
}

test('indexes symbols, containment and resolved call relations with immutable evidence', () => {
  const repo = fixture();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-store-'));
  const built = indexRepository(repo, store);
  const index = loadIndex(store);
  assert.equal(built.manifest.status, 'published');
  assert.ok(index.symbols.some((symbol) => symbol.name === 'Service'));
  assert.ok(index.symbols.some((symbol) => symbol.name === 'run'));
  assert.ok(index.containment.some((node) => node.nodeType === 'directory'));
  assert.ok(index.relations.some((relation) => relation.type === 'calls' && relation.status === 'resolved'));
  const result = queryIndex(index, 'who calls helper');
  assert.equal(result.snapshotId, index.manifest.snapshotId);
  assert.ok(result.evidence.length > 0);
  assert.ok(result.evidence.every((item) => item.source.includes('helper')));
  assert.ok(result.evidence.every((item) => item.blobDigest));
});

test('update reuses unchanged parse results and publishes a new snapshot', () => {
  const repo = fixture();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-store-'));
  const first = indexRepository(repo, store);
  fs.appendFileSync(path.join(repo, 'pkg', 'consumer.py'), '\n\ndef extra(value):\n    return value\n');
  const second = indexRepository(repo, store, { incremental: true });
  assert.notEqual(first.manifest.snapshotId, second.manifest.snapshotId);
  assert.equal(second.stats.changedFiles, 1);
  assert.ok(second.stats.reusedFiles >= 2);
  const index = loadIndex(store);
  assert.ok(index.symbols.some((symbol) => symbol.name === 'extra'));
  assert.ok(fs.existsSync(path.join(store, index.repoId, 'snapshots', first.manifest.snapshotId, 'manifest.json')));
});
