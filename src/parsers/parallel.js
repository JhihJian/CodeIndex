import { Worker } from 'node:worker_threads';
import { parseEntriesBatched } from './index.js';

class ParserWorker {
  constructor() {
    this.worker = new Worker(new URL('./parse-worker.js', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.worker.on('message', (result) => {
      const pending = this.pending;
      this.pending = null;
      if (result.error) pending.reject(new Error(result.error)); else pending.resolve(result.records);
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => this.fail(new Error(`Parser worker exited (${code})`)));
  }
  fail(error) {
    this.error = error;
    this.pending?.reject(error);
    this.pending = null;
  }
  run(entries) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(entries);
    });
  }
}

function* batches(entries) {
  let batch = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = entry.bytes ?? Buffer.byteLength(entry.source || '');
    if (batch.length && (batch.length >= 64 || bytes + size > 4 * 1024 * 1024)) {
      yield batch;
      batch = []; bytes = 0;
    }
    batch.push(entry); bytes += size;
  }
  if (batch.length) yield batch;
}

export async function parseEntriesParallel(entries, onResult, { workers = 1 } = {}) {
  const scripts = entries.filter((entry) => ['javascript', 'typescript'].includes(entry.language));
  // Avoid thread startup on small repositories and one-file updates.
  if (workers === 1 || scripts.reduce((sum, entry) => sum + (entry.bytes ?? Buffer.byteLength(entry.source || '')), 0) < 256 * 1024 || scripts.length < 2) {
    parseEntriesBatched(entries, onResult);
    return;
  }
  parseEntriesBatched(entries.filter((entry) => !['javascript', 'typescript'].includes(entry.language)), onResult);
  const pool = [];
  try {
    for (let i = 0; i < Math.min(workers, scripts.length); i++) pool.push(new ParserWorker());
    const iterator = batches(scripts);
    while (true) {
      const pending = [];
      for (const worker of pool) {
        const next = iterator.next();
        if (next.done) break;
        pending.push(worker.run(next.value));
      }
      if (!pending.length) break;
      // At most one bounded batch/result per worker, consumed in input order.
      for (const records of await Promise.all(pending)) for (const record of records) onResult(record);
    }
  } finally {
    await Promise.all(pool.map(({ worker }) => worker.terminate()));
  }
}
