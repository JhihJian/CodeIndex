import fs from 'node:fs';
import path from 'node:path';
import { parseEntriesBatched } from '../parsers/index.js';
import { gitContext } from './git.js';
import { hashText, shortHash, stableJson } from './hash.js';
import { PARSER_VERSION, iterateJsonl, readJson, readJsonl, repositoryId, routeTerms, scanRepository, sourceLayout, spanFrom, writeJsonAtomic, writeJsonl } from './fs.js';
import { createIndexBuildSession, ensureIndexDatabase } from './sqlite-store.js';

const INDEX_SCHEMA = 'codeindex-index-0.2.0';

function nodeId(kind, value) { return `${kind}:${shortHash(value, 24)}`; }

function loadPublishedManifest(storeRoot, repoId) {
  const published = readJson(path.join(storeRoot, repoId, 'published.json'));
  if (!published?.snapshotId) return null;
  const snapshotDir = path.join(storeRoot, repoId, 'snapshots', published.snapshotId);
  const manifest = readJson(path.join(snapshotDir, 'manifest.json'));
  if (!manifest) return null;
  return { published, snapshotDir, manifest };
}

function normalizeTarget(targetName) {
  return String(targetName || '').replace(/^\.+/, '').replace(/^['"]|['"]$/g, '').replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, '').replaceAll('/', '.').replace(/^\.+/, '');
}

function relationTargetFields(relation, entry, entries) {
  const clean = String(relation.targetName || '').trim().replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '');
  const normalized = normalizeTarget(clean);
  let modulePath = clean;
  if (relation.type === 'includes') {
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), clean));
    modulePath = entries.has(relative) ? relative : clean;
  } else if (relation.type === 'imports' && entry.language === 'python') {
    if (relation.importLevel > 0) {
      let base = path.posix.dirname(entry.path);
      for (let level = 1; level < relation.importLevel; level++) base = path.posix.dirname(base);
      modulePath = path.posix.join(base, (relation.importModule || relation.importName || '').replaceAll('.', '/'));
    } else modulePath = (relation.importModule || clean).replaceAll('.', '/');
  } else if (relation.type === 'imports' && clean.startsWith('.')) {
    modulePath = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), clean));
  }
  modulePath = modulePath.replace(/^\.\//, '');
  return {
    targetNormalized: ['imports', 'includes'].includes(relation.type) ? modulePath.replaceAll('/', '.') : normalized,
    targetLeaf: normalized.split('.').pop() || normalized,
    targetModulePath: modulePath,
  };
}

function makeSummary(node, children, file) {
  const childNames = children.slice(0, 12).map((child) => child.title).filter(Boolean);
  const pieces = [];
  if (node.kind) pieces.push(`${node.kind} ${node.title}`);
  if (node.signature && node.signature !== node.title) pieces.push(node.signature);
  if (node.doc) pieces.push(node.doc);
  if (childNames.length) pieces.push(`contains: ${childNames.join(', ')}`);
  if (file?.language) pieces.push(`language: ${file.language}`);
  const summary = pieces.join('. ').slice(0, 900);
  return { summary: summary || node.title, routeTerms: routeTerms(`${node.title} ${node.signature || ''} ${node.doc || ''} ${childNames.join(' ')}`) };
}

function buildDirectories(files, repoId) {
  const nodes = [{ nodeId: nodeId('root', repoId), parentId: null, nodeType: 'repository', kind: 'repository', title: repoId, path: '', children: [] }];
  const byPath = new Map([['', nodes[0]]]);
  for (const file of files) {
    const parts = file.path.split('/');
    let current = '';
    let parent = nodes[0];
    for (let i = 0; i < parts.length - 1; i += 1) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      if (!byPath.has(current)) {
        const node = { nodeId: nodeId('dir', current), parentId: parent.nodeId, nodeType: 'directory', kind: 'directory', title: parts[i], path: current, children: [] };
        nodes.push(node); byPath.set(current, node); parent.children.push(node.nodeId);
      }
      parent = byPath.get(current);
    }
    file.parentNodeId = parent.nodeId;
  }
  return nodes;
}

function createJsonlWriter(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  let buffer = '';
  let closed = false;
  return {
    write(value) {
      buffer += `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(buffer, 'utf8') >= 1024 * 1024) {
        fs.writeSync(fd, buffer);
        buffer = '';
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try { if (buffer) fs.writeSync(fd, buffer); }
      finally { fs.closeSync(fd); }
    },
  };
}

function sourceSpanFromRow(row, snapshotId) {
  return {
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    startByte: row.start_byte,
    endByte: row.end_byte,
    blobDigest: row.blob_digest,
    snapshotId,
  };
}

function* symbolRows(db, snapshotId) {
  for (const row of db.prepare('SELECT * FROM symbols ORDER BY rowid').iterate()) {
    yield {
      symbolId: row.symbol_id,
      key: row.symbol_key,
      parentKey: row.parent_key,
      path: row.path,
      fileId: row.file_id,
      parentId: row.parent_id,
      kind: row.kind,
      name: row.name,
      qualifiedName: row.qualified_name,
      signature: row.signature,
      sourceSpan: sourceSpanFromRow(row, snapshotId),
      doc: row.doc || null,
      language: row.language,
    };
  }
}

function* containmentRows(db, snapshotId) {
  for (const row of db.prepare(`SELECT c.*, s.start_column, s.end_column FROM containment c
    LEFT JOIN symbols s ON s.symbol_id = c.node_id ORDER BY c.rowid`).iterate()) {
    const item = { nodeId: row.node_id, parentId: row.parent_id, nodeType: row.node_type, kind: row.kind, title: row.title, path: row.path, language: row.language, qualifiedName: row.qualified_name, signature: row.signature };
    if (row.start_line !== null) item.sourceSpan = sourceSpanFromRow(row, snapshotId);
    yield item;
  }
}

function* relationRows(db, snapshotId) {
  for (const row of db.prepare('SELECT relations.*, symbols.language FROM relations JOIN symbols ON symbols.symbol_id = relations.source_id ORDER BY relations.rowid').iterate()) {
    yield {
      relationId: row.relation_id,
      type: row.type,
      sourceId: row.source_id,
      targetId: row.target_id,
      targetName: row.target_name,
      status: row.status,
      confidence: row.confidence,
      sourceSpan: sourceSpanFromRow(row, snapshotId),
      context: { language: row.language, parserVersion: PARSER_VERSION },
    };
  }
}

function* navigationRows(db) {
  for (const row of db.prepare('SELECT * FROM navigation ORDER BY rowid').iterate()) {
    yield { nodeId: row.node_id, title: row.title, path: row.path, nodeType: row.node_type, summary: row.summary, routeTerms: JSON.parse(row.route_terms || '[]'), inputDigest: row.input_digest };
  }
}

function buildNavigation(session) {
  const { db } = session;
  db.exec(`
    CREATE TEMP TABLE containment_child_summary AS
      SELECT parent_id,
        json_group_array(title) AS child_titles,
        json_group_array(node_id) AS child_ids
      FROM (
        SELECT parent_id, node_id, title,
          row_number() OVER (PARTITION BY parent_id ORDER BY path, start_line, node_type, title, node_id) AS child_number
        FROM containment
        WHERE parent_id IS NOT NULL
      )
      WHERE child_number <= 12
      GROUP BY parent_id;
    CREATE UNIQUE INDEX temp.child_summary_parent ON containment_child_summary(parent_id);
  `);
  const rows = db.prepare(`
    SELECT containment.*, symbols.doc AS symbol_doc, files.language AS file_language,
      containment_child_summary.child_titles, containment_child_summary.child_ids
    FROM containment
    LEFT JOIN symbols ON symbols.symbol_id = containment.node_id
    LEFT JOIN files ON files.path = containment.path
    LEFT JOIN containment_child_summary ON containment_child_summary.parent_id = containment.node_id
    ORDER BY containment.rowid
  `);
  session.begin();
  try {
    for (const row of rows.iterate()) {
      const childTitles = row.child_titles ? JSON.parse(row.child_titles).map((title) => ({ title })) : [];
      const childIds = row.child_ids ? JSON.parse(row.child_ids) : [];
      const node = {
        nodeId: row.node_id,
        parentId: row.parent_id,
        nodeType: row.node_type,
        kind: row.kind,
        title: row.title,
        path: row.path,
        language: row.language,
        qualifiedName: row.qualified_name,
        signature: row.signature,
        doc: row.symbol_doc || null,
        children: [],
      };
      if (row.start_line !== null) node.sourceSpan = sourceSpanFromRow(row, null);
      const summary = makeSummary(node, childTitles, row.file_language ? { language: row.file_language } : null);
      const item = { nodeId: row.node_id, title: row.title, path: row.path, nodeType: row.node_type, summary: summary.summary, routeTerms: summary.routeTerms, inputDigest: hashText(stableJson({ node, children: childIds })) };
      session.insertNavigation(item);
      session.insertSearch({ ...item, name: row.title, qualifiedName: row.qualified_name || '', signature: row.signature || '', doc: row.symbol_doc || '' });
    }
    session.commit();
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function validateIndexDatabase({ session, tempDir, manifest, files }) {
  const errors = [];
  for (const file of files) {
    const sourcePath = path.join(tempDir, 'source', file.digest);
    if (!fs.existsSync(sourcePath)) errors.push(`missing-source:${file.path}`);
    else if (hashText(fs.readFileSync(sourcePath, 'utf8')) !== file.digest) errors.push(`source-digest:${file.path}`);
  }
  const { db } = session;
  const checks = [
    ['symbol-file', 'SELECT count(*) AS count FROM symbols s LEFT JOIN files f ON f.file_id = s.file_id WHERE f.file_id IS NULL'],
    ['symbol-node', 'SELECT count(*) AS count FROM symbols s LEFT JOIN containment c ON c.node_id = s.symbol_id WHERE c.node_id IS NULL'],
    ['symbol-parent', 'SELECT count(*) AS count FROM symbols s LEFT JOIN containment c ON c.node_id = s.parent_id WHERE c.node_id IS NULL'],
    ['node-parent', 'SELECT count(*) AS count FROM containment c LEFT JOIN containment p ON p.node_id = c.parent_id WHERE c.parent_id IS NOT NULL AND p.node_id IS NULL'],
    ['symbol-span', 'SELECT count(*) AS count FROM symbols s JOIN files f ON f.file_id = s.file_id WHERE s.start_line < 1 OR s.end_line < s.start_line OR s.end_line > f.line_count + 1 OR s.start_byte < 0 OR s.end_byte < s.start_byte OR s.end_byte > f.bytes OR s.blob_digest != f.digest'],
    ['relation-source', 'SELECT count(*) AS count FROM relations r LEFT JOIN symbols s ON s.symbol_id = r.source_id WHERE s.symbol_id IS NULL'],
    ['relation-target', "SELECT count(*) AS count FROM relations r LEFT JOIN symbols s ON s.symbol_id = r.target_id WHERE r.status = 'resolved' AND s.symbol_id IS NULL"],
    ['relation-span', 'SELECT count(*) AS count FROM relations r LEFT JOIN files f ON f.path = r.path WHERE f.file_id IS NULL'],
  ];
  for (const [name, query] of checks) {
    const count = Number(db.prepare(query).get().count);
    if (count) errors.push(`${name}:${count}`);
  }
  if (errors.length) throw new Error(`index validation failed (${errors.length}): ${errors.slice(0, 8).join(', ')}`);
  return { valid: true, checked: { files: files.length, symbols: manifest.stats.symbols, nodes: manifest.stats.symbols + files.length, relations: manifest.stats.relations }, snapshotId: manifest.snapshotId };
}

function processEntry({ entry, parsed, session, tempDir, fileRecords, parsedWriter, entries }) {
  const source = fs.readFileSync(entry.absolute, 'utf8');
  const sourceBuffer = Buffer.from(source, 'utf8');
  if (hashText(source) !== entry.digest) throw new Error(`source-changed:${entry.path}`);
  const layout = sourceLayout(source, sourceBuffer);
  const fileId = nodeId('file', entry.path);
  const fileNode = { nodeId: fileId, parentId: entry.parentNodeId, nodeType: 'file', kind: 'file', title: entry.path.split('/').pop(), path: entry.path, language: entry.language, children: [] };
  const fileRecord = { path: entry.path, fileId, language: entry.language, bytes: entry.bytes, digest: entry.digest, lineCount: entry.lineCount, parserVersion: PARSER_VERSION, parseStatus: parsed.status, parseError: parsed.error || null };
  fs.writeFileSync(path.join(tempDir, 'source', entry.digest), source);
  session.insertFile(fileRecord);
  session.insertNode(fileNode);
  fileRecords.push(fileRecord);
  const keyAliases = new Map((parsed.symbols || []).map((symbol) => [`symbol-key:${entry.path}:${symbol.name}:${symbol.span.startLine}`, symbol.key]));
  for (const symbol of parsed.symbols || []) {
    const symbolId = nodeId('symbol', symbol.key);
    const sourceSpan = { ...spanFrom(source, symbol.span.startLine, symbol.span.endLine, symbol.span.startColumn, symbol.span.endColumn, layout), path: entry.path, blobDigest: entry.digest, snapshotId: null };
    session.insertSymbol({ symbolId, key: symbol.key, parentKey: keyAliases.get(symbol.parentKey) || symbol.parentKey, path: entry.path, fileId, kind: symbol.kind, name: symbol.name, qualifiedName: symbol.qualifiedName, signature: symbol.signature, sourceSpan, doc: symbol.doc || null, language: entry.language });
  }
  let relationIndex = 0;
  for (const relation of parsed.relations || []) {
    const fields = relationTargetFields(relation, entry, entries);
    const line = Math.max(1, relation.line || 1);
    const lineIndex = line - 1;
    const startByte = layout.byteOffsets[lineIndex] || 0;
    const endByte = layout.byteOffsets[lineIndex + 1] || layout.byteLength;
    const relationId = nodeId('relation', `${entry.path}:${relation.type}:${line}:${relation.column || 0}:${relation.targetName}:${relation.sourceKey}:${relationIndex}`);
    session.insertRelation({ relationId, sourceKey: keyAliases.get(relation.sourceKey) || relation.sourceKey, type: relation.type, targetName: relation.targetName, ...fields, path: entry.path, fileId, sourceSpan: { path: entry.path, startLine: line, endLine: line, startColumn: relation.column || 0, endColumn: 0, startByte, endByte, blobDigest: entry.digest } });
    relationIndex += 1;
  }
  parsedWriter.write(parsed);
  return relationIndex;
}

export function indexRepository(repoRoot, storeRoot, { incremental = true, maxFileBytes = 5 * 1024 * 1024, onProgress = () => {} } = {}) {
  const startedAt = Date.now();
  const stages = {};
  let stageStarted = startedAt;
  function progress(stage) {
    stages[stage] = Date.now() - stageStarted;
    stageStarted = Date.now();
    onProgress({ stage, elapsedMs: Date.now() - startedAt, durationMs: stages[stage], rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
  }
  const repo = fs.realpathSync(repoRoot);
  fs.mkdirSync(storeRoot, { recursive: true });
  const repoId = repositoryId(repo);
  const previous = incremental ? loadPublishedManifest(storeRoot, repoId) : null;
  const currentGit = gitContext(repo);
  const buildConfig = { schema: INDEX_SCHEMA, parserVersion: PARSER_VERSION, maxFileBytes };
  const previousCompatible = previous && stableJson(previous.manifest.buildConfig) === stableJson(buildConfig) && fs.existsSync(path.join(previous.snapshotDir, 'index.db'));
  function noOp() {
    return { manifest: previous.manifest, snapshotDir: previous.snapshotDir, stats: { ...previous.manifest.stats, changedFiles: 0, reusedFiles: previous.manifest.stats.files, buildMs: Date.now() - startedAt, noOp: true } };
  }
  if (previousCompatible && currentGit.revision && currentGit.revision === previous.manifest.git?.revision && !currentGit.dirty && !previous.manifest.git?.dirty) return noOp();
  const scan = scanRepository(repo, { maxFileBytes, retainSource: false });
  const entries = scan.files;
  const contentDigest = hashText(stableJson(entries.map(({ path, digest, language }) => ({ path, digest, language }))));
  if (previousCompatible && previous.manifest.contentDigest === contentDigest) return noOp();
  const priorFiles = new Map();
  if (previousCompatible) for (const file of iterateJsonl(path.join(previous.snapshotDir, 'files.jsonl'))) priorFiles.set(file.path, file);
  const changedEntries = entries.filter((entry) => {
    const old = priorFiles.get(entry.path);
    return !old || old.digest !== entry.digest || old.language !== entry.language;
  });
  const snapshotId = `snapshot:${repoId}:${hashText(stableJson({ contentDigest, buildConfig })).slice(0, 24)}`;
  progress('scan');
  const tempDir = path.join(storeRoot, repoId, 'snapshots', `.build-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.join(tempDir, 'source'), { recursive: true });
  let session;
  let parsedWriter;
  const fileRecords = [];
  const processed = new Set();
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const changedPaths = new Set(changedEntries.map((entry) => entry.path));
  const treeNodes = buildDirectories(entries, repoId);
  try {
    session = createIndexBuildSession(tempDir);
    parsedWriter = createJsonlWriter(path.join(tempDir, 'parsed.jsonl'));
    session.begin();
    for (const node of treeNodes) session.insertNode(node);
    function consume(parsed) {
      const entry = entryByPath.get(parsed.path);
      if (!entry || processed.has(entry.path)) throw new Error(`unexpected-parser-result:${parsed.path}`);
      processEntry({ entry, parsed, session, tempDir, fileRecords, parsedWriter, entries: entryByPath });
      processed.add(entry.path);
      if (processed.size % 256 === 0) { session.commit(); session.begin(); }
      if (processed.size % 2000 === 0) onProgress({ stage: 'parse-progress', files: processed.size, elapsedMs: Date.now() - startedAt, rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
    }
    parseEntriesBatched(changedEntries, consume);
    if (previousCompatible && changedEntries.length < entries.length) {
      for (const parsed of iterateJsonl(path.join(previous.snapshotDir, 'parsed.jsonl'))) {
        if (entryByPath.has(parsed.path) && !changedPaths.has(parsed.path)) consume(parsed);
      }
    }
    if (processed.size !== entries.length) throw new Error('missing-parser-results');
    session.commit();
    parsedWriter.close();
    progress('parse-and-store');
    session.finalizeParents();
    progress('parents');
    session.finalizeContainment();
    progress('containment');
    session.finalizeRelations();
    progress('relations');
    buildNavigation(session);
    progress('navigation');
    session.rebuildIndexes();
    progress('indexes');
    const counts = session.counts();
    const partialFiles = fileRecords.filter((file) => file.parseStatus !== 'complete').length;
    const manifest = {
      schema: INDEX_SCHEMA, parserVersion: PARSER_VERSION, buildConfig, repositoryId: repoId, repositoryPath: repo,
      snapshotId, createdAt: new Date().toISOString(), git: currentGit, contentDigest, fileCount: fileRecords.length,
      status: partialFiles ? 'partial' : 'published', skipped: scan.skipped,
      stats: { files: counts.files, sourceBytes: fileRecords.reduce((sum, file) => sum + file.bytes, 0), changedFiles: changedEntries.length, reusedFiles: entries.length - changedEntries.length, symbols: counts.symbols, relations: counts.relations, partialFiles, skipped: scan.skipped.length },
      coverage: { sourceFiles: fileRecords.length, parsedFiles: fileRecords.filter((file) => file.parseStatus === 'complete').length, unsupportedFiles: fileRecords.filter((file) => file.parseStatus === 'unsupported').length, partialFiles, skippedFiles: scan.skipped.length },
      publishing: { state: 'validated', permissionView: 'public' },
    };
    validateIndexDatabase({ session, tempDir, manifest, files: fileRecords });
    progress('validation');
    writeJsonl(path.join(tempDir, 'files.jsonl'), fileRecords);
    writeJsonl(path.join(tempDir, 'symbols.jsonl'), symbolRows(session.db, snapshotId));
    writeJsonl(path.join(tempDir, 'containment.jsonl'), containmentRows(session.db, snapshotId));
    writeJsonl(path.join(tempDir, 'relations.jsonl'), relationRows(session.db, snapshotId));
    writeJsonl(path.join(tempDir, 'navigation.jsonl'), navigationRows(session.db));
    progress('exports');
    session.close();
    session = null;
    manifest.stats.buildMs = Date.now() - startedAt;
    manifest.stats.stages = stages;
    writeJsonAtomic(path.join(tempDir, 'manifest.json'), manifest);
    const snapshotDir = path.join(storeRoot, repoId, 'snapshots', snapshotId);
    if (fs.existsSync(snapshotDir)) {
      const existing = readJson(path.join(snapshotDir, 'manifest.json'));
      if (existing?.contentDigest !== contentDigest || stableJson(existing?.buildConfig) !== stableJson(buildConfig)) throw new Error('snapshot-identity-conflict');
      if (!fs.existsSync(path.join(snapshotDir, 'index.db'))) fs.renameSync(path.join(tempDir, 'index.db'), path.join(snapshotDir, 'index.db'));
      fs.rmSync(tempDir, { recursive: true, force: true });
    } else fs.renameSync(tempDir, snapshotDir);
    writeJsonAtomic(path.join(storeRoot, repoId, 'published.json'), { repositoryId: repoId, snapshotId, publishedAt: new Date().toISOString() });
    return { manifest, snapshotDir, stats: manifest.stats };
  } catch (error) {
    try { session?.db.exec('ROLLBACK'); } catch {}
    try { parsedWriter?.close(); } catch {}
    try { session?.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function loadIndex(storeRoot, repoId = null) {
  const rootEntries = fs.existsSync(storeRoot) ? fs.readdirSync(storeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('repo-')) : [];
  const selected = repoId || (rootEntries.length === 1 ? rootEntries[0].name : null);
  if (!selected) throw new Error('无法确定仓库索引，请指定 --repo-id 或只保留一个仓库索引');
  const published = readJson(path.join(storeRoot, selected, 'published.json'));
  if (!published?.snapshotId) throw new Error(`没有已发布索引: ${selected}`);
  const snapshotDir = path.join(storeRoot, selected, 'snapshots', published.snapshotId);
  const manifest = readJson(path.join(snapshotDir, 'manifest.json'));
  if (!manifest) throw new Error(`索引 manifest 不存在: ${snapshotDir}`);
  const runtime = ensureIndexDatabase(snapshotDir, manifest);
  return {
    storeRoot, repoId: selected, snapshotDir, manifest, ...runtime,
    get files() { return readJsonl(path.join(snapshotDir, 'files.jsonl')); },
    get symbols() { return readJsonl(path.join(snapshotDir, 'symbols.jsonl')); },
    get containment() { return readJsonl(path.join(snapshotDir, 'containment.jsonl')); },
    get relations() { return readJsonl(path.join(snapshotDir, 'relations.jsonl')); },
    get navigation() { return readJsonl(path.join(snapshotDir, 'navigation.jsonl')); },
  };
}
