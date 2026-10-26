import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveNativeTools, extractCTags, buildCscope, queryCscope } from '../src/lib/native-tools.js';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-native-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const before = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
}

function fakeTool(dir, name, source) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${source}\n`, { encoding: 'utf8', mode: 0o755 });
  return file;
}

function realTools(t) {
  try { return resolveNativeTools(); }
  catch (error) { t.skip(`Native integration tools unavailable: ${error.message}`); return null; }
}

function fixture(t, { spaces = false } = {}) {
  const dir = temp(t);
  const repo = path.join(dir, 'live');
  const snapshotDir = path.join(dir, 'snapshot staging');
  const treeRoot = path.join(snapshotDir, 'tree');
  fs.mkdirSync(repo);
  const source = spaces ? 'source dir/a file.c' : 'demo.c';
  const content = {
    'demo.h': 'int target(int value);\n',
    [source]: '#include "demo.h"\nint target(int value) { return value + 1; }\nint caller(void) { return target(7); }\nint caller2(void) { return target(8); }\n',
    'types.cpp': 'class Base {};\nclass Child : public Base {\npublic:\n int method(int value) { return value; }\n};\n',
    'ignored.py': 'def python_only():\n    pass\n',
  };
  for (const [file, text] of Object.entries(content)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text, 'utf8');
  }
  fs.cpSync(repo, treeRoot, { recursive: true });
  return { dir, repo, snapshotDir, treeRoot, paths: Object.keys(content), source };
}

test('only resolves requested tools and gives explicit missing dependency errors', async (t) => {
  const dir = temp(t);
  assert.deepEqual(resolveNativeTools({ needsCtags: false, needsCscope: false }), { ctags: null, cscope: null });
  assert.throws(() => resolveNativeTools({ ctags: path.join(dir, 'missing'), needsCscope: false }), /Cannot resolve ctags.*executable not found/);
  assert.throws(() => resolveNativeTools({ cscope: path.join(dir, 'missing'), needsCtags: false }), /Cannot resolve cscope.*executable not found/);
});

test('prefers Universal Ctags, validates JSON, and respects explicit and environment options', async (t) => {
  const dir = temp(t);
  const source = `console.log(process.argv.includes('--list-features') ? 'json supports json' : 'Universal Ctags 6.1');`;
  const universal = fakeTool(dir, 'ctags-universal', source);
  const ordinary = fakeTool(dir, 'ctags', source);
  const cscope = fakeTool(dir, 'cscope', `console.error('cscope: version 15.9');`);
  environment(t, { PATH: dir, CODEINDEX_CTAGS: undefined, CODEINDEX_CSCOPE: cscope });
  assert.equal(resolveNativeTools().ctags.path, universal);
  process.env.CODEINDEX_CTAGS = ordinary;
  assert.equal(resolveNativeTools().ctags.path, ordinary);
  assert.equal(resolveNativeTools({ ctags: universal }).ctags.path, universal);
  assert.equal(resolveNativeTools().cscope.path, cscope);
  const exuberant = fakeTool(dir, 'exuberant', `console.log('Exuberant Ctags 5.8');`);
  assert.throws(() => resolveNativeTools({ ctags: exuberant, needsCscope: false }), /Universal Ctags is required/);
  const noJson = fakeTool(dir, 'no-json', `console.log(process.argv.includes('--list-features') ? 'regex' : 'Universal Ctags 6.1');`);
  assert.throws(() => resolveNativeTools({ ctags: noJson, needsCscope: false }), /JSON support is required/);
});

test('Cscope version identity does not contain its installation path', async (t) => {
  const dir = temp(t);
  const source = `console.error(process.argv[1] + ': version 15.9');`;
  const first = fakeTool(dir, 'cscope-first', source);
  const second = fakeTool(dir, 'cscope-second', source);
  const resolve = (cscope) => resolveNativeTools({ cscope, needsCtags: false }).cscope;
  assert.equal(resolve(first).version, 'cscope: version 15.9');
  assert.equal(resolve(second).version, resolve(first).version);
  assert.notEqual(resolve(second).path, resolve(first).path);
});

test('native command timeout and captured-output limits are enforced', async (t) => {
  const dir = temp(t);
  const hanging = fakeTool(dir, 'hanging', 'setInterval(() => {}, 1000);');
  environment(t, { CODEINDEX_NATIVE_TIMEOUT_MS: '100', CODEINDEX_NATIVE_MAX_OUTPUT_BYTES: '1024' });
  assert.throws(() => resolveNativeTools({ cscope: hanging, needsCtags: false }), /ETIMEDOUT/);
  const verbose = fakeTool(dir, 'verbose', `process.stdout.write('a'.repeat(100000));`);
  assert.throws(() => resolveNativeTools({ cscope: verbose, needsCtags: false }), /ENOBUFS/);
});

test('Ctags emits C/C++ ranges, scopes, signatures and inheritance without source patterns', async (t) => {
  const tools = realTools(t);
  if (!tools) return;
  const f = fixture(t, { spaces: true });
  const outputPath = path.join(f.snapshotDir, 'tags.jsonl');
  const output = await extractCTags({ ...f, tools, outputPath });
  assert.deepEqual(output, { outputPaths: [outputPath], warnings: [], failedFiles: [] });
  const tags = fs.readFileSync(outputPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(tags.every((tag) => tag._type === 'tag' && !Object.hasOwn(tag, 'pattern')));
  assert.ok(!tags.some((tag) => tag.name === 'python_only'));
  const caller = tags.find((tag) => tag.name === 'caller');
  assert.equal(caller.path, f.source);
  assert.equal(caller.line, 3);
  assert.equal(caller.end, 3);
  assert.equal(caller.signature, '(void)');
  assert.equal(tags.find((tag) => tag.name === 'method').scope, 'Child');
  assert.match(tags.find((tag) => tag.name === 'Child').inherits, /Base/);
  assert.ok(tags.some((tag) => tag.kind === 'prototype' && tag.path === 'demo.h'));
  // Reusing an output pathname must not trigger Ctags' refusal to overwrite JSONL.
  await extractCTags({ ...f, tools, outputPath });
});

for (const spaces of [false, true]) {
  test(`real Cscope survives snapshot move and live repository deletion${spaces ? ', including spaced paths' : ''}`, async (t) => {
    const tools = realTools(t);
    if (!tools) return;
    const f = fixture(t, { spaces });
    const before = fs.readFileSync(path.join(f.treeRoot, f.source));
    const built = await buildCscope({ ...f, tools });
    assert.deepEqual(built.files, f.paths.filter((file) => !file.endsWith('.py')));
    assert.deepEqual(built.warnings, []);
    for (const artifact of built.artifacts) assert.ok(fs.statSync(path.join(f.snapshotDir, artifact)).size > 0);
    assert.deepEqual(fs.readFileSync(path.join(f.treeRoot, f.source)), before);
    const published = path.join(f.dir, 'published snapshot');
    fs.renameSync(f.snapshotDir, published);
    fs.rmSync(f.repo, { recursive: true });
    const query = (name, mode, limit) => queryCscope({ snapshotDir: published, treeRoot: path.join(published, 'tree'), tools, name, mode, limit });
    const callers = query('target', 'callers');
    assert.deepEqual(callers.rows.map((row) => row.peer).sort(), ['caller', 'caller2']);
    assert.ok(callers.rows.every((row) => row.path === f.source && row.line >= 3 && row.text.includes('target')));
    assert.equal(callers.truncated, false);
    assert.ok(query('caller', 'callees').rows.some((row) => row.peer === 'target'));
    assert.ok(query('target', 'references').rows.length >= 3);
    assert.ok(query('demo.h', 'includes').rows.some((row) => row.path === f.source && row.line === 1));
    assert.deepEqual(query('no_such_symbol', 'references'), { rows: [], truncated: false });
    assert.equal(query('target', 'callers', 1).rows.length, 1);
    assert.equal(query('target', 'callers', 1).truncated, true);
    assert.deepEqual(query('target', 'callers', 0), { rows: [], truncated: true });
    fs.rmSync(path.join(published, 'native/cscope.out.in'));
    assert.throws(() => query('target', 'callers'), /Missing or empty Cscope inverted-index artifact/);
  });
}

test('Cscope uses system PATH for internal env and sort, ignoring include environment', async (t) => {
  const tools = realTools(t);
  if (!tools) return;
  const f = fixture(t);
  const bin = path.join(f.dir, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['env', 'sort']) fakeTool(bin, name, `console.error('poisoned command'); process.exit(99);`);
  environment(t, { PATH: bin, VPATH: f.repo, INCLUDEDIRS: f.repo, SOURCEDIRS: f.repo, INCDIR: f.repo });
  await buildCscope({ ...f, tools });
  assert.equal(queryCscope({ ...f, tools, name: 'target', mode: 'callers' }).rows.length, 2);
});

test('rejects unsupported filenames and snapshot escapes before spawning tools', async (t) => {
  const f = fixture(t);
  for (const file of ['bad\nname.c', 'bad\tname.c', 'bad"name.c', 'bad\\name.c', '../outside.c', '/tmp/absolute.c']) {
    await assert.rejects(() => buildCscope({ ...f, paths: [file], tools: {} }), /filename|relative/);
  }
  fs.symlinkSync(path.join(f.repo, 'demo.c'), path.join(f.treeRoot, 'escape.c'));
  await assert.rejects(() => buildCscope({ ...f, paths: ['escape.c'], tools: {} }), /escapes snapshot/);
});

test('rejects external, symlinked and unlisted includes before native execution', async (t) => {
  const f = fixture(t);
  const file = path.join(f.treeRoot, 'demo.c');
  for (const include of [path.join(f.repo, 'demo.h'), '../../live/demo.h']) {
    fs.writeFileSync(file, `#include "${include}"\nint main(void) { return 0; }\n`);
    await assert.rejects(() => buildCscope({ ...f, tools: {} }), /include|Include/);
  }
  fs.writeFileSync(file, `#include "${path.join(f.repo, 'demo.h')}\n`);
  await assert.rejects(() => buildCscope({ ...f, tools: {} }), /Unsafe include/);
  fs.symlinkSync(path.join(f.repo, 'demo.h'), path.join(f.treeRoot, 'escape.h'));
  fs.writeFileSync(file, '#include "escape.h"\n');
  await assert.rejects(() => buildCscope({ ...f, tools: {} }), /not an indexed snapshot file/);
  fs.writeFileSync(path.join(f.treeRoot, 'not-listed.h'), 'int unexpected;\n');
  fs.writeFileSync(file, '#include "not-listed.h"\n');
  await assert.rejects(() => buildCscope({ ...f, tools: {} }), /not an indexed snapshot file/);
});

test('Cscope accepts missing parent/generated includes and resolves quoted includes from cwd', async (t) => {
  const tools = realTools(t);
  if (!tools) return;
  const f = fixture(t);
  fs.mkdirSync(path.join(f.treeRoot, 'sub'));
  fs.writeFileSync(path.join(f.treeRoot, 'sub/input.c'), '#include "../demo.h"\n#include "local.inc"\n#include "generated/missing.h"\n#include "../../missing.h"\nint sub_input;\n');
  fs.writeFileSync(path.join(f.treeRoot, 'sub/local.inc'), 'int source_relative_only;\n');
  const paths = [...f.paths, 'sub/input.c'];
  const result = await buildCscope({ ...f, paths, allowedFiles: [...paths, 'sub/local.inc'], tools });
  assert.equal(result.files.length, 4);
  assert.equal(result.indexedFiles.length, 4);
  assert.deepEqual(queryCscope({ ...f, tools, name: 'source_relative_only', mode: 'references' }).rows, []);
  // A real cwd candidate outside the snapshot would be opened, even when the
  // source-relative interpretation of ../demo.h is safe.
  fs.writeFileSync(path.join(f.snapshotDir, 'demo.h'), 'int external;\n');
  await assert.rejects(() => buildCscope({ ...f, paths, tools: {} }), /Unsafe include outside snapshot/);
});

test('Cscope follows allowed saved non-C includes transitively and reports actual indexed files', async (t) => {
  const tools = realTools(t);
  if (!tools) return;
  const f = fixture(t);
  fs.mkdirSync(path.join(f.treeRoot, 'generated'));
  fs.writeFileSync(path.join(f.treeRoot, 'demo.c'), '#include "generated/first.inc"\nint primary_symbol;\n');
  fs.writeFileSync(path.join(f.treeRoot, 'generated/first.inc'), '#include "generated/second.def"\nint included_symbol;\n');
  fs.writeFileSync(path.join(f.treeRoot, 'generated/second.def'), '#include "generated/first.inc"\nint nested_symbol;\n');
  const allowedFiles = [...f.paths, 'generated/first.inc', 'generated/second.def'];
  await assert.rejects(() => buildCscope({ ...f, tools: {} }), /not an indexed snapshot file/);
  const built = await buildCscope({ ...f, allowedFiles, tools });
  assert.equal(built.files.length, 3);
  assert.equal(built.indexedFiles.length, 5);
  assert.ok(built.indexedFiles.includes('generated/second.def'));
  assert.equal(queryCscope({ ...f, tools, name: 'nested_symbol', mode: 'references' }).rows[0].path, 'generated/second.def');
  fs.writeFileSync(path.join(f.treeRoot, 'generated/second.def'), `#include "${path.join(f.repo, 'demo.h')}"\n`);
  await assert.rejects(() => buildCscope({ ...f, allowedFiles, tools: {} }), /Unsafe include outside snapshot/);
  fs.writeFileSync(path.join(f.treeRoot, 'generated/second.def'), '#include "not-saved.inc"\n');
  fs.writeFileSync(path.join(f.treeRoot, 'not-saved.inc'), 'int not_saved;\n');
  await assert.rejects(() => buildCscope({ ...f, allowedFiles, tools: {} }), /not an indexed snapshot file/);
});

test('Cscope -k has no angle-include search directories', async (t) => {
  const tools = realTools(t);
  if (!tools) return;
  const f = fixture(t);
  fs.writeFileSync(path.join(f.treeRoot, 'demo.c'), `#include <${path.join(f.repo, 'demo.h')}>\n#include <not-saved.inc>\nint primary_symbol;\n`);
  fs.writeFileSync(path.join(f.treeRoot, 'not-saved.inc'), 'int not_saved;\n');
  const result = await buildCscope({ ...f, tools });
  assert.equal(result.indexedFiles.length, 3);
  assert.deepEqual(queryCscope({ ...f, tools, name: 'not_saved', mode: 'references' }).rows, []);
});

test('Cscope refuses filename aliases when extra include closure files would be lost', async (t) => {
  const f = fixture(t, { spaces: true });
  fs.writeFileSync(path.join(f.treeRoot, f.source), '#include "generated.inc"\n');
  fs.writeFileSync(path.join(f.treeRoot, 'generated.inc'), 'int extra_symbol;\n');
  await assert.rejects(() => buildCscope({ ...f, allowedFiles: [...f.paths, 'generated.inc'], tools: {} }), /filename aliases.*include files/);
});

test('fails on zero-exit Cscope inverted-index diagnostics and cleans artifacts', async (t) => {
  const f = fixture(t);
  const broken = fakeTool(f.dir, 'broken-cscope', `
    import fs from 'node:fs';
    const db = process.argv[process.argv.indexOf('-f') + 1];
    for (const suffix of ['', '.in', '.po']) fs.writeFileSync(db + suffix, 'not a real database');
    console.error('cscope: cannot create inverted index; ignoring -q option');
  `);
  await assert.rejects(() => buildCscope({ ...f, tools: { cscope: { path: broken } } }), /cannot create inverted index/);
  assert.deepEqual(fs.readdirSync(path.join(f.snapshotDir, 'native')), []);
});

test('fails on missing inverted files even when Cscope exits successfully', async (t) => {
  const f = fixture(t);
  const broken = fakeTool(f.dir, 'missing-index', `
    import fs from 'node:fs';
    fs.writeFileSync(process.argv[process.argv.indexOf('-f') + 1], 'database');
  `);
  await assert.rejects(() => buildCscope({ ...f, tools: { cscope: { path: broken } } }), /Missing or empty Cscope/);
});

test('rejects corrupt inverted indexes and zero-exit query errors', async (t) => {
  const tools = realTools(t);
  if (!tools) return;
  const f = fixture(t);
  await buildCscope({ ...f, tools });
  const query = (selectedTools) => queryCscope({ ...f, tools: selectedTools, name: 'target', mode: 'callers' });
  const broken = fakeTool(f.dir, 'query-error', `console.error('cscope: cannot open inverted index');`);
  assert.throws(() => query({ cscope: { path: broken } }), /cannot open inverted index/);
  fs.writeFileSync(path.join(f.snapshotDir, 'native/cscope.out.in'), 'corrupt index');
  assert.throws(() => query(tools), /failed/);
});

test('checks the actual native database file list before accepting artifacts', async (t) => {
  const tools = realTools(t);
  if (!tools) return;
  const f = fixture(t);
  const wrapper = fakeTool(f.dir, 'unexpected-files', `
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const args = process.argv.slice(2);
    const result = spawnSync(${JSON.stringify(tools.cscope.path)}, args, { encoding: 'utf8' });
    if (result.status !== 0) process.exit(result.status || 1);
    const db = args[args.indexOf('-f') + 1];
    const bytes = fs.readFileSync(db);
    const header = bytes.subarray(0, bytes.indexOf(10)).toString();
    const offset = Number(header.match(/ (\\d+)$/)[1]);
    const trailer = bytes.subarray(offset).toString().replace('demo.c', 'evil.c');
    fs.writeFileSync(db, Buffer.concat([bytes.subarray(0, offset), Buffer.from(trailer)]));
  `);
  await assert.rejects(() => buildCscope({ ...f, tools: { cscope: { path: wrapper } } }), /indexed unexpected files/);
});

test('empty inputs require no native dependencies and invalid query modes are rejected', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await buildCscope({ ...f, paths: ['ignored.py'], tools: {} }), { files: [], indexedFiles: [], artifacts: [], warnings: [] });
  const outputPath = path.join(f.snapshotDir, 'empty.jsonl');
  assert.deepEqual(await extractCTags({ ...f, paths: [], outputPath, tools: {} }), { outputPaths: [outputPath], warnings: [], failedFiles: [] });
  assert.equal(fs.readFileSync(outputPath, 'utf8'), '');
  assert.throws(() => queryCscope({ ...f, name: 'target', mode: 'unknown', tools: {} }), /Unsupported Cscope mode/);
});
