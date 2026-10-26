import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractCTags, resolveNativeTools } from '../src/lib/native-tools.js';

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = String(value);
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

function fixture(t, sources, hook = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-ctags-isolation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const treeRoot = path.join(dir, 'tree');
  fs.mkdirSync(treeRoot);
  for (const [file, source] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(treeRoot, file)), { recursive: true });
    fs.writeFileSync(path.join(treeRoot, file), source, 'utf8');
  }
  const log = path.join(dir, 'calls.jsonl');
  const tool = path.join(dir, 'fake-ctags.mjs');
  fs.writeFileSync(tool, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const files = fs.readFileSync(args[args.indexOf('-L') + 1], 'utf8').trim().split('\\n').map(file => file.replace(/^\\.\\//, ''));
const output = args[args.indexOf('-f') + 1];
const isProbe = process.cwd() !== ${JSON.stringify(treeRoot)};
const record = (event, extra = {}) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event, files, isProbe, cwd: process.cwd(), pid: process.pid, ...extra }) + '\\n');
record('start');
${hook}
fs.writeFileSync(output, '', 'utf8');
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes('CRASH')) {
    fs.appendFileSync(output, '{"_type":"tag","name":"truncated');
    record('crash');
    process.kill(process.pid, 'SIGSEGV');
    await new Promise(() => {});
  }
  fs.appendFileSync(output, JSON.stringify({ _type: 'tag', name: isProbe ? 'codeindex_ctags_probe' : file, path: file, kind: 'function', line: 1 }) + '\\n');
}
record('done');
`, { encoding: 'utf8', mode: 0o755 });
  return {
    dir, treeRoot, paths: Object.keys(sources), outputPath: path.join(dir, 'tags.jsonl'),
    tools: { ctags: { path: tool } },
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
  };
}

function readTags(result) {
  return result.outputPaths.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}

function assertClean(f) {
  assert.ok(!fs.readdirSync(f.dir).some((file) => file.startsWith('.ctags-')), 'scratch directory must be removed');
}

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fake Ctags');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(pid) {
  // Linux can briefly retain a killed orphan as a zombie after its group stops.
  try {
    if (fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z')) return false;
  } catch (error) { if (error.code === 'ENOENT') return false; }
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('isolates input SIGSEGVs, discards entire failed output, preserves order and probes once outside sources', async (t) => {
  const sources = {
    'first.c': 'int first;', 'bad.c': 'CRASH', 'with spaces/ok.cpp': 'int middle;',
    'other-bad.h': 'CRASH', '-last.c': 'int last;',
  };
  const f = fixture(t, sources);
  const result = await extractCTags({ ...f, paths: [...f.paths, 'first.c'], workers: 3 });
  assert.deepEqual(readTags(result).map((tag) => tag.path), ['first.c', 'with spaces/ok.cpp', '-last.c']);
  assert.deepEqual(result.failedFiles.map(({ path, signal }) => ({ path, signal })), [
    { path: 'bad.c', signal: 'SIGSEGV' }, { path: 'other-bad.h', signal: 'SIGSEGV' },
  ]);
  assert.ok(result.failedFiles.every((file) => /SIGSEGV/.test(file.error)));
  assert.equal(f.calls().filter((call) => call.event === 'start' && call.isProbe).length, 1);
  for (const [file, content] of Object.entries(sources)) assert.equal(fs.readFileSync(path.join(f.treeRoot, file), 'utf8'), content);
  assert.ok(!fs.existsSync(path.join(f.treeRoot, 'probe.c')));
  assertClean(f);
});

test('bounds batches by count, limits concurrency and publishes in input order', async (t) => {
  const sources = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`${index}.c`, 'int value;']));
  const f = fixture(t, sources, `if (files[0] === '0.c') await new Promise(resolve => setTimeout(resolve, 150));`);
  const result = await extractCTags({ ...f, workers: 2 });
  assert.deepEqual(readTags(result).map((tag) => tag.path), f.paths);
  assert.deepEqual(result.failedFiles, []);
  assert.deepEqual(f.calls().filter((call) => call.event === 'start').map((call) => call.files.length).sort((a, b) => a - b), [1, 256, 256]);
  let active = 0;
  let maximum = 0;
  for (const call of f.calls()) {
    active += call.event === 'start' ? 1 : -1;
    maximum = Math.max(maximum, active);
  }
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assertClean(f);
});

test('bounds batches by bytes and runs an oversized file alone', async (t) => {
  const f = fixture(t, { 'a.c': '', 'b.c': '', 'large.c': '', 'last.c': 'int last;' });
  for (const [file, size] of [['a.c', 5], ['b.c', 5], ['large.c', 9]]) fs.truncateSync(path.join(f.treeRoot, file), size * 1024 * 1024);
  const result = await extractCTags({ ...f, workers: 2 });
  assert.deepEqual(readTags(result).map((tag) => tag.path), f.paths);
  assert.ok(f.calls().filter((call) => call.event === 'start').every((call) => call.files.length === 1));
  assertClean(f);
});

test('empty input reports no failed files without tools', async (t) => {
  const f = fixture(t, {});
  const result = await extractCTags({ ...f, tools: {} });
  assert.deepEqual(result, { outputPaths: [f.outputPath], warnings: [], failedFiles: [] });
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), '');
});

for (const [name, hook, expected] of [
  ['nonzero exit', `console.error('system failure'); process.exit(7);`, { kind: 'exit', exitCode: 7, signal: null }],
  ['other signal', `process.kill(process.pid, 'SIGTERM'); await new Promise(() => {});`, { kind: 'exit', signal: 'SIGTERM' }],
  ['output limit', `process.stdout.write('x'.repeat(100000)); await new Promise(resolve => setTimeout(resolve, 1000));`, { kind: 'output-limit' }],
]) {
  test(`propagates ${name} without splitting or partial status`, async (t) => {
    environment(t, { CODEINDEX_NATIVE_MAX_OUTPUT_BYTES: 1024 });
    const f = fixture(t, { 'a.c': 'int a;', 'b.c': 'int b;' }, hook);
    await assert.rejects(extractCTags(f), (error) => {
      for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value);
      if (name === 'nonzero exit') assert.match(error.stderr, /system failure/);
      return true;
    });
    assert.equal(f.calls().filter((call) => call.event === 'start').length, 1);
    assert.ok(!fs.existsSync(f.outputPath));
    assertClean(f);
  });
}

test('propagates missing executables, invalid settings and output I/O failures', async (t) => {
  const f = fixture(t, { 'a.c': 'int a;' });
  await assert.rejects(extractCTags({ ...f, tools: { ctags: { path: path.join(f.dir, 'absent') } } }), { kind: 'spawn' });
  assertClean(f);
  environment(t, { CODEINDEX_NATIVE_TIMEOUT_MS: 'invalid' });
  await assert.rejects(extractCTags(f), /must be a positive integer/);
  process.env.CODEINDEX_NATIVE_TIMEOUT_MS = '5000';
  const missingOutput = fixture(t, { 'a.c': 'int a;' }, 'process.exit(0);');
  await assert.rejects(extractCTags(missingOutput), { code: 'ENOENT' });
  assertClean(missingOutput);
});

for (const hook of [
  `process.kill(process.pid, 'SIGSEGV'); await new Promise(() => {});`,
  `if (isProbe) { fs.writeFileSync(output, ''); process.exit(0); }`,
]) {
  test('a broken tool cannot classify all inputs as partial', async (t) => {
    const f = fixture(t, { 'bad.c': 'CRASH' }, hook);
    await assert.rejects(extractCTags(f), /SIGSEGV|health probe/);
    assert.equal(f.calls().filter((call) => call.event === 'start').length, 2);
    assert.ok(!fs.existsSync(f.outputPath));
    assertClean(f);
  });
}

test('all crashing inputs yield empty tags only when the known C probe works', async (t) => {
  const f = fixture(t, { 'bad.c': 'CRASH', 'worse.c': 'CRASH' });
  const result = await extractCTags(f);
  assert.deepEqual(readTags(result), []);
  assert.deepEqual(result.failedFiles.map((file) => file.path), f.paths);
  assert.equal(f.calls().filter((call) => call.event === 'start' && call.isProbe).length, 1);
  assertClean(f);
});

test('retries share one total timeout budget', async (t) => {
  environment(t, { CODEINDEX_NATIVE_TIMEOUT_MS: 3000 });
  const f = fixture(t, { 'bad.c': 'CRASH', 'good.c': 'int good;' }, `
if (files.length > 1) await new Promise(resolve => setTimeout(resolve, 100));
else await new Promise(resolve => setTimeout(resolve, 2200));
`);
  const started = performance.now();
  await assert.rejects(extractCTags(f), { kind: 'timeout' });
  assert.ok(performance.now() - started < 3700, 'splits must not restart the overall timeout');
  assert.ok(f.calls().filter((call) => call.event === 'start').length >= 2);
  assertClean(f);
});

test('isolation has a global cap of 128 additional attempts', async (t) => {
  environment(t, { CODEINDEX_NATIVE_TIMEOUT_MS: 180000 });
  const f = fixture(t, Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`${index}.c`, 'int value;'])), `
if (files.length > 1) {
  process.kill(process.pid, 'SIGSEGV');
  await new Promise(() => {});
}
`);
  await assert.rejects(extractCTags(f), /isolation retry limit exceeded/);
  assert.equal(f.calls().filter((call) => call.event === 'start').length, 129);
  assert.ok(!fs.existsSync(f.outputPath));
  assertClean(f);
});

test('cancellation waits for workers and descendants before removing scratch', async (t) => {
  const f = fixture(t, Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`${index}.c`, 'int value;'])), `
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
record('descendant', { descendant: descendant.pid });
setInterval(() => {}, 1000);
await new Promise(() => {});
`);
  const controller = new AbortController();
  const pending = extractCTags({ ...f, workers: 2, signal: controller.signal });
  const rejected = assert.rejects(pending, { kind: 'aborted' });
  await until(() => f.calls().filter((call) => call.event === 'descendant').length === 2);
  controller.abort();
  await rejected;
  for (const call of f.calls().filter((call) => call.event === 'descendant')) {
    assert.equal(alive(call.pid), false);
    assert.equal(alive(call.descendant), false);
  }
  assertClean(f);
});

test('a failing worker cancels and joins its running peers before cleanup', async (t) => {
  const f = fixture(t, Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`${index}.c`, 'int value;'])), `
if (files[0] === '0.c') {
  await new Promise(resolve => setTimeout(resolve, 200));
  console.error('system failure');
  process.exit(9);
}
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
record('descendant', { descendant: descendant.pid });
setInterval(() => {}, 1000);
await new Promise(() => {});
`);
  await assert.rejects(extractCTags({ ...f, workers: 2 }), { kind: 'exit', exitCode: 9 });
  const peers = f.calls().filter((call) => call.event === 'descendant');
  assert.equal(peers.length, 1);
  for (const call of peers) {
    assert.equal(alive(call.pid), false);
    assert.equal(alive(call.descendant), false);
  }
  assertClean(f);
});

test('a pre-aborted invocation does not launch Ctags', async (t) => {
  const f = fixture(t, { 'a.c': 'int a;' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extractCTags({ ...f, signal: controller.signal }), { kind: 'aborted' });
  assert.deepEqual(f.calls(), []);
  assertClean(f);
});

test('real Ctags isolates the original LLVM parser overflow sample when available', async (t) => {
  const sample = '/data/dev/CodeIndex/.data/heldout/sources/llvm/clang/test/Parser/parser_overflow.c';
  if (!fs.existsSync(sample)) { t.skip('Original heldout LLVM sample is unavailable'); return; }
  let tools;
  try { tools = resolveNativeTools({ needsCscope: false }); }
  catch (error) { t.skip(error.message); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-ctags-llvm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = fs.readFileSync(sample);
  const result = await extractCTags({
    treeRoot: path.dirname(sample), paths: [path.basename(sample)],
    outputPath: path.join(dir, 'tags.jsonl'), tools,
  });
  assert.deepEqual(fs.readFileSync(sample), original);
  assert.ok(result.failedFiles.length <= 1);
  if (result.failedFiles.length) {
    assert.equal(result.failedFiles[0].path, path.basename(sample));
    assert.equal(result.failedFiles[0].signal, 'SIGSEGV');
    assert.deepEqual(readTags(result), []);
  } else {
    // Newer Ctags releases may have fixed this historical parser crash.
    readTags(result);
  }
  assert.ok(!fs.readdirSync(dir).some((file) => file.startsWith('.ctags-')));
});
