import os from 'node:os';
import { spawn } from 'node:child_process';

export function workerCount(value = process.env.CODEINDEX_WORKERS ?? Math.min(4, os.availableParallelism())) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 8) throw new Error('workers must be an integer from 1 to 8');
  return count;
}

// Each native job owns a process group, including Cscope's sort subprocess.
// Cancellation resolves only after the child has closed its streams.
export function runProcess(command, args, { cwd, env, timeout, maxBuffer, signal }) {
  if (signal?.aborted) return Promise.reject(new Error('Native build cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [] };
    let bytes = 0;
    let failure;
    const stop = (error) => {
      failure ||= error;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (cause) { if (cause.code !== 'ESRCH') failure = cause; }
      }
    };
    const abort = () => stop(new Error('Native build cancelled'));
    const timer = setTimeout(() => stop(new Error(`Native build timed out after ${timeout}ms`)), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    for (const name of ['stdout', 'stderr']) child[name].on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) stop(new Error(`Native output exceeds ${maxBuffer} bytes`));
      else output[name].push(chunk);
    });
    child.on('error', (error) => { failure ||= error; });
    child.on('close', (code, killedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const result = Object.fromEntries(Object.entries(output).map(([name, chunks]) => [name, Buffer.concat(chunks).toString('utf8')]));
      if (failure || code !== 0) reject(new Error(`${command} failed: ${failure?.message || `exit ${code}, signal ${killedBy}`}\n${result.stderr}`));
      else resolve(result);
    });
  });
}
