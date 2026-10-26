import assert from 'node:assert/strict';
import { loadIndex, queryIndex } from '../../src/index.js';
const [store, marker, file, state] = process.argv.slice(2);
const index = loadIndex(store);
try {
  const present = state === 'present';
  const symbols = index.findSymbols({ name: marker, path: file });
  assert.equal(symbols.length > 0, present);
  const body = queryIndex(index, 'reliability body probe token', { searchMode: 'content' });
  assert.equal(body.evidence.some(item => item.path === file), present);
  let callVerified = false;
  if (present) {
    const calls = index.getRelationsForSource(symbols[0].symbolId, ['calls']);
    assert.ok(calls.some(edge => edge.target_name === `${marker}_helper`));
    callVerified = true;
  }
  console.log(JSON.stringify({ present, symbolVerified: true, bodyVerified: true, callVerified }, null, 2));
} finally { index.close(); }
