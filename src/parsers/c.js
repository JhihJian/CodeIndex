import Parser from 'tree-sitter';
import C from 'tree-sitter-c';
import Cpp from 'tree-sitter-cpp';

const C_LANGUAGES = new Map([['c', C], ['cpp', Cpp]]);
const CONTAINER_TYPES = new Set([
  'class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier',
  'namespace_definition', 'template_declaration', 'linkage_specification',
]);
const TYPE_TYPES = new Set(['struct_specifier', 'union_specifier', 'enum_specifier', 'class_specifier']);
const FUNCTION_TYPES = new Set(['function_definition']);
const CONTROL_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'sizeof', 'typeof', 'alignof', 'return', 'new', 'delete']);

function nodeText(node) { return node?.text || ''; }

function nodeSpan(node) {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
  };
}

function cleanIncludeTarget(text) {
  return String(text || '').trim().replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '');
}

function declarationName(node) {
  const declarator = node.childForFieldName?.('declarator');
  if (!declarator) return null;
  let current = declarator;
  while (current) {
    if (current.type === 'identifier' || current.type === 'field_identifier' || current.type === 'type_identifier') return nodeText(current);
    current = current.childForFieldName?.('declarator') || current.namedChildren?.find((child) => child.type.endsWith('declarator')) || null;
  }
  return null;
}

function functionDeclarator(node) {
  if (!node) return null;
  if (node.type === 'function_declarator') return node;
  for (const child of node.namedChildren || []) {
    const result = functionDeclarator(child);
    if (result) return result;
  }
  return null;
}

function functionName(node) {
  const declarator = functionDeclarator(node);
  if (!declarator) return null;
  return declarationName({ childForFieldName: () => declarator.childForFieldName('declarator') }) || nodeText(declarator.childForFieldName('declarator'));
}

function typeName(node) {
  const name = node.childForFieldName?.('name');
  if (name) return nodeText(name);
  const declarator = node.childForFieldName?.('declarator');
  return declarator ? declarationName({ childForFieldName: () => declarator }) : null;
}

function docBefore(source, startIndex) {
  const before = source.slice(Math.max(0, startIndex - 4096), startIndex);
  const lines = before.split('\n');
  const collected = [];
  for (let index = lines.length - 1; index >= 0 && collected.length < 4; index -= 1) {
    const line = lines[index].trim();
    if (!line) { if (collected.length) break; continue; }
    if (line.startsWith('//')) collected.unshift(line.replace(/^\/\/\s?/, ''));
    else if (line.startsWith('*') || line.startsWith('/*')) collected.unshift(line.replace(/^\/?\*+\s?/, ''));
    else break;
  }
  return collected.join(' ').trim() || null;
}

function walk(node, callback, parent = null) {
  callback(node, parent);
  for (const child of node.namedChildren || []) walk(child, callback, node);
}

function ancestorsFor(node, parents) {
  const result = [];
  let current = parents.get(node);
  while (current) { result.push(current); current = parents.get(current); }
  return result;
}

function qualifiedName(moduleName, parents, symbolName) {
  const containers = parents.filter((node) => CONTAINER_TYPES.has(node.type)).reverse().map((node) => typeName(node)).filter(Boolean);
  return [moduleName, ...containers, symbolName].join('.');
}

function signature(node, name, kind) {
  if (kind === 'function' || kind === 'function_declaration') return `${name}(...)`;
  if (kind === 'class' || kind === 'struct' || kind === 'union' || kind === 'enum') return `${kind} ${name}`;
  return name;
}

function relationTarget(node) {
  const functionNode = node.childForFieldName?.('function');
  if (!functionNode) return null;
  const text = nodeText(functionNode).trim();
  if (!text || CONTROL_CALLS.has(text)) return null;
  return text;
}

export function parseC(entry) {
  const { path, source, language } = entry;
  const parser = new Parser();
  parser.setLanguage(C_LANGUAGES.get(language) || C);
  const tree = parser.parse((offset) => source.slice(offset, offset + 8192));
  const root = tree.rootNode;
  const moduleKey = `module:${path}`;
  const moduleName = path.replace(/\.[^.]+$/, '').replaceAll('/', '.');
  const symbols = [{
    key: moduleKey,
    parentKey: `file:${path}`,
    kind: 'module',
    name: path.split('/').pop(),
    qualifiedName: moduleName,
    signature: moduleName,
    span: nodeSpan(root),
    doc: null,
  }];
  const relations = [];
  const parents = new Map();
  walk(root, (node, parent) => { if (parent) parents.set(node, parent); });
  const symbolNodes = new Map();

  function addSymbol(node, kind, name, parentKey = moduleKey) {
    if (!name) return null;
    const key = `symbol:${path}:${kind}:${name}:${node.startIndex}`;
    if (symbolNodes.has(node.startIndex)) return symbolNodes.get(node.startIndex).key;
    const qualified = qualifiedName(moduleName, ancestorsFor(node, parents), name);
    const record = { key, parentKey, kind, name, qualifiedName: qualified, signature: signature(node, name, kind), span: nodeSpan(node), doc: docBefore(source, node.startIndex) };
    symbols.push(record);
    symbolNodes.set(node.startIndex, record);
    return key;
  }

  walk(root, (node) => {
    if (FUNCTION_TYPES.has(node.type)) {
      const name = functionName(node);
      const parent = ancestorsFor(node, parents).find((item) => symbolNodes.has(item.startIndex));
      const key = addSymbol(node, 'function', name, parent ? symbolNodes.get(parent.startIndex).key : moduleKey);
      if (key) {
        walk(node, (child) => {
          if (child.type !== 'call_expression') return;
          const targetName = relationTarget(child);
          if (targetName) relations.push({ sourceKey: key, type: 'calls', targetName, line: child.startPosition.row + 1, column: child.startPosition.column });
        });
      }
      return;
    }
    if (node.type === 'declaration' && functionDeclarator(node) && node.parent?.type !== 'function_definition') {
      const name = functionName(node);
      if (name) addSymbol(node, 'function_declaration', name);
      return;
    }
    if (TYPE_TYPES.has(node.type)) {
      const name = typeName(node);
      const kind = node.type === 'class_specifier' ? 'class' : node.type.replace('_specifier', '');
      addSymbol(node, kind, name);
      const baseClause = node.childForFieldName?.('base_clause') || node.namedChildren?.find((child) => child.type === 'base_class_clause');
      if (baseClause && name) {
        for (const base of baseClause.namedChildren || []) {
          if (base.type === 'access_specifier') continue;
          const targetName = nodeText(base).trim();
          if (targetName) relations.push({ sourceKey: symbolNodes.get(node.startIndex)?.key, type: 'inherits', targetName, line: base.startPosition.row + 1, column: base.startPosition.column });
        }
      }
      return;
    }
    if (node.type === 'namespace_definition') addSymbol(node, 'namespace', typeName(node) || nodeText(node.childForFieldName?.('name')));
    if (node.type === 'type_definition') addSymbol(node, 'typedef', declarationName(node));
  });

  walk(root, (node) => {
    if (node.type === 'preproc_include') {
      const pathNode = node.childForFieldName?.('path') || node.namedChildren?.find((child) => child.type.endsWith('string'));
      const targetName = cleanIncludeTarget(nodeText(pathNode));
      if (targetName) relations.push({ sourceKey: moduleKey, type: 'includes', targetName, line: node.startPosition.row + 1, column: node.startPosition.column });
    }
    if (node.type === 'preproc_def' || node.type === 'preproc_function_def') {
      const name = node.childForFieldName?.('name') || node.namedChildren?.find((child) => child.type === 'identifier');
      if (name) addSymbol(node, 'macro', nodeText(name));
    }
  });

  const macroNames = new Set(symbols.filter((symbol) => symbol.kind === 'macro').map((symbol) => symbol.name));
  for (const relation of relations) {
    if (relation.type === 'calls' && macroNames.has(relation.targetName)) relation.type = 'references';
  }
  return {
    path,
    status: root.hasError ? 'partial' : 'complete',
    error: root.hasError ? 'tree-sitter-error-node' : null,
    symbols,
    relations: relations.filter((relation) => relation.sourceKey),
  };
}
