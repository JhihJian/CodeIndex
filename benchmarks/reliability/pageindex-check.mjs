import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadIndex, queryIndex } from '../../src/index.js';
const [store, inventoryFile] = process.argv.slice(2);
const index = loadIndex(store);
try {
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  const expected = new Map(inventory.map(file => [file.path, file.digest]));
  let bodies = 0, evidence = 0;
  for (const row of index.db.prepare('SELECT f.path,f.digest,s.body FROM files f JOIN source_fts s ON s.rowid=f.id').iterate()) {
    assert.equal(row.digest, expected.get(row.path));
    assert.equal(createHash('sha256').update(row.body).digest('hex'), row.digest); bodies++;
  }
  assert.equal(bodies, inventory.length);
  const questions = JSON.parse(fs.readFileSync(new URL('../questions-identifiers-pageindex.json', import.meta.url), 'utf8'));
  questions.push({ query: 'Are you frustrated with vector database retrieval accuracy', expectedPaths: ['README.md'], mode: 'content' });
  const rows = questions.map(question => {
    const result = queryIndex(index, question.query, { searchMode: question.mode || 'symbol', maxEvidence: 10 });
    const hit = result.evidence.some(item => question.expectedPaths.includes(item.path)); assert.ok(hit, question.query);
    for (const item of result.evidence) {
      const raw = fs.readFileSync(path.join(index.snapshotDir, 'source', item.blobDigest));
      assert.equal(createHash('sha256').update(raw).digest('hex'), item.blobDigest);
      assert.equal(raw.subarray(item.startByte, item.endByte).toString('utf8'), item.source); evidence++;
    }
    return { query: question.query, hit, mode: question.mode || 'symbol' };
  });
  console.log(JSON.stringify({ bodyFilesVerified: bodies, evidenceChecked: evidence, rows, stats: index.stats() }, null, 2));
} finally { index.close(); }
