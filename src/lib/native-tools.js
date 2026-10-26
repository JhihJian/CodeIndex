import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runProcess, workerCount } from './build-jobs.js';

const SYSTEM_PATH = '/usr/bin:/bin';
const ARTIFACTS = ['native/cscope.out', 'native/cscope.out.in', 'native/cscope.out.po', 'native/cscope.paths.json'];
const MODES = { references: 0, callees: 2, callers: 3, includes: 8 };
const C_EXTENSIONS = /\.(?:c|h|cc|hh|cpp|hpp|cxx|hxx|c\+\+|h\+\+|inl|ipp|tcc)$/i;

function positiveSetting(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nativeEnv() {
  const env = { ...process.env, PATH: SYSTEM_PATH, LC_ALL: 'C' };
  for (const key of ['VPATH', 'SOURCEDIRS', 'INCLUDEDIRS', 'INCDIR', 'CSCOPEOPTIONS', 'CSCOPE_DB']) delete env[key];
  return env;
}

function run(tool, args, { cwd, query = false } = {}) {
  if (!tool?.path) throw new Error('Native tool is not resolved');
  const result = spawnSync(tool.path, args, {
    cwd, env: nativeEnv(), encoding: 'utf8',
    timeout: positiveSetting('CODEINDEX_NATIVE_TIMEOUT_MS', query ? 10000 : 180000),
    maxBuffer: positiveSetting('CODEINDEX_NATIVE_MAX_OUTPUT_BYTES', 32 * 1024 * 1024),
    killSignal: 'SIGKILL',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(tool.path)} failed: ${result.error?.message || `exit ${result.status}, signal ${result.signal}`}\n${result.stderr || ''}`);
  }
  return result;
}

function runBuild(tool, args, { cwd, signal } = {}) {
  if (!tool?.path) return Promise.reject(new Error('Native tool is not resolved'));
  return runProcess(tool.path, args, {
    cwd, signal, env: nativeEnv(),
    timeout: positiveSetting('CODEINDEX_NATIVE_TIMEOUT_MS', 180000),
    maxBuffer: positiveSetting('CODEINDEX_NATIVE_MAX_OUTPUT_BYTES', 32 * 1024 * 1024),
  });
}

function executable(candidate) {
  const candidates = candidate.includes('/') ? [path.resolve(candidate)]
    : (process.env.PATH || SYSTEM_PATH).split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir, candidate));
  return candidates.find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
}

/** Resolve only needed tools. Explicit options override CODEINDEX_CTAGS / CODEINDEX_CSCOPE. */
export function resolveNativeTools({ ctags, cscope, needsCtags = true, needsCscope = true } = {}) {
  const result = { ctags: null, cscope: null };
  for (const [key, needed, configured, defaults] of [
    ['ctags', needsCtags, ctags ?? process.env.CODEINDEX_CTAGS, ['ctags-universal', 'ctags']],
    ['cscope', needsCscope, cscope ?? process.env.CODEINDEX_CSCOPE, ['cscope']],
  ]) {
    if (!needed) continue;
    const candidates = configured ? [configured] : defaults;
    const failures = [];
    for (const candidate of candidates) {
      try {
        const toolPath = executable(candidate);
        if (!toolPath) throw new Error(`executable not found: ${candidate}`);
        const tool = { path: toolPath };
        const response = run(tool, [key === 'ctags' ? '--version' : '-V']);
        let version = `${response.stdout}\n${response.stderr}`.trim().split('\n')[0];
        if (key === 'ctags') {
          if (!version.includes('Universal Ctags')) throw new Error('Universal Ctags is required');
          const features = run(tool, ['--options=NONE', '--list-features']).stdout;
          if (!/^json\s/m.test(features)) throw new Error('Universal Ctags JSON support is required');
        } else {
          // Cscope prefixes -V with argv[0], which can be an installation-specific absolute path.
          const match = /^.+: (version \d[^\r\n]*)$/i.exec(version);
          if (!match) throw new Error('Unrecognized Cscope version');
          version = `cscope: ${match[1]}`;
        }
        result[key] = { path: toolPath, version };
        break;
      } catch (error) { failures.push(error.message); }
    }
    if (!result[key]) throw new Error(`Cannot resolve ${key}: ${failures.join('; ')}`);
  }
  return result;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateRelative(file) {
  if (typeof file !== 'string' || !file || /[\x00-\x1f\x7f"\\]/.test(file)) {
    throw new Error(`Unsupported native filename (control characters, quotes and backslashes are forbidden): ${JSON.stringify(file)}`);
  }
  if (path.isAbsolute(file) || file.split('/').includes('..') || path.posix.normalize(file) !== file || file === '.') {
    throw new Error(`Native filename must be a normalized repository-relative path: ${file}`);
  }
  return file;
}

function snapshotFiles(treeRoot, paths) {
  const root = fs.realpathSync(treeRoot);
  const files = [...new Set(paths)].map(validateRelative).filter((file) => C_EXTENSIONS.test(file));
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!inside(root, fs.realpathSync(absolute)) || !fs.statSync(absolute).isFile()) {
      throw new Error(`Native input escapes snapshot tree or is not a file: ${file}`);
    }
  }
  return { root, files };
}

function warnings(stderr) {
  return stderr.split('\n').filter((line) => line.trim() && !line.includes('Notice: No options will be read'));
}

/**
 * Bounded, ordered Ctags batches. Only input SIGSEGVs confirmed against a healthy
 * scratch-only C probe become failedFiles; all other failures reject the build.
 * A single deadline and retry budget cover every batch, split and health probe.
 */
export async function extractCTags({ treeRoot, paths, outputPath, tools, workers = 1, signal }) {
  const deadline = performance.now() + positiveSetting('CODEINDEX_NATIVE_TIMEOUT_MS', 180000);
  const { root, files } = snapshotFiles(treeRoot, paths);
  outputPath = path.resolve(outputPath);
  if (inside(root, outputPath)) throw new Error('Ctags output must be outside the read-only snapshot tree');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (!files.length) {
    fs.writeFileSync(outputPath, '', 'utf8');
    return { outputPaths: [outputPath], warnings: [], failedFiles: [] };
  }
  const count = workerCount(workers);
  const maxBuffer = positiveSetting('CODEINDEX_NATIVE_MAX_OUTPUT_BYTES', 32 * 1024 * 1024);
  if (!tools?.ctags?.path) throw new Error('Native tool is not resolved');
  const scratch = fs.mkdtempSync(path.join(path.dirname(outputPath), '.ctags-'));
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let attempt = 0;
  let retries = 0;
  let healthProbe;
  const remaining = () => {
    if (controller.signal.aborted) throw Object.assign(new Error('Native build cancelled'), { kind: 'aborted' });
    const milliseconds = Math.floor(deadline - performance.now());
    if (milliseconds <= 0) throw Object.assign(new Error('Ctags total time budget exhausted'), { kind: 'timeout' });
    return milliseconds;
  };
  const invoke = async (inputs, cwd, retry = false) => {
    remaining();
    if (retry && ++retries > 128) throw new Error('Ctags isolation retry limit exceeded (128 extra attempts)');
    const id = attempt++;
    const list = path.join(scratch, `files-${id}`);
    const output = path.join(scratch, `tags-${id}.jsonl`);
    fs.writeFileSync(list, inputs.map((file) => file.startsWith('-') ? `./${file}` : file).join('\n') + '\n', 'utf8');
    try {
      const response = await runProcess(tools.ctags.path, [
        '--options=NONE', '--output-format=json', '--languages=C,C++', '--sort=no',
        '--fields=+neKStiaZ', '--fields=-P', '--extras=-p', '--kinds-C=+p', '--kinds-C++=+p',
        '-L', list, '-f', output,
      ], { cwd, signal: controller.signal, env: nativeEnv(), timeout: remaining(), maxBuffer });
      remaining();
      // Missing/unreadable output is an I/O failure, never an isolatable input.
      fs.accessSync(output, fs.constants.R_OK);
      return { output, warnings: warnings(response.stderr) };
    } catch (error) {
      // Ctags can flush complete tags and a truncated record before crashing.
      // Never publish any part of a failed invocation, even its complete tags.
      fs.rmSync(output, { force: true });
      throw error;
    }
  };
  const confirmHealthy = () => {
    healthProbe ??= (async () => {
      const name = 'codeindex_ctags_probe';
      fs.writeFileSync(path.join(scratch, 'probe.c'), `int ${name}(void) { return 0; }\n`, 'utf8');
      const result = await invoke(['probe.c'], scratch, true);
      const tags = fs.readFileSync(result.output, 'utf8').split('\n').filter((line) => line.trim()).map(JSON.parse);
      if (!tags.some((tag) => tag._type === 'tag' && tag.name === name && tag.kind === 'function')) {
        throw new Error('Ctags health probe did not emit the known C function');
      }
    })();
    return healthProbe;
  };
  const isolate = async (inputs, retry = false) => {
    let result;
    try { result = await invoke(inputs, root, retry); }
    catch (error) {
      if (error.kind !== 'exit' || error.signal !== 'SIGSEGV') throw error;
      remaining();
      if (inputs.length > 1) {
        const middle = Math.ceil(inputs.length / 2);
        const left = await isolate(inputs.slice(0, middle), true);
        const right = await isolate(inputs.slice(middle), true);
        return [...left, ...right];
      }
      await confirmHealthy();
      remaining();
      return [{ failedFile: { path: inputs[0], error: error.message, signal: error.signal } }];
    }
    return [result];
  };
  try {
    const batches = [];
    let batch = [];
    let bytes = 0;
    for (const file of files) {
      remaining();
      const size = fs.statSync(path.join(root, file)).size;
      if (batch.length && (batch.length >= 256 || bytes + size > 8 * 1024 * 1024)) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(file);
      bytes += size;
    }
    if (batch.length) batches.push(batch);
    const results = new Array(batches.length);
    let next = 0;
    let failure;
    // Each worker traverses its split tree sequentially, so retries cannot
    // multiply concurrency. Catch inside workers and join all before cleanup.
    await Promise.all(Array.from({ length: Math.min(count, batches.length) }, async () => {
      try {
        while (next < batches.length) {
          remaining();
          const index = next++;
          results[index] = await isolate(batches[index]);
        }
      } catch (error) { failure ||= error; controller.abort(); }
    }));
    if (failure) throw failure;
    remaining();
    const ordered = results.flat();
    const successful = ordered.filter((result) => result.output);
    const outputPaths = successful.map((result, index) => {
      const output = index ? `${outputPath}.${index}` : outputPath;
      fs.renameSync(result.output, output);
      return output;
    });
    if (!outputPaths.length) {
      fs.writeFileSync(outputPath, '', 'utf8');
      outputPaths.push(outputPath);
    }
    return {
      outputPaths,
      warnings: ordered.flatMap((result) => result.warnings || [`Ctags skipped ${result.failedFile.path}: ${result.failedFile.error}`]),
      failedFiles: ordered.filter((result) => result.failedFile).map((result) => result.failedFile),
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// With -k, no -I and a sanitized environment, Cscope 15 resolves quoted includes
// from cwd, not the including file's directory. Angle includes have no search dirs.
// Check the transitive closure before spawning, including non-C/C++ snapshot text.
function validateIncludes(root, files, allowedFiles = files) {
  const allowed = new Set(allowedFiles);
  const closure = new Set(files);
  for (const file of closure) {
    const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/\\\r?\n/g, '');
    // Match Cscope's lexer, which also accepts an unterminated include token.
    for (const match of source.matchAll(/#[ \t\r\v\f]*include[ \t\r\v\f]*"([^>" \t\n]+)/g)) {
      const include = match[1];
      if (include.includes('\0')) throw new Error(`Unsafe include outside snapshot in ${file}: ${include}`);
      const target = path.resolve(root, include);
      // Missing generated headers and missing ../ cwd candidates are not read.
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) continue;
      if (!inside(root, target)) throw new Error(`Unsafe include outside snapshot in ${file}: ${include}`);
      const relative = path.relative(root, target);
      if (!inside(root, fs.realpathSync(target)) || !allowed.has(relative) || !fs.statSync(target).isFile()) {
        throw new Error(`Include is not an indexed snapshot file in ${file}: ${include}`);
      }
      validateRelative(relative);
      closure.add(relative);
    }
  }
  return [...closure];
}

function checkCscopeResponse(response) {
  // Cscope 15.9 can return zero after failing to create/open its inverted index.
  const diagnostic = `${response.stderr}\n${response.stdout}`;
  if (/(?:cannot|can't|could not|unable|failed|failure|fatal|error|empty inverted|inverted file is locked|press.*RETURN|does not have expected format|ignoring.*(?:index|option))/i.test(response.stderr)
      || /File does not have expected format|cscope:.*(?:cannot|error|failed)/i.test(response.stdout)) {
    throw new Error(`Cscope failed: ${diagnostic.trim()}`);
  }
}

function verifyArtifacts(snapshotDir) {
  for (const artifact of ARTIFACTS.slice(0, 3)) {
    const absolute = path.join(snapshotDir, artifact);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || fs.statSync(absolute).size === 0) {
      throw new Error(`Missing or empty Cscope inverted-index artifact: ${artifact}`);
    }
  }
}

// The v15 trailer is uncompressed and enumerates the files actually indexed.
// Read only the header and trailer, never the potentially multi-GB symbol database.
function databaseFiles(database, { normalizeHeader = false } = {}) {
  const fd = fs.openSync(database, normalizeHeader ? 'r+' : 'r');
  try {
    const head = Buffer.alloc(65536);
    const size = fs.readSync(fd, head, 0, head.length, 0);
    const newline = head.subarray(0, size).indexOf(10);
    const header = head.subarray(0, newline).toString('utf8');
    const match = /^cscope 15 (.+) -q \d+ (\d+)$/.exec(header);
    if (!match) throw new Error('Invalid Cscope v15 database or missing inverted index header');
    if (normalizeHeader && /[ \t\r\v\f]/.test(match[1])) {
      // The legacy header parser uses %s for cwd. It is informational for -d queries;
      // -P always supplies the current snapshot tree. Keep byte offsets unchanged.
      const corrected = header.replace(match[1], match[1].replace(/[ \t\r\v\f]/g, '_'));
      fs.writeSync(fd, Buffer.from(corrected), 0, Buffer.byteLength(corrected), 0);
    }
    const offset = Number(match[2]);
    const length = fs.fstatSync(fd).size - offset;
    if (!Number.isSafeInteger(offset) || offset <= newline || length <= 0 || length > 128 * 1024 * 1024) {
      throw new Error('Invalid or oversized Cscope filename trailer');
    }
    const trailer = Buffer.alloc(length);
    if (fs.readSync(fd, trailer, 0, length, offset) !== length) throw new Error('Truncated Cscope filename trailer');
    const lines = trailer.toString('utf8').split('\n');
    let cursor = 0;
    const count = () => {
      const value = lines[cursor++];
      if (!/^\d+$/.test(value)) throw new Error('Invalid Cscope filename trailer count');
      return Number(value);
    };
    for (let i = 0; i < 2; i++) { const n = count(); cursor += n; }
    const total = count();
    const bytes = count();
    const files = lines.slice(cursor, cursor + total);
    if (files.length !== total || Buffer.byteLength(files.join('\n') + (total ? '\n' : '')) !== bytes) {
      throw new Error('Invalid Cscope filename trailer length');
    }
    return files;
  } finally { fs.closeSync(fd); }
}

// Cscope 15.9 copyinverted() loses macro-tail context and treats multiline
// source fragments as identifiers. Reparse affected files instead of replaying them.
function replayUnsafeFiles(database) {
  const first = Buffer.from(' teisaprnl(of)=c');
  const second = Buffer.from(' tnerpla');
  const letter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  const word = (c) => letter(c) || (c >= 48 && c <= 57);
  const identifierByte = Uint8Array.from({ length: 256 }, (_, c) => c < 128 ? word(c) : word(first[(c & 127) >> 3]) && word(second[c & 7]));
  const files = new Set();
  const fd = fs.openSync(database, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let pending = Buffer.alloc(0);
  let file = '';
  let macroEnd = false;
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, chunk, 0, chunk.length, null))) {
      const data = Buffer.concat([pending, chunk.subarray(0, bytes)]);
      let start = 0, end;
      while ((end = data.indexOf(10, start)) !== -1) {
        const length = end - start;
        if (macroEnd && length && file) files.add(file);
        const initial = data[start] < 128 ? data[start] : first[(data[start] & 127) >> 3];
        if (length && file && letter(initial) && !files.has(file)) {
          for (let cursor = start; cursor < end; cursor++) {
            if (!identifierByte[data[cursor]]) { files.add(file); break; }
          }
        }
        macroEnd = length === 2 && data[start] === 9 && data[start + 1] === 41;
        if (length >= 2 && data[start] === 9 && data[start + 1] === 64) file = data.toString('utf8', start + 2, end);
        start = end + 1;
      }
      pending = Buffer.from(data.subarray(start));
      if (pending.length > chunk.length) return null;
    }
    return pending.length ? null : files;
  } finally { fs.closeSync(fd); }
}

// Reuse only the v15.9 format whose cwd and second-resolution timestamp rules
// have been verified. Never modify a seed or a shared immutable source inode.
function seedCscope({ previousDir, database, root, closure, changedPaths }) {
  if (!previousDir || /\s/.test(root)) return false;
  const seed = path.join(previousDir, ARTIFACTS[0]);
  let header;
  let oldRoot;
  try {
    databaseFiles(seed);
    const mapping = JSON.parse(fs.readFileSync(path.join(previousDir, ARTIFACTS[3]), 'utf8'));
    if (Object.entries(mapping).some(([key, value]) => key !== value)) return false;
    const fd = fs.openSync(seed, 'r');
    const buffer = Buffer.alloc(65536);
    try { header = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8').split('\n')[0]; }
    finally { fs.closeSync(fd); }
    oldRoot = /^cscope 15 (\S+) -q \d+ \d+$/.exec(header)?.[1];
    if (!oldRoot || Buffer.byteLength(oldRoot) !== Buffer.byteLength(root)) return false;
  } catch { return false; }
  const referenceTime = closure.reduce((latest, file) => Math.max(latest, Math.floor(fs.statSync(path.join(root, file)).mtimeMs / 1000)), 0);
  const unsafeFiles = replayUnsafeFiles(seed);
  if (!unsafeFiles) return false;
  const changed = new Set([...changedPaths, ...unsafeFiles]);
  const scratch = fs.mkdtempSync(path.join(path.dirname(database), '.seed-'));
  try {
    for (const file of closure) {
      if (!changed.has(file)) continue;
      const target = path.join(root, file);
      const copy = path.join(scratch, 'source');
      fs.copyFileSync(target, copy, fs.constants.COPYFILE_FICLONE);
      fs.renameSync(copy, target);
      fs.utimesSync(target, referenceTime + 1, referenceTime + 1);
      if (Math.floor(fs.statSync(target).mtimeMs / 1000) <= referenceTime) throw new Error(`Cannot timestamp Cscope changed input: ${file}`);
    }
    fs.copyFileSync(seed, database, fs.constants.COPYFILE_FICLONE);
    const fd = fs.openSync(database, 'r+');
    try { fs.writeSync(fd, Buffer.from(header.replace(oldRoot, root)), 0, Buffer.byteLength(header), 0); }
    finally { fs.closeSync(fd); }
    fs.utimesSync(database, referenceTime, referenceTime);
    if (Math.floor(fs.statSync(database).mtimeMs / 1000) !== referenceTime) throw new Error('Cannot timestamp Cscope seed');
    return true;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

/**
 * paths supplies primary C/C++ inputs. allowedFiles optionally lists all saved snapshot text.
 * files reports primary inputs, indexedFiles reports the actual native database file list.
 * Empty C/C++ inputs yield no artifacts. Snapshot contents must remain immutable during build.
 */
export async function buildCscope({ treeRoot, paths, allowedFiles, snapshotDir, tools, previousDir, changedPaths = [], signal }) {
  const { root, files } = snapshotFiles(treeRoot, paths);
  snapshotDir = path.resolve(snapshotDir);
  const nativeDir = path.join(snapshotDir, 'native');
  if (inside(root, nativeDir)) throw new Error('Cscope output must be outside the read-only snapshot tree');
  fs.mkdirSync(nativeDir, { recursive: true });
  for (const artifact of ARTIFACTS) fs.rmSync(path.join(snapshotDir, artifact), { force: true });
  if (!files.length) return { files: [], indexedFiles: [], artifacts: [], warnings: [] };
  const allowed = new Set(allowedFiles === undefined ? files : [...allowedFiles].map(validateRelative));
  if (files.some((file) => !allowed.has(file))) throw new Error('Primary Cscope inputs must be in allowedFiles');
  const closure = validateIncludes(root, files, allowed);
  const aliases = files.some((file) => /\s/.test(file));
  if (aliases && closure.length !== files.length) {
    throw new Error('Cscope filename aliases cannot preserve additional include files in the snapshot closure');
  }
  const scratch = fs.mkdtempSync(path.join(nativeDir, '.cscope-'));
  try {
    const mapping = Object.create(null);
    const buildRoot = aliases ? path.join(scratch, 'tree') : root;
    if (aliases) fs.mkdirSync(buildRoot);
    for (const [index, file] of files.entries()) {
      // Cscope's result parser cannot read whitespace in paths. A temporary view
      // contains only links to validated immutable snapshot files, never live files.
      const nativePath = aliases ? `${index}${path.extname(file)}` : file;
      mapping[nativePath] = file;
      if (aliases) {
        const target = path.join(buildRoot, nativePath);
        try { fs.linkSync(path.join(root, file), target); }
        catch (error) {
          if (error.code !== 'EXDEV') throw error;
          fs.copyFileSync(path.join(root, file), target, fs.constants.COPYFILE_FICLONE);
        }
      }
    }
    if (aliases) {
      // Includes resolve from Cscope's cwd. The temporary view may have a different
      // depth, so validate its resolution too before allowing Cscope to open it.
      validateIncludes(buildRoot, Object.keys(mapping));
    }
    const list = path.join(scratch, 'files');
    fs.writeFileSync(list, Object.keys(mapping).map((file) => `"./${file}"`).join('\n') + '\n', 'utf8');
    const database = path.join(snapshotDir, ARTIFACTS[0]);
    const reused = !aliases && tools?.cscope?.version === 'cscope: version 15.9' && seedCscope({ previousDir, database, root, closure, changedPaths });
    const response = await runBuild(tools?.cscope, ['-b', '-q', '-k', reused ? '-U' : '-u', '-i', list, '-f', database], { cwd: buildRoot, signal });
    checkCscopeResponse(response);
    verifyArtifacts(snapshotDir);
    const indexed = databaseFiles(database, { normalizeHeader: true });
    const permitted = new Set(aliases ? Object.keys(mapping) : closure);
    const actual = new Set(indexed);
    if (actual.size !== indexed.length || Object.keys(mapping).some((file) => !actual.has(file))
        || indexed.some((file) => !permitted.has(file))) {
      throw new Error('Cscope indexed unexpected files outside the explicit snapshot file list');
    }
    for (const file of indexed) if (!aliases) mapping[file] = file;
    fs.writeFileSync(path.join(snapshotDir, ARTIFACTS[3]), JSON.stringify(mapping), 'utf8');
    // Opening with -q verifies the inverted indexes, including zero-exit diagnostics.
    const probe = run(tools?.cscope, ['-d', '-L', '-q', '-k', '-P', root, '-f', database, '-0', '__codeindex_index_probe__'], { cwd: scratch, query: true });
    checkCscopeResponse(probe);
    return { files, indexedFiles: indexed.map((file) => mapping[file]), artifacts: [...ARTIFACTS], buildMode: reused ? 'incremental' : 'full', warnings: [...warnings(response.stderr), ...warnings(probe.stderr)] };
  } catch (error) {
    for (const artifact of ARTIFACTS) fs.rmSync(path.join(snapshotDir, artifact), { force: true });
    throw error;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

/** Queries only the native database. treeRoot is the final snapshot tree, never the live repository. */
export function queryCscope({ snapshotDir, treeRoot, name, mode, tools, limit = 256 }) {
  if (!Object.hasOwn(MODES, mode)) throw new Error(`Unsupported Cscope mode: ${mode}`);
  if (typeof name !== 'string' || !name || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid Cscope query name');
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Cscope limit must be a nonnegative integer');
  snapshotDir = path.resolve(snapshotDir);
  const root = fs.realpathSync(treeRoot);
  verifyArtifacts(snapshotDir);
  const mapping = JSON.parse(fs.readFileSync(path.join(snapshotDir, ARTIFACTS[3]), 'utf8'));
  const database = path.join(snapshotDir, ARTIFACTS[0]);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-cscope-query-'));
  try {
    const response = run(tools?.cscope, ['-d', '-L', '-q', '-k', '-P', root, '-f', database, `-${MODES[mode]}`, name], { cwd: scratch, query: true });
    checkCscopeResponse(response);
    const rows = [];
    let total = 0;
    for (const line of response.stdout.split('\n')) {
      if (!line.trim()) continue;
      const match = /^(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) throw new Error(`Malformed Cscope result: ${line}`);
      const nativePath = path.isAbsolute(match[1]) ? path.relative(root, match[1]) : match[1];
      if (!Object.hasOwn(mapping, nativePath)) throw new Error(`Cscope result is outside snapshot file list: ${match[1]}`);
      const file = validateRelative(mapping[nativePath]);
      const absolute = path.join(root, file);
      if (!inside(root, fs.realpathSync(absolute))) throw new Error(`Cscope result escapes snapshot tree: ${file}`);
      const number = Number(match[3]);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid Cscope result line: ${line}`);
      total++;
      if (rows.length < limit) rows.push({ path: file, peer: match[2], line: number, text: match[4] });
    }
    return { rows, truncated: total > limit };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
