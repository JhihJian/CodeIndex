import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { parseJavaScript } from '../src/parsers/javascript.js';

function parse(source, path = 'sample.ts') {
  const result = parseJavaScript({ path, source });
  assert.equal(result.status, 'complete', result.error);
  assert.equal(result.error, null);
  assert.equal(result.path, path);
  const seen = new Set([`file:${path}`]);
  for (const symbol of result.symbols) {
    assert.ok(seen.has(symbol.parentKey), `parent must precede ${symbol.qualifiedName}`);
    assert.ok(!seen.has(symbol.key), `duplicate key: ${symbol.key}`);
    seen.add(symbol.key);
  }
  for (const relation of result.relations) assert.ok(seen.has(relation.sourceKey));
  return result;
}

function named(result, name) {
  const matches = result.symbols.filter((symbol) => symbol.name === name);
  assert.equal(matches.length, 1, `expected exactly one ${name}`);
  return matches[0];
}

function calls(result, symbol) {
  return result.relations.filter((relation) => relation.type === 'calls' && relation.sourceKey === symbol.key)
    .map((relation) => relation.targetName);
}

test('generic disposeIfDisposable calls isDisposable and preserves its signature and documentation', () => {
  const result = parse([
    '/** 清理资源 😀 */',
    'export function disposeIfDisposable<T>(value: T): void {',
    '  if (isDisposable(value)) value.dispose();',
    '}',
    'function isDisposable(value: unknown): boolean { return true; }',
  ].join('\n'));
  const dispose = named(result, 'disposeIfDisposable');
  assert.equal(dispose.kind, 'function');
  assert.equal(dispose.signature, 'export function disposeIfDisposable<T>(value: T): void');
  assert.equal(dispose.doc, '清理资源 😀');
  assert.deepEqual(dispose.span, { startLine: 2, startColumn: 0, endLine: 4, endColumn: 1 });
  assert.deepEqual(calls(result, dispose), ['isDisposable', 'value.dispose']);
  assert.deepEqual(calls(result, named(result, 'isDisposable')), []);
  assert.deepEqual(result.relations[0], { sourceKey: dispose.key, type: 'calls', targetName: 'isDisposable', line: 3, column: 6 });
});

test('generic arrows and bound function expressions are callable symbols with exact expression spans', () => {
  const result = parse([
    '// 映射 😀',
    'const map = <T,>(value: T): T => transform(value);',
    'const other = function internal<T>(value: T) { return map(value); };',
    'const asyncMap = async <T,>(value: T) => await other(value);',
    'const wrapped = ((value: number) => map(value)) satisfies Callable;',
    'function use() { return asyncMap(other(map(1))); }',
  ].join('\n'));
  for (const name of ['map', 'other', 'asyncMap', 'wrapped']) assert.equal(named(result, name).kind, 'function');
  assert.equal(named(result, 'map').doc, '映射 😀');
  assert.equal(named(result, 'map').span.startColumn, 6);
  assert.equal(named(result, 'map').span.endColumn, 49);
  assert.deepEqual(calls(result, named(result, 'map')), ['transform']);
  assert.deepEqual(calls(result, named(result, 'other')), ['map']);
  assert.deepEqual(calls(result, named(result, 'asyncMap')), ['other']);
  assert.deepEqual(calls(result, named(result, 'wrapped')), ['map']);
  assert.deepEqual(calls(result, named(result, 'use')), ['asyncMap', 'other', 'map']);
});

test('nested declarations and anonymous callbacks own their calls without leaking to outer scopes', () => {
  const result = parse([
    'function outer(value = defaultValue()) {',
    '  direct();',
    '  function inner() { nested(); }',
    '  const arrow = () => arrowOnly();',
    '  consume(() => callbackOnly());',
    '  consume(function () { expressionOnly(); });',
    '  class Local { run() { methodOnly(); } }',
    '  inner();',
    '}',
    'topLevel();',
  ].join('\n'));
  const outer = named(result, 'outer');
  assert.deepEqual(calls(result, outer), ['defaultValue', 'direct', 'consume', 'consume', 'inner']);
  for (const name of ['inner', 'arrow', 'Local']) assert.equal(named(result, name).parentKey, outer.key);
  assert.equal(named(result, 'run').parentKey, named(result, 'Local').key);
  assert.equal(named(result, 'inner').qualifiedName, 'sample.outer.inner');
  assert.deepEqual(calls(result, named(result, 'inner')), ['nested']);
  assert.deepEqual(calls(result, named(result, 'arrow')), ['arrowOnly']);
  assert.deepEqual(calls(result, named(result, 'run')), ['methodOnly']);
  const callback = named(result, '<arrow@5:10>');
  const expression = named(result, '<function@6:10>');
  assert.equal(callback.parentKey, outer.key);
  assert.equal(expression.parentKey, outer.key);
  assert.deepEqual(calls(result, callback), ['callbackOnly']);
  assert.deepEqual(calls(result, expression), ['expressionOnly']);
  assert.deepEqual(calls(result, result.symbols[0]), ['topLevel']);
});

test('class methods, overloads, constructors and accessors have distinct keys and real parents', () => {
  const result = parse([
    'class Service extends api.Base implements Disposable {',
    '  constructor(value = make()) { super(value); }',
    '  run(value: string): string;',
    '  run(value: number): number;',
    '  run(value: unknown) { return helper(value); }',
    '  get value() { return read(); }',
    '  set value(value) { write(value); }',
    '  action = <T,>(value: T) => act(value);',
    '  static { register(); }',
    '}',
  ].join('\n'));
  const service = named(result, 'Service');
  assert.equal(service.signature, 'class Service extends api.Base implements Disposable');
  assert.deepEqual(result.relations.filter((relation) => ['inherits', 'implements'].includes(relation.type))
    .map(({ type, targetName, sourceKey }) => [type, targetName, sourceKey]),
  [['inherits', 'api.Base', service.key], ['implements', 'Disposable', service.key]]);
  const run = result.symbols.filter((symbol) => symbol.name === 'run');
  assert.equal(run.length, 3);
  assert.deepEqual(run.map((symbol) => calls(result, symbol)), [[], [], ['helper']]);
  assert.deepEqual(run.map((symbol) => symbol.span.startLine), [3, 4, 5]);
  const accessors = result.symbols.filter((symbol) => symbol.name === 'value');
  assert.deepEqual(accessors.map((symbol) => calls(result, symbol)), [['read'], ['write']]);
  for (const method of [...run, ...accessors, named(result, 'constructor')]) {
    assert.equal(method.kind, 'method');
    assert.equal(method.parentKey, service.key);
  }
  assert.deepEqual(calls(result, named(result, 'constructor')), ['make', 'super']);
  assert.deepEqual(calls(result, named(result, 'action')), ['act']);
  assert.equal(named(result, 'action').parentKey, service.key);
  assert.deepEqual(calls(result, service), ['register']);
});

test('same-line overloads and nested class names never collide', () => {
  const result = parse('function f(x: string): string; function f(x: unknown) { return x; } function outer() { class Box { run() {} } } class Box { run() {} }');
  assert.equal(result.symbols.filter((symbol) => symbol.name === 'f').length, 2);
  assert.deepEqual(result.symbols.filter((symbol) => symbol.name === 'run').map((symbol) => symbol.qualifiedName),
    ['sample.outer.Box.run', 'sample.Box.run']);
});

test('interface, alias, enum and namespace declarations use AST syntax and do not invent type calls', () => {
  const result = parse([
    'interface Item<T> extends Base<T>, api.Named {',
    '  apply(value: T): ReturnType<typeof helper>;',
    '  [typeOnlyName()]: string;',
    '}',
    'type Factory<T> = (value: T) => import("./types").Result;',
    'enum State { Ready = initialize(), Done = 2 }',
    'namespace Tools { export function work() { execute(); } }',
  ].join('\n'));
  assert.equal(named(result, 'Item').kind, 'interface');
  assert.equal(named(result, 'Item').signature, 'interface Item<T> extends Base<T>, api.Named');
  assert.equal(named(result, 'apply').parentKey, named(result, 'Item').key);
  assert.equal(named(result, 'Factory').kind, 'type');
  assert.equal(named(result, 'State').kind, 'enum');
  assert.equal(named(result, 'Ready').parentKey, named(result, 'State').key);
  assert.equal(named(result, 'work').parentKey, named(result, 'Tools').key);
  assert.equal(named(result, 'Tools').kind, 'namespace');
  assert.deepEqual(result.relations.map(({ type, targetName }) => [type, targetName]),
    [['inherits', 'Base'], ['inherits', 'api.Named'], ['calls', 'initialize'], ['calls', 'execute']]);
});

test('imports, reexports and dynamic imports ignore comments, ordinary strings and type-only queries', () => {
  const result = parse([
    'import value from "./value";',
    'import "./side-effect";',
    'import type { Shape } from "./shape";',
    'export { value as renamed } from "./value";',
    'export * from "./all";',
    'import legacy = require("./legacy");',
    'const text = "require(\'fake\')";',
    '// import fake from "./fake";',
    'type T = typeof import("./type-query");',
    'function load() { require("./required"); return import("./lazy"); }',
    'export default function namedDefault() { return value(); }',
  ].join('\n'));
  const imports = result.relations.filter((relation) => relation.type === 'imports');
  assert.deepEqual(imports.map((relation) => relation.targetName),
    ['./value', './side-effect', './shape', './value', './all', './legacy', './required', './lazy']);
  assert.ok(imports.every((relation) => relation.sourceKey === result.symbols[0].key));
  assert.deepEqual(calls(result, named(result, 'load')), ['require']);
  assert.deepEqual(calls(result, named(result, 'namedDefault')), ['value']);
});

test('TSX generic arrows and JSX expressions preserve executable callbacks', () => {
  const result = parse([
    'export const View = <T,>({ value }: { value: T }) => (',
    '  <Panel title={format(value)} onClick={() => click(value)}>',
    '    {items.map(item => render(item))}',
    '    <span>ignored(fake()) 😀</span>',
    '  </Panel>',
    ');',
  ].join('\n'), 'view.tsx');
  const view = named(result, 'View');
  assert.deepEqual(calls(result, view), ['format', 'items.map']);
  assert.deepEqual(calls(result, named(result, '<arrow@2:40>')), ['click']);
  assert.deepEqual(calls(result, named(result, '<arrow@3:15>')), ['render']);
  const jsx = parse('export function View() { return <div>{format("😀")}</div>; }', 'view.jsx');
  assert.deepEqual(calls(jsx, named(jsx, 'View')), ['format']);
});

test('template interpolations and tagged templates contain calls while regex and text do not', () => {
  const result = parse('function text() { return tag`literal fake() ${format(value)} ${`nested ${inner()}`}`; }\nconst pattern = /fake\\(\\)/;\nconst plain = "fake()";');
  assert.deepEqual(calls(result, named(result, 'text')), ['tag', 'format', 'inner']);
  assert.deepEqual(calls(result, result.symbols[0]), []);
});

test('UTF-16 columns and exclusive spans handle non-BMP names and same-line prefixes', () => {
  const result = parse('const marker = "😀"; function 𐐀() { call("😀"); }\r\nfunction next() {}');
  const symbol = named(result, '𐐀');
  assert.deepEqual(symbol.span, { startLine: 1, startColumn: 21, endLine: 1, endColumn: 50 });
  assert.deepEqual(result.relations, [{ sourceKey: symbol.key, type: 'calls', targetName: 'call', line: 1, column: 37 }]);
  assert.deepEqual(named(result, 'next').span, { startLine: 2, startColumn: 0, endLine: 2, endColumn: 18 });
  assert.equal('startByte' in symbol.span, false);
});

test('class evaluation calls stay outside method scopes and field initializers stay outside the enclosing function', () => {
  const result = parse([
    'function outer() {',
    '  class Local extends factory() {',
    '    [key()]() { body(); }',
    '    field = initialize();',
    '    callback = () => deferred();',
    '  }',
    '}',
  ].join('\n'));
  assert.deepEqual(calls(result, named(result, 'outer')), ['factory', 'key']);
  assert.deepEqual(calls(result, named(result, 'Local')), ['initialize']);
  assert.deepEqual(calls(result, named(result, '[key()]')), ['body']);
  assert.deepEqual(calls(result, named(result, 'callback')), ['deferred']);
});

test('new, optional, recursive and bracket calls are syntax relations', () => {
  const result = parse('function run() { new Client(); service?.send?.(); this["notify"](); run(); (helper as Callable)(); }');
  assert.deepEqual(calls(result, named(result, 'run')), ['Client', 'service.send', 'this.notify', 'run', 'helper']);
});

test('syntax diagnostics return explicit partial results while internal exceptions propagate', () => {
  const result = parseJavaScript({ path: 'broken.ts', source: 'function broken( {' });
  assert.equal(result.status, 'partial');
  assert.match(result.error, /TS\d+:broken\.ts:1:\d+: .+/);
  assert.deepEqual(result.symbols, []);
  assert.deepEqual(result.relations, []);
  const sentinel = new Error('unexpected source access failure');
  assert.throws(() => parseJavaScript({ path: 'internal.ts', get source() { throw sentinel; } }), (error) => error === sentinel);
  assert.throws(() => parseJavaScript({ path: 'internal.ts', source: {} }), TypeError);
});

test('empty files and JavaScript exports keep module and callable records', () => {
  const empty = parse('', 'empty.js');
  assert.equal(empty.symbols.length, 1);
  assert.deepEqual(empty.symbols[0].span, { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 });
  const result = parse([
    'export default function () { return defaultCall(); }',
    'export const object = { "quoted": () => propertyCall(), method() { methodCall(); } };',
    'const Named = class { run() { classCall(); } };',
  ].join('\n'), 'exports.mjs');
  assert.deepEqual(calls(result, named(result, '<function@1:0>')), ['defaultCall']);
  assert.deepEqual(calls(result, named(result, 'quoted')), ['propertyCall']);
  assert.deepEqual(calls(result, named(result, 'method')), ['methodCall']);
  assert.equal(named(result, 'run').parentKey, named(result, 'Named').key);
  assert.deepEqual(calls(result, named(result, 'run')), ['classCall']);
  assert.deepEqual(calls(result, result.symbols[0]), []);
});

test('computed callbacks retain AST containment while their calls use the nearest execution scope', () => {
  const result = parse([
    'function outer() {',
    '  class Local {',
    '    [choose(() => keyOnly())]() { methodOnly(); }',
    '  }',
    '}',
  ].join('\n'));
  const method = named(result, '[choose(() => keyOnly())]');
  const callback = named(result, '<arrow@3:12>');
  assert.equal(callback.parentKey, method.key);
  assert.deepEqual(calls(result, named(result, 'outer')), ['choose']);
  assert.deepEqual(calls(result, callback), ['keyOnly']);
  assert.deepEqual(calls(result, method), ['methodOnly']);
});

test('successive files release AST ownership within a 256 MiB worker', async () => {
  const parserUrl = new URL('../src/parsers/javascript.js', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    (async () => {
      const { parseJavaScript } = await import(${JSON.stringify(parserUrl)});
      for (let file = 0; file < 12; file++) {
        const source = Array.from({ length: 2000 }, (_, index) =>
          '// 文档😀\\nexport function f' + index + '<T>(value: T) { return target(value); }').join('\\n');
        const result = parseJavaScript({ path: 'large' + file + '.ts', source });
        if (result.status !== 'complete' || result.symbols.length !== 2001 || result.relations.length !== 2000) {
          throw new Error('unexpected large-file result');
        }
        if (result.relations.some(relation => relation.targetName !== 'target')) throw new Error('unexpected callee');
        JSON.stringify(result);
      }
      parentPort.postMessage('complete');
    })().catch(error => { throw error; });
  `, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
  const messages = [];
  worker.on('message', (message) => messages.push(message));
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
  });
  assert.deepEqual(messages, ['complete']);
});
