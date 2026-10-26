import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { indexRepository, loadIndex } from '../src/lib/indexer.js';
import { queryIndex } from '../src/lib/query.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-coordinates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  return { repo, store: path.join(root, 'store') };
}
for (const separator of ['\r', '\u2028', '\u2029', '\r\n']) {
  test(`JS AST preserves original byte coordinates with separator ${JSON.stringify(separator)}`, async t => {
    const { repo, store } = fixture(t);
    const source = `const x = '😀';${separator}function target() { return x; }${separator}function caller() { return target(); }`;
    fs.writeFileSync(path.join(repo, 'a.ts'), source);
    await indexRepository(repo, store);
    const index = loadIndex(store); t.after(() => index.close());
    const result = queryIndex(index, 'target', { searchMode: 'symbol' });
    assert.equal(result.evidence[0].source, 'function target() { return x; }');
    assert.equal(result.evidence[0].startByte, Buffer.byteLength(source.slice(0, source.indexOf('function target'))));
    assert.equal(result.evidence[0].startLine, source.slice(0, source.indexOf('function target')).split('\n').length);
  });
}
test('Python universal newlines map back to original LF evidence lines', async t => {
  const { repo, store } = fixture(t);
  const source = 'x = "😀"\rdef target():\r    return x\rdef caller():\r    return target()\r';
  fs.writeFileSync(path.join(repo, 'a.py'), source);
  await indexRepository(repo, store);
  const index = loadIndex(store); t.after(() => index.close());
  const result = queryIndex(index, 'target', { searchMode: 'symbol' });
  assert.equal(result.evidence[0].source, 'def target():\r    return x');
  assert.equal(result.evidence[0].startLine, 1);
  assert.equal(result.evidence[0].startByte, Buffer.byteLength('x = "😀"\r'));
  const caller = index.findSymbols({ name: 'caller' })[0];
  assert.equal(index.getRelationsForSource(caller.symbolId, ['calls'])[0].start_line, 1);
});
test('removing the last Python input does not require the former runtime', async t => {
  const { repo, store } = fixture(t);
  fs.writeFileSync(path.join(repo, 'a.py'), 'def old(): pass');
  fs.writeFileSync(path.join(repo, 'b.ts'), 'function current() {}');
  await indexRepository(repo, store);
  fs.rmSync(path.join(repo, 'a.py'));
  const built = await indexRepository(repo, store, { python: '/nonexistent/python3.14' });
  assert.equal(built.manifest.buildConfig.python, null);
  const index = loadIndex(store); t.after(() => index.close());
  assert.equal(index.getFile('a.py'), null);
  assert.equal(index.findSymbols({ name: 'current' }).length, 1);
});
