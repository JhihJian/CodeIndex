import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanRepository } from '../../src/lib/fs.js';
import { gitContext } from '../../src/lib/git.js';
import { hashBytes, hashText, stableJson } from '../../src/lib/hash.js';

const [configFile, destination] = process.argv.slice(2);
if (!configFile || !destination) throw new Error('usage: node prepare-inputs.mjs CONFIG.json DESTINATION');
const configuration = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const root = path.resolve(destination);
fs.mkdirSync(root, { recursive: true });
const reports = [];
for (const { name, source } of configuration) {
  const target = path.join(root, name);
  if (fs.existsSync(target)) throw new Error(`Input already exists: ${target}`);
  const git = gitContext(source);
  const scan = scanRepository(source, { retainSource: false });
  fs.mkdirSync(target);
  const files = [];
  for (const entry of scan.files) {
    const file = path.join(target, entry.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(entry.absolute, file, fs.constants.COPYFILE_FICLONE);
    if (hashBytes(fs.readFileSync(file)) !== entry.digest) throw new Error(`source changed: ${entry.path}`);
    files.push({ path: entry.path, digest: entry.digest, bytes: entry.bytes, language: entry.language });
  }
  const command = (args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();
  command(['init', '-q']);
  command(['config', 'user.name', 'CodeIndex Benchmark']);
  command(['config', 'user.email', 'benchmark@example.invalid']);
  command(['config', 'gc.auto', '0']);
  command(['add', '-f', '.']);
  command(['commit', '-qm', '固定代码索引对比输入']);
  const report = { name, source: fs.realpathSync(source), sourceGit: git, target,
    inputGitRevision: command(['rev-parse', 'HEAD']), files: files.length,
    sourceBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    inventoryDigest: hashText(stableJson(files)), maxFileBytes: 5 * 1024 * 1024,
    languages: Object.fromEntries([...new Set(files.map((file) => file.language))].map((language) => [language, files.filter((file) => file.language === language).length])),
    skipped: scan.skipped };
  fs.writeFileSync(path.join(root, `${name}.files.json`), JSON.stringify(files));
  reports.push(report);
  fs.writeFileSync(path.join(root, 'inputs.json'), JSON.stringify(reports, null, 2) + '\n');
  console.log(JSON.stringify({ name, files: report.files, sourceBytes: report.sourceBytes, inventoryDigest: report.inventoryDigest }));
}
