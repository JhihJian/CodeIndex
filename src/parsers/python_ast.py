#!/usr/bin/env python3
import ast
import json
import sys


def name_of(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = name_of(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    if isinstance(node, ast.Call):
        return name_of(node.func)
    if isinstance(node, ast.Subscript):
        return name_of(node.value)
    return None


def safe_unparse(node):
    try:
        return ast.unparse(node)
    except RecursionError:
        # Valid, deeply nested expressions can exceed the unparser's stack.
        return None


def signature(node):
    def argument(arg, default=None, prefix=''):
        item = prefix + arg.arg
        if arg.annotation:
            item += ': ' + (safe_unparse(arg.annotation) or 'Any')
        if default is not None:
            item += '=' + (safe_unparse(default) or '...')
        return item

    args = []
    positional = node.args.posonlyargs + node.args.args
    defaults = [None] * (len(positional) - len(node.args.defaults)) + node.args.defaults
    for index, (arg, default) in enumerate(zip(positional, defaults), 1):
        args.append(argument(arg, default))
        if index == len(node.args.posonlyargs):
            args.append('/')
    if node.args.vararg:
        args.append(argument(node.args.vararg, prefix='*'))
    elif node.args.kwonlyargs:
        args.append('*')
    args.extend(argument(arg, default) for arg, default in zip(node.args.kwonlyargs, node.args.kw_defaults))
    if node.args.kwarg:
        args.append(argument(node.args.kwarg, prefix='**'))
    result = f"{node.name}{type_parameters(node)}({', '.join(args)})"
    if node.returns:
        result += ' -> ' + (safe_unparse(node.returns) or 'Any')
    return result


def type_parameters(node):
    parameters = node.type_params
    return '[' + ', '.join(safe_unparse(param) or '...' for param in parameters) + ']' if parameters else ''


class SourceLayout:
    """Encode and split once. AST columns are UTF-8 bytes, JS columns UTF-16 units."""
    def __init__(self, source):
        # splitlines() also splits Unicode separators that Python does not treat as newlines.
        self.lines = source.encode('utf-8').split(b'\n')
        self.columns = {}

    def column(self, line, byte_column):
        key = (line, byte_column)
        if key not in self.columns:
            prefix = self.lines[line - 1][:byte_column]
            self.columns[key] = len(prefix.decode('utf-8').encode('utf-16-le')) // 2
        return self.columns[key]

    def span(self, node):
        start = node.lineno
        column = node.col_offset
        if getattr(node, 'decorator_list', None):
            # Parenthesized decorators may start several lines before their AST expression.
            # Search only the first decorator's prefix, ending at its opening @.
            start = node.decorator_list[0].lineno
            while start > 1 and self.lines[start - 1][column:column + 1] != b'@':
                start -= 1
        return {
            'startLine': start,
            'endLine': node.end_lineno,
            'startColumn': self.column(start, column),
            'endColumn': self.column(node.end_lineno, node.end_col_offset),
        }


def first_doc(node):
    value = ast.get_docstring(node, clean=True)
    return value.splitlines()[0].strip() if value else None


class Extractor(ast.NodeVisitor):
    def __init__(self, path, module_name, layout, symbols, relations):
        self.path = path
        self.layout = layout
        self.symbols = symbols
        self.relations = relations
        self.scope = (f'module:{path}', module_name, 'module')

    def symbol(self, node, name, kind, declaration, doc=None):
        parent_key, parent_qualified, _ = self.scope
        qualified = f'{parent_qualified}.{name}'
        key = f'symbol:{self.path}:{qualified}:{node.lineno}'
        self.symbols.append({'key': key, 'parentKey': parent_key, 'kind': kind,
                             'name': name, 'qualifiedName': qualified, 'signature': declaration,
                             'span': self.layout.span(node), 'doc': doc})
        return key, qualified, kind

    def relation(self, node, kind, target, source_key=None, **fields):
        self.relations.append({'sourceKey': source_key or self.scope[0], 'type': kind,
                               'targetName': target, 'line': node.lineno,
                               'column': self.layout.column(node.lineno, node.col_offset), **fields})

    def visit_scope(self, node, scope):
        previous = self.scope
        self.scope = scope
        for statement in node.body:
            self.visit(statement)
        self.scope = previous

    def visit_FunctionDef(self, node):
        kind = 'method' if self.scope[2] == 'class' else (
            'async_function' if isinstance(node, ast.AsyncFunctionDef) else 'function')
        scope = self.symbol(node, node.name, kind, signature(node), first_doc(node))
        # Decorators and defaults run in the enclosing scope, not in the function body.
        for expression in [*node.decorator_list, *node.args.defaults, *node.args.kw_defaults]:
            if expression is not None:
                self.visit(expression)
        self.visit_scope(node, scope)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        scope = self.symbol(node, node.name, 'class', f'class {node.name}{type_parameters(node)}', first_doc(node))
        for base in node.bases:
            target = name_of(base)
            if target:
                self.relation(base, 'inherits', target, source_key=scope[0])
        for expression in [*node.decorator_list, *node.bases, *node.keywords]:
            self.visit(expression)
        self.visit_scope(node, scope)

    def visit_TypeAlias(self, node):
        # typedef is the type-alias kind understood by SQL relation resolution.
        self.symbol(node, node.name.id, 'typedef', safe_unparse(node))
        # Alias values and type-parameter bounds/defaults are lazy annotation scopes.

    def visit_Call(self, node):
        target = name_of(node.func)
        if target:
            self.relation(node, 'calls', target)
        self.generic_visit(node)

    def visit_Import(self, node):
        for alias in node.names:
            self.relation(node, 'imports', alias.name)

    def visit_ImportFrom(self, node):
        module = ('.' * node.level) + (node.module or '')
        for alias in node.names:
            separator = '' if not node.module and node.level else '.'
            target = f'{module}{separator}{alias.name}' if module else alias.name
            self.relation(node, 'imports', target, importModule=node.module or '',
                          importLevel=node.level, importName=alias.name)


def parse_file(item):
    path = item['path']
    source = item['source']
    base = path[:-3] if path.endswith('.py') else path
    module_name = base.replace('/', '.').replace('\\', '.')
    if module_name.endswith('.__init__'):
        module_name = module_name[:-len('.__init__')]
    try:
        tree = ast.parse(source, filename=path)
    except (SyntaxError, ValueError, RecursionError) as error:
        # Only input failures from ast.parse are recoverable per file. Extraction and
        # protocol failures, MemoryError and process-control exceptions must propagate.
        message = f'SyntaxError:{error.msg}:{error.lineno}' if isinstance(error, SyntaxError) else f'{type(error).__name__}:{error}'
        return {'path': path, 'status': 'partial', 'error': message, 'symbols': [], 'relations': []}

    layout = SourceLayout(source)
    module_key = f'module:{path}'
    symbols = [{'key': module_key, 'parentKey': f'file:{path}', 'kind': 'module',
                'name': module_name.rsplit('.', 1)[-1], 'qualifiedName': module_name,
                'signature': module_name, 'span': {'startLine': 1, 'endLine': len(layout.lines),
                                                  'startColumn': 0, 'endColumn': 0}, 'doc': first_doc(tree)}]
    relations = []
    Extractor(path, module_name, layout, symbols, relations).visit(tree)
    return {'path': path, 'status': 'complete', 'error': None, 'symbols': symbols, 'relations': relations}


def main():
    payload = json.load(sys.stdin)
    results = [parse_file(item) for item in payload]
    json.dump(results, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
