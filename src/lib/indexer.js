import fs from 'node:fs';
import path from 'node:path';
import { parseEntries } from '../parsers/index.js';
import { gitContext } from './git.js';
import { hashText, shortHash, stableJson } from './hash.js';
import { PARSER_VERSION, readJson, readJsonl, repositoryId, routeTerms, scanRepository, spanFrom, writeJsonAtomic, writeJsonl } from './fs.js';

const INDEX_SCHEMA = 'codeindex-index-0.1.0';

function nodeId(kind, value) { return `${kind}:${shortHash(value, 24)}`; }

function loadPublished(storeRoot, repoId) {
  const published = readJson(path.join(storeRoot, repoId, 'published.json'));
  if (!published?.snapshotId) return null;
  const snapshotDir = path.join(storeRoot, repoId, 'snapshots', published.snapshotId);
  const manifest = readJson(path.join(snapshotDir, 'manifest.json'));
  if (!manifest) return null;
  return { published, snapshotDir, manifest, parsed: readJsonl(path.join(snapshotDir, 'parsed.jsonl')) };
}

function normalizeTarget(targetName) {
  return String(targetName || '').replace(/^\.+/, '').replace(/^['"]|['"]$/g, '').replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, '').replaceAll('/', '.').replace(/^\.+/, '');
}

function resolveRelationTarget(relation, sourceRecord, symbolRecords, moduleRecords, filePath) {
  const raw = normalizeTarget(relation.targetName);
  if (!raw) return null;
  if (relation.type === 'imports') {
    const exactModule = moduleRecords.find((item) => item.qualifiedName === raw || item.qualifiedName.endsWith(`.${raw}`));
    if (exactModule) return exactModule;
    const relative = raw.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(filePath), raw)) : raw;
    const modulePath = relative.replace(/^\.\//, '').replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, '');
    return moduleRecords.find((item) => item.path.replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, '') === modulePath || item.qualifiedName === modulePath.replaceAll('/', '.')) || null;
  }
  const leaf = raw.split('.').pop();
  const sameFile = symbolRecords.filter((item) => item.path === filePath && (item.name === leaf || item.qualifiedName === raw || item.qualifiedName.endsWith(`.${raw}`)));
  if (sameFile.length === 1) return sameFile[0];
  const exact = symbolRecords.filter((item) => item.qualifiedName === raw || item.name === leaf || item.qualifiedName.endsWith(`.${raw}`));
  return exact.length === 1 ? exact[0] : null;
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
  return new Map((previous?.manifest?.files || []).map((file) => [file.path, file]));
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
  const scan = scanRepository(repo, { maxFileBytes });
  const priorFiles = previousFileMap(previous);
  const parsedPrevious = new Map((previous?.parsed || []).map((record) => [record.path, record]));
  const entries = scan.files;
  const changedEntries = entries.filter((entry) => {
    const old = priorFiles.get(entry.path);
    return !old || old.digest !== entry.digest || old.language !== entry.language || old.parserVersion !== PARSER_VERSION;
  });
  const parsedChanged = parseEntries(changedEntries);
  const parsedByFile = new Map();
  for (const entry of entries) parsedByFile.set(entry.path, parsedChanged.get(entry.path) || parsedPrevious.get(entry.path) || { path: entry.path, status: 'partial', error: 'missing-parser-result', symbols: [], relations: [] });

  const fileNodes = [];
  const fileRecords = [];
  const allSymbols = [];
  const rawRelations = [];
  const tempId = `${process.pid}-${Date.now()}`;
  const tempDir = path.join(storeRoot, repoId, 'snapshots', `.build-${tempId}`);
  const sourceDir = path.join(tempDir, 'source');
  fs.mkdirSync(sourceDir, { recursive: true });
  const treeNodes = buildDirectories(entries, repoId);
  const directoryById = new Map(treeNodes.map((node) => [node.nodeId, node]));

  for (const entry of entries) {
    const fileId = nodeId('file', entry.path);
    const parsed = parsedByFile.get(entry.path);
    const fileNode = { nodeId: fileId, parentId: entry.parentNodeId, nodeType: 'file', kind: 'file', title: entry.path.split('/').pop(), path: entry.path, language: entry.language, children: [] };
    fileNodes.push(fileNode);
    directoryById.get(entry.parentNodeId)?.children.push(fileId);
    fs.writeFileSync(path.join(sourceDir, entry.digest), entry.source);
    const fileRecord = { path: entry.path, fileId, language: entry.language, bytes: entry.bytes, digest: entry.digest, lineCount: entry.lineCount, parserVersion: PARSER_VERSION, parseStatus: parsed.status, parseError: parsed.error || null };
    fileRecords.push(fileRecord);
    for (const symbol of parsed.symbols || []) {
      const symbolId = nodeId('symbol', symbol.key);
      const sourceSpan = { ...spanFrom(entry.source, symbol.span.startLine, symbol.span.endLine, symbol.span.startColumn, symbol.span.endColumn), path: entry.path, blobDigest: entry.digest, snapshotId: null };
      const symbolRecord = { symbolId, key: symbol.key, path: entry.path, fileId, parentKey: symbol.parentKey, kind: symbol.kind, name: symbol.name, qualifiedName: symbol.qualifiedName, signature: symbol.signature, sourceSpan, doc: symbol.doc || null, language: entry.language };
      allSymbols.push(symbolRecord);
    }
    for (const relation of parsed.relations || []) rawRelations.push({ ...relation, path: entry.path, fileId, digest: entry.digest, language: entry.language });
  }

  const symbolByKey = new Map(allSymbols.map((symbol) => [symbol.key, symbol]));
  const moduleRecords = allSymbols.filter((symbol) => symbol.kind === 'module');
  const symbolBySpecialKey = new Map();
  for (const symbol of allSymbols) {
    symbolBySpecialKey.set(`symbol-key:${symbol.path}:${symbol.name}:${symbol.sourceSpan.startLine}`, symbol);
  }
  const containmentNodes = [...treeNodes, ...fileNodes];
  for (const symbol of allSymbols) {
    const parent = symbolByKey.get(symbol.parentKey) || symbolBySpecialKey.get(symbol.parentKey) || (symbol.parentKey?.startsWith('file:') ? fileNodes.find((file) => file.path === symbol.path) : null);
    symbol.parentId = parent?.nodeId || nodeId('file', symbol.path);
    const node = { nodeId: symbol.symbolId, parentId: symbol.parentId, nodeType: 'symbol', kind: symbol.kind, title: symbol.name, path: symbol.path, language: symbol.language, qualifiedName: symbol.qualifiedName, signature: symbol.signature, sourceSpan: symbol.sourceSpan, children: [] };
    containmentNodes.push(node);
    const parentNode = containmentNodes.find((candidate) => candidate.nodeId === symbol.parentId);
    if (parentNode && !parentNode.children.includes(node.nodeId)) parentNode.children.push(node.nodeId);
  }
  for (const symbol of allSymbols) symbol.sourceSpan.snapshotId = null;
  const relationRecords = [];
  for (const raw of rawRelations) {
    const source = symbolByKey.get(raw.sourceKey) || symbolBySpecialKey.get(raw.sourceKey);
    if (!source) continue;
    const target = resolveRelationTarget(raw, source, allSymbols, moduleRecords, raw.path);
    const sourceSpan = { ...spanFrom(entries.find((entry) => entry.path === raw.path)?.source || '', raw.line || 1, raw.line || 1, raw.column || 0, 0), path: raw.path, blobDigest: raw.digest, snapshotId: null };
    relationRecords.push({ relationId: nodeId('relation', `${raw.path}:${raw.type}:${raw.line}:${raw.targetName}:${source.symbolId}`), type: raw.type, sourceId: source.symbolId, targetId: target?.symbolId || null, targetName: raw.targetName, status: target ? 'resolved' : 'unresolved', confidence: target ? 1 : 0, sourceSpan, context: { language: raw.language, parserVersion: PARSER_VERSION } });
  }

  const byParent = new Map();
  for (const node of containmentNodes) byParent.set(node.nodeId, containmentNodes.filter((child) => child.parentId === node.nodeId));
  const fileByPath = new Map(fileRecords.map((file) => [file.path, file]));
  const navigation = containmentNodes.map((node) => {
    const children = byParent.get(node.nodeId) || [];
    const file = fileByPath.get(node.path);
    const summary = makeSummary(node, children, file);
    return { nodeId: node.nodeId, title: node.title, path: node.path, nodeType: node.nodeType, summary: summary.summary, routeTerms: summary.routeTerms, inputDigest: hashText(stableJson({ node, children: children.map((child) => child.nodeId) })) };
  });

  const git = gitContext(repo);
  const contentDigest = hashText(stableJson(fileRecords.map(({ path: filePath, digest, language }) => ({ path: filePath, digest, language }))));
  const snapshotId = `snapshot:${repoId}:${contentDigest.slice(0, 24)}`;
  const partialFiles = fileRecords.filter((file) => file.parseStatus !== 'complete').length;
  const manifest = {
    schema: INDEX_SCHEMA, parserVersion: PARSER_VERSION, repositoryId: repoId, repositoryPath: repo,
    snapshotId, createdAt: new Date().toISOString(), git, contentDigest,
    status: partialFiles ? 'partial' : 'published',
    files: fileRecords, skipped: scan.skipped,
    stats: { files: fileRecords.length, changedFiles: changedEntries.length, reusedFiles: entries.length - changedEntries.length, symbols: allSymbols.length, relations: relationRecords.length, partialFiles, skipped: scan.skipped.length, buildMs: Date.now() - startedAt },
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
  return {
    storeRoot, repoId: selected, snapshotDir, manifest,
    files: readJsonl(path.join(snapshotDir, 'files.jsonl')),
    symbols: readJsonl(path.join(snapshotDir, 'symbols.jsonl')),
    containment: readJsonl(path.join(snapshotDir, 'containment.jsonl')),
    relations: readJsonl(path.join(snapshotDir, 'relations.jsonl')),
    navigation: readJsonl(path.join(snapshotDir, 'navigation.jsonl')),
  };
}
