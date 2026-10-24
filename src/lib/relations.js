import path from 'node:path';
import { hashText } from './hash.js';
import { resolveNativeTools, queryCscope } from './native-tools.js';

const FUNCTIONS = ['function', 'async_function', 'method'];
const TYPES = ['class', 'struct', 'interface', 'union', 'enum', 'typedef'];
const isNative = (symbol) => ['c', 'cpp'].includes(symbol?.language);
const normalize = (name) => String(name || '').replaceAll('::', '.').replace(/->/g, '.');
const leaf = (name) => normalize(name).split('.').at(-1);

/** Relations stay queryable without materializing millions of native edges in SQLite. */
export function attachRelations(index, options = {}) {
  const nativeCache = new Map();
  let nativeTools;
  let notices = [];
  const fileOffsets = index.db.prepare('SELECT line_offsets,line_count FROM files WHERE id=?');
  const maxRelations = options.maxRelations || 256;
  const statementModules = index.db.prepare("SELECT id FROM symbols WHERE file_id=? AND kind='module' LIMIT 1");
  function moduleFor(file) {
    const row = file && statementModules.get(file.internalId);
    return row ? index.getSymbol(row.id) : null;
  }
  function nativeRows(name, mode) {
    if (!index.manifest.native?.files) return [];
    const key = `${mode}:${name}`;
    if (!nativeCache.has(key)) {
      nativeTools ||= resolveNativeTools({ cscope: options.cscope, needsCtags: false });
      const response = queryCscope({ snapshotDir: index.snapshotDir, treeRoot: path.join(index.snapshotDir, 'tree'),
        name: name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), mode, tools: nativeTools, limit: maxRelations });
      if (nativeCache.size >= 32) nativeCache.delete(nativeCache.keys().next().value);
      nativeCache.set(key, response);
    }
    const response = nativeCache.get(key);
    if (response.truncated) notices.push(`原生 ${mode} 查询超过 ${maxRelations} 条，结果已截断。`);
    return response.rows;
  }
  function unique(items) { return items.length === 1 ? items[0] : null; }
  function targetFor(raw, source) {
    if (['imports', 'includes'].includes(raw.type)) {
      const modulePath = raw.target_module_path || raw.target_name;
      const paths = [modulePath];
      if (raw.type === 'includes') paths.push(`include/${modulePath}`);
      else for (const extension of ['.py', '/__init__.py', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '/index.ts', '/index.js']) paths.push(modulePath + extension);
      for (const candidate of paths) {
        const file = index.getFile(candidate);
        if (file) return moduleFor(file);
      }
      return null;
    }
    const kinds = ['inherits', 'implements'].includes(raw.type) ? TYPES
      : raw.type === 'references' ? ['macro', 'variable', 'field', ...FUNCTIONS, ...TYPES] : [...FUNCTIONS, ...TYPES];
    const name = raw.target_leaf || leaf(raw.target_name);
    const qualified = normalize(raw.target_normalized || raw.target_name);
    const namePrefix = qualified.slice(0, -(name.length + 1));
    const qualifiedSuffix = qualified.includes('.') && !/^(self|this|super)\./.test(qualified) ? qualified : undefined;
    const languages = isNative(source) ? ['c', 'cpp'] : source?.language === 'python' ? ['python'] : ['javascript', 'typescript'];
    const sameFile = index.findSymbols({ name, path: source?.path, kinds, qualifiedSuffix, languages, limit: 64 });
    if (!qualifiedSuffix && source?.scope) {
      const sameScope = sameFile.filter((symbol) => symbol.scope === source.scope || symbol.scope === source.qualifiedName);
      if (sameScope.length === 1) return sameScope[0];
    }
    if (sameFile.length) return unique(sameFile);
    if (qualifiedSuffix && source && !isNative(source)) {
      for (const base of [namePrefix.replaceAll('.', '/'), path.posix.join(path.posix.dirname(source.path), namePrefix.replaceAll('.', '/'))]) {
        for (const extension of ['.py', '.js', '.ts', '/__init__.py']) {
          const matching = index.findSymbols({ name, path: base + extension, kinds, languages, limit: 2 });
          if (matching.length) return unique(matching);
        }
      }
    }
    return unique(index.findSymbols({ name, kinds, qualifiedSuffix, languages, limit: 2 }));
  }
  function resolved(raw) {
    const source = index.getSymbol(raw.source_id);
    const target = source && targetFor(raw, source);
    return { ...raw, target_id: target?.symbolId || null,
      status: target ? 'resolved' : 'unresolved', confidence: target ? 0.8 : 0, origin: 'parser' };
  }
  function callsite(row, source, type, targetName, target = null) {
    const file = index.getFile(row.path);
    if (!file) throw new Error(`native relation file missing: ${row.path}`);
    const record = fileOffsets.get(file.internalId);
    if (row.line > record.line_count) throw new Error(`native relation span out of bounds: ${row.path}:${row.line}`);
    const offsets = Buffer.from(record.line_offsets);
    return { relation_id: `relation:${hashText(JSON.stringify([source.symbolId, type, targetName, row.path, row.line])).slice(0, 32)}`,
      source_id: source.symbolId, target_id: target?.symbolId || null, target_name: targetName, type,
      status: target ? 'resolved' : 'unresolved', confidence: target ? 0.6 : 0, origin: 'cscope',
      path: row.path, start_line: row.line, end_line: row.line, start_column: 0, end_column: null,
      start_byte: offsets.readUInt32LE((row.line - 1) * 4),
      end_byte: offsets.readUInt32LE(row.line * 4) - (row.line < record.line_count ? 1 : 0), blob_digest: file.digest };
  }
  function sourceAt(row) {
    const found = index.findSymbols({ path: row.path, name: row.peer === '<global>' ? undefined : row.peer,
      line: row.line, kinds: FUNCTIONS, limit: 2 });
    return unique(found) || (row.peer === '<global>' ? moduleFor(index.getFile(row.path)) : null);
  }
  function nativeOutgoing(source, types) {
    if (!isNative(source) || !FUNCTIONS.includes(source.kind)) return [];
    const result = [];
    for (const row of nativeRows(source.name, 'callees')) {
      if (row.path !== source.path || row.line < source.sourceSpan.startLine || row.line > source.sourceSpan.endLine) continue;
      const macros = index.findSymbols({ name: row.peer, path: row.path, kinds: ['macro'], limit: 2 });
      const type = macros.length ? 'references' : 'calls';
      if (!types.includes(type)) continue;
      const target = macros.length ? unique(macros) : targetFor({ type, target_name: row.peer, target_leaf: row.peer }, source);
      result.push(callsite(row, source, type, row.peer, target));
    }
    return result;
  }
  function nativeIncoming(target, types) {
    if (!isNative(target)) return [];
    const type = types.includes('references') && !FUNCTIONS.includes(target.kind) ? 'references' : types.includes('calls') ? 'calls' : types.includes('references') ? 'references' : null;
    if (!type) return [];
    const mode = type === 'calls' ? 'callers' : 'references';
    const result = [];
    for (const row of nativeRows(target.name, mode)) {
      if (type === 'references' && row.path === target.path && row.line === target.sourceSpan.startLine) continue;
      const source = sourceAt(row);
      if (!source) continue;
      const selected = targetFor({ type, target_name: target.name, target_leaf: target.name }, source);
      if (selected && selected.symbolId !== target.symbolId) continue;
      result.push(callsite(row, source, type, target.name, selected));
    }
    if (result.some((row) => row.status === 'unresolved')) notices.push('部分原生交叉引用按名称匹配，同名目标的归属尚未确定。');
    return result;
  }
  function limited(rows) {
    const uniqueRows = [...new Map(rows.map((row) => [row.relation_id, row])).values()];
    if (uniqueRows.length > maxRelations) notices.push(`关系超过 ${maxRelations} 条，结果已截断。`);
    return uniqueRows.slice(0, maxRelations);
  }
  index.getRelationsForSource = (id, types = ['calls']) => {
    const source = index.getSymbol(id);
    if (!source) return [];
    return limited([...index.getRawRelationsForSource(id, types).map(resolved), ...nativeOutgoing(source, types)]);
  };
  index.getRelationsForTarget = (id, types = ['calls']) => {
    const target = index.getSymbol(id);
    if (!target) return [];
    const modulePaths = [target.path, target.path.replace(/\.[^/.]+$/, ''), target.path.replace(/\/(?:__init__\.py|index\.[jt]s)$/, ''), target.path.replace(/^include\//, '')];
    const raw = target.kind === 'module'
      ? index.getRawRelationsForModule(modulePaths, types)
      : index.getRawRelationsForTargetLeaf(target.name, types);
    if (raw.length >= 4097) notices.push('SQL 关系候选超过 4096 条，当前结果可能不完整。');
    const stored = raw.map(resolved).filter((row) => row.target_id === target.symbolId);
    return limited([...stored, ...nativeIncoming(target, types)]);
  };
  index.getRelationsForSymbols = (ids) => limited(ids.flatMap((id) => [
    ...index.getRelationsForSource(id, ['calls', 'references', 'imports', 'includes', 'inherits', 'implements']),
    ...index.getRelationsForTarget(id, ['calls', 'references', 'inherits', 'implements']),
  ]));
  index.iterStoredRelations = function* () {
    for (const row of index.iterRelations()) {
      const relation = resolved(row);
      yield { relationId: relation.relation_id, sourceId: relation.source_id, targetId: relation.target_id,
        targetName: relation.target_name, type: relation.type, status: relation.status, confidence: relation.confidence,
        sourceSpan: { path: relation.path, startLine: relation.start_line, endLine: relation.end_line,
          startColumn: relation.start_column, endColumn: relation.end_column,
          startByte: relation.start_byte, endByte: relation.end_byte, blobDigest: relation.blob_digest, snapshotId: index.manifest.snapshotId } };
    }
  };
  index.beginQuery = () => { notices = []; };
  index.queryNotices = () => [...new Set(notices)];
  return index;
}
