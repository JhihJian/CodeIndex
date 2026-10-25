import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { indexRepository, loadIndex, exportIndex } from '../src/lib/indexer.js';
import { queryIndex } from '../src/lib/query.js';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-production-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), store = path.join(root, 'store');
  fs.mkdirSync(repo);
  return { root, repo, store };
}

test('native updates delete stale facts, preserve readers and match a full rebuild', async (t) => {
  const { root, repo, store } = setup(t);
  fs.writeFileSync(path.join(repo, 'a.c'), 'int helper(void) { return 1; }\nint run(void) { return helper(); }\n');
  fs.writeFileSync(path.join(repo, 'b.c'), 'int helper(void) { return 2; }\nint other(void) { return helper(); }\n');
  await indexRepository(repo, store);
  const old = loadIndex(store);
  t.after(() => old.close());
  const other = old.findSymbols({ name: 'other' })[0];
  const helper = old.findSymbols({ name: 'helper', path: 'b.c' })[0];
  assert.equal(old.getRelationsForSource(other.symbolId)[0].target_id, helper.symbolId);
  fs.renameSync(path.join(repo, 'b.c'), path.join(repo, 'renamed.c'));
  fs.writeFileSync(path.join(repo, 'a.c'), 'int newer(void) { return 3; }\n');
  const updated = await indexRepository(repo, store);
  assert.equal(updated.stats.changedFiles, 2);
  assert.equal(updated.stats.removedFiles, 1);
  const current = loadIndex(store);
  t.after(() => current.close());
  assert.equal(current.findSymbols({ name: 'run' }).length, 0);
  assert.ok(queryIndex(old, 'who calls helper').evidence.some((e) => e.path === 'a.c' && e.source.includes('run')));
  const full = await indexRepository(repo, path.join(root, 'full'), { incremental: false });
  const rebuilt = loadIndex(path.join(root, 'full'));
  t.after(() => rebuilt.close());
  assert.equal(full.manifest.snapshotId, updated.manifest.snapshotId);
  assert.deepEqual([...current.iterSymbols()].map((s) => s.symbolId).sort(), [...rebuilt.iterSymbols()].map((s) => s.symbolId).sort());
  assert.equal(current.getFile('b.c'), null);
  fs.writeFileSync(path.join(repo, 'wrapper.c'), 'int __newer(void) { return 0; }\n');
  await indexRepository(repo, store);
  const ranked = loadIndex(store);
  try { assert.equal(queryIndex(ranked, 'newer').target.name, 'newer'); }
  finally { ranked.close(); }
});

test('JS/TS imports ignore comments and strings and resolve incoming module references', async (t) => {
  const { repo, store } = setup(t);
  fs.writeFileSync(path.join(repo, 'target.ts'), 'export function target() { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'entry.ts'), 'import { target } from "./target";\n// import "./fake";\nconst text = `import "./fake"`;\nexport { target } from "./target";\n');
  await indexRepository(repo, store);
  const index = loadIndex(store);
  t.after(() => index.close());
  const relations = [...index.iterStoredRelations()];
  assert.equal(relations.filter((r) => r.type === 'imports').length, 2);
  assert.ok(relations.every((r) => r.status === 'resolved'));
  const target = index.findSymbols({ path: 'target.ts', kinds: ['module'] })[0];
  assert.equal(index.getRelationsForTarget(target.symbolId, ['imports']).length, 2);
});

test('UTF-8 clipped evidence matches byte ranges and metadata queries do not read blobs', async (t) => {
  const { repo, store } = setup(t);
  fs.writeFileSync(path.join(repo, 'long.py'), 'def long_function():\n' + '    text = "中文😀"\n'.repeat(90) + '    return text\n');
  const built = await indexRepository(repo, store);
  const index = loadIndex(store);
  t.after(() => index.close());
  const result = queryIndex(index, 'long_function');
  const evidence = result.evidence.find((e) => e.symbol.endsWith('long_function'));
  assert.equal(evidence.endLine - evidence.startLine + 1, 60);
  const buffer = fs.readFileSync(path.join(built.snapshotDir, 'source', evidence.blobDigest));
  assert.equal(buffer.subarray(evidence.startByte, evidence.endByte).toString('utf8'), evidence.source);
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    assert.ok(!String(file).includes(`${path.sep}source${path.sep}`));
    return read(file, ...args);
  };
  try { assert.equal(queryIndex(index, 'long_function', { includeSource: false }).evidence.length, 0); }
  finally { fs.readFileSync = read; }
});

test('missing native artifact rebuilds a generation and export states its audit scope', async (t) => {
  const { root, repo, store } = setup(t);
  fs.writeFileSync(path.join(repo, 'demo.h'), 'int callee(void);\n');
  fs.writeFileSync(path.join(repo, 'demo.c'), '/*\n#include "fake.h"\n*/\n#include "demo.h"\nint callee(void) { return 1; }\nint caller(void) { return callee(); }\n');
  const first = await indexRepository(repo, store);
  fs.unlinkSync(path.join(first.snapshotDir, 'native/cscope.out.in'));
  assert.throws(() => loadIndex(store), /重新执行 index/);
  const second = await indexRepository(repo, store);
  assert.equal(second.manifest.snapshotId, first.manifest.snapshotId);
  assert.notEqual(second.snapshotDir, first.snapshotDir);
  const index = loadIndex(store);
  try {
    assert.equal([...index.iterStoredRelations()].filter((r) => r.type === 'includes').length, 1);
    const header = index.findSymbols({ path: 'demo.h', kinds: ['module'] })[0];
    assert.equal(index.getRelationsForTarget(header.symbolId, ['includes']).length, 1);
    const included = queryIndex(index, 'who includes demo.h');
    assert.equal(included.target.symbolId, header.symbolId);
    assert.equal(included.relations.length, 1);
    assert.equal(included.relations[0].sourceSpan.startLine, 4);
  } finally { index.close(); }
  const output = path.join(root, 'export');
  exportIndex(store, output);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.match(manifest.export.relations, /native edges are not expanded/);
  assert.ok(fs.existsSync(path.join(output, 'native/cscope.out.in')));
  assert.ok(fs.existsSync(path.join(output, 'symbols.jsonl')));
  assert.throws(() => exportIndex(store, output), /导出目录必须为空/);
});
