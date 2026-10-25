#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { indexRepository, loadIndex, exportIndex } from '../src/lib/indexer.js';
import { askPi, formatQuery, queryIndex } from '../src/lib/query.js';
import { runBenchmark } from '../src/lib/benchmark.js';

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replaceAll('-', '');
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) { options[key] = next; index += 1; } else options[key] = true;
  }
  return options;
}

function usage() {
  console.log(`CodeIndex commands:
  index     --repo PATH --store PATH [--force] [--progress] [--workers 1..8]
  update    --repo PATH --store PATH [--progress] [--workers 1..8]
  inspect   --store PATH [--repo-id ID]
  query     --store PATH --query TEXT [--metadata-only] [--llm --provider NAME --model NAME]
  export    --store PATH --output PATH [--repo-id ID]
  benchmark --repo PATH --store PATH --questions FILE [--output FILE] [--force]
`);
}

function jsonOrPrint(value, asJson) {
  if (asJson) console.log(JSON.stringify(value, null, 2));
  else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

const options = parseArgs(process.argv.slice(2));
try {
  if (options.command === 'help') { usage(); process.exit(0); }
  const store = path.resolve(options.store || '.codeindex');
  if (options.command === 'index' || options.command === 'update') {
    if (!options.repo) throw new Error('index/update 需要 --repo');
    const result = await indexRepository(path.resolve(options.repo), store, { ctags: options.ctags, cscope: options.cscope, workers: options.workers, incremental: options.command === 'update' && !options.force, onProgress: options.progress ? (event) => console.error(JSON.stringify(event)) : undefined });
    jsonOrPrint({ repositoryId: result.manifest.repositoryId, snapshotId: result.manifest.snapshotId, status: result.manifest.status, stats: result.stats, store }, options.json);
  } else if (options.command === 'inspect') {
    const index = loadIndex(store, options.repoid || null, { cscope: options.cscope });
    try { jsonOrPrint({ manifest: index.manifest, counts: { ...index.stats(), nodes: index.manifest.stats.nodes } }, true); }
    finally { index.close(); }
  } else if (options.command === 'query') {
    if (!options.query) throw new Error('query 需要 --query');
    const index = loadIndex(store, options.repoid || null, { cscope: options.cscope });
    let result;
    try { result = queryIndex(index, options.query, { includeSource: !options.metadataonly }); }
    finally { index.close(); }
    if (options.llm) {
      try { result.llmAnswer = askPi(result, { provider: options.provider, model: options.model }); }
      catch (error) { result.llmError = error.message; }
    }
    jsonOrPrint(options.json ? result : (result.llmAnswer || formatQuery(result)), options.json);
  } else if (options.command === 'export') {
    if (!options.output) throw new Error('export 需要 --output');
    jsonOrPrint(exportIndex(store, options.output, { repoId: options.repoid || null }), true);
  } else if (options.command === 'benchmark') {
    if (!options.repo || !options.questions) throw new Error('benchmark 需要 --repo 和 --questions');
    const output = options.output ? path.resolve(options.output) : null;
    const report = await runBenchmark({ repoRoot: path.resolve(options.repo), storeRoot: store, questionFile: path.resolve(options.questions), outputFile: output, forceIndex: Boolean(options.force) });
    jsonOrPrint({ output, repository: report.repository, snapshotId: report.snapshotId, index: report.index, questions: report.questions, aggregate: report.aggregate, gate: report.gate }, true);
    if (!report.gate.recallAtEvidence || !report.gate.significantAdvantage) process.exitCode = 2;
  } else {
    usage(); process.exitCode = 1;
  }
} catch (error) {
  console.error(`CodeIndex error: ${error.message}`);
  if (options.debug) console.error(error.stack);
  process.exitCode = 1;
}
