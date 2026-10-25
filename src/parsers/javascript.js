import { sourceLayout, spanFrom } from '../lib/fs.js';

const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'await', 'new', 'function']);

function maskSource(source) {
  const chars = source.split('');
  let state = 'code';
  let quote = '';
  for (let i = 0; i < chars.length; i += 1) {
    const current = chars[i];
    const next = chars[i + 1];
    if (state === 'lineComment') {
      if (current === '\n') state = 'code'; else chars[i] = ' ';
      continue;
    }
    if (state === 'blockComment') {
      if (current === '*' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; i += 1; state = 'code'; }
      else if (current !== '\n') chars[i] = ' ';
      continue;
    }
    if (state === 'string') {
      if (current === '\\') { if (current !== '\n') chars[i] = ' '; if (chars[i + 1] && chars[i + 1] !== '\n') chars[i + 1] = ' '; i += 1; continue; }
      if (current === quote) { chars[i] = ' '; state = 'code'; }
      else if (current !== '\n') chars[i] = ' ';
      continue;
    }
    if (current === '/' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; i += 1; state = 'lineComment'; continue; }
    if (current === '/' && next === '*') { chars[i] = ' '; chars[i + 1] = ' '; i += 1; state = 'blockComment'; continue; }
    if (current === '"' || current === "'" || current === '`') { quote = current; chars[i] = ' '; state = 'string'; }
  }
  return chars.join('');
}

// Per-file indexes replace repeated scans of the source prefix and function bodies.
function upperBound(values, position) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] <= position) low = mid + 1; else high = mid;
  }
  return low;
}

function braceEnds(masked) {
  const stack = [];
  const ends = new Map();
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '{') stack.push(i);
    else if (masked[i] === '}' && stack.length) ends.set(stack.pop(), i);
  }
  return ends;
}

function findOpenBrace(masked, from) {
  const open = masked.indexOf('{', from);
  return open === -1 ? masked.length - 1 : open;
}

function docBefore(source, start, offsets) {
  const collected = [];
  let end = start;
  for (let i = upperBound(offsets, start) - 1; i >= 0 && collected.length < 4; i--) {
    const line = source.slice(offsets[i], end).trim();
    end = offsets[i] - 1;
    if (!line) { if (collected.length) break; continue; }
    if (line.startsWith('//')) collected.unshift(line.replace(/^\/\/\s?/, ''));
    else if (line.startsWith('*') || line.startsWith('/*')) collected.unshift(line.replace(/^\/?\*+\s?/, ''));
    else break;
  }
  return collected.join(' ').trim() || null;
}

export function parseJavaScript(entry) {
  const { path, source } = entry;
  const masked = maskSource(source);
  const layout = sourceLayout(source);
  const lineAt = (index) => upperBound(layout.charOffsets, index);
  const ends = braceEnds(masked);
  const calls = [...masked.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)];
  const callPositions = calls.map((call) => call.index);
  const symbols = [];
  const relations = [];
  const moduleKey = `module:${path}`;
  const moduleName = path.replace(/\.[^.]+$/, '').replaceAll('/', '.');
  symbols.push({ key: moduleKey, parentKey: `file:${path}`, kind: 'module', name: path.split('/').pop(), qualifiedName: moduleName, signature: moduleName, span: spanFrom(source, 1, layout.charOffsets.length, 0, 0, layout), doc: null });
  const declarations = [];
  const starts = new Set();
  const declarationPatterns = [
    /\b(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)/g,
    /\b(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+([A-Za-z_$][\w$.]*))?[^\{]*\{/g,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
    /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)[^\{]*\{/g,
    /\b(?:export\s+)?(?:type|enum)\s+([A-Za-z_$][\w$]*)\s*[=\{]/g,
  ];
  for (const pattern of declarationPatterns) {
    for (const match of masked.matchAll(pattern)) {
      const start = match.index ?? 0;
      const name = match[1];
      if (starts.has(start)) continue;
      starts.add(start);
      const isClass = /\bclass\b/.test(match[0]);
      const isInterface = /\binterface\b/.test(match[0]);
      const isType = /\btype\b/.test(match[0]);
      const kind = isClass ? 'class' : isInterface ? 'interface' : isType ? 'type' : /\bfunction\b/.test(match[0]) ? 'function' : 'variable';
      const open = findOpenBrace(masked, start);
      const end = ['variable', 'type'].includes(kind) ? Math.min(masked.length - 1, masked.indexOf(';', start) === -1 ? open : masked.indexOf(';', start)) : (ends.get(open) ?? masked.length - 1);
      declarations.push({ start, end, name, kind, base: match[2] || null });
    }
  }
  declarations.sort((a, b) => a.start - b.start || a.end - b.end);
  const classes = declarations.filter((item) => item.kind === 'class');
  const usedNames = new Set();
  for (const declaration of declarations) {
    const startLine = lineAt(declaration.start);
    const endLine = lineAt(declaration.end);
    const parent = classes.find((candidate) => candidate.start < declaration.start && candidate.end >= declaration.end);
    const qualified = parent ? `${moduleName}.${parent.name}.${declaration.name}` : `${moduleName}.${declaration.name}`;
    const key = `symbol:${path}:${qualified}:${startLine}`;
    if (usedNames.has(key)) continue;
    usedNames.add(key);
    symbols.push({ key, parentKey: parent ? `symbol-key:${path}:${parent.name}:${lineAt(parent.start)}` : moduleKey, kind: declaration.kind, name: declaration.name, qualifiedName: qualified, signature: declaration.kind === 'class' ? `class ${declaration.name}` : `${declaration.name}(...)`, span: spanFrom(source, startLine, endLine, 0, 0, layout), doc: docBefore(source, declaration.start, layout.charOffsets) });
    if (declaration.base) relations.push({ sourceKey: key, type: 'inherits', targetName: declaration.base, line: startLine, column: 0 });
    for (let i = upperBound(callPositions, declaration.start - 1); i < calls.length && calls[i].index <= declaration.end; i++) {
      const call = calls[i];
      if (call.index + call[0].length > declaration.end + 1) continue;
      const targetName = call[1];
      if (CONTROL_WORDS.has(targetName) || targetName === declaration.name) continue;
      relations.push({ sourceKey: key, type: 'calls', targetName, line: lineAt(call.index), column: 0 });
    }
  }
  for (const pattern of [
    /\bimport\s+(?:[^;\n]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+[^;\n]*?\s+from\s+['"]([^'"]+)['"]/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (!masked.slice(match.index, match.index + 6).trim()) continue;
      relations.push({ sourceKey: moduleKey, type: 'imports', targetName: match[1], line: lineAt(match.index ?? 0), column: 0 });
    }
  }
  return { path, status: 'complete', error: null, symbols, relations };
}
