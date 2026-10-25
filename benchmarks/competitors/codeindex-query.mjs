import fs from 'node:fs';
import { loadIndex, queryIndex } from '../../src/index.js';

const [store, questionFile] = process.argv.slice(2);
if (!store || !questionFile) throw new Error('usage: node codeindex-query.mjs STORE QUESTIONS');
const questions = JSON.parse(fs.readFileSync(questionFile, 'utf8'));
const started = performance.now();
const index = loadIndex(store);
const loadMs = performance.now() - started;
const rows = [];
try {
  for (const question of questions) {
    const timings = [];
    let result, coldMs;
    for (let n = 0; n < 21; n++) {
      const begin = performance.now();
      result = queryIndex(index, question.query, { includeSource: false });
      const elapsed = performance.now() - begin;
      if (!n) coldMs = elapsed;
      else timings.push(elapsed);
    }
    timings.sort((a, b) => a - b);
    const evidenceBegin = performance.now();
    const evidence = queryIndex(index, question.query, { maxEvidence: 10 });
    const evidenceMs = performance.now() - evidenceBegin;
    const files = [];
    const seen = new Set();
    for (const candidate of result.candidates) {
      if (seen.has(candidate.path)) continue;
      seen.add(candidate.path);
      files.push({ path: candidate.path, symbol: candidate.name, lines: evidence.evidence
        .filter((item) => item.path === candidate.path)
        .slice(0, 3).map((item) => ({ line: item.startLine, source: item.source.split('\n').slice(0, 3).join('\n'), digest: item.blobDigest })) });
      if (files.length === 10) break;
    }
    rows.push({ query: question.query, hitAt10: files.some((file) => question.expectedPaths?.includes(file.path)),
      coldMs, medianMs: (timings[9] + timings[10]) / 2, evidenceMs, files });
  }
  console.log(JSON.stringify({ tool: 'CodeIndex', loadMs, mode: 'metadata', warmup: 1, repetitions: 20,
    rows, snapshotId: index.manifest.snapshotId, snapshotDir: index.snapshotDir,
    counts: index.manifest.stats, coverage: index.manifest.coverage }, null, 2));
} finally { index.close(); }
