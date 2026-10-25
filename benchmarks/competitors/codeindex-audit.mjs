import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadIndex, queryIndex } from '../../src/index.js';
import { hashBytes } from '../../src/lib/hash.js';
const [store, inventoryFile, questionFile] = process.argv.slice(2);
const inventory = new Map(JSON.parse(fs.readFileSync(inventoryFile, 'utf8')).map((item) => [item.path, item.digest]));
const index = loadIndex(store);
try {
  const found = new Set();
  const digestMismatches = [];
  for (const file of index.db.prepare('SELECT path,digest FROM files').iterate()) {
    found.add(file.path);
    if (inventory.get(file.path) !== file.digest) digestMismatches.push(file.path);
  }
  let evidenceChecked = 0;
  for (const question of JSON.parse(fs.readFileSync(questionFile, 'utf8'))) {
    for (const evidence of queryIndex(index, question.query, { maxEvidence: 10 }).evidence) {
      const source = fs.readFileSync(path.join(index.snapshotDir, 'source', evidence.blobDigest));
      assert.equal(hashBytes(source), evidence.blobDigest);
      assert.equal(evidence.snapshotId, index.manifest.snapshotId);
      assert.equal(inventory.get(evidence.path), evidence.blobDigest);
      assert.equal(source.subarray(evidence.startByte, evidence.endByte).toString('utf8'), evidence.source);
      evidenceChecked++;
    }
  }
  console.log(JSON.stringify({ inputFiles: inventory.size, indexedInputFiles: [...inventory.keys()].filter((name) => found.has(name)).length,
    missingFiles: [...inventory.keys()].filter((name) => !found.has(name)), digestMismatches, evidenceChecked,
    checks: ['snapshot identity', 'blob sha256', 'inventory digest', 'UTF-8 byte slice equals returned source'], coverage: index.manifest.coverage }, null, 2));
} finally { index.close(); }
