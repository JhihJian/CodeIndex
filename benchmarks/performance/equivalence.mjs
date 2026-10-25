import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadIndex } from '../../src/index.js';

const [baseline, optimized, inventoryFile] = process.argv.slice(2);
const before = loadIndex(baseline);
const after = loadIndex(optimized);
const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
function records(index, file) {
  const { id } = index.db.prepare('SELECT id FROM files WHERE path=?').get(file);
  const symbols = index.db.prepare(`SELECT s.kind,s.name,s.scope,s.symbol_key,s.qualified_name,s.signature,s.doc,
    s.start_line,s.end_line,s.start_column,s.end_column,s.start_byte,s.end_byte,
    p.name AS parent_name,p.kind AS parent_kind,p.scope AS parent_scope,p.start_line AS parent_line,p.start_column AS parent_column
    FROM symbols s LEFT JOIN symbols p ON p.id=s.parent_id WHERE s.file_id=?
    ORDER BY s.kind,s.name,s.scope,s.start_line,s.start_column,s.symbol_key`).all(id);
  const relations = index.db.prepare(`SELECT r.relation_id,r.type,r.target_name,r.target_normalized,r.target_leaf,r.target_module_path,
    r.start_line,r.end_line,r.start_column,r.end_column,r.start_byte,r.end_byte,
    s.name AS source_name,s.kind AS source_kind,s.scope AS source_scope,s.start_line AS source_line,s.start_column AS source_column
    FROM relations r JOIN symbols s ON s.id=r.source_id WHERE r.file_id=?
    ORDER BY r.type,r.target_name,r.start_line,r.start_column,s.name,s.kind,s.scope,s.start_line,s.start_column`).all(id);
  return { symbols, relations };
}
function nativeHash(directory) {
  const file = path.join(directory, 'native/cscope.out');
  if (!fs.existsSync(file)) return null;
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  let first = true;
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      const start = first ? buffer.indexOf(10) + 1 : 0;
      assert.ok(!first || start > 0);
      first = false;
      hash.update(buffer.subarray(start, bytes));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
try {
  // Bound SQLite caches; per-file records avoid retaining whole-repository facts.
  for (const index of [before, after]) index.db.exec('PRAGMA cache_size=-32768; PRAGMA temp_store=FILE');
  let symbols = 0, relations = 0;
  const digest = createHash('sha256');
  const blobs = new Set();
  for (const item of inventory) {
    const old = records(before, item.path);
    const current = records(after, item.path);
    assert.deepEqual(current, old, `facts differ: ${item.path}`);
    symbols += current.symbols.length;
    relations += current.relations.length;
    digest.update(JSON.stringify([item.path, current]));
    if (!blobs.has(item.digest)) {
      const source = fs.readFileSync(path.join(after.snapshotDir, 'source', item.digest));
      assert.equal(createHash('sha256').update(source).digest('hex'), item.digest, item.path);
      blobs.add(item.digest);
    }
    const tree = fs.readFileSync(path.join(after.snapshotDir, 'tree', item.path));
    assert.equal(createHash('sha256').update(tree).digest('hex'), item.digest, item.path);
  }
  const oldNative = nativeHash(before.snapshotDir);
  const newNative = nativeHash(after.snapshotDir);
  assert.equal(newNative, oldNative, 'native cross-reference body differs');
  console.log(JSON.stringify({ files: inventory.length, symbols, relations, factsSha256: digest.digest('hex'),
    sourceBlobsChecked: blobs.size, nativeBodySha256: newNative, equivalent: true,
    scope: 'Every file: symbol fields and parent identities, stored relations and source identities, source/blob digests; entire Cscope body after the cwd header' }, null, 2));
} finally { before.close(); after.close(); }
