import ts from 'typescript';

function scriptKind(path) {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (['.js', '.mjs', '.cjs'].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) {
    node = node.expression;
  }
  return node;
}

function expressionName(node) {
  node = unwrap(node);
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (node.kind === ts.SyntaxKind.SuperKeyword) return 'super';
  if (ts.isPropertyAccessExpression(node)) {
    const base = expressionName(node.expression);
    return base ? `${base}.${node.name.text}` : node.name.text;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
    const base = expressionName(node.expression);
    return base ? `${base}.${node.argumentExpression.text}` : node.argumentExpression.text;
  }
  return null;
}

export function parseJavaScript({ path, source }) {
  // One syntax tree per call. No Program, checker, parent links or AST nodes escape in the result.
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, scriptKind(path));
  const location = (offset) => {
    const { line, character } = tree.getLineAndCharacterOfPosition(offset);
    return { line: line + 1, column: character };
  };
  if (tree.parseDiagnostics.length) {
    const error = tree.parseDiagnostics.slice(0, 20).map((diagnostic) => {
      const { line, column } = location(diagnostic.start ?? 0);
      return `TS${diagnostic.code}:${path}:${line}:${column + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    }).join('\n');
    return { path, status: 'partial', error, symbols: [], relations: [] };
  }

  const symbols = [];
  const relations = [];
  const moduleName = path.replace(/\.[^.]+$/, '').replaceAll('/', '.');
  function span(start, end) {
    const first = location(start);
    const last = location(end);
    // Offsets and columns are UTF-16, just like JavaScript strings. The indexer owns byte conversion.
    return { startLine: first.line, startColumn: first.column, endLine: last.line, endColumn: last.column };
  }
  const module = { key: `module:${path}`, parentKey: `file:${path}`, kind: 'module',
    name: path.split('/').pop(), qualifiedName: moduleName, signature: moduleName,
    span: span(0, source.length), doc: null };
  symbols.push(module);

  function documentation(node) {
    const comments = ts.getLeadingCommentRanges(source, node.pos) || [];
    if (!comments.length) return null;
    return comments.map(({ pos, end }) => source.slice(pos, end)
      .replace(/^\/\*\*?/, '').replace(/\*\/$/, '')
      .split(/\r?\n/).map((line) => line.replace(/^\s*(?:\/\/|\*)\s?/, '').trim()).join(' '))
      .join(' ').trim() || null;
  }
  function declarationName(node, fallback) {
    if (!node.name) return fallback;
    if (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name) || ts.isStringLiteralLike(node.name)
      || ts.isNumericLiteral(node.name)) return node.name.text;
    return node.name.getText(tree);
  }
  function anonymousName(node, kind) {
    const { line, column } = location(node.getStart(tree));
    return `<${kind}@${line}:${column}>`;
  }
  function addSymbol(node, parent, kind, name, signatureEnd = node.end, docNode = node) {
    const start = node.getStart(tree);
    const qualifiedName = `${parent.qualifiedName}.${name}`;
    const symbol = { key: `symbol:${path}:${qualifiedName}:${start}`, parentKey: parent.key, kind, name, qualifiedName,
      signature: source.slice(start, signatureEnd).trim(), span: span(start, node.end), doc: documentation(docNode) };
    symbols.push(symbol);
    return symbol;
  }
  function relation(owner, type, targetName, node) {
    if (targetName) relations.push({ sourceKey: owner.key, type, targetName, ...location(node.getStart(tree)) });
  }
  function visitDecorators(node, parent, scope) {
    for (const modifier of node.modifiers || []) {
      if (ts.isDecorator(modifier)) visit(modifier.expression, parent, scope);
    }
  }
  function visitComputedName(node, parent, scope) {
    if (node.name && ts.isComputedPropertyName(node.name)) visit(node.name.expression, parent, scope);
  }
  function visitFunction(node, parent, outerScope, binding = node, bindingName = null, docNode = binding) {
    const method = ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
    const name = bindingName || (ts.isConstructorDeclaration(node) ? 'constructor'
      : declarationName(node, anonymousName(node, ts.isArrowFunction(node) ? 'arrow' : 'function')));
    const symbol = addSymbol(binding, parent, method ? 'method' : 'function', name,
      node.body ? node.body.getStart(tree) : node.end, docNode);
    // Names and decorators execute when defining the function; defaults and bodies execute when calling it.
    visitDecorators(binding, symbol, outerScope);
    visitComputedName(binding, symbol, outerScope);
    for (const parameter of node.parameters) {
      visitDecorators(parameter, symbol, outerScope);
      visit(parameter.name, symbol, symbol);
      if (parameter.initializer) visit(parameter.initializer, symbol, symbol);
    }
    if (node.body) visit(node.body, symbol, symbol);
  }
  function visitClass(node, parent, outerScope, binding = node, bindingName = null, docNode = binding) {
    const name = bindingName || declarationName(node, anonymousName(node, 'class'));
    const symbol = addSymbol(binding, parent, 'class', name, node.members.pos - 1, docNode);
    visitDecorators(node, symbol, outerScope);
    if (binding !== node) {
      visitDecorators(binding, symbol, outerScope);
      visitComputedName(binding, symbol, outerScope);
    }
    visitHeritage(node, symbol, symbol, outerScope);
    for (const member of node.members) {
      // Class members are contained by the class, while computed names execute in the enclosing scope.
      if (ts.isPropertyDeclaration(member)) {
        const initializer = unwrap(member.initializer);
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          visitFunction(initializer, symbol, outerScope, member, declarationName(member));
        } else {
          const field = addSymbol(member, symbol, 'field', declarationName(member), member.initializer?.getStart(tree) ?? member.end);
          visitDecorators(member, field, outerScope);
          visitComputedName(member, field, outerScope);
          if (member.initializer) visit(member.initializer, field, symbol);
        }
      } else if (ts.isClassStaticBlockDeclaration(member)) {
        visit(member.body, symbol, symbol);
      } else {
        visit(member, symbol, outerScope);
      }
    }
  }
  function visitHeritage(node, symbol, parent, scope) {
    for (const clause of node.heritageClauses || []) {
      for (const base of clause.types) {
        relation(symbol, clause.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'inherits', expressionName(base.expression), base.expression);
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) visit(base.expression, parent, scope);
      }
    }
  }
  function visit(node, parent, scope, docNode = node) {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      visitFunction(node, parent, scope, node, null, docNode);
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      visitClass(node, parent, scope, node, null, docNode);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) visit(declaration, parent, scope, node);
      return;
    }
    if ((ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) || ts.isPropertyAssignment(node)) {
      const initializer = unwrap(node.initializer);
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        visitFunction(initializer, parent, scope, node, declarationName(node), docNode);
        return;
      }
      if (initializer && ts.isClassExpression(initializer)) {
        visitClass(initializer, parent, scope, node, declarationName(node), docNode);
        return;
      }
    }
    if (ts.isInterfaceDeclaration(node)) {
      const symbol = addSymbol(node, parent, 'interface', node.name.text, node.members.pos - 1);
      visitHeritage(node, symbol, parent, scope);
      // Interface members are declarations only, including their computed names.
      for (const member of node.members) {
        if (ts.isMethodSignature(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          addSymbol(member, symbol, 'method', declarationName(member));
        } else if (ts.isPropertySignature(member)) {
          addSymbol(member, symbol, 'field', declarationName(member));
        }
      }
      return;
    }
    if (ts.isTypeAliasDeclaration(node)) {
      addSymbol(node, parent, 'type', node.name.text);
      return;
    }
    if (ts.isEnumDeclaration(node)) {
      const symbol = addSymbol(node, parent, 'enum', node.name.text, node.members.pos - 1);
      for (const member of node.members) {
        const value = addSymbol(member, symbol, 'field', declarationName(member), member.initializer?.getStart(tree) ?? member.end);
        if (member.initializer) visit(member.initializer, value, symbol);
      }
      return;
    }
    if (ts.isModuleDeclaration(node)) {
      const symbol = addSymbol(node, parent, 'namespace', declarationName(node), node.body?.getStart(tree) ?? node.end);
      if (node.body) visit(node.body, symbol, symbol);
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) relation(module, 'imports', node.moduleSpecifier.text, node);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && reference.expression && ts.isStringLiteralLike(reference.expression)) {
        relation(module, 'imports', reference.expression.text, node);
      }
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
      const expression = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
      const target = expressionName(expression);
      const argument = node.arguments?.[0];
      if ((expression.kind === ts.SyntaxKind.ImportKeyword || target === 'require') && argument && ts.isStringLiteralLike(argument)) {
        relation(module, 'imports', argument.text, node);
      }
      relation(scope, 'calls', target, expression);
    }
    // Type syntax can contain typeof/import queries and function-shaped signatures, but does not execute.
    if (ts.isTypeNode(node)) return;
    ts.forEachChild(node, (child) => { visit(child, parent, scope); });
  }
  visit(tree, module, module);
  return { path, status: 'complete', error: null, symbols, relations };
}
