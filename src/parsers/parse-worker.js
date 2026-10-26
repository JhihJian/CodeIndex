import { parentPort } from 'node:worker_threads';
import { parseEntriesBatched } from './index.js';

parentPort.on('message', async (entries) => {
  try {
    const records = [];
    await parseEntriesBatched(entries, (record) => records.push(record));
    parentPort.postMessage({ records });
  } catch (error) {
    parentPort.postMessage({ error: error.stack || error.message });
  }
});
