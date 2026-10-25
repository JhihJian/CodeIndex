import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hashBytes, hashText, stableJson } from '../../src/lib/hash.js';
import { gitContext } from '../../src/lib/git.js';
const root = path.resolve(import.meta.dirname, '../..');
const inputs = path.join(root, '.data/competitors/inputs');
const results = [];
const relationCases = JSON.parse(fs.readFileSync(path.join(root, 'benchmarks/competitors/relation-cases.json'), 'utf8'));
for (const input of JSON.parse(fs.readFileSync(path.join(inputs, 'inputs.json'), 'utf8'))) {
  const inventory = JSON.parse(fs.readFileSync(path.join(inputs, `${input.name}.files.json`), 'utf8'));
  assert.equal(hashText(stableJson(inventory)), input.inventoryDigest);
  const mismatches = [];
  for (const file of inventory) {
    for (const [kind, directory] of [['input', input.target], ['original', input.source]]) {
      const filename = path.join(directory, file.path);
      if (!fs.existsSync(filename) || hashBytes(fs.readFileSync(filename)) !== file.digest) mismatches.push({ kind, path: file.path });
    }
  }
  for (const test of relationCases[input.name] || []) {
    const line = fs.readFileSync(path.join(input.target, test.path), 'utf8').split('\n')[test.callLine - 1];
    assert.ok(line.includes(`${test.callee}(`), `${input.name}:${test.path}:${test.callLine}`);
  }
  const git = gitContext(input.target);
  const originalGit = gitContext(input.source);
  const tracked = execFileSync('git', ['-C', input.target, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const expectedPaths = new Set(inventory.map((file) => file.path));
  const sameTrackedFiles = tracked.length === inventory.length && tracked.every((name) => expectedPaths.has(name));
  results.push({ corpus: input.name, checkedFiles: inventory.length, inventoryDigest: input.inventoryDigest, mismatches,
    inputClean: !git.dirty, inputRevisionRestored: git.revision === input.inputGitRevision, sameTrackedFiles,
    originalGitStateUnchanged: originalGit.revision === input.sourceGit.revision && originalGit.dirty === input.sourceGit.dirty && originalGit.statusLines === input.sourceGit.statusLines });
}
fs.writeFileSync(path.join(root, 'benchmarks/results/competitors/input-verification.json'), JSON.stringify(results, null, 2) + '\n');
assert.ok(results.every((item) => !item.mismatches.length && item.inputClean && item.inputRevisionRestored && item.sameTrackedFiles && item.originalGitStateUnchanged));
console.log('INPUTS_VERIFIED');
