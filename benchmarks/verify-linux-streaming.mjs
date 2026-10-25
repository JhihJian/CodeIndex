// Linux snapshot verification. Add --update to measure a reversible single-file update.
// node --max-old-space-size=2048 benchmarks/verify-linux-streaming.mjs STORE [--update]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { indexRepository, loadIndex } from '../src/lib/indexer.js';
import { queryIndex } from '../src/lib/query.js';
import { hashBytes } from '../src/lib/hash.js';
import { writeJsonAtomic } from '../src/lib/fs.js';

const store = path.resolve(process.argv[2]);
const questions = JSON.parse(fs.readFileSync(new URL('./questions-linux-c.json', import.meta.url), 'utf8'));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function verify() {
  const index = loadIndex(store);
  const rows = [];
  try {
    for (const question of questions) {
      const readFileSync = fs.readFileSync;
      let metadata;
      fs.readFileSync = (file, ...args) => {
        assert.ok(!String(file).endsWith('.jsonl'), 'query must not load JSONL');
        assert.ok(!String(file).includes(`${path.sep}source${path.sep}`), 'metadata query must not read source');
        return readFileSync(file, ...args);
      };
      try { metadata = queryIndex(index, question.query, { includeSource: false }); }
      finally { fs.readFileSync = readFileSync; }
      assert.equal(metadata.evidence.length, 0);
      const result = queryIndex(index, question.query);
      const expected = result.evidence.find((item) => question.expectedPaths.includes(item.path) && item.symbol.endsWith(question.query));
      assert.ok(expected, `missing evidence: ${question.query}`);
      for (const item of result.evidence) {
        const source = fs.readFileSync(path.join(index.snapshotDir, 'source', item.blobDigest));
        const symbol = index.getSymbol(item.symbolId);
        assert.equal(hashBytes(source), item.blobDigest);
        assert.equal(item.snapshotId, index.manifest.snapshotId);
        assert.equal(symbol.sourceSpan.blobDigest, item.blobDigest);
        assert.equal(item.source, source.toString('utf8').split('\n').slice(item.startLine - 1, item.endLine).join('\n'));
        assert.ok(item.startByte >= 0 && item.endByte >= item.startByte && item.endByte <= source.length);
      }
      const timings = [];
      let relations;
      for (let i = 0; i < 21; i++) {
        const start = performance.now();
        relations = index.getRelationsForSource(expected.symbolId, ['calls']);
        if (i) timings.push(performance.now() - start);
      }
      assert.ok(relations.length, `missing calls: ${question.query}`);
      const source = fs.readFileSync(path.join(index.snapshotDir, 'source', expected.blobDigest));
      for (const relation of relations) {
        assert.equal(relation.source_id, expected.symbolId);
        assert.equal(relation.blob_digest, expected.blobDigest);
        assert.ok(relation.start_byte >= 0 && relation.end_byte >= relation.start_byte && relation.end_byte <= source.length);
      }
      const targetIds = [...new Set(relations.map((relation) => relation.target_id).filter(Boolean))];
      assert.equal(index.getSymbols(targetIds).length, targetIds.length);
      rows.push({ query: question.query, path: expected.path, evidenceCount: result.evidence.length, calls: relations.length, resolvedCalls: relations.filter((relation) => relation.status === 'resolved').length, relationMedianMs: median(timings) });
    }
    return { snapshotId: index.manifest.snapshotId, coverage: index.manifest.coverage, rows };
  } finally { index.close(); }
}

const before = verify();
const report = { before };
if (process.argv.includes('--update')) {
  const index = loadIndex(store);
  const repo = index.manifest.repositoryPath;
  const pointerPath = path.join(store, index.repoId, 'published.json');
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  const expectedDigest = index.db.prepare("SELECT digest FROM files WHERE path = 'fs/open.c'").get().digest;
  index.close();
  const file = path.join(repo, 'fs/open.c');
  const original = fs.readFileSync(file);
  assert.equal(hashBytes(original), expectedDigest, 'benchmark input must match the indexed snapshot');
  // Keep a recovery copy outside the repository so it cannot enter the next scan.
  const backupPath = path.join(store, 'incremental-open.c.backup');
  fs.writeFileSync(backupPath, original, { flag: 'wx' });
  try {
    fs.appendFileSync(file, '\n/* CodeIndex streaming incremental benchmark. */\n');
    const result = await indexRepository(repo, store, { onProgress: (event) => console.error(JSON.stringify(event)) });
    assert.equal(result.stats.changedFiles, 1);
    assert.equal(result.stats.reusedFiles, result.stats.files - 1);
    assert.notEqual(result.manifest.snapshotId, before.snapshotId);
    report.update = result.stats;
    report.after = verify();
  } finally {
    fs.writeFileSync(file, original);
    writeJsonAtomic(pointerPath, pointer);
    assert.equal(hashBytes(fs.readFileSync(file)), hashBytes(original));
    fs.unlinkSync(backupPath);
  }
  report.restoredSnapshotId = loadRestoredSnapshot();
}
function loadRestoredSnapshot() {
  const restored = loadIndex(store);
  try {
    assert.equal(restored.manifest.snapshotId, before.snapshotId);
    return restored.manifest.snapshotId;
  } finally { restored.close(); }
}
console.log(JSON.stringify(report, null, 2));
