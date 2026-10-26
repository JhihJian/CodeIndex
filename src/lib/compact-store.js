import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const COMPACT_SCHEMA_VERSION = 'codeindex-compact-2';

/**
 * Builder records (camelCase; fileId/parentId/sourceId below are INTERNAL integers):
 * file: {path, publicId?, language, bytes, digest, lineCount?, parseStatus?,
 *        parseError?, lineOffsets: Buffer|Uint8Array|number[]}.
 * lineOffsets contains little-endian uint32 byte offsets for every line followed
 * by an EOF sentinel, including an empty last line after a trailing newline.
 * symbol: {fileId, kind, name, scope?, key?, qualifiedName?, signature?, doc?,
 *          parentId?, startLine, endLine?, startColumn?, endColumn?,
 *          startByte?, endByte?}. Positions may instead be in sourceSpan.
 * relation: {fileId, sourceId, type, relationId?, targetName?, targetNormalized?,
 *            targetLeaf?, targetModulePath?, ...positions/sourceSpan}.
 * Source symbols must exist before relations. Parent IDs must refer to existing
 * symbols in the same file. Parser-key mapping and native tags belong to callers.
 *
 * Public symbol IDs encode [file public ID, name, kind, scope, line, column].
 * They do not store an internal rowid or need a per-symbol public-ID index.
 * Ctags spans are whole lines: columns default to zero (unspecified), bytes are
 * derived from offsets, excluding the final LF. Precise parser spans override
 * those defaults. No runtime method opens source blobs or the repository.
 *
 * Full builds defer secondary indexes and FTS to finalize(). Incremental builds
 * clone a finalized, closed database and maintain both FTS indexes with triggers.
 * All iterators stream; callers must exhaust/close them before closing the DB.
 * getInternalSymbol(internalId|publicId) returns a joined snake_case SQL row.
 * findSymbols({name?,path?,scope?,kinds?,line?,limit?}) returns public symbols,
 * each with internalId. name or path is required, line means enclosing range.
 * Raw relation methods accept source internal/public ID or a target leaf;
 * source_id in returned rows is public, source_internal_id retains the SQL ID.
 * getNavigation accepts symbol/file IDs, relative paths, or dir:<base64url(path)>.
 */

const SYMBOL_COLUMNS = `s.*, f.public_id AS file_public_id, f.path, f.language,
  f.digest AS blob_digest, f.bytes AS file_bytes, f.line_count, f.line_offsets`;
const SYMBOL_FROM = 'symbols s JOIN files f ON f.id=s.file_id';
const RELATION_COLUMNS = `r.*, f.public_id AS file_public_id, f.path,
  f.digest AS blob_digest, f.bytes AS file_bytes, f.line_count, f.line_offsets`;
const RELATION_FROM = 'relations r JOIN files f ON f.id=r.file_id';

function contentPhrase(query) { return `"${String(query).replaceAll('"', '""')}"`; }

function publicFileId(filePath) {
  return `file:${createHash('sha256').update(filePath).digest('hex').slice(0, 24)}`;
}

function publicSymbolId(row) {
  return `symbol:${Buffer.from(JSON.stringify([
    row.file_public_id, row.name, row.kind, row.scope, row.start_line, row.start_column,
  ])).toString('base64url')}`;
}

function qualifiedName(row) {
  const separator = ['c', 'cpp'].includes(row.language) ? '::' : '.';
  return row.qualified_name ?? (row.scope ? `${row.scope}${separator}${row.name}` : row.name);
}

function symbolIdentity(id) {
  if (typeof id !== 'string' || !id.startsWith('symbol:')) return null;
  try {
    const identity = JSON.parse(Buffer.from(id.slice(7), 'base64url').toString('utf8'));
    return Array.isArray(identity) && identity.length === 6
      && identity.slice(0, 4).every((value) => typeof value === 'string')
      && identity.slice(4).every(Number.isInteger) ? identity : null;
  } catch { return null; }
}

function directoryId(directory) {
  return `dir:${Buffer.from(directory).toString('base64url')}`;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE files(
      id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE,
      language TEXT NOT NULL, bytes INTEGER NOT NULL, digest TEXT NOT NULL,
      line_count INTEGER NOT NULL, parse_status TEXT NOT NULL, parse_error TEXT,
      line_offsets BLOB NOT NULL
    );
    CREATE TABLE symbols(
      id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
      symbol_key TEXT, qualified_name TEXT, signature TEXT, doc TEXT,
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL DEFAULT 0, end_column INTEGER,
      start_byte INTEGER, end_byte INTEGER, parent_id INTEGER
    );
    CREATE TABLE relations(
      id INTEGER PRIMARY KEY, relation_id TEXT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      source_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      type TEXT NOT NULL, target_name TEXT NOT NULL, target_normalized TEXT NOT NULL,
      target_leaf TEXT NOT NULL, target_module_path TEXT NOT NULL,
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL DEFAULT 0, end_column INTEGER,
      start_byte INTEGER, end_byte INTEGER
    );
    CREATE VIRTUAL TABLE search_fts USING fts5(name, scope, signature, doc,
      content='symbols', content_rowid='id', tokenize='unicode61');
    CREATE VIRTUAL TABLE source_fts USING fts5(body, tokenize='unicode61');
    CREATE TRIGGER source_fts_delete AFTER DELETE ON files BEGIN
      DELETE FROM source_fts WHERE rowid=old.id;
    END;
    CREATE VIRTUAL TABLE files_fts USING fts5(path,
      content='files', content_rowid='id', tokenize='unicode61');
  `);
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', COMPACT_SCHEMA_VERSION);
}

function createIndexes(db) {
  db.exec(`
    CREATE INDEX symbols_by_name ON symbols(name);
    CREATE INDEX symbols_by_file_name ON symbols(file_id, name, start_line);
    CREATE INDEX symbols_by_parent ON symbols(parent_id) WHERE parent_id IS NOT NULL;
    CREATE INDEX symbols_modules ON symbols(file_id) WHERE kind='module';
    CREATE INDEX relations_by_file ON relations(file_id);
    CREATE INDEX relations_by_source ON relations(source_id, type);
    CREATE INDEX relations_by_module ON relations(target_module_path, type) WHERE target_module_path<>'';
    CREATE INDEX relations_by_target_leaf ON relations(target_leaf, type);
  `);
}

function createFtsTriggers(db) {
  for (const [table, fts, columns] of [
    ['symbols', 'search_fts', ['name', 'scope', 'signature', 'doc']],
    ['files', 'files_fts', ['path']],
  ]) {
    const fields = columns.join(',');
    const fresh = columns.map((name) => `new.${name}`).join(',');
    const old = columns.map((name) => `old.${name}`).join(',');
    db.exec(`
      CREATE TRIGGER ${table}_fts_insert AFTER INSERT ON ${table} BEGIN
        INSERT INTO ${fts}(rowid,${fields}) VALUES(new.id,${fresh}); END;
      CREATE TRIGGER ${table}_fts_delete AFTER DELETE ON ${table} BEGIN
        INSERT INTO ${fts}(${fts},rowid,${fields}) VALUES('delete',old.id,${old}); END;
      CREATE TRIGGER ${table}_fts_update AFTER UPDATE OF ${fields} ON ${table} BEGIN
        INSERT INTO ${fts}(${fts},rowid,${fields}) VALUES('delete',old.id,${old});
        INSERT INTO ${fts}(rowid,${fields}) VALUES(new.id,${fresh}); END;
    `);
  }
}

function verifySchema(db) {
  if (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value !== COMPACT_SCHEMA_VERSION) {
    throw new Error('紧凑索引 schema 不匹配，请重新构建');
  }
  if (db.prepare("SELECT value FROM meta WHERE key='finalized'").get()?.value !== '1') {
    throw new Error('紧凑索引尚未 finalize');
  }
}

function offsetsBuffer(offsets) {
  if (Array.isArray(offsets)) {
    const buffer = Buffer.allocUnsafe(offsets.length * 4);
    offsets.forEach((offset, index) => buffer.writeUInt32LE(offset, index * 4));
    return buffer;
  }
  if (!(offsets instanceof Uint8Array)) throw new TypeError('lineOffsets 必须是 little-endian uint32 BLOB 或数值数组');
  return Buffer.from(offsets.buffer, offsets.byteOffset, offsets.byteLength);
}

function positions(record) {
  const span = record.sourceSpan || record;
  const start = span.startLine ?? 1;
  return [start, span.endLine ?? start, span.startColumn ?? 0, span.endColumn ?? null,
    span.startByte ?? null, span.endByte ?? null];
}

function counts(db) {
  return Object.fromEntries(['files', 'symbols', 'relations'].map((table) =>
    [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
}

export function createCompactStore(snapshotDir, { previousDatabase = null } = {}) {
  fs.mkdirSync(snapshotDir, { recursive: true });
  const databasePath = path.join(snapshotDir, 'index.db');
  if (fs.existsSync(databasePath)) throw new Error(`索引数据库已存在：${databasePath}`);
  if (previousDatabase) {
    if (fs.existsSync(`${previousDatabase}-wal`) && fs.statSync(`${previousDatabase}-wal`).size) {
      throw new Error('复制前需要关闭并 checkpoint 旧数据库');
    }
    fs.copyFileSync(previousDatabase, databasePath, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
  }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF;
      PRAGMA foreign_keys=ON; PRAGMA cache_size=-65536; PRAGMA temp_store=FILE;`);
    if (previousDatabase) verifySchema(db);
    else createSchema(db);
    db.prepare("DELETE FROM meta WHERE key='finalized'").run();
    const fileInsert = db.prepare(`INSERT INTO files(public_id,path,language,bytes,digest,
      line_count,parse_status,parse_error,line_offsets) VALUES(?,?,?,?,?,?,?,?,?)`);
    const symbolInsert = db.prepare(`INSERT INTO symbols(file_id,kind,name,scope,symbol_key,
      qualified_name,signature,doc,start_line,end_line,start_column,end_column,start_byte,end_byte,parent_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const relationInsert = db.prepare(`INSERT INTO relations(relation_id,file_id,source_id,type,
      target_name,target_normalized,target_leaf,target_module_path,
      start_line,end_line,start_column,end_column,start_byte,end_byte) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const bodyInsert = db.prepare('INSERT INTO source_fts(rowid,body) VALUES(?,?)');
    const fileDelete = db.prepare('DELETE FROM files WHERE path=?');
    let finalized = false;
    return {
      db, databasePath,
      begin() { db.exec('BEGIN'); },
      commit() { db.exec('COMMIT'); },
      insertFile(record) {
        const offsets = offsetsBuffer(record.lineOffsets);
        const lineCount = record.lineCount ?? offsets.length / 4 - 1;
        if (offsets.length < 8 || offsets.length !== (lineCount + 1) * 4
          || offsets.readUInt32LE(0) !== 0 || offsets.readUInt32LE(offsets.length - 4) !== record.bytes) {
          throw new Error(`无效的行偏移：${record.path}`);
        }
        if (typeof record.body !== 'string' || Buffer.byteLength(record.body) !== record.bytes) throw new Error(`无效的正文：${record.path}`);
        const id = Number(fileInsert.run(record.publicId ?? publicFileId(record.path), record.path,
          record.language, record.bytes, record.digest, lineCount, record.parseStatus ?? 'parsed',
          record.parseError ?? null, offsets).lastInsertRowid);
        bodyInsert.run(id, record.body);
        return id;
      },
      insertSymbol(record) {
        return Number(symbolInsert.run(record.fileId, record.kind, record.name, record.scope ?? '',
          record.key ?? null, record.qualifiedName ?? null, record.signature ?? null, record.doc ?? null,
          ...positions(record), record.parentId ?? null).lastInsertRowid);
      },
      insertRelation(record) {
        const target = record.targetName ?? '';
        return Number(relationInsert.run(record.relationId ?? null, record.fileId, record.sourceId,
          record.type, target, record.targetNormalized ?? target,
          record.targetLeaf ?? target.split(/::|\.|->/).at(-1), record.targetModulePath ?? '',
          ...positions(record)).lastInsertRowid);
      },
      deleteFile(filePath) { return fileDelete.run(filePath).changes; },
      finalize() {
        if (finalized) return;
        if (db.isTransaction) db.exec('COMMIT');
        db.exec('BEGIN');
        try {
          if (!previousDatabase) {
            createIndexes(db);
            db.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild'); INSERT INTO files_fts(files_fts) VALUES('rebuild');");
            createFtsTriggers(db);
          }
          if (db.prepare(`SELECT 1 FROM files f LEFT JOIN source_fts s ON s.rowid=f.id WHERE s.rowid IS NULL
            UNION ALL SELECT 1 FROM source_fts s LEFT JOIN files f ON f.id=s.rowid WHERE f.id IS NULL LIMIT 1`).get()) throw new Error('正文索引覆盖不完整');
          db.exec("INSERT INTO source_fts(source_fts) VALUES('integrity-check')");
          db.prepare("INSERT OR REPLACE INTO meta VALUES('finalized','1')").run();
          db.exec('COMMIT');
          finalized = true;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      counts() { return counts(db); },
      close() { db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function rowToFile(row) {
  return row ? { fileId: row.public_id, internalId: row.id, path: row.path,
    language: row.language, bytes: row.bytes, digest: row.digest, lineCount: row.line_count,
    parseStatus: row.parse_status, parseError: row.parse_error } : null;
}

function sourceSpan(row, snapshotId) {
  const offsets = Buffer.from(row.line_offsets.buffer, row.line_offsets.byteOffset, row.line_offsets.byteLength);
  const startLine = Math.max(1, Math.min(row.line_count, row.start_line));
  const endLine = Math.max(startLine, Math.min(row.line_count, row.end_line));
  return { path: row.path, startLine, endLine,
    startColumn: row.start_column ?? 0, endColumn: row.end_column ?? 0,
    startByte: row.start_byte ?? offsets.readUInt32LE((startLine - 1) * 4),
    endByte: row.end_byte ?? (offsets.readUInt32LE(endLine * 4) - (endLine < row.line_count ? 1 : 0)),
    blobDigest: row.blob_digest, snapshotId };
}

export function openCompactStore(snapshotDir, manifest = {}) {
  const databasePath = path.join(snapshotDir, 'index.db');
  if (!fs.existsSync(databasePath)) return null;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { verifySchema(db); } catch (error) { db.close(); throw error; }
  const byInternal = db.prepare(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE s.id=?`);
  const byPublic = db.prepare(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM}
    WHERE f.public_id=? AND s.name=? AND s.kind=? AND s.scope=? AND s.start_line=? AND s.start_column=? LIMIT 1`);
  const fileByPublic = db.prepare('SELECT * FROM files WHERE public_id=?');
  const fileByPath = db.prepare('SELECT * FROM files WHERE path=?');
  const parentByName = db.prepare(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM}
    WHERE s.file_id=? AND s.name=? AND s.start_line<=? AND s.end_line>=? AND s.id<>?
      AND (s.scope=? OR COALESCE(s.qualified_name, '')=?)
    ORDER BY s.start_line DESC, s.end_line ASC LIMIT 2`);
  const moduleByFile = db.prepare(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM}
    WHERE s.file_id=? AND s.kind='module' AND s.id<>? LIMIT 2`);
  const search = db.prepare(`SELECT s.id, f.public_id AS file_public_id,
      s.name,s.kind,s.scope,s.start_line,s.start_column,s.qualified_name,s.signature,s.doc,f.path,f.language,
      bm25(search_fts) AS rank FROM search_fts JOIN symbols s ON s.id=search_fts.rowid
      JOIN files f ON f.id=s.file_id WHERE search_fts MATCH ? ORDER BY rank LIMIT ?`);
  const searchFiles = db.prepare(`SELECT f.public_id, f.path, bm25(files_fts) AS rank
    FROM files_fts JOIN files f ON f.id=files_fts.rowid WHERE files_fts MATCH ? ORDER BY rank LIMIT ?`);

  function internalSymbol(id) {
    if (Number.isSafeInteger(id)) return byInternal.get(id) ?? null;
    const identity = symbolIdentity(id);
    return identity ? byPublic.get(...identity) ?? null : null;
  }

  function parentId(row) {
    if (row.parent_id !== null) {
      const parent = internalSymbol(row.parent_id);
      if (parent && parent.file_id === row.file_id && parent.id !== row.id) return publicSymbolId(parent);
    }
    if (row.kind === 'module') return row.file_public_id;
    if (row.scope) {
      const parts = row.scope.split(/::|\./);
      const name = parts.pop();
      const separator = row.scope.includes('::') ? '::' : '.';
      const parents = parentByName.all(row.file_id, name, row.start_line, row.end_line,
        row.id, parts.join(separator), row.scope);
      if (parents.length === 1) return publicSymbolId(parents[0]);
    }
    const modules = moduleByFile.all(row.file_id, row.id);
    return modules.length === 1 ? publicSymbolId(modules[0]) : row.file_public_id;
  }

  function toSymbol(row) {
    if (!row) return null;
    const symbolId = publicSymbolId(row);
    return { symbolId, internalId: row.id, key: row.symbol_key ?? symbolId,
      fileId: row.file_public_id, path: row.path, language: row.language,
      kind: row.kind, name: row.name, scope: row.scope,
      qualifiedName: qualifiedName(row),
      parentId: parentId(row), signature: row.signature, doc: row.doc,
      sourceSpan: sourceSpan(row, manifest.snapshotId) };
  }

  function rawRelation(row) {
    const span = sourceSpan(row, manifest.snapshotId);
    const source = internalSymbol(row.source_id);
    return { ...row, line_offsets: undefined, source_internal_id: row.source_id,
      source_id: source ? publicSymbolId(source) : null,
      relation_id: row.relation_id ?? `relation:${Buffer.from(JSON.stringify([
        source ? publicSymbolId(source) : null, row.type, row.target_name,
        row.start_line, row.start_column, row.end_line, row.end_column,
      ])).toString('base64url')}`,
      start_byte: span.startByte, end_byte: span.endByte };
  }

  function relationRows(where, values, types) {
    const filter = types?.length ? ' AND r.type IN (SELECT value FROM json_each(?))' : '';
    if (types && !types.length) return [];
    const rows = db.prepare(`SELECT ${RELATION_COLUMNS} FROM ${RELATION_FROM} WHERE ${where}${filter} LIMIT ?`)
      .iterate(...values, ...(filter ? [JSON.stringify(types)] : []), 4097);
    return Array.from(rows, rawRelation);
  }

  function navigationForDirectory(directory) {
    const prefix = directory ? `${directory}/` : '';
    const where = prefix ? 'WHERE path>=? AND path<?' : '';
    const values = prefix ? [prefix, `${directory}0`] : [];
    const exists = db.prepare(`SELECT 1 FROM files ${where} LIMIT 1`).get(...values);
    if (directory && !exists) return null;
    const fileCount = db.prepare(`SELECT count(*) AS n FROM files ${where}`).get(...values).n;
    return { nodeId: directoryId(directory), parentId: directory ? directoryId(path.posix.dirname(directory) === '.' ? '' : path.posix.dirname(directory)) : null,
      nodeType: directory ? 'directory' : 'repository', title: directory ? path.posix.basename(directory) : (manifest.repositoryId ?? 'repository'),
      path: directory, summary: `${fileCount} files`, routeTerms: directory.split('/').filter(Boolean),
      inputDigest: manifest.snapshotId ?? '' };
  }

  const index = {
    storeRoot: path.dirname(path.dirname(path.dirname(snapshotDir))), snapshotDir, manifest, db, databasePath,
    searchNodes(query, limit = 24) {
      limit = Math.max(0, Math.trunc(limit));
      const terms = [...new Set(String(query).split(/[^\p{L}\p{N}_$]+/u).filter(Boolean))];
      if (!terms.length || !limit) return [];
      const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' OR ');
      const symbols = search.all(ftsQuery, limit).map((row) => ({
        node_id: publicSymbolId(row), node_type: 'symbol', symbol_kind: row.kind, name: row.name,
        qualified_name: qualifiedName(row),
        signature: row.signature, doc: row.doc, summary: '', path: row.path,
        rank: row.rank, score: -row.rank,
      }));
      const files = searchFiles.all(ftsQuery, limit).map((row) => ({
        node_id: row.public_id, node_type: 'file', name: path.posix.basename(row.path),
        qualified_name: row.path, signature: '', doc: '', summary: '', path: row.path,
        rank: row.rank, score: -row.rank,
      }));
      return [...symbols, ...files].sort((a, b) => a.rank - b.rank).slice(0, limit);
    },
    searchContent(query, limit = 12) {
      if (!/[\p{L}\p{N}]/u.test(query) || limit <= 0) return [];
      return db.prepare(`SELECT f.public_id AS fileId,f.path,f.digest,bm25(source_fts) AS rank
        FROM source_fts JOIN files f ON f.id=source_fts.rowid
        WHERE source_fts MATCH ? ORDER BY rank,f.path LIMIT ?`).all(contentPhrase(query), limit);
    },
    contentMatch(fileId, query) {
      const file = fileByPublic.get(fileId);
      if (!file) return null;
      // Markers are chosen per read and checked against the original body.
      const marker = `codeindex-${randomUUID()}`;
      const begin = `${marker}<`, end = `${marker}>`;
      const row = db.prepare(`SELECT highlight(source_fts,0,?,?) AS marked,
        instr(body,?) AS collision FROM source_fts WHERE rowid=? AND source_fts MATCH ?`)
        .get(begin, end, marker, BigInt(file.id), contentPhrase(query));
      if (!row) return null;
      if (row.collision) return index.contentMatch(fileId, query);
      const start = row.marked.indexOf(begin), finish = row.marked.indexOf(end);
      if (start < 0 || finish < start) throw new Error('正文命中位置缺失');
      const original = row.marked.replaceAll(begin, '').replaceAll(end, '');
      if (createHash('sha256').update(original).digest('hex') !== file.digest) throw new Error(`content-digest:${file.path}`);
      return { startByte: Buffer.byteLength(row.marked.slice(0, start)),
        endByte: Buffer.byteLength(row.marked.slice(0, start)) + Buffer.byteLength(row.marked.slice(start + begin.length, finish)) };
    },
    getInternalSymbol: internalSymbol,
    getSymbol(id) { return toSymbol(internalSymbol(id)); },
    getSymbols(ids) { return ids.map((id) => toSymbol(internalSymbol(id))).filter(Boolean); },
    getFile(id) { return rowToFile(fileByPublic.get(id) ?? fileByPath.get(id)); },
    getFiles(ids) { return ids.map((id) => index.getFile(id)).filter(Boolean); },
    findSymbols({ name, path: filePath, scope, kinds, line, languages, qualifiedSuffix, limit = 100 } = {}) {
      const clauses = [];
      const values = [];
      if (name !== undefined) { clauses.push('s.name=?'); values.push(name); }
      if (filePath !== undefined) { clauses.push('f.path=?'); values.push(filePath); }
      if (scope !== undefined) { clauses.push('s.scope=?'); values.push(scope); }
      if (languages) { clauses.push('f.language IN (SELECT value FROM json_each(?))'); values.push(JSON.stringify(languages)); }
      if (qualifiedSuffix) {
        clauses.push("(replace(COALESCE(s.qualified_name, CASE WHEN s.scope='' THEN s.name ELSE s.scope || '.' || s.name END),'::','.')=? OR replace(COALESCE(s.qualified_name,s.scope || '.' || s.name),'::','.') LIKE ? ESCAPE '\\')");
        values.push(qualifiedSuffix, `%.${qualifiedSuffix.replace(/[\\%_]/g, '\\$&')}`);
      }
      if (kinds) { clauses.push('s.kind IN (SELECT value FROM json_each(?))'); values.push(JSON.stringify(kinds)); }
      if (line !== undefined) { clauses.push('s.start_line<=? AND s.end_line>=?'); values.push(line, line); }
      if (name === undefined && filePath === undefined) throw new Error('findSymbols 需要 name 或 path 以限制索引范围');
      return db.prepare(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM}
        WHERE ${clauses.join(' AND ')} ORDER BY s.start_line DESC,s.end_line ASC LIMIT ?`)
        .all(...values, limit).map(toSymbol);
    },
    getRawRelationsForSource(id, types) {
      const source = internalSymbol(id);
      return source ? relationRows('r.source_id=?', [source.id], types) : [];
    },
    getRawRelationsForModule(paths, types) { return relationRows("r.target_module_path<>'' AND r.target_module_path IN (SELECT value FROM json_each(?))", [JSON.stringify(paths)], types); },
    getRawRelationsForTargetLeaf(leaf, types) { return relationRows('r.target_leaf=?', [leaf], types); },
    getNavigation(id) {
      if (typeof id !== 'string') return null;
      if (id.startsWith('symbol:')) {
        const symbol = index.getSymbol(id);
        return symbol ? { nodeId: symbol.symbolId, parentId: symbol.parentId, nodeType: 'symbol',
          kind: symbol.kind, title: symbol.name, path: symbol.path, summary: symbol.signature || symbol.qualifiedName,
          routeTerms: [symbol.name], inputDigest: symbol.sourceSpan.blobDigest,
          language: symbol.language, qualifiedName: symbol.qualifiedName, signature: symbol.signature,
          sourceSpan: symbol.sourceSpan } : null;
      }
      if (id.startsWith('dir:')) return navigationForDirectory(Buffer.from(id.slice(4), 'base64url').toString('utf8'));
      const file = index.getFile(id);
      if (!file) return navigationForDirectory(id);
      const directory = path.posix.dirname(file.path);
      const n = db.prepare('SELECT count(*) AS n FROM symbols WHERE file_id=?').get(file.internalId).n;
      return { nodeId: file.fileId, parentId: directoryId(directory === '.' ? '' : directory), nodeType: 'file',
        kind: 'file', title: path.posix.basename(file.path), path: file.path, language: file.language,
        summary: `${file.language}, ${file.lineCount} lines, ${n} symbols`,
        routeTerms: file.path.split('/'), inputDigest: file.digest };
    },
    *iterFiles() {
      for (const row of db.prepare('SELECT * FROM files ORDER BY id').iterate()) yield rowToFile(row);
    },
    *iterSymbols() {
      for (const row of db.prepare(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} ORDER BY s.id`).iterate()) yield toSymbol(row);
    },
    *iterRelations() {
      for (const row of db.prepare(`SELECT ${RELATION_COLUMNS} FROM ${RELATION_FROM} ORDER BY r.id`).iterate()) yield rawRelation(row);
    },
    *iterContainment() {
      yield navigationForDirectory('');
      // Lexicographic paths let us emit directories with only the previous path in memory.
      let previous = [];
      for (const row of db.prepare('SELECT * FROM files ORDER BY path').iterate()) {
        const directories = row.path.split('/').slice(0, -1);
        let common = 0;
        while (common < directories.length && common < previous.length && directories[common] === previous[common]) common++;
        for (let i = common; i < directories.length; i++) {
          const directory = directories.slice(0, i + 1).join('/');
          yield { nodeId: directoryId(directory), parentId: directoryId(directories.slice(0, i).join('/')),
            nodeType: 'directory', kind: 'directory', title: directories[i], path: directory };
        }
        previous = directories;
        yield { nodeId: row.public_id, parentId: directoryId(directories.join('/')),
          nodeType: 'file', kind: 'file', title: path.posix.basename(row.path), path: row.path, language: row.language };
      }
      for (const symbol of index.iterSymbols()) {
        yield { nodeId: symbol.symbolId, parentId: symbol.parentId, nodeType: 'symbol', kind: symbol.kind,
          title: symbol.name, path: symbol.path, language: symbol.language,
          qualifiedName: symbol.qualifiedName, signature: symbol.signature, sourceSpan: symbol.sourceSpan };
      }
    },
    stats() { return counts(db); },
    close() { db.close(); },
  };
  return index;
}
