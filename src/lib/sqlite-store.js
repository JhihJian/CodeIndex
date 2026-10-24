import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 'codeindex-sqlite-0.2.0';

function sqlQuote(value) {
  return String(value ?? '').replaceAll('"', '""');
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (
      file_id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      language TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      digest TEXT NOT NULL,
      line_count INTEGER NOT NULL,
      parse_status TEXT NOT NULL,
      parse_error TEXT
    );
    CREATE TABLE IF NOT EXISTS symbols (
      symbol_id TEXT PRIMARY KEY,
      symbol_key TEXT NOT NULL,
      parent_key TEXT,
      path TEXT NOT NULL,
      file_id TEXT NOT NULL,
      parent_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      signature TEXT,
      doc TEXT,
      language TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      start_byte INTEGER NOT NULL,
      end_byte INTEGER NOT NULL,
      blob_digest TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS symbols_by_key ON symbols(symbol_key);
    CREATE INDEX IF NOT EXISTS symbols_by_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS symbols_by_qualified_name ON symbols(qualified_name);
    CREATE INDEX IF NOT EXISTS symbols_by_file ON symbols(file_id);
    CREATE INDEX IF NOT EXISTS symbols_by_parent ON symbols(parent_id);
    CREATE TABLE IF NOT EXISTS containment (
      node_id TEXT PRIMARY KEY,
      parent_id TEXT,
      node_type TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT,
      qualified_name TEXT,
      signature TEXT,
      start_line INTEGER,
      end_line INTEGER,
      start_byte INTEGER,
      end_byte INTEGER,
      blob_digest TEXT
    );
    CREATE INDEX IF NOT EXISTS containment_by_parent ON containment(parent_id);
    CREATE TABLE IF NOT EXISTS relations (
      relation_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      start_byte INTEGER NOT NULL,
      end_byte INTEGER NOT NULL,
      blob_digest TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS relations_by_source ON relations(source_id, type);
    CREATE INDEX IF NOT EXISTS relations_by_target ON relations(target_id, type);
    CREATE TABLE IF NOT EXISTS navigation (
      node_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      node_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      route_terms TEXT NOT NULL,
      input_digest TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      node_id UNINDEXED,
      node_type UNINDEXED,
      name,
      qualified_name,
      signature,
      doc,
      summary,
      path,
      tokenize='unicode61'
    );
    INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
  `);
}

export function createIndexBuildSession(snapshotDir) {
  const databasePath = path.join(snapshotDir, 'index.db');
  const db = new DatabaseSync(databasePath);
  createSchema(db);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = OFF;
    PRAGMA cache_size = -65536;
    PRAGMA temp_store = FILE;
    DROP INDEX IF EXISTS symbols_by_name;
    DROP INDEX IF EXISTS symbols_by_qualified_name;
    DROP INDEX IF EXISTS symbols_by_file;
    DROP INDEX IF EXISTS symbols_by_parent;
    DROP INDEX IF EXISTS containment_by_parent;
    DROP INDEX IF EXISTS relations_by_source;
    DROP INDEX IF EXISTS relations_by_target;
  `);
  db.exec(`
    CREATE TEMP TABLE relation_staging (
      relation_id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      type TEXT NOT NULL,
      target_name TEXT,
      target_normalized TEXT,
      target_leaf TEXT,
      target_module_path TEXT,
      path TEXT NOT NULL,
      file_id TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      start_byte INTEGER NOT NULL,
      end_byte INTEGER NOT NULL,
      blob_digest TEXT NOT NULL
    );
    CREATE INDEX relation_staging_source ON relation_staging(source_key);
    CREATE TEMP TABLE module_lookup (
      module_path TEXT,
      qualified_name TEXT NOT NULL,
      symbol_id TEXT NOT NULL
    );
    CREATE INDEX module_lookup_path ON module_lookup(module_path);
    CREATE INDEX module_lookup_qualified ON module_lookup(qualified_name);
  `);
  const insertFile = db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertSymbol = db.prepare('INSERT INTO symbols VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertModule = db.prepare('INSERT INTO module_lookup VALUES (?, ?, ?)');
  const insertNode = db.prepare('INSERT INTO containment VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertRelation = db.prepare('INSERT INTO relation_staging VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertNavigation = db.prepare('INSERT INTO navigation VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertSearch = db.prepare('INSERT INTO search_fts(node_id, node_type, name, qualified_name, signature, doc, summary, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  return {
    db,
    begin() { db.exec('BEGIN'); },
    commit() { db.exec('COMMIT'); },
    insertFile(file) { insertFile.run(file.fileId, file.path, file.language, file.bytes, file.digest, file.lineCount, file.parseStatus, file.parseError); },
    insertSymbol(symbol) {
      const span = symbol.sourceSpan;
      insertSymbol.run(symbol.symbolId, symbol.key, symbol.parentKey || null, symbol.path, symbol.fileId, null, symbol.kind, symbol.name, symbol.qualifiedName, symbol.signature || '', symbol.doc || '', symbol.language, span.startLine, span.endLine, span.startColumn, span.endColumn, span.startByte, span.endByte, span.blobDigest);
      if (symbol.kind === 'module') {
        const modulePath = symbol.path.replace(/^\.\//, '');
        const moduleWithoutExtension = modulePath.replace(/\.(js|jsx|mjs|cjs|ts|tsx|py|c|h|cc|cpp|cxx|hh|hpp|hxx)$/, '');
        insertModule.run(modulePath, symbol.qualifiedName, symbol.symbolId);
        if (moduleWithoutExtension !== modulePath) insertModule.run(moduleWithoutExtension, symbol.qualifiedName, symbol.symbolId);
      }
    },
    insertNode(node) {
      insertNode.run(node.nodeId, node.parentId || null, node.nodeType, node.kind || '', node.title, node.path || '', node.language || '', node.qualifiedName || '', node.signature || '', node.sourceSpan?.startLine || null, node.sourceSpan?.endLine || null, node.sourceSpan?.startByte || null, node.sourceSpan?.endByte || null, node.sourceSpan?.blobDigest || null);
    },
    insertRelation(relation) {
      const span = relation.sourceSpan;
      insertRelation.run(relation.relationId, relation.sourceKey, relation.type, relation.targetName || '', relation.targetNormalized || '', relation.targetLeaf || '', relation.targetModulePath || '', relation.path, relation.fileId, span.startLine, span.endLine, span.startColumn, span.endColumn, span.startByte, span.endByte, span.blobDigest);
    },
    insertNavigation(item) { insertNavigation.run(item.nodeId, item.title, item.path || '', item.nodeType, item.summary, JSON.stringify(item.routeTerms || []), item.inputDigest); },
    insertSearch(item) { insertSearch.run(item.nodeId, item.nodeType, item.name || item.title || '', item.qualifiedName || '', item.signature || '', item.doc || '', item.summary || '', item.path || ''); },
    finalizeParents() {
      db.exec(`BEGIN;
        UPDATE symbols SET parent_id = COALESCE(
          (SELECT parent.symbol_id FROM symbols parent WHERE parent.symbol_key = symbols.parent_key LIMIT 1),
          symbols.file_id
        ) WHERE parent_id IS NULL;
      COMMIT`);
    },
    finalizeContainment() {
      db.exec(`BEGIN;
        INSERT INTO containment(node_id, parent_id, node_type, kind, title, path, language, qualified_name, signature, start_line, end_line, start_byte, end_byte, blob_digest)
          SELECT symbol_id, parent_id, 'symbol', kind, name, path, language, qualified_name, signature, start_line, end_line, start_byte, end_byte, blob_digest FROM symbols;
      COMMIT`);
    },
    finalizeRelations() {
      db.exec(`BEGIN;
        CREATE TEMP TABLE symbol_file_name_unique AS
          SELECT path, name, CASE WHEN count(*) = 1 THEN min(symbol_id) END AS symbol_id
          FROM symbols GROUP BY path, name;
        CREATE TEMP TABLE symbol_qualified_unique AS
          SELECT qualified_name, CASE WHEN count(*) = 1 THEN min(symbol_id) END AS symbol_id
          FROM symbols GROUP BY qualified_name;
        CREATE TEMP TABLE symbol_name_unique AS
          SELECT name, CASE WHEN count(*) = 1 THEN min(symbol_id) END AS symbol_id
          FROM symbols GROUP BY name;
        CREATE TEMP TABLE module_path_unique AS
          SELECT module_path, CASE WHEN count(*) = 1 THEN min(symbol_id) END AS symbol_id
          FROM module_lookup GROUP BY module_path;
        CREATE TEMP TABLE module_qualified_unique AS
          SELECT qualified_name, CASE WHEN count(DISTINCT symbol_id) = 1 THEN min(symbol_id) END AS symbol_id
          FROM module_lookup GROUP BY qualified_name;
        CREATE UNIQUE INDEX temp.file_name_lookup ON symbol_file_name_unique(path, name);
        CREATE UNIQUE INDEX temp.qualified_lookup ON symbol_qualified_unique(qualified_name);
        CREATE UNIQUE INDEX temp.name_lookup ON symbol_name_unique(name);
        CREATE UNIQUE INDEX temp.module_path_lookup ON module_path_unique(module_path);
        CREATE UNIQUE INDEX temp.module_qualified_lookup ON module_qualified_unique(qualified_name);
        WITH resolved AS (
          SELECT r.*, source.symbol_id AS source_id,
            CASE WHEN r.type IN ('imports', 'includes')
              THEN COALESCE(module_path.symbol_id, module_qualified.symbol_id)
              ELSE COALESCE(file_name.symbol_id, qualified.symbol_id, name.symbol_id)
            END AS target_id
          FROM relation_staging r
          JOIN symbols source ON source.symbol_key = r.source_key
          LEFT JOIN module_path_unique module_path ON module_path.module_path = r.target_module_path
          LEFT JOIN module_qualified_unique module_qualified ON module_qualified.qualified_name = r.target_normalized
          LEFT JOIN symbol_file_name_unique file_name ON file_name.path = r.path AND file_name.name = r.target_leaf
          LEFT JOIN symbol_qualified_unique qualified ON qualified.qualified_name = r.target_normalized
          LEFT JOIN symbol_name_unique name ON name.name = r.target_leaf
        )
        INSERT INTO relations(relation_id, type, source_id, target_id, target_name, status, confidence, path, start_line, end_line, start_column, end_column, start_byte, end_byte, blob_digest)
          SELECT relation_id, type, source_id, target_id, target_name,
            CASE WHEN target_id IS NULL THEN 'unresolved' ELSE 'resolved' END,
            CASE WHEN target_id IS NULL THEN 0 ELSE 1 END,
            path, start_line, end_line, start_column, end_column, start_byte, end_byte, blob_digest
          FROM resolved;
      COMMIT`);
    },
    rebuildIndexes() {
      db.exec(`
        CREATE INDEX IF NOT EXISTS symbols_by_name ON symbols(name);
        CREATE INDEX IF NOT EXISTS symbols_by_qualified_name ON symbols(qualified_name);
        CREATE INDEX IF NOT EXISTS symbols_by_file ON symbols(file_id);
        CREATE INDEX IF NOT EXISTS symbols_by_parent ON symbols(parent_id);
        CREATE INDEX IF NOT EXISTS containment_by_parent ON containment(parent_id);
        CREATE INDEX IF NOT EXISTS relations_by_source ON relations(source_id, type);
        CREATE INDEX IF NOT EXISTS relations_by_target ON relations(target_id, type);
      `);
    },
    counts() {
      return {
        files: Number(db.prepare('SELECT count(*) AS count FROM files').get().count),
        symbols: Number(db.prepare('SELECT count(*) AS count FROM symbols').get().count),
        relations: Number(db.prepare('SELECT count(*) AS count FROM relations').get().count),
      };
    },
    close() { db.close(); },
  };
}

function rowToFile(row) {
  return row ? { fileId: row.file_id, path: row.path, language: row.language, bytes: row.bytes, digest: row.digest, lineCount: row.line_count, parseStatus: row.parse_status, parseError: row.parse_error } : null;
}

function rowToSymbol(row, snapshotId) {
  return row ? { symbolId: row.symbol_id, key: row.symbol_key, path: row.path, fileId: row.file_id, parentId: row.parent_id, kind: row.kind, name: row.name, qualifiedName: row.qualified_name, signature: row.signature, doc: row.doc, language: row.language, sourceSpan: { path: row.path, startLine: row.start_line, endLine: row.end_line, startColumn: row.start_column, endColumn: row.end_column, startByte: row.start_byte, endByte: row.end_byte, blobDigest: row.blob_digest, snapshotId } } : null;
}

function rowToNavigation(row) {
  return row ? { nodeId: row.node_id, title: row.title, path: row.path, nodeType: row.node_type, summary: row.summary, routeTerms: JSON.parse(row.route_terms || '[]'), inputDigest: row.input_digest } : null;
}

export function openIndexDatabase(snapshotDir, manifest) {
  const databasePath = path.join(snapshotDir, 'index.db');
  if (!fs.existsSync(databasePath)) return null;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const searchStatement = db.prepare(`SELECT node_id, node_type, name, qualified_name, signature, doc, summary, path, bm25(search_fts) AS rank FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT ?`);
  const symbolById = db.prepare('SELECT * FROM symbols WHERE symbol_id = ?');
  const symbolsById = db.prepare(`SELECT * FROM symbols WHERE symbol_id IN (SELECT value FROM json_each(?))`);
  const fileById = db.prepare('SELECT * FROM files WHERE file_id = ?');
  const filesByIds = db.prepare(`SELECT * FROM files WHERE file_id IN (SELECT value FROM json_each(?))`);
  const relationsByTarget = db.prepare('SELECT * FROM relations WHERE target_id = ? AND type IN (SELECT value FROM json_each(?))');
  const relationsBySource = db.prepare('SELECT * FROM relations WHERE source_id = ? AND type IN (SELECT value FROM json_each(?))');
  const allRelationsForIds = db.prepare(`SELECT * FROM relations WHERE source_id IN (SELECT value FROM json_each(?)) OR target_id IN (SELECT value FROM json_each(?))`);
  const navigationById = db.prepare('SELECT * FROM navigation WHERE node_id = ?');
  const symbolCount = db.prepare('SELECT count(*) AS count FROM symbols');
  const relationCount = db.prepare('SELECT count(*) AS count FROM relations');
  const fileCount = db.prepare('SELECT count(*) AS count FROM files');
  const index = {
    storeRoot: path.dirname(path.dirname(path.dirname(snapshotDir))),
    snapshotDir, manifest, db, databasePath,
    searchNodes(query, limit = 24) {
      const terms = [...new Set(String(query).split(/[^\p{L}\p{N}_$]+/u).filter(Boolean))];
      if (!terms.length) return [];
      const ftsQuery = terms.map((term) => `"${sqlQuote(term)}"*`).join(' OR ');
      return searchStatement.all(ftsQuery, limit).map((row) => ({ ...row, score: 1 / (1 + Math.max(0, Number(row.rank) || 0)) }));
    },
    getSymbol(symbolId) { return rowToSymbol(symbolById.get(symbolId), manifest.snapshotId); },
    getSymbols(ids) { return symbolsById.all(JSON.stringify(ids)).map((row) => rowToSymbol(row, manifest.snapshotId)); },
    getFile(fileId) { return rowToFile(fileById.get(fileId)); },
    getFiles(ids) { return filesByIds.all(JSON.stringify(ids)).map(rowToFile); },
    getRelationsForTarget(targetId, types) { return relationsByTarget.all(targetId, JSON.stringify(types)); },
    getRelationsForSource(sourceId, types) { return relationsBySource.all(sourceId, JSON.stringify(types)); },
    getRelationsForSymbols(ids) { const encoded = JSON.stringify(ids); return allRelationsForIds.all(encoded, encoded); },
    getNavigation(nodeId) { return rowToNavigation(navigationById.get(nodeId)); },
    stats() { return { files: fileCount.get().count, symbols: symbolCount.get().count, relations: relationCount.get().count }; },
    close() { db.close(); },
  };
  return index;
}

export function ensureIndexDatabase(snapshotDir, manifest) {
  const existing = openIndexDatabase(snapshotDir, manifest);
  if (existing) return existing;
  throw new Error(`索引数据库缺失：${path.join(snapshotDir, 'index.db')}，请重新执行 index 命令生成索引。`);
}
