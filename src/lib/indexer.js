import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { resolvePythonRuntime } from '../parsers/python-runtime.js';
import { cIncludes } from '../parsers/c-includes.js';
import { parseEntriesParallel } from '../parsers/parallel.js';
import { workerCount } from './build-jobs.js';
import { gitContext } from './git.js';
import { hashBytes, hashText, stableJson } from './hash.js';
import { PARSER_VERSION, scanRepository, sourceLayout, spanFrom, iterateJsonl, readJson, repositoryId, writeJsonAtomic, writeJsonl } from './fs.js';
import { COMPACT_SCHEMA_VERSION, createCompactStore, openCompactStore } from './compact-store.js';
import { resolveNativeTools, extractCTags, buildCscope } from './native-tools.js';
import { attachRelations } from './relations.js';

const INDEX_SCHEMA = 'codeindex-index-0.4.0';
const SUPPORTED = new Set(['c', 'cpp', 'python', 'javascript', 'typescript']);
const nativeLanguage = (language) => language === 'c' || language === 'cpp';
const moduleName = (file) => file.replace(/\.[^.]+$/, '').replaceAll('/', '.').replace(/\.__init__$/, '');

function publishedSnapshot(store, repoId) {
  const pointer = readJson(path.join(store, repoId, 'published.json'));
  if (!pointer?.directory || path.basename(pointer.directory) !== pointer.directory) return null;
  const snapshotDir = path.join(store, repoId, 'snapshots', pointer.directory);
  const manifest = readJson(path.join(snapshotDir, 'manifest.json'));
  return manifest?.schema === INDEX_SCHEMA ? { snapshotDir, manifest } : null;
}

function artifactsPresent(previous) {
  return previous && ['index.db', 'source', 'tree', ...(previous.manifest.native?.artifacts || [])]
    .every((file) => fs.existsSync(path.join(previous.snapshotDir, file)));
}

function toolVersions(tools) {
  return Object.fromEntries(Object.entries(tools).filter(([, tool]) => tool).map(([name, tool]) => [name, tool.version]));
}

function offsetsFor(buffer) {
  const values = [0];
  let position = -1;
  while ((position = buffer.indexOf(10, position + 1)) !== -1) values.push(position + 1);
  values.push(buffer.length);
  const offsets = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index++) offsets.writeUInt32LE(values[index], index * 4);
  return { offsets, lineCount: values.length - 1 };
}

function targetFields(relation, entry, paths) {
  const target = String(relation.targetName || '').trim().replace(/^[<"']|[>"']$/g, '');
  let modulePath = '';
  if (relation.type === 'includes') {
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), target));
    modulePath = paths.has(relative) ? relative : target;
  } else if (relation.type === 'imports') {
    if (entry.language === 'python') {
      if (relation.importLevel > 0) {
        let base = path.posix.dirname(entry.path);
        for (let level = 1; level < relation.importLevel; level++) base = path.posix.dirname(base);
        modulePath = path.posix.join(base, (relation.importModule || relation.importName || '').replaceAll('.', '/'));
      } else modulePath = (relation.importModule || target).replaceAll('.', '/');
    } else modulePath = target.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), target)) : target;
  }
  return { targetName: target, targetNormalized: target.replace(/^\.+/, '').replaceAll('::', '.'),
    targetLeaf: target.split(/::|\.|->/).at(-1), targetModulePath: modulePath.replace(/^\.\//, '') };
}

function copyBlob(source, destination) {
  if (fs.existsSync(destination)) return;
  try { fs.linkSync(source, destination); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
  }
}

function* iterateTagShards(files) {
  for (const file of files) {
    yield* iterateJsonl(file);
    fs.unlinkSync(file);
  }
}

export async function indexRepository(repoRoot, storeRoot, {
  incremental = true, maxFileBytes = 5 * 1024 * 1024, onProgress = () => {}, ctags, cscope, python, workers,
} = {}) {
  workers = workerCount(workers);
  const started = Date.now();
  let stageStarted = started;
  const stages = {};
  function progress(stage, extra = {}) {
    const now = Date.now();
    stages[stage] = now - stageStarted;
    stageStarted = now;
    onProgress({ stage, durationMs: stages[stage], elapsedMs: now - started, rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2), ...extra });
  }
  const repo = fs.realpathSync(repoRoot);
  const store = path.resolve(storeRoot);
  fs.mkdirSync(store, { recursive: true });
  const repoId = repositoryId(repo);
  const previous = incremental ? publishedSnapshot(store, repoId) : null;
  const git = gitContext(repo);
  const baseConfig = { schema: INDEX_SCHEMA, sqliteSchema: COMPACT_SCHEMA_VERSION, parserVersion: PARSER_VERSION, maxFileBytes, typescript: ts.version };
  const sameGit = git.revision && git.revision === previous?.manifest.git?.revision && !git.dirty && !previous.manifest.git?.dirty;
  const sameBase = previous && Object.entries(baseConfig).every(([key, value]) => previous.manifest.buildConfig?.[key] === value);
  const checkFastPath = Boolean(sameGit && sameBase && artifactsPresent(previous));
  let pythonRuntime = checkFastPath && previous.manifest.buildConfig.python ? resolvePythonRuntime(python) : null;
  let tools = resolveNativeTools({ ctags, cscope, needsCtags: Boolean(checkFastPath && previous.manifest.native?.files), needsCscope: Boolean(checkFastPath && previous.manifest.native?.files) });
  let config = { ...baseConfig, tools: toolVersions(tools), python: pythonRuntime };
  let compatible = artifactsPresent(previous) && stableJson(previous.manifest.buildConfig) === stableJson(config);
  const noOp = () => ({ manifest: previous.manifest, snapshotDir: previous.snapshotDir,
    stats: { ...previous.manifest.stats, changedFiles: 0, removedFiles: 0, reusedFiles: previous.manifest.stats.files,
      buildMs: Date.now() - started, noOp: true, stages: {} } });
  if (compatible && checkFastPath) return noOp();
  const scan = scanRepository(repo, { maxFileBytes, retainSource: false, excludedRoots: [store] });
  const entries = scan.files;
  const cFiles = entries.filter((entry) => nativeLanguage(entry.language));
  tools = resolveNativeTools({ ctags, cscope, needsCtags: cFiles.length > 0, needsCscope: cFiles.length > 0 });
  pythonRuntime = entries.some(entry => entry.language === 'python') ? (pythonRuntime || resolvePythonRuntime(python)) : null;
  config = { ...baseConfig, tools: toolVersions(tools), python: pythonRuntime };
  compatible = artifactsPresent(previous) && stableJson(previous.manifest.buildConfig) === stableJson(config);
  const contentDigest = hashText(stableJson(entries.map(({ path, digest, language }) => ({ path, digest, language }))));
  if (compatible && contentDigest === previous.manifest.contentDigest) return noOp();
  const oldFiles = new Map();
  if (compatible) {
    const old = openCompactStore(previous.snapshotDir, previous.manifest);
    try { for (const file of old.iterFiles()) oldFiles.set(file.path, file); }
    finally { old.close(); }
  }
  const changed = entries.filter((entry) => oldFiles.get(entry.path)?.digest !== entry.digest || oldFiles.get(entry.path)?.language !== entry.language);
  const paths = new Set(entries.map((entry) => entry.path));
  const removed = [...oldFiles.keys()].filter((file) => !paths.has(file));
  const snapshotId = `snapshot:${repoId}:${hashText(stableJson({ contentDigest, config })).slice(0, 24)}`;
  progress('scan', { files: entries.length, changedFiles: changed.length });
  const snapshotRoot = path.join(store, repoId, 'snapshots');
  fs.mkdirSync(snapshotRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(snapshotRoot, '.build-'));
  const tree = path.join(temporary, 'tree');
  fs.mkdirSync(tree);
  fs.mkdirSync(path.join(temporary, 'source'));
  const controller = new AbortController();
  let nativeTask;
  let session;
  let published = false;
  let destination = temporary;
  try {
    session = createCompactStore(temporary, { previousDatabase: compatible ? path.join(previous.snapshotDir, 'index.db') : null });
    const changedPaths = new Set(changed.map((entry) => entry.path));
    const fileInfo = new Map();
    session.begin();
    for (const file of [...changedPaths, ...removed]) session.deleteFile(file);
    for (const entry of entries) {
      const blob = path.join(temporary, 'source', entry.digest);
      const priorBlob = compatible && path.join(previous.snapshotDir, 'source', entry.digest);
      const altered = changedPaths.has(entry.path);
      let content;
      if (priorBlob && fs.existsSync(priorBlob)) copyBlob(priorBlob, blob);
      else {
        content = fs.readFileSync(entry.absolute);
        if (hashBytes(content) !== entry.digest) throw new Error(`source-changed:${entry.path}`);
        if (!fs.existsSync(blob)) fs.writeFileSync(blob, content, { mode: 0o444 });
      }
      const frozen = path.join(tree, entry.path);
      fs.mkdirSync(path.dirname(frozen), { recursive: true });
      fs.linkSync(blob, frozen);
      if (!altered) continue;
      content ||= fs.readFileSync(blob);
      const { offsets, lineCount } = offsetsFor(content);
      const fileId = session.insertFile({ ...entry, body: content.toString('utf8'), lineCount, lineOffsets: offsets,
        parseStatus: SUPPORTED.has(entry.language) ? 'complete' : 'unsupported',
        parseError: SUPPORTED.has(entry.language) ? null : `unsupported-language:${entry.language}` });
      const moduleId = session.insertSymbol({ fileId, kind: 'module', name: path.posix.basename(entry.path),
        qualifiedName: moduleName(entry.path), startLine: 1, endLine: lineCount, startByte: 0, endByte: entry.bytes });
      fileInfo.set(entry.path, { fileId, moduleId, lineCount, entry });
      if (nativeLanguage(entry.language)) {
        const source = content.toString('utf8');
        let line = 1;
        let cursor = 0;
        for (const match of cIncludes(source)) {
          let newline;
          while ((newline = source.indexOf('\n', cursor)) !== -1 && newline < match.index) { line++; cursor = newline + 1; }
          session.insertRelation({ fileId, sourceId: moduleId, type: 'includes',
            ...targetFields({ type: 'includes', targetName: match.path }, entry, paths), startLine: line, endLine: line });
        }
      }
    }
    session.commit();
    progress('source-and-files');
    const nativeStarted = Date.now();
    nativeTask = buildCscope({ treeRoot: tree, paths: cFiles.map((entry) => entry.path),
      allowedFiles: entries.map((entry) => entry.path), snapshotDir: temporary, tools,
      previousDir: compatible ? previous.snapshotDir : null, changedPaths, signal: controller.signal,
    }).then((value) => ({ value, durationMs: Date.now() - nativeStarted }), (error) => {
      controller.abort(error);
      return { error };
    });
    const changedNative = changed.filter((entry) => nativeLanguage(entry.language));
    const diagnostics = [];
    if (changedNative.length) {
      const tagsFile = path.join(temporary, 'tags.jsonl');
      const extracted = await extractCTags({ treeRoot: tree, paths: changedNative.map((entry) => entry.path), outputPath: tagsFile, tools, workers, signal: controller.signal });
      diagnostics.push(...extracted.warnings);
      session.begin();
      const failedStatus = session.db.prepare('UPDATE files SET parse_status=?,parse_error=? WHERE path=?');
      for (const failure of extracted.failedFiles) failedStatus.run('partial', `ctags-parser-crash:${failure.signal}`, failure.path);
      let currentPath;
      let seen = new Set();
      for (const tag of iterateTagShards(extracted.outputPaths)) {
        if (tag._type !== 'tag') continue;
        const filePath = path.posix.normalize(tag.path);
        const info = fileInfo.get(filePath);
        if (!info || !Number.isInteger(tag.line) || tag.line < 1 || tag.line > info.lineCount) throw new Error(`invalid-native-symbol:${filePath}:${tag.line}`);
        if (currentPath !== filePath) { currentPath = filePath; seen = new Set(); }
        const kind = tag.kind === 'prototype' ? 'function_declaration' : tag.kind === 'member' ? 'field' : tag.kind;
        const scope = tag.scope || '';
        const identity = JSON.stringify([tag.name, kind, scope, tag.line]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const id = session.insertSymbol({ fileId: info.fileId, kind, name: tag.name, scope,
          signature: tag.signature || null, startLine: tag.line, endLine: Math.max(tag.line, Math.min(tag.end || tag.line, info.lineCount)) });
        if (tag.inherits) {
          for (const base of String(tag.inherits).split(',')) {
            const name = base.trim().replace(/^(?:(?:public|protected|private|virtual)\s+)+/, '');
            session.insertRelation({ fileId: info.fileId, sourceId: id, type: 'inherits',
              ...targetFields({ type: 'inherits', targetName: name }, info.entry, paths), startLine: tag.line });
          }
        }
      }
      session.commit();
    }
    progress('native-symbols');
    const updateModule = session.db.prepare('UPDATE symbols SET name=?,qualified_name=?,signature=?,doc=?,symbol_key=? WHERE id=?');
    const updateStatus = session.db.prepare('UPDATE files SET parse_status=?,parse_error=? WHERE id=?');
    const scripted = changed.filter((entry) => ['python', 'javascript', 'typescript'].includes(entry.language))
      .map((entry) => ({ ...entry, absolute: path.join(tree, entry.path) }));
    session.begin();
    await parseEntriesParallel(scripted, (parsed) => {
      const info = fileInfo.get(parsed.path);
      if (!info) throw new Error(`unexpected-parser-result:${parsed.path}`);
      updateStatus.run(parsed.status, parsed.error || null, info.fileId);
      const source = fs.readFileSync(path.join(tree, parsed.path), 'utf8');
      const layout = sourceLayout(source);
      const keys = new Map([[`module:${parsed.path}`, info.moduleId]]);
      const aliases = new Map((parsed.symbols || []).map((symbol) => [`symbol-key:${parsed.path}:${symbol.name}:${symbol.span.startLine}`, symbol.key]));
      for (const symbol of parsed.symbols || []) {
        if (symbol.kind === 'module') {
          updateModule.run(symbol.name, symbol.qualifiedName, symbol.signature || null, symbol.doc || null, symbol.key, info.moduleId);
          keys.set(symbol.key, info.moduleId);
          continue;
        }
        const scope = symbol.qualifiedName?.slice(0, -(symbol.name.length + 1)) || '';
        const span = spanFrom(source, symbol.span.startLine, symbol.span.endLine, symbol.span.startColumn, symbol.span.endColumn, layout);
        const parentId = keys.get(aliases.get(symbol.parentKey) || symbol.parentKey);
        if (!parentId) throw new Error(`missing-symbol-parent:${parsed.path}:${symbol.key}`);
        const id = session.insertSymbol({ fileId: info.fileId, kind: symbol.kind, name: symbol.name,
          scope, key: symbol.key, qualifiedName: symbol.qualifiedName, signature: symbol.signature, doc: symbol.doc,
          parentId, sourceSpan: span });
        keys.set(symbol.key, id);
      }
      for (const relation of parsed.relations || []) {
        const sourceId = keys.get(aliases.get(relation.sourceKey) || relation.sourceKey);
        if (!sourceId) throw new Error(`missing-relation-source:${parsed.path}:${relation.sourceKey}`);
        session.insertRelation({ fileId: info.fileId, sourceId, type: relation.type,
          ...targetFields(relation, info.entry, paths), startLine: Math.max(1, relation.line || 1), endColumn: null });
      }
    }, { workers, signal: controller.signal, pythonRuntime });
    session.commit();
    progress('parser-symbols');
    progress('relations');
    session.finalize();
    progress('indexes');
    const nativeResult = await nativeTask;
    if (nativeResult.error) throw nativeResult.error;
    const native = nativeResult.value;
    diagnostics.push(...native.warnings);
    progress('native-cross-references', { taskDurationMs: nativeResult.durationMs, buildMode: native.buildMode || 'none' });
    const invalid = session.db.prepare(`SELECT count(*) AS n FROM symbols s JOIN files f ON f.id=s.file_id
      WHERE s.start_line<1 OR s.end_line<s.start_line OR s.end_line>f.line_count
        OR (s.start_byte IS NOT NULL AND (s.start_byte<0 OR s.end_byte<s.start_byte OR s.end_byte>f.bytes))`).get().n;
    if (invalid || session.db.prepare('PRAGMA foreign_key_check').get()) throw new Error(`index validation failed: invalid spans=${invalid}`);
    const counts = session.counts();
    const statusCounts = Object.fromEntries(session.db.prepare('SELECT parse_status,count(*) AS n FROM files GROUP BY parse_status').all().map((row) => [row.parse_status, row.n]));
    const directoryPaths = new Set(['']);
    for (const entry of entries) {
      let directory = path.posix.dirname(entry.path);
      while (directory !== '.' && directory !== '') { directoryPaths.add(directory); directory = path.posix.dirname(directory); }
    }
    const partialFiles = entries.length - (statusCounts.complete || 0);
    const stats = { ...counts, sourceBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      changedFiles: changed.length, removedFiles: removed.length, reusedFiles: entries.length - changed.length,
      parsedFiles: changed.filter((entry) => SUPPORTED.has(entry.language)).length,
      partialFiles, skipped: scan.skipped.length, nodes: counts.files + counts.symbols + directoryPaths.size,
      nativeFiles: native.files.length, nativeIndexedFiles: native.indexedFiles.length,
      workers, nativeBuildMode: native.buildMode || 'none', nativeTaskMs: nativeResult.durationMs,
      relationsScope: 'stored-sql-relations; native calls and references queried from cscope', stages };
    session.close(); session = null;
    progress('validation');
    const manifest = { schema: INDEX_SCHEMA, parserVersion: PARSER_VERSION, buildConfig: config,
      repositoryId: repoId, repositoryPath: repo, snapshotId, contentDigest, createdAt: new Date().toISOString(), git,
      status: partialFiles || diagnostics.length ? 'partial' : 'published', skipped: scan.skipped, diagnostics,
      native: { backend: native.files.length ? 'cscope' : null, files: native.files.length, indexedFiles: native.indexedFiles.length,
        artifacts: native.artifacts, version: tools.cscope?.version || null },
      coverage: { sourceFiles: counts.files, parsedFiles: statusCounts.complete || 0, unsupportedFiles: statusCounts.unsupported || 0,
        partialFiles, skippedFiles: scan.skipped.length, nativeCalls: native.files.length > 0,
        semantics: 'syntax-level symbols and cross-references; no compiler-level overload or pointer resolution' },
      publishing: { state: 'validated', permissionView: 'public' }, stats: { ...stats, buildMs: Date.now() - started } };
    writeJsonAtomic(path.join(temporary, 'manifest.json'), manifest);
    const directory = `${snapshotId}-${randomUUID().slice(0, 8)}`;
    const destinationPath = path.join(snapshotRoot, directory);
    fs.renameSync(temporary, destinationPath);
    destination = destinationPath;
    writeJsonAtomic(path.join(store, repoId, 'published.json'), { repositoryId: repoId, snapshotId, directory, publishedAt: new Date().toISOString() });
    published = true;
    return { manifest, snapshotDir: destination, stats: { ...manifest.stats, buildMs: Date.now() - started } };
  } catch (error) {
    controller.abort(error);
    await nativeTask;
    try { session?.close(); } catch {}
    if (!published) fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export function loadIndex(storeRoot, repoId = null, options = {}) {
  const store = path.resolve(storeRoot);
  const repositories = fs.existsSync(store) ? fs.readdirSync(store, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('repo-')) : [];
  const selected = repoId || (repositories.length === 1 ? repositories[0].name : null);
  if (!selected) throw new Error('无法确定仓库索引，请指定 --repo-id');
  const published = publishedSnapshot(store, selected);
  if (!published) throw new Error(`没有当前格式的已发布索引，请重新执行 index：${selected}`);
  if (!artifactsPresent(published)) throw new Error('索引产物缺失，请重新执行 index');
  const index = openCompactStore(published.snapshotDir, published.manifest);
  index.repoId = selected;
  index.storeRoot = store;
  attachRelations(index, options);
  return index;
}

export function exportIndex(storeRoot, outputDir, { repoId = null } = {}) {
  const index = loadIndex(storeRoot, repoId);
  const output = path.resolve(outputDir);
  try {
    if (output === index.snapshotDir || output.startsWith(`${index.snapshotDir}${path.sep}`)) throw new Error('导出目录必须位于不可变快照之外');
    if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('导出目录必须为空');
    fs.mkdirSync(output, { recursive: true });
    writeJsonl(path.join(output, 'files.jsonl'), index.iterFiles());
    writeJsonl(path.join(output, 'symbols.jsonl'), index.iterSymbols());
    writeJsonl(path.join(output, 'containment.jsonl'), index.iterContainment());
    writeJsonl(path.join(output, 'relations.jsonl'), index.iterStoredRelations());
    for (const artifact of index.manifest.native.artifacts) {
      fs.mkdirSync(path.dirname(path.join(output, artifact)), { recursive: true });
      fs.copyFileSync(path.join(index.snapshotDir, artifact), path.join(output, artifact), fs.constants.COPYFILE_FICLONE);
    }
    writeJsonAtomic(path.join(output, 'manifest.json'), { ...index.manifest,
      export: { sourceSnapshot: index.snapshotDir, relations: 'SQL facts plus native Cscope artifacts; native edges are not expanded as JSONL' } });
    return { output, snapshotId: index.manifest.snapshotId };
  } finally { index.close(); }
}
