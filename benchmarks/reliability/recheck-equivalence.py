#!/usr/bin/env python3
"""为早期更新结果补充文件布局和全部 Cscope 产物比较。"""
import os
from pathlib import Path
import shutil
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'heldout'))
from common import ROOT, Study, git, load, options, save

args = options(__doc__).parse_args()
assert args.data.resolve().name == args.results.resolve().name == 'reliability'
study = Study(args)
for corpus in args.corpora:
    report = load(study.results / f'{corpus}-updates.json')
    assert report['restored'] and report['baselineQueriesAndRelationsPreserved'] and report['probe']['callVerified']
    source = study.source(corpus)
    assert source.resolve() == source and source.parent == study.data / 'inputs'
    file = source / report['path']
    assert file.resolve() == file and file.stat().st_nlink == 1
    assert git(source, 'rev-parse', 'HEAD') == report['originalRevision']
    assert not git(source, 'status', '--porcelain')
    original, stat = file.read_bytes(), file.stat()
    snapshots = [p.parent for p in study.store('codeindex', corpus).glob('*/snapshots/*/manifest.json')
                 if load(p)['git']['revision'] == report['updatedRevision']]
    assert len(snapshots) == 1
    oracle = study.data / 'oracles' / 'codeindex' / corpus
    assert oracle.resolve() == oracle
    if oracle.exists():
        manifests = list(oracle.glob('*/snapshots/*/manifest.json'))
        assert len(manifests) == 1 and load(manifests[0])['git']['revision'] == report['updatedRevision']
    try:
        git(source, 'reset', '--hard', report['updatedRevision'])
        build, _ = study.commands('codeindex', corpus, oracle)
        assert study.measure(f'{corpus}-strict-oracle-build', build)['status'] == 'success'
        result = study.adapter(f'{corpus}-final-equivalence', ['node', ROOT / 'benchmarks/reliability/equivalence.mjs',
            oracle, snapshots[0], study.data / 'updated-inventories' / f'{corpus}.json'], 1800)
        assert result and result['equivalent']
        save(study.results / f'{corpus}-strict-result.json', {'equivalent': True, 'restored': False})
        shutil.rmtree(oracle)
    finally:
        assert not study.active_unit
        git(source, 'reset', '--hard', report['originalRevision'])
        file.write_bytes(original)
        os.utime(file, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        study.verify(corpus, report['originalRevision'])
        result_file = study.results / f'{corpus}-strict-result.json'
        if result_file.exists():
            save(result_file, {'equivalent': True, 'restored': True})
print('STRICT_EQUIVALENCE_COMPLETE', flush=True)
