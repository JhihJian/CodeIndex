import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashText, shortHash } from './hash.js';

export const PARSER_VERSION = 'codeindex-parser-0.1.0';
export const DEFAULT_IGNORES = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'coverage', '.next', '.turbo', '.cache', 'target',
  'vendor', 'third_party', '.idea', '.vscode', '.data', '.codeindex'
]);

const EXTENSIONS = new Map([
  ['.py', 'python'], ['.pyi', 'python'],
  ['.js', 'javascript'], ['.jsx', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.ts', 'typescript'], ['.tsx', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'],
  ['.java', 'java'], ['.go', 'go'], ['.rs', 'rust'], ['.rb', 'ruby'],
  ['.md', 'markdown'], ['.json', 'json'], ['.yaml', 'yaml'], ['.yml', 'yaml'],
  ['.toml', 'toml'], ['.sh', 'shell'], ['.css', 'css'], ['.scss', 'scss'],
]);

export function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSIONS.get(ext) || 'unknown';
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return null; }
}

export function lineOffsets(source) {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) offsets.push(index + 1);
  }
  return offsets;
}

export function sourceLayout(source, sourceBuffer = null) {
  const buffer = sourceBuffer || Buffer.from(source, 'utf8');
  const byteOffsets = [0];
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 10) byteOffsets.push(index + 1);
  }
  return { charOffsets: lineOffsets(source), byteOffsets, byteLength: buffer.length };
}

export function spanFrom(source, startLine, endLine, startColumn = 0, endColumn = 0, layout = null) {
  const offsets = layout?.charOffsets || lineOffsets(source);
  const clampLine = (line) => Math.max(1, Math.min(Number(line) || 1, offsets.length));
  const first = clampLine(startLine);
  const last = clampLine(endLine || startLine);
  const startLineChar = offsets[first - 1];
  const startChar = startLineChar + Math.max(0, Number(startColumn) || 0);
  const endLineStart = offsets[last - 1];
  const endChar = endColumn ? endLineStart + endColumn : (last < offsets.length ? offsets[last] : source.length);
  const startByte = layout ? layout.byteOffsets[first - 1] + Buffer.byteLength(source.slice(startLineChar, startChar), 'utf8') : Buffer.byteLength(source.slice(0, startChar), 'utf8');
  const endByte = layout ? layout.byteOffsets[last - 1] + Buffer.byteLength(source.slice(endLineStart, endChar), 'utf8') : Buffer.byteLength(source.slice(0, endChar), 'utf8');
  return { startLine: first, endLine: last, startColumn: Number(startColumn) || 0, endColumn: Number(endColumn) || 0, startByte, endByte };
}

export function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, filePath);
}

export function writeJsonl(filePath, rows, { chunkBytes = 1024 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  let buffer = '';
  try {
    for (const row of rows) {
      const line = `${JSON.stringify(row)}\n`;
      if (buffer && buffer.length + line.length > chunkBytes) {
        fs.writeSync(fd, buffer, undefined, 'utf8');
        buffer = '';
      }
      buffer += line;
    }
    if (buffer) fs.writeSync(fd, buffer, undefined, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function repositoryId(repoRoot) {
  return `repo-${shortHash(fs.realpathSync(repoRoot), 20)}`;
}

export function scanRepository(repoRoot, { maxFileBytes = 5 * 1024 * 1024, ignores = DEFAULT_IGNORES, retainSource = true } = {}) {
  const root = fs.realpathSync(repoRoot);
  const files = [];
  const skipped = [];
  function walk(directory) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
      skipped.push({ path: path.relative(root, directory) || '.', reason: `read-error:${error.code || error.message}` });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (ignores.has(entry.name) || entry.name.startsWith('.codeindex-')) {
        skipped.push({ path: relative, reason: 'ignored' });
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped.push({ path: relative, reason: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) { walk(absolute); continue; }
      if (!entry.isFile()) { skipped.push({ path: relative, reason: 'non-file' }); continue; }
      let stat;
      try { stat = fs.statSync(absolute); } catch (error) {
        skipped.push({ path: relative, reason: `stat-error:${error.code || error.message}` });
        continue;
      }
      if (stat.size > maxFileBytes) {
        skipped.push({ path: relative, bytes: stat.size, reason: 'too-large' });
        continue;
      }
      let content;
      try { content = fs.readFileSync(absolute); } catch (error) {
        skipped.push({ path: relative, reason: `read-error:${error.code || error.message}` });
        continue;
      }
      const source = decodeText(content);
      if (source === null) { skipped.push({ path: relative, bytes: content.length, reason: 'binary' }); continue; }
      let lineCount = content.length ? 1 : 0;
      for (const byte of content) if (byte === 10) lineCount += 1;
      files.push({ path: relative, absolute, language: detectLanguage(relative), bytes: content.length, digest: hashBytes(content), lineCount, ...(retainSource ? { source } : {}) });
    }
  }
  walk(root);
  return { root, files, skipped };
}

export function routeTerms(text) {
  return [...new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}_$]+/u).filter(Boolean).flatMap((token) => {
    const camel = token.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/);
    return [token, ...camel];
  }))];
}

export function sourceDigest(source) { return hashText(source); }
