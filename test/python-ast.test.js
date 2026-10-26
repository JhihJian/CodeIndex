import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sourceLayout, spanFrom } from '../src/lib/fs.js';

const python = process.env.CODEINDEX_PYTHON || 'python3.14';
const parser = fileURLToPath(new URL('../src/parsers/python_ast.py', import.meta.url));
const loadParser = `
import importlib.util
import sys
from unittest.mock import patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('python_ast', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
`;

function run(entries = [], script = null) {
  return spawnSync(python, script === null ? [parser] : ['-c', loadParser + script, parser], {
    input: JSON.stringify(entries), encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
  });
}

function results(entries, script = null) {
  const child = run(entries, script);
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  const parsed = JSON.parse(child.stdout);
  assert.ok(Array.isArray(parsed));
  assert.deepEqual(parsed.map((entry) => entry.path), entries.map((entry) => entry.path));
  return parsed;
}

function parse(source, path = 'sample.py') {
  const [result] = results([{ path, source }]);
  assert.equal(result.status, 'complete', result.error);
  return result;
}

function symbol(result, name) {
  const found = result.symbols.find((entry) => entry.qualifiedName === name);
  assert.ok(found, `missing symbol ${name}`);
  return found;
}

function calls(result, name) {
  const key = symbol(result, name).key;
  return result.relations.filter((entry) => entry.sourceKey === key && entry.type === 'calls')
    .map((entry) => entry.targetName).sort();
}

test('Python AST tests execute a real Python 3.14+ interpreter', () => {
  const child = run([], '\nassert sys.version_info >= (3, 14), sys.version\nmodule.main()\n');
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), []);
});

test('one batch returns one result per input and isolates syntax failures', () => {
  const entries = [
    { path: 'bad.py', source: 'def invalid(:\n' },
    { path: 'good.py', source: 'def valid():\n    return target()\n' },
    { path: 'nul.py', source: '\0' },
    { path: 'surrogate.py', source: '# \ud800' },
    { path: 'empty.py', source: '' },
  ];
  const parsed = results(entries);
  assert.deepEqual(parsed.map((entry) => entry.status), ['partial', 'complete', 'partial', 'partial', 'complete']);
  for (const index of [0, 2]) {
    assert.match(parsed[index].error, /^SyntaxError:/);
    assert.deepEqual(parsed[index].symbols, []);
    assert.deepEqual(parsed[index].relations, []);
  }
  assert.match(parsed[3].error, /^UnicodeEncodeError:/);
  assert.deepEqual(calls(parsed[1], 'good.valid'), ['target']);
});

test('ValueError and RecursionError are isolated only at the ast.parse boundary', () => {
  const entries = ['value', 'recursive', 'good'].map((name) => ({ path: `${name}.py`, source: 'def valid(): pass' }));
  const parsed = results(entries, `
real_parse = module.ast.parse
def parse_input(source, filename):
    if filename == 'value.py':
        raise ValueError('bad input')
    if filename == 'recursive.py':
        raise RecursionError('input too deep')
    return real_parse(source, filename=filename)
with patch.object(module.ast, 'parse', side_effect=parse_input):
    module.main()
`);
  assert.deepEqual(parsed.map((entry) => entry.status), ['partial', 'partial', 'complete']);
  assert.equal(parsed[0].error, 'ValueError:bad input');
  assert.equal(parsed[1].error, 'RecursionError:input too deep');
  symbol(parsed[2], 'good.valid');
});

test('unknown parser errors and extraction failures propagate without a success array', () => {
  for (const [target, error] of [
    ["module.ast, 'parse'", "RuntimeError('unexpected parse error')"],
    ["module.ast, 'parse'", "MemoryError('out of memory')"],
    ["module.ast, 'parse'", 'SystemExit(17)'],
    ["module.Extractor, 'visit_Call'", "RuntimeError('visitor failed')"],
    ["module.Extractor, 'visit_Call'", "ValueError('visitor failed')"],
    ["module.Extractor, 'visit_Call'", "RecursionError('visitor failed')"],
    ["module.ast, 'unparse'", "RuntimeError('unparse failed')"],
  ]) {
    const child = run([{ path: 'a.py', source: 'def f(x: str): target()' }], `
with patch.object(${target}, side_effect=${error}):
    module.main()
`);
    assert.ifError(child.error);
    assert.notEqual(child.status, 0, `${target}: ${error}`);
    assert.equal(child.stdout, '');
    if (error.startsWith('SystemExit')) assert.equal(child.status, 17);
    else assert.match(child.stderr, new RegExp(error.split('(')[0]));
  }
});

test('deep unparsing has a narrow fallback while signatures retain argument semantics', () => {
  const [result] = results([{ path: 'a.py', source: 'def f(x: str, /, *args: int, y=1, **kwargs: bool) -> str: pass' }], `
with patch.object(module.ast, 'unparse', side_effect=RecursionError('too deep')):
    module.main()
`);
  assert.equal(symbol(result, 'a.f').signature, 'f(x: Any, /, *args: Any, y=..., **kwargs: Any) -> Any');
  const normal = parse('def f(x: str, /, *, y: int=1) -> str: pass');
  assert.equal(symbol(normal, 'sample.f').signature, 'f(x: str, /, *, y: int=1) -> str');
});

test('Python 3.14 type parameters, lazy aliases, template strings and except syntax extract', () => {
  const result = parse(`type Alias[T = str] = list[T]
class Box[T = str](Base[T]):
    type Item = tuple[T, int]
    async def get[U = str](self, value: U) -> U:
        text = t"result {format_value(value)}"
        try:
            return process(value)
        except ValueError, TypeError:
            return recover()
`);
  const alias = symbol(result, 'sample.Alias');
  assert.equal(alias.kind, 'typedef');
  assert.equal(alias.signature, 'type Alias[T = str] = list[T]');
  const box = symbol(result, 'sample.Box');
  assert.equal(box.signature, 'class Box[T = str]');
  const item = symbol(result, 'sample.Box.Item');
  assert.equal(item.kind, 'typedef');
  assert.equal(item.parentKey, box.key);
  const method = symbol(result, 'sample.Box.get');
  assert.equal(method.kind, 'method');
  assert.equal(method.parentKey, box.key);
  assert.match(method.signature, /^get\[U = str\]/);
  assert.deepEqual(calls(result, method.qualifiedName), ['format_value', 'process', 'recover']);
  assert.ok(result.relations.some((relation) => relation.sourceKey === box.key
    && relation.type === 'inherits' && relation.targetName === 'Base'));
});

test('UTF-16 spans preserve emoji, CRLF, multiline decorators and Unicode separators', () => {
  const source = [
    '# separator \u2028 stays on this physical line',
    '@(',
    '    decorate("😀")',
    ')',
    'def café(): return "😀" + target()',
    'class Box:',
    '    @decorate("😀")',
    '    async def méthode(self): return "😀" + target()',
    'marker = "😀"; type Alias = str',
    '',
  ].join('\r\n');
  const result = parse(source);
  const lines = source.split('\n');
  const layout = sourceLayout(source);
  for (const [name, first, last] of [['sample.café', 2, 5], ['sample.Box.méthode', 7, 8]]) {
    const entry = symbol(result, name);
    const indent = first === 7 ? 4 : 0;
    assert.deepEqual(entry.span, { startLine: first, endLine: last, startColumn: indent, endColumn: lines[last - 1].length - 1 });
    const span = spanFrom(source, first, last, entry.span.startColumn, entry.span.endColumn, layout);
    const expected = lines.slice(first - 1, last).join('\n').slice(indent, -1);
    assert.equal(Buffer.from(source).subarray(span.startByte, span.endByte).toString('utf8'), expected);
  }
  const alias = symbol(result, 'sample.Alias');
  assert.equal(alias.span.startColumn, lines[8].indexOf('type'));
  assert.equal(alias.span.endColumn, lines[8].length - 1);
  for (const call of result.relations.filter((entry) => entry.targetName === 'target')) {
    assert.equal(call.column, lines[call.line - 1].indexOf('target()'));
  }
  assert.equal(result.symbols[0].span.endLine, lines.length);
});

test('relation columns use UTF-16 for inheritance and imports too', () => {
  const source = 'class C(factory("😀"), Base): pass\nmarker = "😀"; import package\n';
  const result = parse(source);
  const inheritance = result.relations.find((entry) => entry.type === 'inherits' && entry.targetName === 'Base');
  assert.equal(inheritance.column, source.split('\n')[0].indexOf('Base'));
  const imported = result.relations.find((entry) => entry.type === 'imports');
  assert.equal(imported.column, source.split('\n')[1].indexOf('import'));
});

test('nested declarations follow lexical parents through all compound statements', () => {
  const result = parse(`def outer():
    direct()
    if enabled:
        @decorate()
        def inner(value=make_default()):
            inner_call()
        class Nested:
            class_call()
            if enabled:
                async def method(self):
                    method_call()
                    def helper():
                        helper_call()
                    return helper()
    try:
        def tried(): try_call()
    except Exception:
        def handled(): handled_call()
    finally:
        def finalized(): final_call()
    match value:
        case 1:
            def matched(): match_call()
    return inner()
async def standalone(): standalone_call()
`);
  const outer = symbol(result, 'sample.outer');
  assert.deepEqual(calls(result, 'sample.outer'), ['decorate', 'direct', 'inner', 'make_default']);
  for (const name of ['inner', 'Nested', 'tried', 'handled', 'finalized', 'matched']) {
    assert.equal(symbol(result, `sample.outer.${name}`).parentKey, outer.key);
  }
  assert.deepEqual(calls(result, 'sample.outer.inner'), ['inner_call']);
  assert.deepEqual(calls(result, 'sample.outer.Nested'), ['class_call']);
  const method = symbol(result, 'sample.outer.Nested.method');
  assert.equal(method.kind, 'method');
  assert.equal(method.parentKey, symbol(result, 'sample.outer.Nested').key);
  assert.deepEqual(calls(result, method.qualifiedName), ['helper', 'method_call']);
  const helper = symbol(result, `${method.qualifiedName}.helper`);
  assert.equal(helper.kind, 'function');
  assert.equal(helper.parentKey, method.key);
  assert.deepEqual(calls(result, helper.qualifiedName), ['helper_call']);
  assert.equal(symbol(result, 'sample.standalone').kind, 'async_function');
  const positions = new Map(result.symbols.map((entry, index) => [entry.key, index]));
  for (const entry of result.symbols.slice(1)) assert.ok(positions.get(entry.parentKey) < positions.get(entry.key));
});

test('nested imports retain their owning scope and relative import metadata', () => {
  const result = parse('def f():\n    if enabled:\n        from . import sibling\n        import package.child\n', 'pkg/__init__tools.py');
  const owner = symbol(result, 'pkg.__init__tools.f');
  assert.deepEqual(result.relations.map((entry) => entry.targetName), ['.sibling', 'package.child']);
  assert.ok(result.relations.every((entry) => entry.sourceKey === owner.key));
  assert.equal(result.relations[0].importModule, '');
  assert.equal(result.relations[0].importLevel, 1);
  assert.equal(result.relations[0].importName, 'sibling');
});

test('line layout and UTF-8 encoding are reused across thousands of symbols', () => {
  const child = run([], `
class Source(str):
    encodings = 0
    def encode(self, *args, **kwargs):
        self.encodings += 1
        return super().encode(*args, **kwargs)
    def splitlines(self, *args, **kwargs):
        raise AssertionError('full-source splitlines must not run per symbol')
source = Source(''.join(f'def f{i}(): return "😀"\\n' for i in range(2000)))
result = module.parse_file({'path': 'large.py', 'source': source})
assert len(result['symbols']) == 2001
assert source.encodings == 1, source.encodings
module.main()
`);
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), []);
});
