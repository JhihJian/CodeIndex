import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { indexRepository, loadIndex } from '../src/lib/indexer.js';
import { queryIndex } from '../src/lib/query.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-content-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  return { root, repo, store: path.join(root, 'store') };
}
const content = (index, query, options = {}) => queryIndex(index, query, { searchMode: 'content', ...options });

test('正文覆盖函数体、未支持文件和解析失败文件，证据定位实际 UTF-8 匹配', async t => {
  const { repo, store } = workspace(t);
  fs.writeFileSync(path.join(repo, 'a.py'), 'def answer():\n    value = "secret amber phrase"\n    return value\n');
  fs.writeFileSync(path.join(repo, 'notes.md'), '# Header\n' + '\n'.repeat(80) + '😀 Café "quoted"\n跨行文本 done\n');
  fs.writeFileSync(path.join(repo, 'bad.py'), 'def (: # broken syntax keeps searchable words\n');
  await indexRepository(repo, store);
  const index = loadIndex(store); t.after(() => index.close());
  for (const [query, expected] of [['secret amber phrase', 'a.py'], ['searchable words', 'bad.py'], ['cafe quoted 跨行文本', 'notes.md'], ['Café "quoted"', 'notes.md']]) {
    const result = content(index, query);
    assert.equal(result.candidates[0].path, expected);
    const evidence = result.evidence[0];
    const raw = fs.readFileSync(path.join(repo, expected));
    assert.equal(raw.subarray(evidence.startByte, evidence.endByte).toString('utf8'), evidence.source);
    assert.ok(evidence.match.endByte > evidence.match.startByte);
    assert.ok(evidence.startByte <= evidence.match.startByte && evidence.endByte >= evidence.match.endByte);
    if (expected === 'notes.md') assert.ok(evidence.startLine > 80);
  }
  assert.equal(index.getFile('bad.py').parseStatus, 'partial');
  assert.equal(content(index, 'secret amber').relations.length, 0);
  assert.equal(queryIndex(index, 'answer').candidates[0].type, 'symbol');
  assert.equal(queryIndex(index, 'secret amber phrase').candidates[0].type, 'content');
  assert.equal(queryIndex(index, 'secret amber phrase', { searchMode: 'symbol' }).candidates.some(c => c.type === 'content'), false);
  assert.deepEqual(content(index, '***').candidates, []);
  assert.throws(() => queryIndex(index, 'x', { searchMode: 'invalid' }), /searchMode/);
  const short = content(index, 'cafe quoted 跨行文本', { maxLines: 1 }).evidence[0];
  assert.equal(short.truncated, true);
  assert.equal(short.endLine, short.startLine);
  const read = fs.readFileSync;
  fs.readFileSync = () => { throw new Error('metadata must not read source'); };
  try {
    const metadata = content(index, 'secret amber', { includeSource: false });
    assert.equal(metadata.evidence.length, 0);
    assert.equal(metadata.candidates[0].path, 'a.py');
    assert.equal(metadata.candidates[0].blobDigest, index.getFile('a.py').digest);
  } finally { fs.readFileSync = read; }
});

test('正文增删改名与全量一致，旧读者仍看到旧正文', async t => {
  const { root, repo, store } = workspace(t);
  fs.writeFileSync(path.join(repo, 'old.md'), 'old exclusive phrase');
  fs.writeFileSync(path.join(repo, 'stable.md'), 'stable untouched phrase');
  fs.writeFileSync(path.join(repo, 'remove.md'), 'removed exclusive phrase');
  await indexRepository(repo, store);
  const old = loadIndex(store); t.after(() => old.close());
  fs.renameSync(path.join(repo, 'old.md'), path.join(repo, 'renamed.md'));
  fs.writeFileSync(path.join(repo, 'renamed.md'), 'new exclusive phrase');
  fs.rmSync(path.join(repo, 'remove.md'));
  await indexRepository(repo, store);
  await indexRepository(repo, path.join(root, 'full'));
  const updated = loadIndex(store), full = loadIndex(path.join(root, 'full'));
  t.after(() => { updated.close(); full.close(); });
  for (const query of ['old exclusive', 'new exclusive', 'removed exclusive', 'stable untouched']) {
    const actual = content(updated, query), expected = content(full, query);
    assert.deepEqual(actual.candidates, expected.candidates);
    assert.deepEqual(actual.evidence, expected.evidence);
  }
  assert.equal(content(old, 'old exclusive').candidates[0].path, 'old.md');
  assert.equal(content(updated, 'old exclusive').candidates.length, 0);
  assert.equal(content(updated, 'removed exclusive').candidates.length, 0);
  assert.equal(updated.db.prepare('SELECT count(*) AS n FROM source_fts').get().n, 2);
});
