import { Worker } from 'node:worker_threads';
import { parseEntriesBatched, parsePythonBatch, parserBatches, pythonJobContext, validateRecords } from './index.js';
import { resolvePythonRuntime } from './python-runtime.js';

class ParserWorker {
  constructor() {
    this.worker = new Worker(new URL('./parse-worker.js', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 256 } });
    this.worker.on('message', result => {
      const pending = this.pending;
      this.pending = null;
      if (!pending) return;
      if (result.error) pending.reject(new Error(result.error)); else pending.resolve(result.records);
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => this.fail(new Error(`Parser worker exited (${code})`)));
  }
  fail(error) { this.error = error; this.pending?.reject(error); this.pending = null; }
  run(entries) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(entries);
    });
  }
}

// Keep one bounded batch per worker in flight and consume in source order.
async function consumeBatches(entries, runners, consume, signal, controller) {
  const iterator = parserBatches(entries);
  while (true) {
    signal.throwIfAborted();
    const jobs = [];
    for (const run of runners) {
      const next = iterator.next();
      if (next.done) break;
      jobs.push(run(next.value).then(records => validateRecords(next.value, records)).catch(error => {
        controller.abort(error); throw error;
      }));
    }
    if (!jobs.length) break;
    const completed = await Promise.allSettled(jobs);
    const failed = completed.find(result => result.status === 'rejected');
    if (failed) throw controller.signal.reason || failed.reason;
    for (const result of completed) for (const record of result.value) consume(record);
  }
}

export async function parseEntriesParallel(entries, onResult, { workers = 1, signal, pythonRuntime } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const pool = [];
  const abort = () => {
    controller.abort(signal?.reason || new Error('Parser cancelled'));
    for (const parser of pool) { parser.fail(controller.signal.reason); void parser.worker.terminate(); }
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const consume = record => { controller.signal.throwIfAborted(); onResult(record); };
  try {
    const python = entries.filter(entry => entry.language === 'python');
    if (python.length) {
      const context = pythonJobContext(pythonRuntime || resolvePythonRuntime(), controller.signal);
      const runners = Array.from({ length: workers }, () => batch => parsePythonBatch(batch, context));
      await consumeBatches(python, runners, consume, controller.signal, controller);
    }
    const scripts = entries.filter(entry => ['javascript', 'typescript'].includes(entry.language));
    if (workers === 1 || scripts.length < 2 || scripts.reduce((sum, entry) => sum + (entry.bytes ?? Buffer.byteLength(entry.source || '')), 0) < 256 * 1024) {
      await parseEntriesBatched(scripts, consume, { signal: controller.signal });
    } else {
      for (let i = 0; i < Math.min(workers, scripts.length); i++) pool.push(new ParserWorker());
      controller.signal.addEventListener('abort', () => {
        for (const parser of pool) { parser.fail(controller.signal.reason); void parser.worker.terminate(); }
      }, { once: true });
      await consumeBatches(scripts, pool.map(parser => batch => parser.run(batch)), consume, controller.signal, controller);
    }
    await parseEntriesBatched(entries.filter(entry => !['python', 'javascript', 'typescript'].includes(entry.language)), consume, { signal: controller.signal });
  } finally {
    signal?.removeEventListener('abort', abort);
    await Promise.all(pool.map(({ worker }) => worker.terminate()));
  }
}
