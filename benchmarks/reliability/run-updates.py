#!/usr/bin/env python3
"""隔离副本上的增量、全量等价与恢复验收。"""
import hashlib
import os
from pathlib import Path
import shutil
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'heldout'))
from common import ROOT, Study, git, load, options, save

args = options(__doc__).parse_args()
assert args.data.resolve().name == 'reliability', 'Only the dedicated reliability directory is allowed'
assert args.results.resolve().name == 'reliability', 'Do not overwrite historical results'
study = Study(args)
cases = load(ROOT / 'benchmarks/heldout/update-cases.json')
marker = 'codeindex_reliability_probe'


def checked(name, command, seconds=1800):
    result = study.adapter(name, command, seconds)
    assert result is not None, name
    return result


for corpus in args.corpora:
    report_file = study.results / f'{corpus}-updates.json'
    assert not report_file.exists(), f'Inspect existing recovery report before retry: {report_file}'
    source = study.source(corpus)
    assert source.resolve() == source and source.parent == study.data / 'inputs'
    assert (source / '.git').is_dir() and (source / '.git').resolve() == source / '.git'
    study.verify(corpus)
    revision = git(source, 'rev-parse', 'HEAD')
    file = source / cases[corpus]['path']
    assert file.resolve() == file and file.stat().st_nlink == 1, 'Source must be an independent regular copy'
    original, stat = file.read_bytes(), file.stat()
    assert marker.encode() not in original
    store = study.store('codeindex', corpus)
    assert store.resolve() == store and store.is_relative_to(study.data / 'indexes')
    pointers = {p: p.read_bytes() for p in store.glob('*/published.json')}
    assert all(p.resolve() == p and p.stat().st_nlink == 1 for p in pointers)
    assert len(pointers) == 1
    backup = study.data / 'update-backups' / corpus
    backup.mkdir(parents=True, exist_ok=False)
    (backup / 'source').write_bytes(original)
    save(backup / 'pointers.json', {str(p): data.decode() for p, data in pointers.items()})
    report = {'completed': False, 'restored': False, 'originalRevision': revision,
              'path': cases[corpus]['path'], 'originalDigest': hashlib.sha256(original).hexdigest(),
              'originalMtimeNs': stat.st_mtime_ns, 'recoveryDirectory': str(backup)}
    save(report_file, report)
    try:
        build, _ = study.commands('codeindex', corpus, store)
        update = [*build]; update[2] = 'update'
        assert study.measure(f'{corpus}-noop', update, 300)['status'] == 'success'
        assert all(p.read_bytes() == data for p, data in pointers.items())
        declaration = 'export function' if corpus == 'vscode' else 'int'
        parameters = '()' if corpus == 'vscode' else '(void)'
        addition = f'\n\n// reliability body probe token\n{declaration} {marker}_helper{parameters} {{ return 42; }}\n{declaration} {marker}{parameters} {{ return {marker}_helper(); }}\n'
        file.write_bytes(original + addition.encode())
        git(source, 'add', '--', cases[corpus]['path'])
        git(source, 'commit', '-qm', '新增解析可靠性验收探针')
        report['updatedRevision'] = git(source, 'rev-parse', 'HEAD')
        inventory = load(study.data / 'inputs' / f'{corpus}.files.json')
        item = next(item for item in inventory if item['path'] == cases[corpus]['path'])
        contents = file.read_bytes()
        item.update(digest=hashlib.sha256(contents).hexdigest(), bytes=len(contents),
                    gitBlobOid=hashlib.sha1(f'blob {len(contents)}\0'.encode() + contents).hexdigest())
        inventory_file = study.data / 'updated-inventories' / f'{corpus}.json'
        save(inventory_file, inventory)
        save(report_file, report)
        assert study.measure(f'{corpus}-update', update, 300)['status'] == 'success'
        report['probe'] = checked(f'{corpus}-update-probe', ['node', ROOT / 'benchmarks/reliability/update-check.mjs', store, marker, cases[corpus]['path'], 'present'])
        audit = checked(f'{corpus}-update-audit', ['node', ROOT / 'benchmarks/reliability/audit.mjs', store, corpus, inventory_file])
        baseline = load(study.results / f'{corpus}-audit.stdout')
        assert len(audit['rows']) == len(baseline['rows'])
        assert all(new['query'] == old['query'] and new['mode'] == old['mode']
                   and (not old['hitAt10'] or new['hitAt10'])
                   and (not old['expectedEvidence'] or new['expectedEvidence'])
                   for old, new in zip(baseline['rows'], audit['rows']))
        relations = study.relation_query('codeindex', corpus, store, f'{corpus}-update-relations')
        old_relations = load(study.results / f'{corpus}-relations.stdout')['rows']
        assert relations and len(relations['rows']) == len(old_relations)
        assert all(not old['hit'] or new['hit'] for old, new in zip(old_relations, relations['rows']))
        report['baselineQueriesAndRelationsPreserved'] = True
        oracle = study.data / 'oracles' / 'codeindex' / corpus
        assert not oracle.exists() and oracle.resolve() == oracle
        rebuild, _ = study.commands('codeindex', corpus, oracle)
        assert study.measure(f'{corpus}-oracle-build', rebuild)['status'] == 'success'
        report['equivalence'] = checked(f'{corpus}-equivalence', ['node', ROOT / 'benchmarks/reliability/equivalence.mjs', oracle, store, inventory_file])
        assert report['equivalence']['equivalent']
        report['completed'] = True
        shutil.rmtree(oracle)
    finally:
        if study.active_unit:
            raise RuntimeError(f'Refusing restore with active descendants: {study.active_unit}')
        git(source, 'reset', '--hard', revision)
        file.write_bytes(original)
        os.utime(file, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        for pointer, contents in pointers.items():
            pointer.write_bytes(contents)
        study.verify(corpus, revision)
        assert file.stat().st_mtime_ns == stat.st_mtime_ns
        assert all(p.read_bytes() == data for p, data in pointers.items())
        report['restoredProbe'] = checked(f'{corpus}-restored-probe', ['node', ROOT / 'benchmarks/reliability/update-check.mjs', store, marker, cases[corpus]['path'], 'absent'])
        report['restored'] = True
        save(report_file, report)
        if report['completed']:
            shutil.rmtree(backup)
print('UPDATES_COMPLETE', flush=True)
