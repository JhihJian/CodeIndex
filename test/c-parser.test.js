import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseC } from '../src/parsers/c.js';
import { indexRepository, loadIndex } from '../src/lib/indexer.js';
import { queryIndex } from '../src/lib/query.js';

function cFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-c-repo-'));
  fs.writeFileSync(path.join(root, 'demo.h'), `typedef struct Item {\n  int value;\n} Item;\nint helper(int value);\n`);
  fs.writeFileSync(path.join(root, 'demo.c'), `#include "demo.h"\n#define TWICE(x) ((x) + (x))\n\nstatic int helper(int value) { return value; }\nint run(int value) { return helper(TWICE(value)); }\n`);
  fs.writeFileSync(path.join(root, 'demo.cpp'), `class Base {};\nclass Child : public Base {\npublic:\n  int run(int value) { return value; }\n};\n`);
  return root;
}

test('parses C/C++ functions, types, includes, macros and calls', () => {
  const result = parseC({
    path: 'demo.c',
    language: 'c',
    source: fs.readFileSync(path.join(cFixture(), 'demo.c'), 'utf8'),
  });
  assert.equal(result.status, 'complete');
  assert.ok(result.symbols.some((symbol) => symbol.kind === 'function' && symbol.name === 'run'));
  assert.ok(result.symbols.some((symbol) => symbol.kind === 'macro' && symbol.name === 'TWICE'));
  assert.ok(result.relations.some((relation) => relation.type === 'includes' && relation.targetName === 'demo.h'));
  assert.ok(result.relations.some((relation) => relation.type === 'calls' && relation.targetName === 'helper'));
  assert.ok(result.relations.some((relation) => relation.type === 'references' && relation.targetName === 'TWICE'));
});

test('publishes C/C++ symbols and resolves local calls and includes', () => {
  const repo = cFixture();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'codeindex-c-store-'));
  const built = indexRepository(repo, store);
  const index = loadIndex(store);
  assert.equal(built.manifest.status, 'published');
  assert.ok(index.symbols.some((symbol) => symbol.kind === 'function' && symbol.name === 'run' && symbol.path === 'demo.c'));
  assert.ok(index.symbols.some((symbol) => symbol.kind === 'class' && symbol.name === 'Child' && symbol.path === 'demo.cpp'));
  assert.ok(index.symbols.some((symbol) => symbol.kind === 'macro' && symbol.name === 'TWICE'));
  assert.ok(index.relations.some((relation) => relation.type === 'calls' && relation.status === 'resolved' && relation.targetName === 'helper'));
  assert.ok(index.relations.some((relation) => relation.type === 'includes' && relation.status === 'resolved' && relation.targetName === 'demo.h'));
  assert.ok(index.relations.some((relation) => relation.type === 'inherits' && relation.status === 'resolved' && relation.targetName === 'Base'));
  const result = queryIndex(index, 'run');
  assert.ok(result.evidence.length > 0);
  assert.ok(result.evidence.some((item) => item.path === 'demo.c'));
});
