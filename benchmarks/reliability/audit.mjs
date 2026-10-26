import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadIndex } from '../../src/lib/indexer.js';
import { queryIndex } from '../../src/lib/query.js';

const [store, corpus, inventoryFile] = process.argv.slice(2);
const index = loadIndex(store);
try {
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  const expected = new Map(inventory.map(file => [file.path, file]));
  let bodies = 0;
  for (const row of index.db.prepare('SELECT f.path,f.digest,s.body FROM files f JOIN source_fts s ON s.rowid=f.id ORDER BY f.path').iterate()) {
    assert.equal(row.digest, expected.get(row.path)?.digest, row.path);
    assert.equal(createHash('sha256').update(row.body).digest('hex'), row.digest, row.path);
    bodies++;
  }
  assert.equal(bodies, inventory.length);
  assert.equal(index.stats().files, inventory.length);
  const rows = [];
  let evidenceChecked = 0;
  for (const mode of ['symbol', 'content']) {
    const questions = JSON.parse(fs.readFileSync(new URL(`../heldout/questions/${corpus}${mode === 'content' ? '-content' : ''}.json`, import.meta.url), 'utf8'));
    for (const question of questions) {
      const started = performance.now();
      const metadata = queryIndex(index, question.query, { searchMode: mode, includeSource: false });
      const metadataMs = performance.now() - started;
      const result = queryIndex(index, question.query, { searchMode: mode, maxEvidence: 10 });
      for (const item of result.evidence) {
        const raw = fs.readFileSync(path.join(index.snapshotDir, 'source', item.blobDigest));
        assert.equal(createHash('sha256').update(raw).digest('hex'), item.blobDigest);
        assert.equal(raw.subarray(item.startByte, item.endByte).toString('utf8'), item.source);
        assert.equal(raw.subarray(0, item.startByte).toString('utf8').split('\n').length, item.startLine);
        if (item.match) assert.ok(item.match.startByte >= item.startByte && (item.truncated || item.match.endByte <= item.endByte));
        evidenceChecked++;
      }
      const files = [...new Set(result.candidates.map(item => item.path))].slice(0, 10);
      rows.push({ mode, query: question.query, metadataMs,
        hitAt10: question.expectedPaths.some(file => files.includes(file)),
        expectedEvidence: result.evidence.some(item => question.expectedPaths.includes(item.path) && item.startLine <= question.expectedLine && item.endLine >= question.expectedLine),
        candidates: metadata.candidates, evidence: result.evidence });
    }
  }
  const status = index.db.prepare('SELECT language,parse_status,count(*) AS files FROM files GROUP BY language,parse_status ORDER BY language,parse_status').all();
  const failures = index.db.prepare("SELECT path,parse_error FROM files WHERE parse_status='partial' ORDER BY path").all();
  console.log(JSON.stringify({ corpus, snapshotId: index.manifest.snapshotId, config: index.manifest.buildConfig,
    coverage: index.manifest.coverage, stats: index.stats(), bodyFilesVerified: bodies, evidenceChecked, status, failures, rows }, null, 2));
} finally { index.close(); }
