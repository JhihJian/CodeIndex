import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { COMPACT_SCHEMA_VERSION, createCompactStore, openCompactStore } from '../src/lib/compact-store.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-compact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fileRecord(filePath, source, language = 'c') {
  const bytes = Buffer.from(source);
  const offsets = [0];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) offsets.push(i + 1);
  offsets.push(bytes.length);
  const lineOffsets = Buffer.alloc(offsets.length * 4);
  offsets.forEach((offset, i) => lineOffsets.writeUInt32LE(offset, i * 4));
  return { path: filePath, body: source, language, bytes: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
    lineCount: offsets.length - 1, lineOffsets };
}

function finish(builder) {
  builder.finalize();
  builder.close();
}

function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('UTF-8 行偏移提供 metadata evidence，精确 parser span 可覆盖默认值', (t) => {
  const root = fixture(t);
  const builder = createCompactStore(root);
  const source = '// 中文注释\nint café() {\n  return 1;\n}\n';
  const file = fileRecord('src/café.c', source);
  builder.begin();
  const fileId = builder.insertFile(file);
  builder.insertSymbol({ fileId, kind: 'module', name: 'café.c', startLine: 1, endLine: 5 });
  const internalId = builder.insertSymbol({ fileId, kind: 'function', name: 'café', startLine: 2, endLine: 4 });
  const startByte = Buffer.byteLength('// 中文注释\nint ');
  const endByte = startByte + Buffer.byteLength('café');
  builder.insertSymbol({ fileId, kind: 'identifier', name: 'precise',
    sourceSpan: { startLine: 2, endLine: 2, startColumn: 4, endColumn: 8, startByte, endByte } });
  builder.commit();
  assert.deepEqual(builder.counts(), { files: 1, symbols: 3, relations: 0 });
  finish(builder);
  const index = openCompactStore(root, { snapshotId: 'snapshot-utf8' });
  t.after(() => index.close());
  assert.equal(index.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, COMPACT_SCHEMA_VERSION);
  assert.equal(fs.existsSync(path.join(root, 'source')), false);
  const symbol = index.getSymbol(internalId);
  assert.equal(symbol.name, 'café');
  assert.equal(symbol.sourceSpan.startByte, Buffer.byteLength('// 中文注释\n'));
  assert.equal(Buffer.from(source).subarray(symbol.sourceSpan.startByte, symbol.sourceSpan.endByte).toString(), 'int café() {\n  return 1;\n}');
  assert.equal(symbol.sourceSpan.snapshotId, 'snapshot-utf8');
  assert.equal(symbol.sourceSpan.blobDigest, file.digest);
  assert.equal(index.getSymbol(symbol.symbolId).symbolId, symbol.symbolId);
  assert.equal(index.getInternalSymbol(symbol.symbolId).id, internalId);
  assert.equal(index.getSymbol(symbol.parentId).kind, 'module');
  const precise = index.findSymbols({ name: 'precise', path: file.path })[0];
  assert.deepEqual(precise.sourceSpan, { path: file.path, startLine: 2, endLine: 2,
    startColumn: 4, endColumn: 8, startByte, endByte, blobDigest: file.digest, snapshotId: 'snapshot-utf8' });
  assert.equal(Buffer.from(source).subarray(startByte, endByte).toString(), 'café');
  assert.equal(index.getFile(file.path).lineCount, 5);
  assert.equal(index.getFiles([symbol.fileId])[0].digest, file.digest);
  assert.equal(index.searchNodes('café', 10).some((row) => row.node_id === symbol.symbolId), true);
  assert.deepEqual(index.searchNodes('"()[]', 10), []);
  assert.equal(index.getNavigation(symbol.fileId).summary, 'c, 5 lines, 3 symbols');
  assert.equal(index.getNavigation(symbol.symbolId).sourceSpan.startByte, symbol.sourceSpan.startByte);
  assert.equal(index.getSymbol('symbol:garbage'), null);
  assert.equal(index.getFile('absent'), null);
});

test('增量 clone 不污染旧 DB，删除维护 FTS，完整与增量构建 ID 一致', (t) => {
  const root = fixture(t);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const clean = path.join(root, 'clean');
  const initial = createCompactStore(first);
  initial.begin();
  const changing = initial.insertFile(fileRecord('change.c', 'int obsolete();\n'));
  initial.insertSymbol({ fileId: changing, kind: 'function', name: 'obsolete', startLine: 1 });
  const stable = initial.insertFile(fileRecord('stable.c', 'int caller();\n'));
  const callerId = initial.insertSymbol({ fileId: stable, kind: 'function', name: 'caller', startLine: 1 });
  initial.insertRelation({ fileId: stable, sourceId: callerId, type: 'calls', targetName: 'obsolete', startLine: 1 });
  initial.insertRelation({ fileId: changing, sourceId: 1, type: 'calls', targetName: 'caller', startLine: 1 });
  initial.commit();
  finish(initial);
  const database = path.join(first, 'index.db');
  const originalHash = fileHash(database);
  const oldIndex = openCompactStore(first, { snapshotId: 'old' });
  t.after(() => oldIndex.close());
  const oldCaller = oldIndex.getSymbol(callerId);
  const oldSymbol = oldIndex.findSymbols({ name: 'obsolete' })[0];
  const update = createCompactStore(second, { previousDatabase: database });
  assert.notEqual(fs.statSync(database).ino, fs.statSync(update.databasePath).ino);
  update.begin();
  assert.equal(update.deleteFile('change.c'), 1);
  const changed = update.insertFile(fileRecord('change.c', 'int obsolete();\nint fresh();\n'));
  const recreatedId = update.insertSymbol({ fileId: changed, kind: 'function', name: 'obsolete', startLine: 1 });
  update.insertSymbol({ fileId: changed, kind: 'function', name: 'fresh', startLine: 2 });
  update.commit();
  finish(update);
  assert.equal(fileHash(database), originalHash);
  const current = openCompactStore(second, { snapshotId: 'new' });
  t.after(() => current.close());
  assert.notEqual(recreatedId, oldSymbol.internalId);
  assert.equal(current.getSymbol(recreatedId).symbolId, oldSymbol.symbolId);
  assert.equal(current.getSymbol(oldCaller.symbolId).internalId, callerId);
  assert.deepEqual(current.stats(), { files: 2, symbols: 3, relations: 1 });
  assert.equal(current.getRawRelationsForTargetLeaf('obsolete', ['calls']).length, 1);
  assert.equal(current.getRawRelationsForSource(oldCaller.symbolId, ['calls'])[0].source_id, oldCaller.symbolId);
  assert.equal(current.getRawRelationsForSource(callerId, ['calls'])[0].source_internal_id, callerId);
  assert.equal(current.getRawRelationsForSource(callerId, []).length, 0);
  assert.equal(oldIndex.searchNodes('fresh').length, 0);
  assert.equal(oldIndex.getFile('change.c').bytes, Buffer.byteLength('int obsolete();\n'));
  assert.equal(current.searchNodes('fresh').length, 1);

  const full = createCompactStore(clean);
  full.begin();
  const newStable = full.insertFile(fileRecord('stable.c', 'int caller();\n'));
  full.insertSymbol({ fileId: newStable, kind: 'function', name: 'caller', startLine: 1 });
  const newChanging = full.insertFile(fileRecord('change.c', 'int obsolete();\nint fresh();\n'));
  full.insertSymbol({ fileId: newChanging, kind: 'function', name: 'obsolete', startLine: 1 });
  full.insertSymbol({ fileId: newChanging, kind: 'function', name: 'fresh', startLine: 2 });
  finish(full);
  const rebuilt = openCompactStore(clean, {});
  t.after(() => rebuilt.close());
  assert.deepEqual([...current.iterSymbols()].map((s) => s.symbolId).sort(), [...rebuilt.iterSymbols()].map((s) => s.symbolId).sort());

  const deletion = createCompactStore(path.join(root, 'deleted'), { previousDatabase: database });
  deletion.begin();
  deletion.deleteFile('change.c');
  deletion.commit();
  // External-content FTS integrity-check also catches stale postings hidden by JOINs.
  deletion.db.exec("INSERT INTO search_fts(search_fts,rank) VALUES('integrity-check',1); INSERT INTO files_fts(files_fts,rank) VALUES('integrity-check',1)");
  assert.equal(deletion.db.prepare("SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH 'obsolete'").get().n, 0);
  assert.equal(deletion.db.prepare("SELECT count(*) AS n FROM files_fts WHERE files_fts MATCH 'change'").get().n, 0);
  finish(deletion);
  assert.equal(fileHash(database), originalHash);
});

test('FTS update triggers 更新名称、scope、signature、doc 和文件路径', (t) => {
  const root = fixture(t);
  const first = path.join(root, 'first');
  const builder = createCompactStore(first);
  const fileId = builder.insertFile(fileRecord('before.c', 'void old();'));
  builder.insertSymbol({ fileId, kind: 'function', name: 'old', startLine: 1, doc: 'oldword' });
  finish(builder);
  const second = path.join(root, 'second');
  const update = createCompactStore(second, { previousDatabase: path.join(first, 'index.db') });
  update.begin();
  update.db.prepare('UPDATE symbols SET name=?,scope=?,signature=?,doc=? WHERE file_id=?').run('new', 'namespace', 'signatureword', 'newword', fileId);
  update.db.prepare('UPDATE files SET path=? WHERE id=?').run('after.c', fileId);
  update.commit();
  update.db.exec("INSERT INTO search_fts(search_fts,rank) VALUES('integrity-check',1); INSERT INTO files_fts(files_fts,rank) VALUES('integrity-check',1)");
  finish(update);
  const index = openCompactStore(second);
  t.after(() => index.close());
  assert.equal(index.searchNodes('oldword').length, 0);
  assert.equal(index.searchNodes('before').length, 0);
  for (const query of ['namespace', 'signatureword', 'newword', 'after']) assert.equal(index.searchNodes(query).length, 1);
});

test('同文件 scope 和 enclosing range 找 parent，不把同名歧义声明为唯一', (t) => {
  const root = fixture(t);
  const builder = createCompactStore(root);
  builder.begin();
  const fileId = builder.insertFile(fileRecord('src/a.cc', '\n'.repeat(20), 'cpp'));
  const module = builder.insertSymbol({ fileId, kind: 'module', name: 'a.cc', startLine: 1, endLine: 21 });
  const outer = builder.insertSymbol({ fileId, kind: 'class', name: 'Outer', startLine: 1, endLine: 10 });
  const inner = builder.insertSymbol({ fileId, kind: 'class', name: 'Inner', scope: 'Outer', startLine: 2, endLine: 8 });
  const method = builder.insertSymbol({ fileId, kind: 'function', name: 'run', scope: 'Outer::Inner', startLine: 3, endLine: 5 });
  builder.insertSymbol({ fileId, kind: 'class', name: 'Inner', scope: 'Elsewhere', startLine: 2, endLine: 8 });
  builder.insertSymbol({ fileId, kind: 'class', name: 'Inner', scope: 'Outer', startLine: 12, endLine: 18 });
  const secondFile = builder.insertFile(fileRecord('src/nested/b.cc', '\n'.repeat(20), 'cpp'));
  builder.insertSymbol({ fileId: secondFile, kind: 'class', name: 'Inner', scope: 'Outer', startLine: 2, endLine: 8 });
  const ambiguous = builder.insertSymbol({ fileId, kind: 'function', name: 'ambiguous', scope: 'Dup', startLine: 13 });
  builder.insertSymbol({ fileId, kind: 'class', name: 'Dup', startLine: 12, endLine: 16 });
  builder.insertSymbol({ fileId, kind: 'class', name: 'Dup', startLine: 11, endLine: 17 });
  builder.commit();
  finish(builder);
  const index = openCompactStore(root, { repositoryId: 'repo' });
  t.after(() => index.close());
  assert.equal(index.getSymbol(method).parentId, index.getSymbol(inner).symbolId);
  assert.equal(index.getSymbol(inner).parentId, index.getSymbol(outer).symbolId);
  assert.equal(index.getSymbol(ambiguous).parentId, index.getSymbol(module).symbolId);
  assert.deepEqual(index.findSymbols({ name: 'run', path: 'src/a.cc', scope: 'Outer::Inner', kinds: ['function'], line: 4 }).map((s) => s.internalId), [method]);
  assert.equal(index.findSymbols({ name: 'run', path: 'src/a.cc', line: 6 }).length, 0);
  const plans = index.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM symbols WHERE file_id=? AND name=? AND start_line<=? AND end_line>=?').all(fileId, 'Inner', 3, 5);
  assert.ok(plans.some((row) => row.detail.includes('symbols_by_file_name')));
  const nodes = [...index.iterContainment()];
  assert.equal(nodes.length, 1 + 2 + 2 + index.stats().symbols);
  assert.equal(new Set(nodes.map((n) => n.nodeId)).size, nodes.length);
  for (const node of nodes.filter((n) => n.nodeType === 'directory')) {
    assert.equal(index.getNavigation(node.nodeId).path, node.path);
  }
  assert.equal([...index.iterFiles()].length, 2);
  assert.equal([...index.iterRelations()].length, 0);
  const tables = index.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  assert.equal(tables.includes('navigation'), false);
  assert.equal(tables.includes('containment'), false);
});

test('拒绝未 finalize 的快照及错误行偏移', (t) => {
  const root = fixture(t);
  const builder = createCompactStore(root);
  const record = fileRecord('bad.c', 'x');
  assert.throws(() => builder.insertFile({ ...record, lineOffsets: [0, 2] }), /行偏移/);
  builder.close();
  assert.throws(() => openCompactStore(root), /finalize/);
  assert.throws(() => createCompactStore(root), /已存在/);
  assert.equal(openCompactStore(path.join(root, 'missing')), null);
});
