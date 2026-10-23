import { spawnSync } from 'node:child_process';

export function gitValue(repoRoot, args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function gitContext(repoRoot) {
  const inside = gitValue(repoRoot, ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!inside) return { repository: null, revision: null, dirty: null, submodules: null };
  const revision = gitValue(repoRoot, ['rev-parse', 'HEAD']);
  const status = gitValue(repoRoot, ['status', '--porcelain=v1']);
  const submodules = gitValue(repoRoot, ['submodule', 'status']);
  return { repository: gitValue(repoRoot, ['remote', 'get-url', 'origin']) || repoRoot, revision, dirty: Boolean(status), statusLines: status ? status.split('\n').length : 0, submodules };
}
