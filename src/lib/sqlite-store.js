import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readJsonl } from './fs.js';

const SCHEMA_VERSION = 'codeindex-sqlite-0.1.0';

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
      end_byte INTEGER
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
      line INTEGER NOT NULL,
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

function insertRows(db, { files, symbols, containment, relations, navigation }) {
  const insertFile = db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertSymbol = db.prepare('INSERT INTO symbols VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertNode = db.prepare('INSERT INTO containment VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertRelation = db.prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertNavigation = db.prepare('INSERT INTO navigation VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertSearch = db.prepare('INSERT INTO search_fts(node_id, node_type, name, qualified_name, signature, doc, summary, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const file of files) insertFile.run(file.fileId, file.path, file.language, file.bytes, file.digest, file.lineCount, file.parseStatus, file.parseError);
  for (const symbol of symbols) {
    const span = symbol.sourceSpan;
    insertSymbol.run(symbol.symbolId, symbol.key, symbol.path, symbol.fileId, symbol.parentId || null, symbol.kind, symbol.name, symbol.qualifiedName, symbol.signature || '', symbol.doc || '', symbol.language, span.startLine, span.endLine, span.startColumn, span.endColumn, span.startByte, span.endByte, span.blobDigest);
  }
  for (const node of containment) insertNode.run(node.nodeId, node.parentId || null, node.nodeType, node.kind || '', node.title, node.path || '', node.language || '', node.qualifiedName || '', node.signature || '', node.sourceSpan?.startLine || null, node.sourceSpan?.endLine || null, node.sourceSpan?.startByte || null, node.sourceSpan?.endByte || null);
  for (const relation of relations) insertRelation.run(relation.relationId, relation.type, relation.sourceId, relation.targetId || null, relation.targetName || '', relation.status, relation.confidence, relation.sourceSpan.path, relation.sourceSpan.startLine, relation.sourceSpan.blobDigest);
  for (const item of navigation) insertNavigation.run(item.nodeId, item.title, item.path || '', item.nodeType, item.summary, JSON.stringify(item.routeTerms || []), item.inputDigest);
  const nodeById = new Map(navigation.map((item) => [item.nodeId, item]));
  for (const symbol of symbols) {
    const item = nodeById.get(symbol.symbolId);
    insertSearch.run(symbol.symbolId, 'symbol', symbol.name, symbol.qualifiedName, symbol.signature || '', symbol.doc || '', item?.summary || '', symbol.path);
  }
  for (const item of navigation.filter((entry) => entry.nodeType === 'file' || entry.nodeType === 'directory' || entry.nodeType === 'repository')) {
    insertSearch.run(item.nodeId, item.nodeType, item.title, '', '', '', item.summary, item.path || '');
  }
}

export function buildIndexDatabase(snapshotDir, data) {
  const databasePath = path.join(snapshotDir, 'index.db');
  const tempPath = `${databasePath}.${process.pid}.${Date.now()}.tmp`;
  const db = new DatabaseSync(tempPath);
  try {
    createSchema(db);
    db.exec('BEGIN');
    insertRows(db, data);
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  db.close();
  fs.renameSync(tempPath, databasePath);
  return databasePath;
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
  const data = {
    files: readJsonl(path.join(snapshotDir, 'files.jsonl')),
    symbols: readJsonl(path.join(snapshotDir, 'symbols.jsonl')),
    containment: readJsonl(path.join(snapshotDir, 'containment.jsonl')),
    relations: readJsonl(path.join(snapshotDir, 'relations.jsonl')),
    navigation: readJsonl(path.join(snapshotDir, 'navigation.jsonl')),
  };
  buildIndexDatabase(snapshotDir, data);
  return openIndexDatabase(snapshotDir, manifest);
}
