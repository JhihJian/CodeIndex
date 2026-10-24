import { lineOffsets, spanFrom } from '../lib/fs.js';

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

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function matchingBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}' && --depth === 0) return i;
  }
  return masked.length - 1;
}

function findOpenBrace(masked, from) {
  const open = masked.indexOf('{', from);
  return open === -1 ? masked.length - 1 : open;
}

function docBefore(source, start) {
  const before = source.slice(0, start);
  const lines = before.split('\n');
  const collected = [];
  for (let i = lines.length - 1; i >= 0 && collected.length < 4; i -= 1) {
    const line = lines[i].trim();
    if (!line) { if (collected.length) break; continue; }
    if (line.startsWith('//')) collected.unshift(line.replace(/^\/\/\s?/, ''));
    else if (line.startsWith('*') || line.startsWith('/*')) collected.unshift(line.replace(/^\/?\*+\s?/, ''));
    else break;
  }
  return collected.join(' ').trim() || null;
}

function parseJavaScript(entry) {
  const { path, source, language } = entry;
  const masked = maskSource(source);
  const symbols = [];
  const relations = [];
  const moduleKey = `module:${path}`;
  const moduleName = path.replace(/\.[^.]+$/, '').replaceAll('/', '.');
  symbols.push({ key: moduleKey, parentKey: `file:${path}`, kind: 'module', name: path.split('/').pop(), qualifiedName: moduleName, signature: moduleName, span: spanFrom(source, 1, Math.max(1, source.split('\n').length)), doc: null });
  const declarations = [];
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
      if (declarations.some((item) => item.start === start)) continue;
      const isClass = /\bclass\b/.test(match[0]);
      const isInterface = /\binterface\b/.test(match[0]);
      const isType = /\btype\b/.test(match[0]);
      const kind = isClass ? 'class' : isInterface ? 'interface' : isType ? 'type' : /\bfunction\b/.test(match[0]) ? 'function' : 'variable';
      const open = findOpenBrace(masked, start);
      const end = ['variable', 'type'].includes(kind) ? Math.min(masked.length - 1, masked.indexOf(';', start) === -1 ? open : masked.indexOf(';', start)) : matchingBrace(masked, open);
      declarations.push({ start, end, name, kind, base: match[2] || null });
    }
  }
  declarations.sort((a, b) => a.start - b.start || a.end - b.end);
  const usedNames = new Set();
  for (const declaration of declarations) {
    const startLine = lineAt(source, declaration.start);
    const endLine = lineAt(source, declaration.end);
    const parent = declarations.find((candidate) => candidate.kind === 'class' && candidate.start < declaration.start && candidate.end >= declaration.end);
    const qualified = parent ? `${moduleName}.${parent.name}.${declaration.name}` : `${moduleName}.${declaration.name}`;
    const key = `symbol:${path}:${qualified}:${startLine}`;
    if (usedNames.has(key)) continue;
    usedNames.add(key);
    symbols.push({ key, parentKey: parent ? `symbol-key:${path}:${parent.name}:${lineAt(source, parent.start)}` : moduleKey, kind: declaration.kind, name: declaration.name, qualifiedName: qualified, signature: declaration.kind === 'class' ? `class ${declaration.name}` : `${declaration.name}(...)`, span: spanFrom(source, startLine, endLine), doc: docBefore(source, declaration.start) });
    if (declaration.base) relations.push({ sourceKey: key, type: 'inherits', targetName: declaration.base, line: startLine, column: 0 });
    const body = masked.slice(declaration.start, declaration.end + 1);
    for (const call of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const targetName = call[1];
      if (CONTROL_WORDS.has(targetName) || targetName === declaration.name) continue;
      relations.push({ sourceKey: key, type: 'calls', targetName, line: lineAt(source, declaration.start + (call.index ?? 0)), column: 0 });
    }
  }
  for (const match of source.matchAll(/\bimport\s+(?:[^;\n]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    if (!masked.slice(match.index, match.index + 6).trim()) continue;
    relations.push({ sourceKey: moduleKey, type: 'imports', targetName: match[1], line: lineAt(source, match.index ?? 0), column: 0 });
  }
  for (const match of source.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!masked.slice(match.index, match.index + 6).trim()) continue;
    relations.push({ sourceKey: moduleKey, type: 'imports', targetName: match[1], line: lineAt(source, match.index ?? 0), column: 0 });
  }
  for (const match of source.matchAll(/\bexport\s+[^;\n]*?\s+from\s+['"]([^'"]+)['"]/g)) {
    if (!masked.slice(match.index, match.index + 6).trim()) continue;
    relations.push({ sourceKey: moduleKey, type: 'imports', targetName: match[1], line: lineAt(source, match.index ?? 0), column: 0 });
  }
  return { path, status: 'complete', error: null, symbols, relations };
}

export { parseJavaScript };
