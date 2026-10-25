import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { indexRepository, loadIndex } from '../src/lib/indexer.js';
import { extractCTags, queryCscope, resolveNativeTools } from '../src/lib/native-tools.js';
import { runProcess, workerCount } from '../src/lib/build-jobs.js';
import { parseEntries } from '../src/parsers/index.js';
import { parseEntriesParallel } from '../src/parsers/parallel.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-performance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  return { root, repo, store: path.join(root, 'store') };
}

function inventory(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return inventory(root, relative);
    const file = path.join(root, relative);
    const stat = fs.statSync(file);
    return [{ path: relative, hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtime: stat.mtimeMs, mode: stat.mode, ino: stat.ino }];
  });
}

test('bounded parser workers preserve UTF-8 spans, docs and all serial records; consumer failure stops the pool', async () => {
  const entries = Array.from({ length: 130 }, (_, file) => ({ path: `f${file}.ts`, language: 'typescript', source:
    Array.from({ length: 80 }, (_, i) => `// 中文😀 ${i}\nexport function f${i}() { return helper${i}(); }\n`).join('') }));
  const expected = parseEntries(entries);
  const actual = new Map();
  await parseEntriesParallel(entries, (record) => actual.set(record.path, record), { workers: 4 });
  assert.deepEqual(actual, expected);
  for (const [file, record] of actual) {
    const bytes = Buffer.from(entries.find((entry) => entry.path === file).source);
    for (const symbol of record.symbols.slice(1)) {
      assert.ok(bytes.subarray(symbol.span.startByte, symbol.span.endByte).toString().includes(symbol.name));
      assert.match(symbol.doc, /中文😀/);
    }
  }
  let calls = 0;
  await assert.rejects(parseEntriesParallel(entries, () => { calls++; throw new Error('storage failure'); }, { workers: 4 }), /storage failure/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  const cancelled = parseEntriesParallel(entries, () => {}, { workers: 4, signal: controller.signal });
  controller.abort(new Error('native failure'));
  await assert.rejects(cancelled, /native failure/);
  for (const workers of [0, 9, 1.5, 'bad']) assert.throws(() => workerCount(workers), /workers/);
});

test('Ctags shards preserve all serial tags and input order without concatenating temporary output', async (t) => {
  const { root, repo } = fixture(t);
  const paths = Array.from({ length: 257 }, (_, i) => `${String(i).padStart(3, '0')}.c`);
  for (const [i, file] of paths.entries()) fs.writeFileSync(path.join(repo, file), `int f${i}(void) { return target${i}(); }\n`);
  const tools = resolveNativeTools({ needsCscope: false });
  const serial = await extractCTags({ treeRoot: repo, paths, tools, outputPath: path.join(root, 'serial'), workers: 1 });
  const parallel = await extractCTags({ treeRoot: repo, paths, tools, outputPath: path.join(root, 'parallel'), workers: 4 });
  const read = (result) => result.outputPaths.map((file) => fs.readFileSync(file, 'utf8')).join('');
  assert.ok(parallel.outputPaths.length > 1);
  assert.equal(read(parallel), read(serial));
});

test('Cscope successive same-second updates, deletes and transitive non-C includes match full builds without changing old snapshots', async (t) => {
  const { root, repo, store } = fixture(t);
  const tools = resolveNativeTools({ needsCtags: false });
  fs.writeFileSync(path.join(repo, 'a.c'), '#include "payload.inc"\n#include "generated.def"\nint a(void) { return payload(); }\n');
  fs.writeFileSync(path.join(repo, 'payload.inc'), 'int payload(void) { return 0; }\n');
  fs.writeFileSync(path.join(repo, 'z.c'), 'int deleted(void) { return 0; }\n');
  let previous = await indexRepository(repo, store);
  for (let generation = 1; generation <= 3; generation++) {
    const old = inventory(previous.snapshotDir);
    fs.writeFileSync(path.join(repo, 'payload.inc'), `int payload(void) { return fresh${generation}(); }\n`);
    fs.writeFileSync(path.join(repo, 'generated.def'), `int fresh${generation}(void) { return ${generation}; }\n`);
    if (generation === 1) fs.unlinkSync(path.join(repo, 'z.c'));
    if (generation === 2) fs.renameSync(path.join(repo, 'a.c'), path.join(repo, 'renamed.c'));
    // Source timestamps carry no change information. Digests must drive reuse.
    for (const file of fs.readdirSync(repo)) fs.utimesSync(path.join(repo, file), 1, 1);
    const updated = await indexRepository(repo, store);
    assert.equal(updated.stats.nativeBuildMode, 'incremental');
    assert.deepEqual(inventory(previous.snapshotDir), old);
    const full = await indexRepository(repo, path.join(root, `full-${generation}`), { incremental: false });
    for (const [name, mode] of [['.*', 'references'], ['a', 'callees'], ['payload', 'callers'], ['payload.inc', 'includes']]) {
      const query = (built) => queryCscope({ snapshotDir: built.snapshotDir, treeRoot: path.join(built.snapshotDir, 'tree'), tools, name, mode }).rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      assert.deepEqual(query(updated), query(full));
    }
    previous = updated;
  }
});

test('unchanged macro tails and multiline strings retain their references across incremental rebuilds', async (t) => {
  const { root, repo, store } = fixture(t);
  const tools = resolveNativeTools({ needsCtags: false });
  fs.writeFileSync(path.join(repo, 'macros.h'), '#define FN(obj, field_name) obj->field_name\n#define ID(x) x\n#define CTX(ctx) ctx\n');
  fs.writeFileSync(path.join(repo, 'strings.c'), String.raw`const char *message = "hello\
_world: more text";
`);
  fs.writeFileSync(path.join(repo, 'a.c'), 'int a(void) { return 1; }\n');
  let previous = await indexRepository(repo, store);
  for (let generation = 2; generation <= 3; generation++) {
    const old = inventory(previous.snapshotDir);
    fs.writeFileSync(path.join(repo, 'a.c'), `int a(void) { return ${generation}; }\n`);
    const updated = await indexRepository(repo, store);
    const full = await indexRepository(repo, path.join(root, `full-${generation}`), { incremental: false });
    assert.equal(updated.stats.nativeBuildMode, 'incremental');
    for (const name of ['field_name', 'x', 'ctx', '.*']) {
      const query = (built) => queryCscope({ snapshotDir: built.snapshotDir, treeRoot: path.join(built.snapshotDir, 'tree'), tools, name, mode: 'references' }).rows;
      assert.deepEqual(query(updated), query(full));
    }
    const body = (built) => { const bytes = fs.readFileSync(path.join(built.snapshotDir, 'native/cscope.out')); return bytes.subarray(bytes.indexOf(10) + 1); };
    assert.deepEqual(body(updated), body(full));
    assert.deepEqual(inventory(previous.snapshotDir), old);
    previous = updated;
  }
});

test('Cscope alias reordering falls back to a full build', async (t) => {
  const { repo, store } = fixture(t);
  fs.writeFileSync(path.join(repo, 'z space.c'), 'int old(void) { return 1; }\n');
  await indexRepository(repo, store);
  fs.writeFileSync(path.join(repo, 'a space.c'), 'int fresh(void) { return old(); }\n');
  const updated = await indexRepository(repo, store);
  assert.equal(updated.stats.nativeBuildMode, 'full');
  const index = loadIndex(store);
  try { assert.equal([...index.iterSymbols()].filter((symbol) => symbol.name === 'fresh').length, 1); }
  finally { index.close(); }
});

test('native timeout kills the process group, including a sort-like descendant', async (t) => {
  const { root } = fixture(t);
  const pidFile = path.join(root, 'pid');
  await assert.rejects(runProcess('/bin/sh', ['-c', 'sleep 30 & echo $! > "$1"; wait', 'test', pidFile], {
    timeout: 200, maxBuffer: 1024, env: process.env,
  }), /timed out/);
  const pid = fs.readFileSync(pidFile, 'utf8').trim();
  const stat = `/proc/${pid}/stat`;
  if (fs.existsSync(stat)) assert.match(fs.readFileSync(stat, 'utf8'), /\) Z /);
});

test('failure after starting native work drains children before deleting staging and preserves publication', async (t) => {
  const { repo, store } = fixture(t);
  fs.writeFileSync(path.join(repo, 'a.c'), 'int before(void) { return 1; }\n');
  const first = await indexRepository(repo, store);
  fs.appendFileSync(path.join(repo, 'a.c'), 'int after(void) { return before(); }\n');
  await assert.rejects(indexRepository(repo, store, { onProgress(event) {
    if (event.stage === 'native-symbols') throw new Error('injected storage failure');
  } }), /injected storage failure/);
  const index = loadIndex(store);
  try { assert.equal(index.manifest.snapshotId, first.manifest.snapshotId); } finally { index.close(); }
  assert.ok(fs.readdirSync(path.dirname(first.snapshotDir)).every((name) => !name.startsWith('.build-')));
});
