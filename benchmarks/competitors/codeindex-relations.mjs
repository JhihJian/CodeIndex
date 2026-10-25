import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { loadIndex } from '../../src/index.js';
const [store, corpus, caseFile] = process.argv.slice(2);
const index = loadIndex(store);
try {
  const rows = JSON.parse(fs.readFileSync(caseFile, 'utf8'))[corpus].map((test) => {
    const source = index.findSymbols({ name: test.caller, path: test.path, kinds: ['function', 'async_function', 'method'], limit: 10 })[0];
    if (!source) return { ...test, hit: false, reason: 'caller definition missing' };
    const begin = performance.now();
    const relations = index.getRelationsForSource(source.symbolId, ['calls']);
    const elapsedMs = performance.now() - begin;
    const matching = relations.filter((edge) => edge.target_name?.split(/::|\./).at(-1) === test.callee);
    return { ...test, hit: matching.length > 0, elapsedMs, totalCalls: relations.length, matches: matching };
  });
  console.log(JSON.stringify({ tool: 'CodeIndex', corpus, rows }, null, 2));
} finally { index.close(); }
