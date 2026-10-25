import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hashBytes, hashText, stableJson } from '../../src/lib/hash.js';
import { gitContext } from '../../src/lib/git.js';

const [inputs, casesFile] = process.argv.slice(2);
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
const rows = [];
for (const input of JSON.parse(fs.readFileSync(path.join(inputs, 'inputs.json'), 'utf8'))) {
  const inventory = JSON.parse(fs.readFileSync(path.join(inputs, `${input.name}.files.json`), 'utf8'));
  assert.equal(hashText(stableJson(inventory)), input.inventoryDigest);
  for (const file of inventory) {
    for (const directory of [input.source, input.target]) {
      assert.equal(hashBytes(fs.readFileSync(path.join(directory, file.path))), file.digest, `${directory}/${file.path}`);
    }
  }
  for (const test of cases[input.name] || []) {
    const line = fs.readFileSync(path.join(input.target, test.path), 'utf8').split('\n')[test.callLine - 1];
    assert.ok(line.includes(`${test.callee}(`), `${input.name}:${test.path}:${test.callLine}`);
  }
  const git = gitContext(input.target);
  const originalGit = gitContext(input.source);
  const tracked = execFileSync('git', ['-C', input.target, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  assert.deepEqual(new Set(tracked), new Set(inventory.map(file => file.path)));
  assert.equal(git.dirty, false);
  assert.equal(git.revision, input.inputGitRevision);
  for (const field of ['revision', 'dirty', 'statusLines']) assert.equal(originalGit[field], input.sourceGit[field]);
  rows.push({ corpus: input.name, checkedFiles: inventory.length, inputAndOriginalDigestsMatch: true,
    trackedFilesMatch: true, inputRevisionRestored: true, originalGitStateUnchanged: true });
}
console.log(JSON.stringify({ verified: true, rows }, null, 2));
