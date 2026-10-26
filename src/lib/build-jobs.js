import os from 'node:os';
import { spawn } from 'node:child_process';

export function workerCount(value = process.env.CODEINDEX_WORKERS ?? Math.min(4, os.availableParallelism())) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 8) throw new Error('workers must be an integer from 1 to 8');
  return count;
}

export class ProcessError extends Error {
  constructor(command, kind, message, details = {}) {
    super(`${command} failed: ${message}`, details.cause ? { cause: details.cause } : undefined);
    this.name = 'ProcessError';
    this.kind = kind;
    Object.assign(this, details);
  }
}

// Cancellation joins the process group before callers can remove staging data.
export function runProcess(command, args, {
  cwd, env = process.env, timeout = 180000, maxBuffer = 32 * 1024 * 1024, signal, input,
} = {}) {
  if (signal?.aborted) return Promise.reject(new ProcessError(command, 'aborted', 'Build cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [] };
    let bytes = 0;
    let failure;
    const stop = (error) => {
      failure ||= error;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (cause) { if (cause.code !== 'ESRCH') failure = new ProcessError(command, 'kill', cause.message, { cause }); }
      }
    };
    const abort = () => stop(new ProcessError(command, 'aborted', 'Build cancelled'));
    const timer = setTimeout(() => stop(new ProcessError(command, 'timeout', `Build timed out after ${timeout}ms`)), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const name of ['stdout', 'stderr']) child[name].on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) stop(new ProcessError(command, 'output-limit', `Process output exceeds ${maxBuffer} bytes`));
      else output[name].push(chunk);
    });
    child.on('error', (cause) => { failure ||= new ProcessError(command, 'spawn', cause.message, { cause, code: cause.code }); });
    if (input !== undefined) {
      child.stdin.on('error', (cause) => {
        // An early failed exit also closes stdin; preserve its actual exit/signal.
        if (cause.code !== 'EPIPE') stop(new ProcessError(command, 'stdin', cause.message, { cause }));
      });
      child.stdin.end(input);
    }
    child.on('close', (exitCode, killedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const result = Object.fromEntries(Object.entries(output).map(([name, chunks]) => [name, Buffer.concat(chunks).toString('utf8')]));
      if (failure || exitCode !== 0) {
        const error = failure || new ProcessError(command, 'exit', `exit ${exitCode}, signal ${killedBy}\n${result.stderr}`);
        Object.assign(error, result, { exitCode, signal: killedBy });
        reject(error);
      } else resolve(result);
    });
  });
}
