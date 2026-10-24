// Experimental Linux symbol index with optional native C/C++ cross-references.
// It does not implement the production CodeIndex relation schema or all its query behavior.
// node benchmarks/ctags-prototype.mjs REPO OUTPUT_DIRECTORY CTAGS_BINARY [CSCOPE_BINARY]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { scanRepository, iterateJsonl, writeJsonAtomic } from '../src/lib/fs.js';
import { hashBytes, hashText } from '../src/lib/hash.js';

const [repoArg, outputArg, ctagsArg, cscopeArg] = process.argv.slice(2);
if (!repoArg || !outputArg || !ctagsArg) throw new Error('需要 REPO OUTPUT_DIRECTORY CTAGS_BINARY');
const repo = fs.realpathSync(repoArg);
const output = path.resolve(outputArg);
const started = performance.now();
const stages = {};
let previous = started;
function progress(stage) {
  const now = performance.now();
  stages[stage] = now - previous;
  previous = now;
  console.error(JSON.stringify({ stage, elapsedMs: now - started, durationMs: stages[stage], rssMiB: process.memoryUsage().rss / 1024 ** 2 }));
}
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(output, '.build-'));
let db;
try {
  const scan = scanRepository(repo, { retainSource: false });
  const entries = scan.files;
  const snapshotId = hashText(JSON.stringify(entries.map(({ path, digest }) => ({ path, digest })))).slice(0, 24);
  fs.writeFileSync(path.join(temporary, 'files.txt'), entries.map((entry) => entry.path).join('\n') + '\n');
  progress('scan');
  const tagsFile = path.join(temporary, 'tags.jsonl');
  const parse = spawnSync(path.resolve(ctagsArg), ['--options=NONE', '--output-format=json', '--fields=+ne', '--kinds-C=+p', '--kinds-C++=+p', '--languages=C,C++,Python', '--sort=no', '-L', path.join(temporary, 'files.txt'), '-f', tagsFile], { cwd: repo, encoding: 'utf8', timeout: 180000 });
  assert.equal(parse.status, 0, parse.error?.message || parse.stderr);
  progress('ctags');
  db = new DatabaseSync(path.join(temporary, 'index.db'));
  db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-65536; PRAGMA temp_store=FILE;
    CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, bytes INTEGER NOT NULL);
    CREATE TABLE symbols(id INTEGER PRIMARY KEY, name TEXT NOT NULL, file_id INTEGER NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, end_line INTEGER, scope TEXT);
    CREATE VIRTUAL TABLE search USING fts5(name, scope, content='symbols', content_rowid='id');`);
  const insertFile = db.prepare('INSERT INTO files VALUES(?,?,?,?)');
  const fileIds = new Map();
  fs.mkdirSync(path.join(temporary, 'source'));
  db.exec('BEGIN');
  for (const [offset, entry] of entries.entries()) {
    const id = offset + 1;
    const source = fs.readFileSync(entry.absolute);
    assert.equal(hashBytes(source), entry.digest, `source changed: ${entry.path}`);
    const blob = path.join(temporary, 'source', entry.digest);
    if (!fs.existsSync(blob)) fs.writeFileSync(blob, source);
    insertFile.run(id, entry.path, entry.digest, entry.bytes);
    fileIds.set(entry.path, id);
  }
  db.exec('COMMIT');
  progress('source-and-files');
  const insertSymbol = db.prepare('INSERT INTO symbols(name,file_id,kind,line,end_line,scope) VALUES(?,?,?,?,?,?)');
  let symbols = 0;
  const kinds = {};
  db.exec('BEGIN');
  for (const tag of iterateJsonl(tagsFile)) {
    if (tag._type !== 'tag') continue;
    const fileId = fileIds.get(tag.path);
    assert.ok(fileId, `unexpected path: ${tag.path}`);
    insertSymbol.run(tag.name, fileId, tag.kind, tag.line, tag.end ?? null, tag.scope || '');
    symbols++;
    kinds[tag.kind] = (kinds[tag.kind] || 0) + 1;
  }
  db.exec('COMMIT');
  progress('symbol-ingestion');
  db.exec(`CREATE INDEX symbols_name ON symbols(name);
    CREATE INDEX symbols_file ON symbols(file_id);
    INSERT INTO search(search) VALUES('rebuild');`);
  progress('indexes-and-fts');
  const cscopeFile = path.join(temporary, 'cscope.out');
  if (cscopeArg) {
    const list = path.join(temporary, 'cscope.files');
    fs.writeFileSync(list, entries.filter((entry) => ['c', 'cpp'].includes(entry.language)).map((entry) => entry.absolute).join('\n') + '\n');
    const crossReferences = spawnSync(path.resolve(cscopeArg), ['-b', '-q', '-k', '-i', list, '-f', cscopeFile], {
      cwd: temporary, env: { ...process.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 180000,
    });
    assert.equal(crossReferences.status, 0, crossReferences.error?.message || crossReferences.stderr);
    assert.ok(fs.existsSync(`${cscopeFile}.in`) && fs.existsSync(`${cscopeFile}.po`), `missing inverted index: ${crossReferences.stderr}`);
    fs.unlinkSync(list);
    progress('cscope-cross-references');
  }
  const queries = [];
  const questions = JSON.parse(fs.readFileSync(new URL('./questions-linux-c.json', import.meta.url), 'utf8'));
  const evidence = [];
  for (const question of questions) {
    const symbol = db.prepare(`SELECT s.*,f.path,f.digest FROM symbols s JOIN files f ON f.id=s.file_id
      WHERE s.name=? AND f.path=? AND s.kind='function' ORDER BY s.line LIMIT 1`).get(question.query, question.expectedPaths[0]);
    assert.ok(symbol, question.query);
    assert.ok(symbol.end_line >= symbol.line, `missing end line: ${question.query}`);
    const source = fs.readFileSync(path.join(temporary, 'source', symbol.digest));
    assert.equal(hashBytes(source), symbol.digest);
    const lines = source.toString('utf8').split('\n');
    assert.ok(symbol.line > 0 && symbol.end_line <= lines.length);
    const match = db.prepare('SELECT rowid FROM search WHERE search MATCH ? LIMIT 16').all(`"${question.query}"`);
    assert.ok(match.some((row) => row.rowid === symbol.id), `FTS miss: ${question.query}`);
    evidence.push({ name: symbol.name, path: symbol.path, startLine: symbol.line, endLine: symbol.end_line, digest: symbol.digest });
    if (cscopeArg) {
      for (const [field, mode] of [['2', 'callees'], ['3', 'callers']]) {
        const queryStarted = performance.now();
        const response = spawnSync(path.resolve(cscopeArg), ['-d', '-L', '-q', '-f', cscopeFile, `-${field}`, question.query], { encoding: 'utf8', timeout: 10000 });
        assert.equal(response.status, 0, response.error?.message || response.stderr);
        const elapsedMs = performance.now() - queryStarted;
        const rows = response.stdout.trim().split('\n').filter(Boolean).map((line) => {
          const match = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
          assert.ok(match, line);
          const relative = path.relative(repo, match[1]);
          assert.ok(fileIds.has(relative), `unindexed reference file: ${relative}`);
          const file = db.prepare('SELECT digest FROM files WHERE path=?').get(relative);
          const blob = fs.readFileSync(path.join(temporary, 'source', file.digest));
          assert.equal(hashBytes(blob), file.digest);
          assert.ok(Number(match[3]) > 0 && Number(match[3]) <= blob.toString('utf8').split('\n').length);
          return { path: relative, peer: match[2], line: Number(match[3]), text: match[4] };
        });
        assert.ok(rows.length, `no ${mode} for ${question.query}`);
        queries.push({ query: question.query, mode, elapsedMs, count: rows.length, rows });
      }
    }
  }
  progress('verification');
  db.close();
  db = null;
  const parserOutputBytes = fs.statSync(tagsFile).size;
  fs.unlinkSync(tagsFile);
  fs.unlinkSync(path.join(temporary, 'files.txt'));
  const manifest = { experimental: true, scope: cscopeArg ? 'symbols-source-and-native-c-cross-references' : 'symbols-and-source-evidence-without-relations', snapshotId, repository: repo, files: entries.length, sourceBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), symbols, kinds, parserOutputBytes, stages, evidence, queries };
  writeJsonAtomic(path.join(temporary, 'manifest.json'), manifest);
  const destination = path.join(output, `snapshot-${snapshotId}`);
  assert.ok(!fs.existsSync(destination), 'use a fresh output directory');
  fs.renameSync(temporary, destination);
  writeJsonAtomic(path.join(output, 'published.json'), { snapshotId, directory: path.basename(destination) });
  const elapsedMs = performance.now() - started;
  console.log(JSON.stringify({ ...manifest, elapsedMs, within180Seconds: elapsedMs <= 180000, maxMainRssKiB: process.resourceUsage().maxRSS, databaseBytes: fs.statSync(path.join(destination, 'index.db')).size }, null, 2));
} catch (error) {
  try { db?.close(); } catch {}
  fs.rmSync(temporary, { recursive: true, force: true });
  throw error;
}
