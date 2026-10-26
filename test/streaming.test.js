import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { indexRepository, loadIndex } from '../src/lib/indexer.js';
import { iterateJsonl } from '../src/lib/fs.js';
import { parseEntriesBatched } from '../src/parsers/index.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-stream-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  return { root, repo, store: path.join(root, 'store') };
}

test('streamed updates reuse records without whole JSONL reads and match full rebuild identity', async (t) => {
  const { repo, store, root } = workspace(t);
  fs.writeFileSync(path.join(repo, 'a.py'), 'def helper():\n    return 1\n');
  fs.writeFileSync(path.join(repo, 'b.py'), 'import a\ndef caller():\n    return a.helper()\n');
  const first = await indexRepository(repo, store);
  fs.appendFileSync(path.join(repo, 'b.py'), '\ndef extra():\n    return 2\n');
  const readFileSync = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    assert.ok(!String(file).endsWith('.jsonl'), 'must stream JSONL during incremental build');
    return readFileSync(file, ...args);
  };
  let updated;
  try { updated = await indexRepository(repo, store); }
  finally { fs.readFileSync = readFileSync; }
  assert.equal(updated.stats.changedFiles, 1);
  assert.equal(updated.stats.reusedFiles, 1);
  const full = await indexRepository(repo, path.join(root, 'full'), { incremental: false });
  assert.equal(updated.manifest.snapshotId, full.manifest.snapshotId);
  assert.notEqual(first.manifest.snapshotId, full.manifest.snapshotId);
  const relationIds = (targetStore) => {
    const db = loadIndex(targetStore);
    try { return [...db.iterStoredRelations()].map((x) => x.relationId).sort(); }
    finally { db.close(); }
  };
  assert.deepEqual(relationIds(store), relationIds(path.join(root, 'full')));
  assert.equal((await indexRepository(repo, store)).stats.noOp, true);
  const index = loadIndex(store);
  t.after(() => index.close());
  assert.ok([...index.iterStoredRelations()].some((r) => r.type === 'imports' && r.targetId));
  for (const symbol of index.iterSymbols()) assert.ok(symbol.sourceSpan.endByte >= symbol.sourceSpan.startByte);
  const node = [...index.iterContainment()].find((n) => n.kind === 'function');
  assert.equal(typeof node.sourceSpan.startColumn, 'number');
  assert.equal(typeof node.sourceSpan.endColumn, 'number');
  assert.ok(!index.db.prepare("SELECT name FROM sqlite_master WHERE name = 'relation_staging'").get());
});

test('parser consumers propagate storage failure exactly once', async () => {
  const sentinel = new Error('storage failed');
  for (const language of ['python', 'c']) {
    let calls = 0;
    await assert.rejects(() => parseEntriesBatched([{ path: `x.${language}`, language, source: language === 'c' ? 'int x() {}' : 'def x(): pass' }], () => {
      calls += 1;
      throw sentinel;
    }), (error) => error === sentinel);
    assert.equal(calls, 1);
  }
});

test('failed build preserves published snapshot and removes temporary files', async (t) => {
  const { repo, store } = workspace(t);
  fs.writeFileSync(path.join(repo, 'a.py'), 'def old(): pass');
  const first = await indexRepository(repo, store);
  fs.writeFileSync(path.join(repo, 'a.py'), 'def changed(): pass');
  await assert.rejects(() => indexRepository(repo, store, {
    onProgress(event) { if (event.stage === 'relations') throw new Error('injected failure'); },
  }), /injected failure/);
  const index = loadIndex(store);
  t.after(() => index.close());
  assert.equal(index.manifest.snapshotId, first.manifest.snapshotId);
  assert.ok([...index.iterSymbols()].some((s) => s.name === 'old'));
  assert.ok(!fs.readdirSync(path.dirname(first.snapshotDir)).some((name) => name.startsWith('.build-')));
});

test('build configuration changes snapshot identity and invalidates no-op', async (t) => {
  const { repo, store } = workspace(t);
  fs.writeFileSync(path.join(repo, 'a.py'), 'def same(): pass');
  const first = await indexRepository(repo, store);
  const second = await indexRepository(repo, store, { maxFileBytes: 1024 });
  assert.notEqual(first.manifest.snapshotId, second.manifest.snapshotId);
  assert.equal(second.stats.changedFiles, 1);
});

test('JSONL streaming preserves UTF-8 crossing chunk boundary and final record', async (t) => {
  const { root } = workspace(t);
  const file = path.join(root, 'rows.jsonl');
  const rows = [{ text: 'a'.repeat(65523) + '中文😀' }, { text: 'tail' }];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
  assert.deepEqual([...iterateJsonl(file)], rows);
});

test('navigation and imports are independent of incremental insertion order', async (t) => {
  const { repo, store, root } = workspace(t);
  fs.mkdirSync(path.join(repo, 'pkg'));
  for (let i = 0; i < 14; i++) fs.writeFileSync(path.join(repo, 'pkg', `f${String(i).padStart(2, '0')}.py`), `def f${i}(): pass\n`);
  fs.writeFileSync(path.join(repo, 'pkg', 'caller.py'), 'from . import f00\n');
  await indexRepository(repo, store);
  fs.appendFileSync(path.join(repo, 'pkg', 'f13.py'), 'def extra(): pass\n');
  const incremental = await indexRepository(repo, store);
  const full = await indexRepository(repo, path.join(root, 'full'), { incremental: false });
  const nav = (targetStore) => {
    const index = loadIndex(targetStore);
    try { return [...index.iterContainment()].map((node) => index.getNavigation(node.nodeId)).sort((a, b) => a.nodeId.localeCompare(b.nodeId)); }
    finally { index.close(); }
  };
  assert.deepEqual(nav(store), nav(path.join(root, 'full')));
  assert.equal(incremental.manifest.snapshotId, full.manifest.snapshotId);
  const index = loadIndex(store);
  const relations = [...index.iterStoredRelations()];
  index.close();
  assert.ok(relations.some((r) => r.type === 'imports' && r.targetId));
});

test('rebuilding restores a missing database under the same snapshot identity', async (t) => {
  const { repo, store } = workspace(t);
  fs.writeFileSync(path.join(repo, 'a.py'), 'def retained(): pass\n');
  const first = await indexRepository(repo, store);
  let current = first;
  for (const incremental of [false, true]) {
    fs.unlinkSync(path.join(current.snapshotDir, 'index.db'));
    assert.throws(() => loadIndex(store), /重新执行 index/);
    const rebuilt = await indexRepository(repo, store, { incremental });
    current = rebuilt;
    assert.equal(rebuilt.manifest.snapshotId, first.manifest.snapshotId);
    assert.notEqual(rebuilt.stats.noOp, true);
    const index = loadIndex(store);
    try { assert.ok(index.searchNodes('retained').some((row) => row.name === 'retained')); }
    finally { index.close(); }
  }
});

test('C type usages do not create definition symbols', async (t) => {
  const { repo, store } = workspace(t);
  fs.writeFileSync(path.join(repo, 'x.c'), 'struct S { int n; }; struct S *a; struct S *b; int f(struct S *s) { return s->n; }');
  await indexRepository(repo, store);
  const index = loadIndex(store);
  t.after(() => index.close());
  const symbols = [...index.iterSymbols()];
  assert.equal(symbols.filter((s) => s.kind === 'struct' && s.name === 'S').length, 1);
  assert.ok(symbols.some((s) => s.name === 'f'));
});
