#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadIndex } from '../src/lib/indexer.js';
import { queryIndex } from '../src/lib/query.js';

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) result[argv[i].slice(2)] = argv[++i];
  }
  return result;
}

function hit(result, question) {
  const paths = result.evidence.map((item) => item.path);
  const names = result.evidence.map((item) => item.symbol);
  return question.expectedPaths?.some((expected) => paths.some((actual) => actual === expected || actual.endsWith(expected))) || question.expectedSymbols?.some((expected) => names.some((actual) => actual === expected || actual.endsWith(`.${expected}`) || actual.includes(expected)));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

const options = args(process.argv.slice(2));
if (!options.store || !options.questions || !options.output) throw new Error('需要 --store --questions --output');
const index = loadIndex(path.resolve(options.store));
const questions = JSON.parse(fs.readFileSync(path.resolve(options.questions), 'utf8'));
const rows = [];
for (const question of questions) {
  queryIndex(index, question.query);
  const timings = [];
  let result;
  for (let i = 0; i < 7; i += 1) {
    const start = performance.now();
    result = queryIndex(index, question.query);
    timings.push(performance.now() - start);
  }
  queryIndex(index, question.query, { includeSource: false });
  const metadataTimings = [];
  for (let i = 0; i < 7; i += 1) {
    const start = performance.now();
    queryIndex(index, question.query, { includeSource: false });
    metadataTimings.push(performance.now() - start);
  }
  const metadataResult = queryIndex(index, question.query, { includeSource: false });
  const payload = Buffer.byteLength(JSON.stringify(result), 'utf8');
  rows.push({ query: question.query, hit: hit(result, question), medianMs: median(timings), metadataMedianMs: median(metadataTimings), minMs: Math.min(...timings), evidenceCount: result.evidence.length, metadataCandidateCount: metadataResult.candidates.length, resultBytes: payload, contextBytes: result.metrics.contextBytes, topCandidates: result.candidates.slice(0, 5) });
}
const report = {
  tool: 'CodeIndex', repository: index.manifest.repositoryPath, snapshotId: index.manifest.snapshotId,
  stats: { ...index.stats(), relationsScope: index.manifest.stats.relationsScope, native: index.manifest.native, parsedFiles: index.manifest.coverage.parsedFiles, sourceBytes: index.manifest.stats.sourceBytes, storeBytes: 0 },
  questions: { total: rows.length, hits: rows.filter((row) => row.hit).length, recall: rows.filter((row) => row.hit).length / rows.length },
  aggregate: { medianMs: median(rows.map((row) => row.medianMs)), metadataMedianMs: median(rows.map((row) => row.metadataMedianMs)), resultBytes: rows.reduce((sum, row) => sum + row.resultBytes, 0), medianResultBytes: median(rows.map((row) => row.resultBytes)), contextBytes: rows.reduce((sum, row) => sum + row.contextBytes, 0) }, rows,
};
function directoryBytes(directory, seen = new Set()) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full, seen);
    else {
      const stat = fs.statSync(full);
      const key = `${stat.dev}:${stat.ino}`;
      if (!seen.has(key)) { total += stat.size; seen.add(key); }
    }
  }
  return total;
}
report.stats.snapshotBytes = directoryBytes(index.snapshotDir);
report.stats.storageScope = 'logical file bytes deduplicated by inode; store includes all retained snapshots';
report.stats.storeBytes = directoryBytes(path.resolve(options.store));
fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
fs.writeFileSync(path.resolve(options.output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ stats: report.stats, questions: report.questions, aggregate: report.aggregate }, null, 2));
index.close();
