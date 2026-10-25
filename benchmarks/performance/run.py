#!/usr/bin/env python3
"""Sequential, memory-limited performance regression on the frozen competitor inputs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser()
p.add_argument('--baseline-root', type=Path, required=True)
p.add_argument('--inputs', type=Path, required=True)
p.add_argument('--store-root', type=Path, required=True)
p.add_argument('--results', type=Path, required=True)
p.add_argument('--corpora', nargs='+', default=['pageindex', 'typescript', 'linux'])
p.add_argument('--workers', type=int, default=4)
p.add_argument('--build-only', action='store_true')
a = p.parse_args()

def interrupt(signum, frame):
    raise KeyboardInterrupt

signal.signal(signal.SIGTERM, interrupt)
environment = dict(os.environ)
environment.pop('NODE_OPTIONS', None)
active_measurement = None
for key in ['baseline_root', 'inputs', 'store_root', 'results']:
    setattr(a, key, getattr(a, key).resolve())
if (a.results / 'environment.json').exists():
    raise RuntimeError(f'Fresh results directory required: {a.results}')
a.results.mkdir(parents=True, exist_ok=True)
a.store_root.mkdir(parents=True, exist_ok=True)
QUESTIONS = {'pageindex': 'questions-identifiers-pageindex.json', 'typescript': 'questions-identifiers-typescript.json', 'linux': 'questions-linux-c.json'}
FILES = {'pageindex': 'pageindex/tree_optimize.py', 'typescript': 'packages/typescript/src/api/async/api.ts', 'linux': 'fs/open.c'}
PROBE = 'codeindex_benchmark_update_probe_20261025'
APPEND = {'pageindex': f'\n\ndef {PROBE}():\n    return 42\n',
          'typescript': f'\n\nexport function {PROBE}() {{ return 42; }}\n',
          'linux': f'\n\nstatic int {PROBE}(void) {{ return 42; }}\n'}

def git(source, *args):
    return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()

def save(file, value):
    file.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

def measure(name, command, seconds=1800):
    global active_measurement
    prefix = a.results / name
    print(f'{time.strftime("%H:%M:%S")} {name}', flush=True)
    child = subprocess.Popen([sys.executable, str(ROOT / 'benchmarks/competitors/measure.py'), '--output', str(prefix),
                              '--memory-gib', '12', '--seconds', str(seconds), '--', *map(str, command)], cwd=ROOT, env=environment)
    active_measurement = f'codeindex-benchmark-{child.pid}.scope'
    try:
        if child.wait() != 0:
            raise RuntimeError(f'Measurement failed: {name}')
    except BaseException:
        child.terminate()
        try:
            child.wait(timeout=30)
        except subprocess.TimeoutExpired:
            subprocess.run(['systemctl', '--user', 'kill', '--signal=SIGKILL', '--kill-whom=all', f'codeindex-benchmark-{child.pid}.scope'], check=False)
            child.kill()
            child.wait()
        raise
    finally:
        unit = f'codeindex-benchmark-{child.pid}.scope'
        group = subprocess.run(['systemctl', '--user', 'show', unit, '--property=ControlGroup', '--value'], capture_output=True, text=True).stdout.strip()
        procs = Path('/sys/fs/cgroup' + group) / 'cgroup.procs' if group else None
        if procs and procs.exists() and procs.read_text().strip():
            raise RuntimeError(f'Measurement still has descendants: {unit}')
        active_measurement = None
    result = json.loads(prefix.with_suffix('.json').read_text())
    if result['status'] != 'success':
        raise RuntimeError(f'{name}: {result["status"]}')
    return result

def adapter(name, script, *args):
    measure(name + '-measurement', ['node', ROOT / 'benchmarks/competitors' / script, *args])
    result = json.loads((a.results / (name + '-measurement.stdout')).read_text())
    save(a.results / (name + '.json'), result)
    return result

def verify_inputs(source, inventory):
    for item in inventory:
        actual = hashlib.sha256((source / item['path']).read_bytes()).hexdigest()
        if actual != item['digest']:
            raise RuntimeError(f'Input changed: {source}/{item["path"]}')
    expected = {item['path'] for item in inventory}
    tracked = set(subprocess.check_output(['git', '-C', str(source), 'ls-files', '-z']).decode().rstrip('\0').split('\0'))
    if tracked != expected:
        raise RuntimeError(f'Tracked file set changed: {source}')
    if git(source, 'status', '--porcelain'):
        raise RuntimeError(f'Dirty fixed input: {source}')

def query(corpus, store, suffix, questions):
    result = adapter(f'{corpus}-{suffix}', 'codeindex-query.mjs', store, questions)
    if not all(row['hitAt10'] for row in result['rows']):
        raise RuntimeError(f'Query misses: {corpus}-{suffix}')
    return result

baseline_environment = json.loads((a.baseline_root / 'benchmarks/results/competitors/environment.json').read_text())
save(a.results / 'environment.json', {'baselineRevision': baseline_environment['codeindexRevision'],
    'baselineArtifactCheckout': git(a.baseline_root, 'rev-parse', 'HEAD'),
    'optimizedRevision': git(ROOT, 'rev-parse', 'HEAD'), 'optimizedDirty': git(ROOT, 'status', '--porcelain'),
    'workers': a.workers, 'memoryMaxBytes': 12 * 1024 ** 3, 'swapMaxBytes': 0,
    'nodeHeap': 'automatic; NODE_OPTIONS cleared', 'workerOldGenerationMiB': 256,
    'cache': 'Pre-read source and Git objects; new output; no parser cache reuse',
    'serial': True, 'host': subprocess.check_output(['hostname'], text=True).strip(),
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'startedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z')})

for corpus in a.corpora:
    source = a.inputs / corpus
    store = a.store_root / corpus
    inventory_file = a.inputs / (corpus + '.files.json')
    inventory = json.loads(inventory_file.read_text())
    verify_inputs(source, inventory)
    if store.exists() and any(store.iterdir()):
        raise RuntimeError(f'Fresh output required: {store}')
    for parent, _, files in os.walk(source):
        for name in files:
            file = Path(parent) / name
            if file.is_symlink():
                continue
            with file.open('rb') as stream:
                while stream.read(1024 * 1024):
                    pass
    command = ['node', ROOT / 'bin/codeindex.js']
    options = ['--repo', source, '--store', store, '--workers', str(a.workers), '--progress']
    measure(corpus + '-build', [*command, 'index', *options])
    build = json.loads((a.results / (corpus + '-build.stdout')).read_text())
    pointer = next(store.glob('repo-*/published.json'))
    original_pointer = pointer.read_bytes()
    snapshot = pointer.parent / 'snapshots' / json.loads(original_pointer)['directory']
    seen, size = set(), 0
    for file in snapshot.rglob('*'):
        if file.is_file():
            stat = file.stat()
            key = (stat.st_dev, stat.st_ino)
            if key not in seen:
                size += stat.st_size
                seen.add(key)
    save(a.results / (corpus + '-storage.json'), {'bytes': size, 'scope': 'Published snapshot, hard links counted once', 'sqliteBytes': (snapshot / 'index.db').stat().st_size})
    question_file = ROOT / 'benchmarks' / QUESTIONS[corpus]
    query(corpus, store, 'query', question_file)
    audit = adapter(corpus + '-audit', 'codeindex-audit.mjs', store, inventory_file, question_file)
    assert not audit['missingFiles'] and not audit['digestMismatches']
    if corpus != 'typescript':
        relations = adapter(corpus + '-relations', 'codeindex-relations.mjs', store, corpus, ROOT / 'benchmarks/competitors/relation-cases.json')
        assert all(row['hit'] for row in relations['rows'])
    if a.build_only:
        verify_inputs(source, inventory)
        continue
    measure(corpus + '-equivalence', ['node', '--max-old-space-size=2048', ROOT / 'benchmarks/performance/equivalence.mjs',
            a.baseline_root / '.data/competitors/codeindex' / corpus, store, inventory_file])
    measure(corpus + '-noop', [*command, 'update', *options], 300)
    assert json.loads((a.results / (corpus + '-noop.stdout')).read_text())['stats']['noOp']
    revision = git(source, 'rev-parse', 'HEAD')
    changed = source / FILES[corpus]
    original = changed.read_bytes()
    report = {'completed': False, 'restored': False, 'file': FILES[corpus], 'originalRevision': revision,
              'pointer': str(pointer), 'originalPointer': original_pointer.decode(),
              'originalFileDigest': hashlib.sha256(original).hexdigest()}
    verification_file = a.results / (corpus + '-update-verification.json')
    save(verification_file, report)
    probe_questions = json.loads(question_file.read_text()) + [{'query': PROBE, 'expectedPaths': [FILES[corpus]]}]
    probes = a.results / (corpus + '-update-questions.json')
    save(probes, probe_questions)
    try:
        changed.write_bytes(original + APPEND[corpus].encode())
        git(source, 'add', '--', FILES[corpus])
        git(source, 'commit', '-qm', '性能更新验证')
        measure(corpus + '-update', [*command, 'update', *options], 300)
        update = json.loads((a.results / (corpus + '-update.stdout')).read_text())
        assert update['stats']['changedFiles'] == 1
        query(corpus, store, 'update-query', probes)
        if corpus != 'typescript':
            relations = adapter(corpus + '-update-relations', 'codeindex-relations.mjs', store, corpus, ROOT / 'benchmarks/competitors/relation-cases.json')
            assert all(row['hit'] for row in relations['rows'])
        report['updatedFileDigest'] = hashlib.sha256(changed.read_bytes()).hexdigest()
        report['completed'] = True
    finally:
        if active_measurement:
            report['restorationBlockedByUnit'] = active_measurement
            save(verification_file, report)
            raise RuntimeError(f'Refusing input restoration while {active_measurement} has descendants')
        git(source, 'reset', '--hard', revision)
        changed.write_bytes(original)
        pointer.write_bytes(original_pointer)
        verify_inputs(source, inventory)
        restored = adapter(corpus + '-restored-query', 'codeindex-query.mjs', store, a.results / (corpus + '-update-questions.json'))
        assert all(row['hitAt10'] for row in restored['rows'][:-1]) and not restored['rows'][-1]['hitAt10']
        report['restored'] = True
        save(a.results / (corpus + '-update-verification.json'), report)
    print(f'{corpus} COMPLETE: {build["stats"]["buildMs"]}ms', flush=True)
print('PERFORMANCE_COMPLETE', flush=True)
