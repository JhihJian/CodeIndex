import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repositoryId, scanRepository } from '../src/lib/fs.js';
import { indexRepository, loadIndex } from '../src/lib/indexer.js';
import { parseEntriesBatched, parsePythonBatch, pythonJobContext } from '../src/parsers/index.js';
import { resolvePythonRuntime } from '../src/parsers/python-runtime.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-parser-protocol-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const store = path.join(root, 'store');
  fs.mkdirSync(repo);
  return { root, repo, store };
}

// A real child process exercises stdin/stdout and exit handling without product hooks.
function fakePython(root, body) {
  const executable = path.join(root, 'fake-python.cjs');
  const log = path.join(root, 'invocations.jsonl');
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
${body}
`, { mode: 0o755 });
  return {
    runtime: { path: executable },
    invocations: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
  };
}

const entries = ['first.py', 'second.py'].map(file => ({
  path: file, language: 'python', source: 'def valid(): return target()\n',
}));
const readBatch = `const batch = JSON.parse(fs.readFileSync(0, 'utf8'));
const records = batch.map(({ path }) => ({ path, status: 'complete', symbols: [], relations: [] }));`;

for (const [name, response, message] of [
  ['missing result', 'records.pop(); console.log(JSON.stringify(records));', /result count differs/],
  ['duplicate path with matching count', 'records[1] = records[0]; console.log(JSON.stringify(records));', /invalid or duplicate result/],
  ['unexpected path', "records[1].path = 'foreign.py'; console.log(JSON.stringify(records));", /invalid or duplicate result/],
  ['truncated JSON', "process.stdout.write('[{');", /invalid Python JSON/],
  ['non-array JSON', "console.log('{}');", /result count differs/],
  ['invalid status', "records[1].status = 'success'; console.log(JSON.stringify(records));", /invalid or duplicate result/],
  ['missing symbols', 'delete records[1].symbols; console.log(JSON.stringify(records));', /invalid or duplicate result/],
  ['invalid symbol span', `records[1].symbols = [{ key: 'bad', name: 'bad', kind: 'function',
    span: { startLine: 0, endLine: 1, startColumn: 0, endColumn: 1 } }];
    console.log(JSON.stringify(records));`, /invalid symbol/],
  ['invalid relation line', `records[1].relations = [{ sourceKey: 'module:second.py', type: 'calls', targetName: 'target', line: 0 }];
    console.log(JSON.stringify(records));`, /invalid relation/],
]) {
  test(`Python protocol rejects ${name} without isolation or partial results`, async (t) => {
    const { root } = workspace(t);
    const fake = fakePython(root, `${readBatch}\n${response}`);
    const context = pythonJobContext(fake.runtime);
    await assert.rejects(parsePythonBatch(entries, context), error => {
      assert.match(error.message, /parser-protocol:/);
      assert.match(error.message, message);
      return true;
    });
    assert.equal(context.retries, 0);
    assert.equal(context.healthProbe, null);
    assert.equal(fake.invocations().length, 1);
  });
}

test('a malformed Python batch does not emit its valid prefix to the result callback', async (t) => {
  const { root } = workspace(t);
  const fake = fakePython(root, `${readBatch}\nrecords[1] = records[0]; console.log(JSON.stringify(records));`);
  const emitted = [];
  await assert.rejects(parseEntriesBatched(entries, record => emitted.push(record), { pythonRuntime: fake.runtime }), /parser-protocol:/);
  assert.deepEqual(emitted, []);
  assert.equal(fake.invocations().length, 1);
});

test('valid Python responses retain path identity even when returned out of order', async (t) => {
  const { root } = workspace(t);
  const fake = fakePython(root, `${readBatch}\nconsole.log(JSON.stringify(records.reverse()));`);
  const emitted = [];
  await parseEntriesBatched(entries, record => emitted.push(record), { pythonRuntime: fake.runtime });
  assert.deepEqual(emitted.map(record => [record.path, record.status]), [
    ['second.py', 'complete'], ['first.py', 'complete'],
  ]);
  assert.equal(fake.invocations().length, 1);
});

for (const [name, body, exitCode, stderr] of [
  ['ordinary nonzero exit despite valid stdout', `${readBatch}
    console.log(JSON.stringify(records)); process.stderr.write('ordinary parser failure'); process.exitCode = 17;`, 17, /ordinary parser failure/],
  ['unexpected child exception', `${readBatch}\nthrow new Error('unexpected extraction failure');`, 1, /unexpected extraction failure/],
]) {
  test(`Python ${name} fails instead of producing partial records`, async (t) => {
    const { root } = workspace(t);
    const fake = fakePython(root, body);
    const context = pythonJobContext(fake.runtime);
    await assert.rejects(parsePythonBatch(entries, context), error => {
      assert.equal(error.kind, 'exit');
      assert.equal(error.exitCode, exitCode);
      assert.equal(error.signal, null);
      assert.match(error.stderr, stderr);
      return true;
    });
    assert.equal(context.retries, 0);
    assert.equal(context.healthProbe, null);
    assert.equal(fake.invocations().length, 1);
  });
}

test('Python spawn failures propagate instead of becoming partial records', async (t) => {
  const { root } = workspace(t);
  const context = pythonJobContext({ path: path.join(root, 'missing-python') });
  await assert.rejects(parsePythonBatch(entries, context), error => error.kind === 'spawn' && error.code === 'ENOENT');
  assert.equal(context.retries, 0);
  assert.equal(context.healthProbe, null);
});

for (const [extension, source] of [['py', 'def valid(): pass\n'], ['js', 'function valid() {}\n'], ['ts', 'function valid<T>() {}\n']]) {
  test(`unreadable scanned ${extension} input fails instead of becoming unsupported`, async (t) => {
    const { root, repo } = workspace(t);
    const absolute = path.join(repo, `input.${extension}`);
    fs.writeFileSync(absolute, source);
    const scanned = scanRepository(repo, { retainSource: false }).files;
    assert.equal(scanned.length, 1);
    fs.unlinkSync(absolute);
    const fake = fakePython(root, `${readBatch}\nconsole.log(JSON.stringify(records));`);
    const emitted = [];
    await assert.rejects(parseEntriesBatched(scanned, record => emitted.push(record), { pythonRuntime: fake.runtime }), error => {
      assert.equal(error.code, 'ENOENT');
      assert.equal(error.path, absolute);
      return true;
    });
    assert.deepEqual(emitted, []);
    assert.deepEqual(fake.invocations(), []);
  });
}

test('source read failure during indexing leaves the published snapshot intact and removes staging', async (t) => {
  const { repo, store } = workspace(t);
  const source = path.join(repo, 'input.ts');
  fs.writeFileSync(source, 'export function original() {}\n');
  const first = await indexRepository(repo, store, { workers: 1 });
  const repositoryStore = path.join(store, repositoryId(repo));
  const pointer = path.join(repositoryStore, 'published.json');
  const published = fs.readFileSync(pointer, 'utf8');
  const snapshots = fs.readdirSync(path.join(repositoryStore, 'snapshots'));
  fs.writeFileSync(source, 'export function changed() {}\n');
  let removed = false;
  await assert.rejects(indexRepository(repo, store, {
    workers: 1,
    onProgress({ stage }) {
      if (stage === 'scan') { fs.unlinkSync(source); removed = true; }
    },
  }), error => error.code === 'ENOENT' && error.path === source);
  assert.equal(removed, true);
  assert.equal(fs.readFileSync(pointer, 'utf8'), published);
  assert.deepEqual(fs.readdirSync(path.join(repositoryStore, 'snapshots')), snapshots);
  const index = loadIndex(store);
  try {
    assert.equal(index.manifest.snapshotId, first.manifest.snapshotId);
    assert.equal(index.getFile('input.ts').parseStatus, 'complete');
    assert.equal(index.findSymbols({ name: 'original' }).length, 1);
    assert.equal(index.findSymbols({ name: 'changed' }).length, 0);
  } finally { index.close(); }
});

test('Python below 3.14 fails the real runtime probe before parsing or creating a snapshot', async (t) => {
  const { root, repo, store } = workspace(t);
  const actualRuntime = resolvePythonRuntime();
  // Execute the production probe under real Python, with an older version tuple.
  // This tests the version assertion itself, not just a fabricated nonzero exit.
  const fake = fakePython(root, `
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== '-I' || args[1] !== '-c') throw new Error('parser must not start');
const child = spawnSync(${JSON.stringify(actualRuntime.path)}, ['-I', '-c',
  'import sys; sys.version_info = (3, 13, 9)\\n' + args[2]], { encoding: 'utf8' });
if (child.error) throw child.error;
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
process.exitCode = child.status;
`);
  fs.writeFileSync(path.join(repo, 'input.py'), 'def valid(): pass\n');
  assert.throws(() => resolvePythonRuntime(fake.runtime.path), /Python 3\.14\+ is required/);
  const progress = [];
  await assert.rejects(indexRepository(repo, store, {
    python: fake.runtime.path, workers: 1, onProgress: event => progress.push(event.stage),
  }), /Python 3\.14\+ is required/);
  assert.deepEqual(progress, []);
  assert.equal(fs.existsSync(path.join(store, repositoryId(repo))), false);
  assert.equal(fake.invocations().length, 2);
  assert.ok(fake.invocations().every(args => args[0] === '-I' && args[1] === '-c'));
});

test('generic disposeIfDisposable<T> retains its definition, body span and isDisposable call through indexing', async (t) => {
  const { repo, store } = workspace(t);
  const definition = `export function disposeIfDisposable<T>(disposables: Iterable<T>): void {
  for (const disposable of disposables) {
    if (isDisposable(disposable)) {
      disposable.dispose();
    }
  }
}`;
  const source = `export interface IDisposable { dispose(): void; }
export function isDisposable(thing: unknown): thing is IDisposable {
  return typeof (thing as IDisposable)?.dispose === 'function';
}
${definition}
`;
  fs.writeFileSync(path.join(repo, 'lifecycle.ts'), source);
  const scanned = scanRepository(repo, { retainSource: false }).files;
  const parsed = [];
  await parseEntriesBatched(scanned, record => parsed.push(record));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].status, 'complete');
  const definitions = parsed[0].symbols.filter(symbol => symbol.name === 'disposeIfDisposable');
  assert.equal(definitions.length, 1);
  const symbol = definitions[0];
  assert.equal(symbol.kind, 'function');
  assert.equal(symbol.signature, 'export function disposeIfDisposable<T>(disposables: Iterable<T>): void');
  assert.deepEqual(symbol.span, { startLine: 5, startColumn: 0, endLine: 11, endColumn: 1 });
  const calls = parsed[0].relations.filter(relation => relation.sourceKey === symbol.key && relation.type === 'calls');
  assert.deepEqual(calls.map(relation => [relation.targetName, relation.line]), [['isDisposable', 7], ['disposable.dispose', 8]]);

  const result = await indexRepository(repo, store, { workers: 1 });
  assert.equal(result.manifest.status, 'published');
  assert.equal(result.manifest.coverage.partialFiles, 0);
  const index = loadIndex(store);
  try {
    assert.equal(index.getFile('lifecycle.ts').parseStatus, 'complete');
    const stored = index.findSymbols({ name: 'disposeIfDisposable', path: 'lifecycle.ts', kinds: ['function'] });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].signature, symbol.signature);
    const { startByte, endByte } = stored[0].sourceSpan;
    assert.equal(Buffer.from(source).subarray(startByte, endByte).toString('utf8'), definition);
    const targets = index.findSymbols({ name: 'isDisposable', path: 'lifecycle.ts', kinds: ['function'] });
    assert.equal(targets.length, 1);
    const outgoing = [...index.iterStoredRelations()].filter(relation => relation.sourceId === stored[0].symbolId && relation.type === 'calls');
    const guardCalls = outgoing.filter(relation => relation.targetName === 'isDisposable');
    assert.equal(guardCalls.length, 1);
    assert.equal(guardCalls[0].status, 'resolved');
    assert.equal(guardCalls[0].targetId, targets[0].symbolId);
  } finally { index.close(); }
});
