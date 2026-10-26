#!/usr/bin/env python3
"""从保留的原始记录生成可复核汇总。"""
import json
from pathlib import Path
import re
import statistics

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'benchmarks/results/reliability'

def load(name):
    return json.loads((RESULTS / name).read_text(encoding='utf-8'))

rows = []
for corpus in ('cpython', 'vscode', 'llvm'):
    builds, cpu, queries = [], [], []
    for prefix in ('', 'repeat2-', 'repeat3-'):
        stem = f'{prefix}codeindex-{corpus}'
        metric = load(stem + '-build.json')
        assert metric['status'] == 'success'
        builds.append(metric)
        text = (RESULTS / (stem + '-build.time')).read_text()
        cpu.append(sum(float(re.search(label + r' \(seconds\): ([\d.]+)', text)[1]) for label in ('User time', 'System time')))
        queries.append(load(stem + '-query.json'))
    audit = load(corpus + '-audit.stdout')
    relations = load(corpus + '-relations.stdout')
    updates = load(corpus + '-updates.json')
    strict = load(corpus + '-strict-result.json')
    assert updates['restored'] and strict == {'equivalent': True, 'restored': True}
    symbols = [row for row in audit['rows'] if row['mode'] == 'symbol']
    content = [row for row in audit['rows'] if row['mode'] == 'content']
    equivalence_name = corpus + ('-final-equivalence' if (RESULTS / f'{corpus}-final-equivalence.json').exists() else '-strict-equivalence')
    rows.append({'corpus': corpus, 'files': audit['stats']['files'], 'buildSeconds': [b['wallSeconds'] for b in builds],
        'medianBuildSeconds': statistics.median(b['wallSeconds'] for b in builds), 'cpuSeconds': cpu,
        'medianCpuSeconds': statistics.median(cpu), 'gnuMaxRssMiB': [b['gnuTimeMaxRssKiB']/1024 for b in builds],
        'sampledTreeRssGiB': [b['sampledProcessTreeRssSumBytes']/2**30 for b in builds],
        'cgroupPeakGiB': [b['cgroupMemoryPeakBytes']/2**30 for b in builds],
        'storageBytes': load(f'codeindex-{corpus}-storage.json')['bytes'], 'stats': audit['stats'], 'parseStatus': audit['status'],
        'symbolFileHits': sum(r['hitAt10'] for r in symbols), 'symbolDeclarationEvidence': sum(r['expectedEvidence'] for r in symbols),
        'contentHits': sum(r['hitAt10'] and r['expectedEvidence'] for r in content), 'callHits': sum(r['hit'] for r in relations['rows']),
        'bodyFilesVerified': audit['bodyFilesVerified'], 'evidenceChecked': audit['evidenceChecked'],
        'medianLoadMs': statistics.median(q['loadMs'] for q in queries),
        'medianHotMetadataMs': statistics.median(r['medianMs'] for q in queries for r in q['rows']),
        'medianFirstMetadataMs': statistics.median(r['coldMs'] for q in queries for r in q['rows']),
        'medianEvidenceMs': statistics.median(r['evidenceMs'] for q in queries for r in q['rows']),
        'noopSeconds': load(corpus + '-noop.json')['wallSeconds'], 'updateSeconds': load(corpus + '-update.json')['wallSeconds'],
        'oracleSeconds': load(corpus + '-strict-oracle-build.json')['wallSeconds'],
        'equivalenceSeconds': load(equivalence_name + '-measurement.json')['wallSeconds'],
        'equivalence': load(equivalence_name + '.json'), 'restored': True})
for name, count in [('node24', 122), ('node22-verified', 122)]:
    assert load(f'checks/{name}.json')['status'] == 'success'
    output = (RESULTS / f'checks/{name}.stdout').read_text()
    assert f'tests {count}' in output and 'fail 0' in output
result = {'productCommit': 'dec7a41', 'memoryLimitGiB': 12, 'swapAllowed': False, 'rows': rows,
    'tests': {'node24.13.1': 122, 'node22.23.2': 122},
    'invalidOrSupersededRecords': {'checks/node22': 'PATH resolved env to a shell setup script; no tests ran',
        'llvm-equivalence-measurement': 'Unbounded Buffer assertion exhausted V8 while formatting native posting differences; replaced by streaming SHA-256, equal-length Cscope cwd headers and exclusion of ABI padding',
        'cpython-equivalence': 'Superseded by strict equivalence including file layouts and native indexes',
        'vscode-strict-equivalence-measurement': 'Raw dictionary bytes include padding and unused block space; superseded by all defined dictionary fields and postings',
        'vscode-equivalence': 'Superseded by strict equivalence including file layouts and native indexes'}}
(RESULTS / 'summary.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
print(json.dumps([{key: row[key] for key in ('corpus','medianBuildSeconds','medianCpuSeconds','storageBytes','medianHotMetadataMs','noopSeconds','updateSeconds','equivalenceSeconds')}for row in rows],indent=2))
