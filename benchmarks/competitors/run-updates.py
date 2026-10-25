#!/usr/bin/env python3
"""Measure no-change and one-file updates, then restore all supplied inputs/indexes."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / '.data/competitors'
RESULTS = ROOT / 'benchmarks/results/competitors'
p = argparse.ArgumentParser()
p.add_argument('--tools', type=Path, required=True)
p.add_argument('--corpora', nargs='+', default=['pageindex', 'typescript', 'linux'])
a = p.parse_args()
tools = a.tools.resolve()
def interrupt(signum, frame):
    raise KeyboardInterrupt
signal.signal(signal.SIGTERM, interrupt)
env = dict(os.environ, CTAGS_COMMAND=os.environ.get('CODEINDEX_CTAGS', str(Path.home() / '.local/bin/ctags-universal')), SCIP_INDEXER='false', ENABLE_AUTO_WATCH='false')
marker = 'codeindex_benchmark_update_probe_20261025'
measurement_units = []

def ensure_measurements_stopped():
    for unit in measurement_units:
        group = subprocess.run(['systemctl', '--user', 'show', unit, '--property=ControlGroup', '--value'], capture_output=True, text=True).stdout.strip()
        members = Path('/sys/fs/cgroup') / group.lstrip('/') / 'cgroup.procs'
        if group and members.exists() and members.read_text().strip():
            raise RuntimeError(f'Refusing to restore while measurement is running: {unit}')
cases = {
    'pageindex': ('pageindex/tree_optimize.py', f'\n\ndef {marker}():\n    return 42\n', 'questions-identifiers-pageindex.json'),
    'typescript': ('packages/typescript/src/api/async/api.ts', f'\n\nexport function {marker}() {{ return 42; }}\n', 'questions-identifiers-typescript.json'),
    'linux': ('fs/open.c', f'\n\nstatic int {marker}(void) {{ return 42; }}\n', 'questions-linux-c.json'),
}

def run(command, **kw):
    return subprocess.run(list(map(str, command)), cwd=ROOT, env=env, check=True, **kw)

def git(source, *args):
    return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()

def copy(source, target):
    run(['cp', '-a', '--reflink=auto', source, target])

def remove(file):
    if file.is_dir(): shutil.rmtree(file)
    elif file.exists(): file.unlink()

def clean_ignore(source):
    file = source / '.cgcignore'
    if file.exists() and not git(source, 'ls-files', '.cgcignore'):
        file.unlink()

def measure(name, command):
    output = RESULTS / name
    print(time.strftime('%H:%M:%S'), name, flush=True)
    process = subprocess.Popen(list(map(str, [sys.executable, ROOT / 'benchmarks/competitors/measure.py', '--output', output, '--seconds', '300', '--', *command])), cwd=ROOT, env=env)
    measurement_units.append(f'codeindex-benchmark-{process.pid}.scope')
    try:
        process.wait()
    except BaseException:
        process.terminate()
        process.wait(timeout=20)
        raise
    return json.loads(output.with_suffix('.json').read_text())

def query(tool, corpus, question_file, suffix):
    output = DATA / tool / corpus
    source = DATA / 'inputs' / corpus
    if tool == 'codeindex': command = ['node', ROOT / 'benchmarks/competitors/codeindex-query.mjs', output, question_file]
    elif tool == 'opengrok': command = ['java', '-cp', f'{tools}:{tools}/opengrok-1.14.20/lib/*', 'OpenGrokQuery', output / 'config.xml', question_file, 'symbol']
    elif tool == 'zoekt': command = [tools / 'zoekt-query', output, question_file, 'symbol']
    else: command = [tools / 'cgc-venv/bin/python', ROOT / 'benchmarks/competitors/cgc-query.py', output, source, question_file, 'symbol']
    dest = RESULTS / f'{tool}-{corpus}-{suffix}-query.json'
    try:
        with dest.open('w') as stdout, dest.with_suffix('.stderr').open('w') as stderr:
            run(command, stdout=stdout, stderr=stderr, timeout=180)
        data = json.loads(dest.read_text())
        baseline = json.loads((RESULTS / f'{tool}-{corpus}-query.json').read_text())
        checks = {'probeHit': data['rows'][-1]['hitAt10'],
                  'baselineHitsPreserved': len(data['rows']) == len(baseline['rows']) + 1 and all(not old['hitAt10'] or new['hitAt10'] for old, new in zip(baseline['rows'], data['rows']))}
        if tool in ['codeindex', 'cgc'] and corpus in ['pageindex', 'linux']:
            cases = ROOT / 'benchmarks/competitors/relation-cases.json'
            command = ['node', ROOT / 'benchmarks/competitors/codeindex-relations.mjs', output, corpus, cases] if tool == 'codeindex' else [tools / 'cgc-venv/bin/python', ROOT / 'benchmarks/competitors/cgc-relations.py', output, source, corpus, cases]
            relation_file = RESULTS / f'{tool}-{corpus}-{suffix}-relations.json'
            with relation_file.open('w') as stdout, relation_file.with_suffix('.stderr').open('w') as stderr:
                run(command, stdout=stdout, stderr=stderr, timeout=180)
            before = json.loads((RESULTS / f'{tool}-{corpus}-relations.json').read_text())['rows']
            after = json.loads(relation_file.read_text())['rows']
            checks['relationsPreserved'] = len(before) == len(after) and all(not old['hit'] or new['hit'] for old, new in zip(before, after))
        return checks
    except (subprocess.SubprocessError, ValueError) as error:
        return {'error': str(error), 'probeHit': False}

for corpus in a.corpora:
    source = DATA / 'inputs' / corpus
    assert source.resolve().parent == (DATA / 'inputs').resolve()
    if git(source, 'status', '--porcelain'): raise RuntimeError(f'Dirty input: {source}')
    report_file = RESULTS / f'{corpus}-updates.json'
    previous = json.loads(report_file.read_text()) if report_file.exists() else {}
    if previous.get('completed') and previous.get('restoredInput') and previous.get('restoredIndexesVerified'):
        print(f'{corpus}: retained existing update results', flush=True)
        continue
    if report_file.exists():
        report_file.rename(report_file.with_suffix(f'.incomplete-{time.time_ns()}.json'))
    revision = git(source, 'rev-parse', 'HEAD')
    relative, addition, questions = cases[corpus]
    changed = source / relative
    original = changed.read_bytes()
    if marker.encode() in original: raise RuntimeError('Probe already exists')
    backup = DATA / 'update-backups' / corpus
    backup.mkdir(parents=True, exist_ok=False)
    active = []
    commands = {}
    saved = []
    pointers = {}
    report = {'completed': False, 'corpus': corpus, 'originalRevision': revision, 'changedFile': relative, 'marker': marker, 'timeLimitSeconds': 300, 'operations': []}
    (backup / 'recovery.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    try:
        for tool in ['codeindex', 'opengrok', 'zoekt', 'cgc']:
            build = json.loads((RESULTS / f'{tool}-{corpus}-build.json').read_text())
            if build['status'] != 'success' or not (RESULTS / f'{tool}-{corpus}-query.json').exists(): continue
            active.append(tool)
            command = build['command'].copy()
            if tool == 'codeindex': command[2] = 'update'
            commands[tool] = command
            output = DATA / tool / corpus
            if tool == 'codeindex':
                pointers = {file: file.read_bytes() for file in output.glob('*/published.json')}
                (backup / 'codeindex-pointers.json').write_text(json.dumps({str(file): text.decode() for file, text in pointers.items()}, indent=2) + '\n', encoding='utf-8')
            else:
                target = backup / tool
                copy(output, target)
                saved.append((target, output))
                if tool == 'cgc' and Path(str(output) + '.settings').exists():
                    setting = Path(str(output) + '.settings')
                    copy(setting, backup / 'cgc.settings')
                    saved.append((backup / 'cgc.settings', setting))
        for tool in active:
            metric = measure(f'{tool}-{corpus}-noop', commands[tool])
            note = 'CLI index checks registration; not a content-digest reconciliation' if tool == 'cgc' else 'normal CLI update with unchanged input'
            report['operations'].append({'tool': tool, 'mode': 'noop', 'measurement': metric, 'semantics': note})
            clean_ignore(source)
            if tool == 'cgc':
                # Even an interrupted no-op attempt must not affect the next probe.
                for src, dest in saved:
                    if src.name.startswith('cgc'):
                        remove(dest)
                        copy(src, dest)
        changed.write_bytes(original + addition.encode())
        git(source, 'add', '--', relative)
        git(source, 'commit', '-qm', '新增单文件索引更新验收探针')
        report['updatedRevision'] = git(source, 'rev-parse', 'HEAD')
        assert git(source, 'diff', '--name-only', revision, 'HEAD').splitlines() == [relative]
        question_file = backup / 'questions.json'
        question_list = json.loads((ROOT / 'benchmarks' / questions).read_text())
        question_list.append({'query': marker, 'expectedPaths': [relative]})
        question_file.write_text(json.dumps(question_list, indent=2) + '\n', encoding='utf-8')
        for tool in active:
            command = commands[tool]
            mode = 'update'
            if tool == 'cgc':
                command = [str(tools / 'cgc-venv/bin/python'), str(ROOT / 'benchmarks/competitors/cgc-watch-update.py'), str(DATA / tool / corpus), str(source), str(changed)]
                mode = 'watch-handler'
            metric = measure(f'{tool}-{corpus}-{mode}', command)
            checks = query(tool, corpus, question_file, mode) if metric['status'] == 'success' else {'probeHit': False}
            report['operations'].append({'tool': tool, 'mode': mode, 'measurement': metric, 'checks': checks})
            clean_ignore(source)
            if tool == 'zoekt':
                output = DATA / tool / corpus
                remove(output)
                copy(backup / tool, output)
                metric = measure(f'{tool}-{corpus}-delta-update', [*command[:-1], '-delta', command[-1]])
                checks = query(tool, corpus, question_file, 'delta-update') if metric['status'] == 'success' else {'probeHit': False}
                report['operations'].append({'tool': tool, 'mode': 'delta-update', 'measurement': metric, 'checks': checks})
        report['completed'] = True
    except BaseException as error:
        report['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        ensure_measurements_stopped()
        clean_ignore(source)
        git(source, 'reset', '--hard', revision)
        for pointer, content in pointers.items(): pointer.write_bytes(content)
        for src, dest in saved:
            if src.exists():
                remove(dest)
                src.rename(dest)
        report['restoredRevision'] = git(source, 'rev-parse', 'HEAD')
        report['restoredInput'] = changed.read_bytes() == original and not git(source, 'status', '--porcelain')
        if (backup / 'questions.json').exists():
            report['restoredIndexes'] = {tool: query(tool, corpus, backup / 'questions.json', 'restored') for tool in active}
            report['restoredIndexesVerified'] = all(not check.get('error') and not check['probeHit'] and check.get('baselineHitsPreserved') and check.get('relationsPreserved', True) for check in report['restoredIndexes'].values())
        else:
            report['restoredIndexesVerified'] = False
        report_file.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        if report['restoredInput'] and report['restoredIndexesVerified']:
            shutil.rmtree(backup)
    assert report['restoredInput'] and report['restoredIndexesVerified']
print('UPDATES_COMPLETE', flush=True)
