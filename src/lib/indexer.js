import fs from 'node:fs';
import path from 'node:path';
import { parseEntries } from '../parsers/index.js';
import { gitContext } from './git.js';
import { hashText, shortHash, stableJson } from './hash.js';
import { PARSER_VERSION, readJson, readJsonl, repositoryId, routeTerms, scanRepository, spanFrom, writeJsonAtomic, writeJsonl } from './fs.js';
import { buildIndexDatabase, ensureIndexDatabase } from './sqlite-store.js';

const INDEX_SCHEMA = 'codeindex-index-0.1.0';

function nodeId(kind, value) { return `${kind}:${shortHash(value, 24)}`; }

function loadPublished(storeRoot, repoId) {
  const published = readJson(path.join(storeRoot, repoId, 'published.json'));
  if (!published?.snapshotId) return null;
  const snapshotDir = path.join(storeRoot, repoId, 'snapshots', published.snapshotId);
  const manifest = readJson(path.join(snapshotDir, 'manifest.json'));
  if (!manifest) return null;
  return { published, snapshotDir, manifest, files: readJsonl(path.join(snapshotDir, 'files.jsonl')), parsed: readJsonl(path.join(snapshotDir, 'parsed.jsonl')) };
}

function normalizeTarget(targetName) {
  return String(targetName || '').replace(/^\.+/, '').replace(/^['"]|['"]$/g, '').replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, '').replaceAll('/', '.').replace(/^\.+/, '');
}

function resolveRelationTarget(relation, indexes, filePath) {
  const raw = normalizeTarget(relation.targetName);
  if (!raw) return null;
  if (relation.type === 'imports') {
    const exactModule = indexes.moduleByQualified.get(raw) || [...indexes.moduleByQualified.values()].find((item) => item.qualifiedName.endsWith(`.${raw}`));
    if (exactModule) return exactModule;
    const relative = raw.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(filePath), raw)) : raw;
    const modulePath = relative.replace(/^\.\//, '').replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, '');
    return indexes.moduleByPath.get(modulePath) || indexes.moduleByQualified.get(modulePath.replaceAll('/', '.')) || null;
  }
  const leaf = raw.split('.').pop();
  const sameFile = indexes.symbolsByFileName.get(`${filePath}\0${leaf}`) || [];
  if (sameFile.length === 1) return sameFile[0];
  const exact = indexes.symbolsByQualified.get(raw);
  if (exact) return exact;
  const named = indexes.symbolsByName.get(leaf) || [];
  return named.length === 1 ? named[0] : null;
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

function previousFileMap(previous) {
  return new Map((previous?.files || []).map((file) => [file.path, file]));
}

export function validateIndexData({ tempDir, manifest, files, symbols, containment, relations }) {
  const errors = [];
  const fileById = new Map(files.map((file) => [file.fileId, file]));
  const nodeIds = new Set(containment.map((node) => node.nodeId));
  for (const file of files) {
    const sourcePath = path.join(tempDir, 'source', file.digest);
    if (!fs.existsSync(sourcePath)) errors.push(`missing-source:${file.path}`);
    else if (hashText(fs.readFileSync(sourcePath, 'utf8')) !== file.digest) errors.push(`source-digest:${file.path}`);
  }
  for (const symbol of symbols) {
    const file = fileById.get(symbol.fileId);
    if (!file) errors.push(`symbol-file:${symbol.symbolId}`);
    if (!nodeIds.has(symbol.symbolId)) errors.push(`symbol-node:${symbol.symbolId}`);
    if (!nodeIds.has(symbol.parentId)) errors.push(`symbol-parent:${symbol.symbolId}`);
    if (file && (symbol.sourceSpan.startLine < 1 || symbol.sourceSpan.endLine < symbol.sourceSpan.startLine || symbol.sourceSpan.endLine > file.lineCount + 1)) errors.push(`symbol-span:${symbol.symbolId}`);
  }
  for (const node of containment) {
    if (node.parentId && !nodeIds.has(node.parentId)) errors.push(`node-parent:${node.nodeId}`);
  }
  const symbolIds = new Set(symbols.map((symbol) => symbol.symbolId));
  for (const relation of relations) {
    if (!symbolIds.has(relation.sourceId)) errors.push(`relation-source:${relation.relationId}`);
    if (relation.status === 'resolved' && !symbolIds.has(relation.targetId)) errors.push(`relation-target:${relation.relationId}`);
    if (!relation.sourceSpan?.path || !fileById.has(files.find((file) => file.path === relation.sourceSpan.path)?.fileId)) errors.push(`relation-span:${relation.relationId}`);
  }
  if (errors.length) throw new Error(`index validation failed (${errors.length}): ${errors.slice(0, 8).join(', ')}`);
  return { valid: true, checked: { files: files.length, symbols: symbols.length, nodes: containment.length, relations: relations.length }, snapshotId: manifest.snapshotId };
}

export function indexRepository(repoRoot, storeRoot, { incremental = true, maxFileBytes } = {}) {
  const startedAt = Date.now();
  const repo = fs.realpathSync(repoRoot);
  fs.mkdirSync(storeRoot, { recursive: true });
  const repoId = repositoryId(repo);
  const previous = incremental ? loadPublished(storeRoot, repoId) : null;
  const currentGit = gitContext(repo);
  if (previous && currentGit.revision && currentGit.revision === previous.manifest.git?.revision && !currentGit.dirty && !previous.manifest.git?.dirty) {
    return { manifest: previous.manifest, snapshotDir: previous.snapshotDir, stats: { ...previous.manifest.stats, changedFiles: 0, reusedFiles: previous.manifest.stats.files, buildMs: Date.now() - startedAt, noOp: true } };
  }
  const scan = scanRepository(repo, { maxFileBytes, retainSource: false });
  const priorFiles = previousFileMap(previous);
  const parsedPrevious = new Map((previous?.parsed || []).map((record) => [record.path, record]));
  const entries = scan.files;
  const scannedContentDigest = hashText(stableJson(entries.map((entry) => ({ path: entry.path, digest: entry.digest, language: entry.language }))));
  if (previous && previous.manifest.contentDigest === scannedContentDigest) {
    return { manifest: previous.manifest, snapshotDir: previous.snapshotDir, stats: { ...previous.manifest.stats, changedFiles: 0, reusedFiles: entries.length, buildMs: Date.now() - startedAt, noOp: true } };
  }
  const changedEntries = entries.filter((entry) => {
    const old = priorFiles.get(entry.path);
    return !old || old.digest !== entry.digest || old.language !== entry.language || old.parserVersion !== PARSER_VERSION;
  });
  for (const entry of changedEntries) entry.source = fs.readFileSync(entry.absolute, 'utf8');
  const parsedChanged = parseEntries(changedEntries);
  for (const entry of changedEntries) delete entry.source;
  const parsedByFile = new Map();
  for (const entry of entries) parsedByFile.set(entry.path, parsedChanged.get(entry.path) || parsedPrevious.get(entry.path) || { path: entry.path, status: 'partial', error: 'missing-parser-result', symbols: [], relations: [] });

  const fileNodes = [];
  const fileRecords = [];
  const allSymbols = [];
  const rawRelations = [];
  const lineBytesByPath = new Map();
  const tempId = `${process.pid}-${Date.now()}`;
  const tempDir = path.join(storeRoot, repoId, 'snapshots', `.build-${tempId}`);
  const sourceDir = path.join(tempDir, 'source');
  fs.mkdirSync(sourceDir, { recursive: true });
  const treeNodes = buildDirectories(entries, repoId);
  const directoryById = new Map(treeNodes.map((node) => [node.nodeId, node]));

  for (const entry of entries) {
    const source = fs.readFileSync(entry.absolute, 'utf8');
    const sourceBuffer = Buffer.from(source, 'utf8');
    const lineOffsets = [0];
    for (let byteIndex = 0; byteIndex < sourceBuffer.length; byteIndex += 1) if (sourceBuffer[byteIndex] === 10) lineOffsets.push(byteIndex + 1);
    lineBytesByPath.set(entry.path, { lineOffsets, byteLength: sourceBuffer.length });
    const fileId = nodeId('file', entry.path);
    const parsed = parsedByFile.get(entry.path);
    const fileNode = { nodeId: fileId, parentId: entry.parentNodeId, nodeType: 'file', kind: 'file', title: entry.path.split('/').pop(), path: entry.path, language: entry.language, children: [] };
    fileNodes.push(fileNode);
    directoryById.get(entry.parentNodeId)?.children.push(fileId);
    fs.writeFileSync(path.join(sourceDir, entry.digest), source);
    const fileRecord = { path: entry.path, fileId, language: entry.language, bytes: entry.bytes, digest: entry.digest, lineCount: entry.lineCount, parserVersion: PARSER_VERSION, parseStatus: parsed.status, parseError: parsed.error || null };
    fileRecords.push(fileRecord);
    for (const symbol of parsed.symbols || []) {
      const symbolId = nodeId('symbol', symbol.key);
      const sourceSpan = { ...spanFrom(source, symbol.span.startLine, symbol.span.endLine, symbol.span.startColumn, symbol.span.endColumn), path: entry.path, blobDigest: entry.digest, snapshotId: null };
      const symbolRecord = { symbolId, key: symbol.key, path: entry.path, fileId, parentKey: symbol.parentKey, kind: symbol.kind, name: symbol.name, qualifiedName: symbol.qualifiedName, signature: symbol.signature, sourceSpan, doc: symbol.doc || null, language: entry.language };
      allSymbols.push(symbolRecord);
    }
    for (const relation of parsed.relations || []) rawRelations.push({ ...relation, path: entry.path, fileId, digest: entry.digest, language: entry.language });
  }

  const symbolByKey = new Map(allSymbols.map((symbol) => [symbol.key, symbol]));
  const moduleRecords = allSymbols.filter((symbol) => symbol.kind === 'module');
  const indexes = {
    moduleByQualified: new Map(moduleRecords.map((symbol) => [symbol.qualifiedName, symbol])),
    moduleByPath: new Map(moduleRecords.map((symbol) => [symbol.path.replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, ''), symbol])),
    symbolsByQualified: new Map(allSymbols.map((symbol) => [symbol.qualifiedName, symbol])),
    symbolsByName: new Map(),
    symbolsByFileName: new Map(),
  };
  for (const symbol of allSymbols) {
    const byName = indexes.symbolsByName.get(symbol.name) || [];
    byName.push(symbol); indexes.symbolsByName.set(symbol.name, byName);
    const byFileNameKey = `${symbol.path}\0${symbol.name}`;
    const byFileName = indexes.symbolsByFileName.get(byFileNameKey) || [];
    byFileName.push(symbol); indexes.symbolsByFileName.set(byFileNameKey, byFileName);
  }
  const symbolBySpecialKey = new Map();
  for (const symbol of allSymbols) {
    symbolBySpecialKey.set(`symbol-key:${symbol.path}:${symbol.name}:${symbol.sourceSpan.startLine}`, symbol);
  }
  const containmentNodes = [...treeNodes, ...fileNodes];
  const containmentById = new Map(containmentNodes.map((node) => [node.nodeId, node]));
  const fileNodeByPath = new Map(fileNodes.map((file) => [file.path, file]));
  for (const symbol of allSymbols) {
    const parent = symbolByKey.get(symbol.parentKey) || symbolBySpecialKey.get(symbol.parentKey) || (symbol.parentKey?.startsWith('file:') ? fileNodeByPath.get(symbol.path) : null);
    symbol.parentId = parent?.nodeId || nodeId('file', symbol.path);
    const node = { nodeId: symbol.symbolId, parentId: symbol.parentId, nodeType: 'symbol', kind: symbol.kind, title: symbol.name, path: symbol.path, language: symbol.language, qualifiedName: symbol.qualifiedName, signature: symbol.signature, sourceSpan: symbol.sourceSpan, children: [] };
    containmentNodes.push(node);
    containmentById.set(node.nodeId, node);
    const parentNode = containmentById.get(symbol.parentId);
    if (parentNode && !parentNode.children.includes(node.nodeId)) parentNode.children.push(node.nodeId);
  }
  for (const symbol of allSymbols) symbol.sourceSpan.snapshotId = null;
  const relationRecords = [];
  for (const raw of rawRelations) {
    const source = symbolByKey.get(raw.sourceKey) || symbolBySpecialKey.get(raw.sourceKey);
    if (!source) continue;
    const target = resolveRelationTarget(raw, indexes, raw.path);
    const lineInfo = lineBytesByPath.get(raw.path) || { lineOffsets: [0], byteLength: 0 };
    const lineIndex = Math.max(0, (raw.line || 1) - 1);
    const sourceStartByte = lineInfo.lineOffsets[lineIndex] || 0;
    const sourceEndByte = lineInfo.lineOffsets[lineIndex + 1] || lineInfo.byteLength;
    const sourceSpan = { path: raw.path, startLine: raw.line || 1, endLine: raw.line || 1, startColumn: raw.column || 0, endColumn: 0, startByte: sourceStartByte, endByte: sourceEndByte, blobDigest: raw.digest, snapshotId: null };
    relationRecords.push({ relationId: nodeId('relation', `${raw.path}:${raw.type}:${raw.line}:${raw.column || 0}:${raw.targetName}:${source.symbolId}:${relationRecords.length}`), type: raw.type, sourceId: source.symbolId, targetId: target?.symbolId || null, targetName: raw.targetName, status: target ? 'resolved' : 'unresolved', confidence: target ? 1 : 0, sourceSpan, context: { language: raw.language, parserVersion: PARSER_VERSION } });
  }

  const byParent = new Map();
  for (const node of containmentNodes) {
    const children = byParent.get(node.parentId) || [];
    children.push(node);
    byParent.set(node.parentId, children);
  }
  const fileByPath = new Map(fileRecords.map((file) => [file.path, file]));
  const navigation = containmentNodes.map((node) => {
    const children = byParent.get(node.nodeId) || [];
    const file = fileByPath.get(node.path);
    const summary = makeSummary(node, children, file);
    return { nodeId: node.nodeId, title: node.title, path: node.path, nodeType: node.nodeType, summary: summary.summary, routeTerms: summary.routeTerms, inputDigest: hashText(stableJson({ node, children: children.map((child) => child.nodeId) })) };
  });

  const git = currentGit;
  const contentDigest = hashText(stableJson(fileRecords.map(({ path: filePath, digest, language }) => ({ path: filePath, digest, language }))));
  const snapshotId = `snapshot:${repoId}:${contentDigest.slice(0, 24)}`;
  const partialFiles = fileRecords.filter((file) => file.parseStatus !== 'complete').length;
  const manifest = {
    schema: INDEX_SCHEMA, parserVersion: PARSER_VERSION, repositoryId: repoId, repositoryPath: repo,
    snapshotId, createdAt: new Date().toISOString(), git, contentDigest, fileCount: fileRecords.length,
    status: partialFiles ? 'partial' : 'published',
    skipped: scan.skipped,
    stats: { files: fileRecords.length, sourceBytes: fileRecords.reduce((sum, file) => sum + file.bytes, 0), changedFiles: changedEntries.length, reusedFiles: entries.length - changedEntries.length, symbols: allSymbols.length, relations: relationRecords.length, partialFiles, skipped: scan.skipped.length, buildMs: Date.now() - startedAt },
    coverage: { sourceFiles: fileRecords.length, parsedFiles: fileRecords.filter((file) => file.parseStatus === 'complete').length, unsupportedFiles: fileRecords.filter((file) => file.parseStatus === 'unsupported').length, partialFiles, skippedFiles: scan.skipped.length },
    publishing: { state: 'validated', permissionView: 'public' },
  };
  for (const symbol of allSymbols) symbol.sourceSpan.snapshotId = snapshotId;
  for (const relation of relationRecords) relation.sourceSpan.snapshotId = snapshotId;
  validateIndexData({ tempDir, manifest, files: fileRecords, symbols: allSymbols, containment: containmentNodes, relations: relationRecords });
  writeJsonAtomic(path.join(tempDir, 'manifest.json'), manifest);
  writeJsonl(path.join(tempDir, 'files.jsonl'), fileRecords);
  writeJsonl(path.join(tempDir, 'symbols.jsonl'), allSymbols);
  writeJsonl(path.join(tempDir, 'containment.jsonl'), containmentNodes);
  writeJsonl(path.join(tempDir, 'relations.jsonl'), relationRecords);
  writeJsonl(path.join(tempDir, 'navigation.jsonl'), navigation);
  writeJsonl(path.join(tempDir, 'parsed.jsonl'), [...parsedByFile.values()]);
  buildIndexDatabase(tempDir, { files: fileRecords, symbols: allSymbols, containment: containmentNodes, relations: relationRecords, navigation });
  const snapshotDir = path.join(storeRoot, repoId, 'snapshots', snapshotId);
  fs.mkdirSync(path.dirname(snapshotDir), { recursive: true });
  if (!fs.existsSync(snapshotDir)) fs.renameSync(tempDir, snapshotDir); else fs.rmSync(tempDir, { recursive: true, force: true });
  writeJsonAtomic(path.join(storeRoot, repoId, 'published.json'), { repositoryId: repoId, snapshotId, publishedAt: new Date().toISOString() });
  return { manifest, snapshotDir, stats: manifest.stats };
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
