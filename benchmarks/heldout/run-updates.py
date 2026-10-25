#!/usr/bin/env python3
"""No-op and identical one-file updates, including real Zoekt delta and CGC watch."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
from common import ROOT, Study, git, load, options, save, storage

args = options(__doc__).parse_args()
study = Study(args)
cases = load(ROOT / 'benchmarks/heldout/update-cases.json')
marker = 'codeindex_heldout_update_probe_20261025'


def remove(file):
    if file.is_dir():
        shutil.rmtree(file)
    elif file.exists():
        file.unlink()


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['cp', '-a', '--reflink=auto', str(source), str(target)], check=True)


def checks(tool, corpus, store, suffix, questions):
    _, query = study.commands(tool, corpus, store, questions)
    result = study.adapter(suffix + '-query', query)
    if result is None:
        return {'querySucceeded': False, 'probeHit': False, 'baselinePreserved': False}
    baseline = load(study.results / f'{tool}-{corpus}-query.json')['rows']
    rows = result['rows']
    report = {'querySucceeded': True, 'probeHit': rows[-1]['hitAt10'],
        'baselinePreserved': len(rows) == len(baseline) + 1 and all(not old['hitAt10'] or new['hitAt10'] for old, new in zip(baseline, rows))}
    if tool in ('codeindex', 'cgc'):
        relation_file = study.results / f'{tool}-{corpus}-relations.json'
        if relation_file.exists():
            relations = study.relation_query(tool, corpus, store, suffix + '-relations')
            before = load(relation_file)['rows']
            report['relationsPreserved'] = relations is not None and len(relations['rows']) == len(before) and all(not old['hit'] or new['hit'] for old, new in zip(before, relations['rows']))
    return report


for corpus in args.corpora:
    report_file = study.results / f'{corpus}-updates.json'
    if report_file.exists():
        previous = load(report_file)
        if previous.get('completed') and previous.get('restored'):
            continue
        raise RuntimeError(f'Inspect incomplete update recovery before retry: {report_file}')
    source = study.source(corpus)
    assert source.resolve().parent == (study.data / 'inputs').resolve()
    study.verify(corpus)
    revision = git(source, 'rev-parse', 'HEAD')
    file = source / cases[corpus]['path']
    original, stat = file.read_bytes(), file.stat()
    assert marker.encode() not in original
    backup = study.data / 'update-backups' / corpus
    backup.mkdir(parents=True, exist_ok=False)
    pointers, backups, active = {}, [], []
    report = {'completed': False, 'restored': False, 'originalRevision': revision,
        'changedFile': cases[corpus]['path'], 'originalDigest': hashlib.sha256(original).hexdigest(),
        'mtimeNs': stat.st_mtime_ns, 'operations': [], 'recoveryDirectory': str(backup)}
    save(report_file, report)
    questions = study.results / f'{corpus}-update-questions.json'
    save(questions, load(study.questions(corpus)) + [{'query': marker, 'expectedPaths': [cases[corpus]['path']]}])
    try:
        for tool in args.tool_names:
            name = f'{tool}-{corpus}'
            if load(study.results / f'{name}-build.json')['status'] != 'success' or not (study.results / f'{name}-query.json').exists():
                continue
            store = study.store(tool, corpus)
            if tool == 'codeindex':
                pointers = {pointer: pointer.read_bytes() for pointer in store.glob('*/published.json')}
                save(backup / 'pointers.json', {str(p): text.decode() for p, text in pointers.items()})
            else:
                for position, output in enumerate(study.paths(tool, store)):
                    if output.exists():
                        saved = backup / f'{tool}-{position}'
                        copy(output, saved)
                        backups.append((saved, output))
            active.append(tool)
            command, _ = study.commands(tool, corpus, store)
            if tool == 'codeindex':
                command[2] = 'update'
            metric = study.measure(name + '-noop', command, 300)
            study.clean_generated(corpus, name + '-noop')
            report['operations'].append({'tool': tool, 'mode': 'noop', 'measurement': metric,
                'semantics': 'registration check only' if tool == 'cgc' else 'normal unchanged-input update'})
            save(report_file, report)
        file.write_bytes(original + cases[corpus]['addition'].replace('{marker}', marker).encode())
        git(source, 'add', '--', cases[corpus]['path'])
        git(source, 'commit', '-qm', '新增未见项目更新验收探针')
        assert git(source, 'diff', '--name-only', revision, 'HEAD').splitlines() == [cases[corpus]['path']]
        report['updatedRevision'] = git(source, 'rev-parse', 'HEAD')
        report['updatedDigest'] = hashlib.sha256(file.read_bytes()).hexdigest()
        save(report_file, report)
        for tool in active:
            store = study.store(tool, corpus)
            name = f'{tool}-{corpus}'
            command, _ = study.commands(tool, corpus, store)
            mode = 'update'
            if tool == 'codeindex':
                command[2] = 'update'
            elif tool == 'cgc':
                mode = 'watch'
                command = [study.tools / 'cgc-venv/bin/python', ROOT / 'benchmarks/competitors/cgc-watch-update.py', store, source, file]
            metric = study.measure(name + '-' + mode, command, 300)
            study.clean_generated(corpus, name + '-' + mode)
            checked = checks(tool, corpus, store, name + '-' + mode, questions) if metric['status'] == 'success' else {'probeHit': False}
            if tool == 'codeindex' and metric['status'] == 'success':
                oracle = study.data / 'update-oracles' / corpus
                rebuild, _ = study.commands(tool, corpus, oracle)
                rebuilt = study.measure(name + '-update-oracle-build', rebuild)
                if rebuilt['status'] == 'success':
                    inventory = load(study.data / 'inputs' / f'{corpus}.files.json')
                    changed = next(item for item in inventory if item['path'] == cases[corpus]['path'])
                    contents = file.read_bytes()
                    changed.update(digest=report['updatedDigest'], bytes=len(contents),
                        gitBlobOid=hashlib.sha1(f'blob {len(contents)}\0'.encode() + contents).hexdigest())
                    inventory_file = study.data / 'updated-inventories' / f'{corpus}.json'
                    save(inventory_file, inventory)
                    equivalent = study.adapter(name + '-update-equivalence', ['node', ROOT / 'benchmarks/performance/equivalence.mjs', oracle, store, inventory_file], 1800)
                    checked['fullBuildEquivalent'] = equivalent is not None and equivalent.get('equivalent') is True
                    if checked['fullBuildEquivalent']:
                        shutil.rmtree(oracle)
                else:
                    checked['fullBuildEquivalent'] = False
            report['operations'].append({'tool': tool, 'mode': mode, 'measurement': metric, 'checks': checked,
                'storageAfter': storage(study.paths(tool, store))})
            save(report_file, report)
            if tool == 'zoekt':
                for saved, output in backups:
                    if saved.name.startswith('zoekt-'):
                        remove(output)
                        copy(saved, output)
                command = [*command[:-1], '-delta', '-submodules=false', command[-1]]
                metric = study.measure(name + '-delta-update', command, 300)
                checked = checks(tool, corpus, store, name + '-delta-update', questions) if metric['status'] == 'success' else {'probeHit': False}
                log = (study.results / f'{name}-delta-update.stderr').read_text()
                checked['fallbackToFull'] = 'falling back' in log.lower() or "delta builds currently don't support" in log
                report['operations'].append({'tool': tool, 'mode': 'delta', 'measurement': metric, 'checks': checked})
                save(report_file, report)
        report['completed'] = True
    finally:
        if study.active_unit:
            report['restorationBlockedByUnit'] = study.active_unit
            save(report_file, report)
            raise RuntimeError(f'Refusing restore with active descendants: {study.active_unit}')
        git(source, 'reset', '--hard', revision)
        file.write_bytes(original)
        os.utime(file, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        for pointer, contents in pointers.items():
            pointer.write_bytes(contents)
        for saved, output in backups:
            remove(output)
            copy(saved, output)
        study.clean_generated(corpus, corpus + '-restored')
        study.verify(corpus, revision)
        restored = {}
        for tool in active:
            result = checks(tool, corpus, study.store(tool, corpus), f'{tool}-{corpus}-restored', questions)
            restored[tool] = result
        report['restoredChecks'] = restored
        report['restored'] = all(v.get('querySucceeded') and v.get('baselinePreserved') and not v.get('probeHit') and v.get('relationsPreserved', True) for v in restored.values())
        save(report_file, report)
        if report['restored']:
            shutil.rmtree(backup)
        else:
            raise RuntimeError(f'Restoration checks failed: {corpus}')
print('UPDATES_COMPLETE', flush=True)
