#!/usr/bin/env python3
"""Measure actual Zoekt delta builds with submodule indexing explicitly disabled."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / '.data/competitors'
RESULTS = ROOT / 'benchmarks/results/competitors'
p = argparse.ArgumentParser()
p.add_argument('--tools', type=Path, required=True)
a = p.parse_args()
def interrupt(signum, frame):
    raise KeyboardInterrupt
signal.signal(signal.SIGTERM, interrupt)
env = dict(os.environ, CTAGS_COMMAND=os.environ.get('CODEINDEX_CTAGS', str(Path.home() / '.local/bin/ctags-universal')))
def run(command, **kwargs):
    return subprocess.run(list(map(str, command)), cwd=ROOT, env=env, check=True, **kwargs)
def git(source, *args):
    return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()
report_file = RESULTS / 'zoekt-delta-updates.json'
reports = json.loads(report_file.read_text()) if report_file.exists() else []
for corpus in ['pageindex', 'typescript', 'linux']:
    source = DATA / 'inputs' / corpus
    output = DATA / 'zoekt' / corpus
    previous = json.loads((RESULTS / f'{corpus}-updates.json').read_text())
    assert previous['restoredInput'] and previous['restoredIndexesVerified']
    assert not git(source, 'status', '--porcelain')
    assert git(source, 'rev-parse', 'HEAD') == previous['originalRevision']
    existing = next((item for item in reports if item['corpus'] == corpus), None)
    if existing:
        restored = existing.get('restoredChecks', {})
        if existing.get('completed') and existing.get('restoredInput') and restored.get('probeHit') is False and restored.get('baselineHitsPreserved'):
            print(corpus, 'retained existing delta result', flush=True)
            continue
        raise RuntimeError(f'Incomplete delta result for {corpus}; inspect recovery before retrying')
    backup = DATA / 'delta-backups' / corpus
    backup.mkdir(parents=True, exist_ok=False)
    (backup / 'recovery.json').write_text(json.dumps(previous, indent=2) + '\n')
    run(['cp', '-a', '--reflink=auto', output, backup / 'index'])
    questions = 'questions-identifiers-' + corpus + '.json' if corpus != 'linux' else 'questions-linux-c.json'
    items = json.loads((ROOT / 'benchmarks' / questions).read_text())
    items.append({'query': previous['marker'], 'expectedPaths': [previous['changedFile']]})
    question_file = backup / 'questions.json'
    question_file.write_text(json.dumps(items))
    record = {'corpus': corpus, 'mode': 'delta-submodules-disabled', 'completed': False}
    def query(suffix):
        target = RESULTS / f'zoekt-{corpus}-{suffix}-query.json'
        with target.open('w') as stdout, target.with_suffix('.stderr').open('w') as stderr:
            run([a.tools / 'zoekt-query', output, question_file, 'symbol'], stdout=stdout, stderr=stderr, timeout=180)
        data = json.loads(target.read_text())['rows']
        baseline = json.loads((RESULTS / f'zoekt-{corpus}-query.json').read_text())['rows']
        return {'probeHit': data[-1]['hitAt10'], 'baselineHitsPreserved': len(data) == len(baseline)+1 and all(not old['hitAt10'] or new['hitAt10'] for old,new in zip(baseline,data))}
    measurement_unit = None
    try:
        git(source, 'reset', '--hard', previous['updatedRevision'])
        command = json.loads((RESULTS / f'zoekt-{corpus}-build.json').read_text())['command']
        command = [*command[:-1], '-delta', '-submodules=false', command[-1]]
        prefix = RESULTS / f'zoekt-{corpus}-delta-enabled-update'
        print(corpus, 'delta with submodules=false', flush=True)
        process = subprocess.Popen(list(map(str, [sys.executable, ROOT / 'benchmarks/competitors/measure.py', '--output', prefix, '--seconds', '300', '--', *command])), cwd=ROOT, env=env)
        measurement_unit = f'codeindex-benchmark-{process.pid}.scope'
        try:
            process.wait()
        except BaseException:
            process.terminate()
            process.wait(timeout=20)
            raise
        record['measurement'] = json.loads(prefix.with_suffix('.json').read_text())
        record['fellBackToFullBuild'] = 'falling back to normal build' in prefix.with_suffix('.stderr').read_text()
        record['checks'] = query('delta-enabled-update') if record['measurement']['status'] == 'success' else {'probeHit': False}
        record['completed'] = True
    finally:
        if measurement_unit:
            group = subprocess.run(['systemctl', '--user', 'show', measurement_unit, '--property=ControlGroup', '--value'], capture_output=True, text=True).stdout.strip()
            members = Path('/sys/fs/cgroup') / group.lstrip('/') / 'cgroup.procs'
            if group and members.exists() and members.read_text().strip():
                raise RuntimeError(f'Refusing to restore while measurement is running: {measurement_unit}')
        git(source, 'reset', '--hard', previous['originalRevision'])
        shutil.rmtree(output)
        (backup / 'index').rename(output)
        record['restoredChecks'] = query('delta-enabled-restored')
        record['restoredInput'] = not git(source, 'status', '--porcelain') and git(source, 'rev-parse', 'HEAD') == previous['originalRevision']
        reports.append(record)
        report_file.write_text(json.dumps(reports, indent=2) + '\n')
        if record['restoredInput'] and not record['restoredChecks']['probeHit'] and record['restoredChecks']['baselineHitsPreserved']:
            shutil.rmtree(backup)
    assert record['restoredInput'] and not record['restoredChecks']['probeHit'] and record['restoredChecks']['baselineHitsPreserved']
print('DELTA_UPDATES_COMPLETE', flush=True)
