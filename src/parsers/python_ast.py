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
    return None


def safe_unparse(node):
    try:
        return ast.unparse(node)
    except Exception:
        return None


def signature(node):
    try:
        args = []
        positional = list(node.args.posonlyargs) + list(node.args.args)
        defaults = [None] * (len(positional) - len(node.args.defaults)) + list(node.args.defaults)
        for arg, default in zip(positional, defaults):
            item = arg.arg
            if arg.annotation:
                item += ': ' + (safe_unparse(arg.annotation) or 'Any')
            if default is not None:
                item += '=' + (safe_unparse(default) or '...')
            args.append(item)
        if node.args.vararg:
            args.append('*' + node.args.vararg.arg)
        for arg, default in zip(node.args.kwonlyargs, node.args.kw_defaults):
            item = arg.arg
            if arg.annotation:
                item += ': ' + (safe_unparse(arg.annotation) or 'Any')
            if default is not None:
                item += '=' + (safe_unparse(default) or '...')
            args.append(item)
        if node.args.kwarg:
            args.append('**' + node.args.kwarg.arg)
        result = f"{node.name}({', '.join(args)})"
        if node.returns:
            result += ' -> ' + (safe_unparse(node.returns) or 'Any')
        return result
    except Exception:
        return node.name


def span(node, source):
    start = node.lineno
    if getattr(node, 'decorator_list', None):
        start = min([start] + [item.lineno for item in node.decorator_list])

    def char_column(line, byte_column):
        lines = source.splitlines()
        if line < 1 or line > len(lines):
            return 0
        raw = lines[line - 1].encode('utf-8')
        return len(raw[:byte_column].decode('utf-8', errors='ignore'))

    return {
        'startLine': start,
        'endLine': getattr(node, 'end_lineno', node.lineno),
        'startColumn': char_column(start, getattr(node, 'col_offset', 0)),
        'endColumn': char_column(getattr(node, 'end_lineno', node.lineno), getattr(node, 'end_col_offset', 0)),
    }


def first_doc(node):
    value = ast.get_docstring(node, clean=True)
    return value.splitlines()[0].strip() if value else None


def collect_calls(node):
    result = []
    class Visitor(ast.NodeVisitor):
        def visit_FunctionDef(self, child):
            if child is not node:
                return
            self.generic_visit(child)
        def visit_AsyncFunctionDef(self, child):
            if child is not node:
                return
            self.generic_visit(child)
        def visit_Call(self, child):
            target = name_of(child.func)
            if target:
                result.append({'targetName': target, 'line': child.lineno, 'column': child.col_offset})
            self.generic_visit(child)
    visitor = Visitor()
    for statement in getattr(node, 'body', []):
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and statement is not node:
            continue
        visitor.visit(statement)
    return result


def parse_file(item):
    path = item['path']
    source = item['source']
    base = path[:-3] if path.endswith('.py') else path
    module_name = base.replace('/', '.').replace('\\', '.').replace('.__init__', '')
    symbols = []
    relations = []
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as error:
        return {'path': path, 'status': 'partial', 'error': f"SyntaxError:{error.msg}:{error.lineno}", 'symbols': [], 'relations': []}

    module_key = f"module:{path}"
    symbols.append({'key': module_key, 'parentKey': f"file:{path}", 'kind': 'module', 'name': module_name.rsplit('.', 1)[-1], 'qualifiedName': module_name, 'signature': module_name, 'span': {'startLine': 1, 'endLine': max(1, len(source.splitlines())), 'startColumn': 0, 'endColumn': 0}, 'doc': first_doc(tree)})

    def visit_body(body, parent_key, parent_qualified):
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                key = f"symbol:{path}:{parent_qualified}.{node.name}:{node.lineno}"
                qualified = f"{parent_qualified}.{node.name}"
                symbols.append({'key': key, 'parentKey': parent_key, 'kind': 'function' if isinstance(node, ast.FunctionDef) else 'async_function', 'name': node.name, 'qualifiedName': qualified, 'signature': signature(node), 'span': span(node, source), 'doc': first_doc(node)})
                for call in collect_calls(node):
                    relations.append({'sourceKey': key, 'type': 'calls', 'targetName': call['targetName'], 'line': call['line'], 'column': call['column']})
                visit_body(node.body, key, qualified)
            elif isinstance(node, ast.ClassDef):
                key = f"symbol:{path}:{parent_qualified}.{node.name}:{node.lineno}"
                qualified = f"{parent_qualified}.{node.name}"
                symbols.append({'key': key, 'parentKey': parent_key, 'kind': 'class', 'name': node.name, 'qualifiedName': qualified, 'signature': f"class {node.name}", 'span': span(node, source), 'doc': first_doc(node)})
                for base in node.bases:
                    target = name_of(base)
                    if target:
                        relations.append({'sourceKey': key, 'type': 'inherits', 'targetName': target, 'line': base.lineno, 'column': base.col_offset})
                visit_body(node.body, key, qualified)

    visit_body(tree.body, module_key, module_name)
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                relations.append({'sourceKey': module_key, 'type': 'imports', 'targetName': alias.name, 'line': node.lineno, 'column': node.col_offset})
        elif isinstance(node, ast.ImportFrom):
            module = ('.' * node.level) + (node.module or '')
            for alias in node.names:
                target = f"{module}.{alias.name}" if module else alias.name
                relations.append({'sourceKey': module_key, 'type': 'imports', 'targetName': target, 'importModule': node.module or '', 'importLevel': node.level, 'importName': alias.name, 'line': node.lineno, 'column': node.col_offset})
    return {'path': path, 'status': 'complete', 'error': None, 'symbols': symbols, 'relations': relations}


def main():
    payload = json.load(sys.stdin)
    results = [parse_file(item) for item in payload]
    json.dump(results, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
