import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { indexRepository, loadIndex } from './indexer.js';
import { queryIndex } from './query.js';
import { readJson, writeJsonAtomic } from './fs.js';

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function baseline(repoRoot, query, files) {
  const terms = query.split(/[^\p{L}\p{N}_$]+/u).filter((term) => term.length > 2).slice(0, 6);
  const pattern = terms.join('|') || query;
  const started = performance.now();
  const result = spawnSync('rg', ['-n', '-i', '--no-heading', '--color', 'never', '--glob', '!node_modules', '--glob', '!.git', pattern, repoRoot], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const elapsedMs = performance.now() - started;
  const lines = (result.stdout || '').split('\n').filter(Boolean);
  const matchedPaths = new Set(lines.map((line) => line.split(':', 1)[0].replace(`${repoRoot}/`, '')));
  const matchedBytes = files.filter((file) => matchedPaths.has(file.path)).reduce((sum, file) => sum + file.bytes, 0);
  return { elapsedMs, matchCount: lines.length, matchedPaths: [...matchedPaths].slice(0, 20), matchedBytes, outputBytes: Buffer.byteLength(result.stdout || '', 'utf8') };
}

function expectedHit(result, question) {
  const paths = result.evidence.map((item) => item.path);
  const names = result.evidence.map((item) => item.symbol);
  return (question.expectedPaths || []).some((expected) => paths.some((actual) => actual === expected || actual.includes(expected))) || (question.expectedSymbols || []).some((expected) => names.some((actual) => actual === expected || actual.endsWith(`.${expected}`) || actual.includes(expected)));
}

export function runBenchmark({ repoRoot, storeRoot, questionFile, outputFile, forceIndex = false }) {
  const questions = readJson(questionFile, []);
  if (!questions.length) throw new Error(`问题集为空: ${questionFile}`);
  let index;
  const startedIndex = performance.now();
  try { index = forceIndex ? null : loadIndex(storeRoot); } catch { index = null; }
  let indexResult = null;
  if (!index || index.manifest.repositoryPath !== fs.realpathSync(repoRoot)) {
    index?.close();
    indexResult = indexRepository(repoRoot, storeRoot, { incremental: !forceIndex });
    index = loadIndex(storeRoot);
  }
  try {
    const files = [...index.iterFiles()];
    const indexMs = performance.now() - startedIndex;
    const totalSourceBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const rows = [];
    for (const question of questions) {
      const started = performance.now();
      const result = queryIndex(index, question.query);
      const codeIndexMs = performance.now() - started;
      const base = baseline(repoRoot, question.query, files);
      rows.push({ query: question.query, hit: expectedHit(result, question), codeIndexMs, baselineMs: base.elapsedMs, candidateCount: result.candidates.length, evidenceCount: result.evidence.length, contextBytes: result.metrics.contextBytes, baselineMatchedBytes: base.matchedBytes, baselineOutputBytes: base.outputBytes, matches: base.matchCount, topCandidates: result.candidates.slice(0, 5), snapshotId: result.snapshotId });
    }
    const hits = rows.filter((row) => row.hit).length;
    const codeBytes = rows.reduce((sum, row) => sum + row.contextBytes, 0);
    const baselineBytes = rows.reduce((sum, row) => sum + row.baselineMatchedBytes, 0);
    const report = {
      schema: 'codeindex-benchmark-0.1.0', generatedAt: new Date().toISOString(), repository: fs.realpathSync(repoRoot), snapshotId: index.manifest.snapshotId,
      index: { ...(indexResult?.stats || index.manifest.stats), totalSourceBytes, indexLoadOrBuildMs: indexMs },
      questions: { file: questionFile, total: rows.length, hits, recallAtEvidence: hits / rows.length },
      aggregate: {
        codeIndexMedianMs: percentile(rows.map((row) => row.codeIndexMs), 0.5), baselineMedianMs: percentile(rows.map((row) => row.baselineMs), 0.5),
        codeIndexContextBytes: codeBytes, baselineMatchedBytes: baselineBytes, fullRepositoryBytes: totalSourceBytes * rows.length,
        contextReductionVsFullRepository: codeBytes ? (totalSourceBytes * rows.length) / codeBytes : null,
        contextReductionVsMatchedFiles: codeBytes ? baselineBytes / codeBytes : null,
        queryWorkReductionVsFullRepository: totalSourceBytes ? (totalSourceBytes * rows.length) / codeBytes : null,
        queryLatencySpeedupVsRg: percentile(rows.map((row) => row.baselineMs), 0.5) / Math.max(0.001, percentile(rows.map((row) => row.codeIndexMs), 0.5)),
      },
      gate: {
        recallAtEvidence: hits / rows.length >= 0.75,
        contextReductionVsFullRepository: codeBytes > 0 && (totalSourceBytes * rows.length) / codeBytes >= 3,
        queryLatencyWithinBaseline: percentile(rows.map((row) => row.codeIndexMs), 0.5) <= percentile(rows.map((row) => row.baselineMs), 0.5) * 1.5,
        significantAdvantage: codeBytes > 0 && (totalSourceBytes * rows.length) / codeBytes >= 3 && percentile(rows.map((row) => row.codeIndexMs), 0.5) <= percentile(rows.map((row) => row.baselineMs), 0.5) * 1.5
      },
      rows,
    };
    if (outputFile) writeJsonAtomic(outputFile, report);
    return report;
  } finally { index.close(); }
}
