import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function resolvePythonRuntime(configured = process.env.CODEINDEX_PYTHON || 'python3.14') {
  const candidates = configured.includes('/') ? [path.resolve(configured)]
    : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, configured));
  const executable = candidates.find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
  if (!executable) throw new Error('Python 3.14+ is required; install python3.14 or set CODEINDEX_PYTHON');
  const runtimePath = fs.realpathSync(executable);
  const probe = `import ast,json,platform,sys
assert sys.version_info >= (3,14), 'Python 3.14+ is required'
assert platform.python_implementation() == 'CPython', 'CPython is required'
ast.parse('type Alias[T] = list[T]\\nvalue = t"hello {1}"\\n')
print(json.dumps({'version':platform.python_version(),'implementation':platform.python_implementation()}))`;
  let result;
  try {
    result = JSON.parse(execFileSync(runtimePath, ['-I', '-c', probe], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 }));
  } catch (cause) { throw new Error(`Cannot use Python runtime ${runtimePath}: ${cause.message}`, { cause }); }
  if (typeof result.version !== 'string' || result.implementation !== 'CPython') throw new Error('Invalid Python runtime probe');
  return { path: runtimePath, ...result };
}
