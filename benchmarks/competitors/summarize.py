#!/usr/bin/env python3
"""Summarize completed measurements without treating failed builds as usable indexes."""
import json
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'benchmarks/results/competitors'
def read(name):
    return json.loads((RESULTS / name).read_text(encoding='utf-8'))

builds = []
updates = []
for corpus in ['pageindex', 'typescript', 'linux']:
    for tool in ['codeindex', 'opengrok', 'zoekt', 'cgc']:
        prefix = f'{tool}-{corpus}'
        build = read(prefix + '-build.json')
        status = build['status']
        if (RESULTS / (prefix + '-failure.json')).exists():
            status = read(prefix + '-failure.json')['classification']
        row = {'corpus': corpus, 'tool': tool, 'status': status,
               'seconds': build['wallSeconds'] if build['wallSeconds'] is not None else build['wallSecondsIncludingSupervisor'],
               'timeSource': 'GNU time' if build['wallSeconds'] is not None else 'supervisor',
               'gnuTimeMaxRssKiB': build['gnuTimeMaxRssKiB'],
               'sampledProcessTreeRssSumBytes': build['sampledProcessTreeRssSumBytes'],
               'cgroupMemoryPeakBytes': build['cgroupMemoryPeakBytes']}
        if status == 'success':
            query = read(prefix + '-query.json')
            audit = read(prefix + '-audit.json')
            evidence = read(prefix + '-evidence-check.json')
            for field in ['digestMismatches', 'checksumMismatches', 'versionMismatches', 'sourceDigestMismatches']:
                assert not audit.get(field), (prefix, field)
            row.update({'storageBytes': read(prefix + '-storage.json')['bytes'],
                        'hits': sum(item['hitAt10'] for item in query['rows']), 'questions': len(query['rows']),
                        'queryMedianMs': statistics.median(item['medianMs'] for item in query['rows']),
                        'queryMinMs': min(item['medianMs'] for item in query['rows']),
                        'queryMaxMs': max(item['medianMs'] for item in query['rows']),
                        'indexedInputFiles': audit['indexedInputFiles'], 'inputFiles': audit['inputFiles'],
                        'contentOmitted': len(audit.get('contentOmitted', [])),
                        'evidenceMismatches': len(evidence['mismatches']), 'evidenceAbsentPaths': len(evidence['absentPaths'])})
            relation_file = RESULTS / (prefix + '-relations.json')
            if relation_file.exists():
                relations = read(relation_file.name)['rows']
                row['relationHits'] = sum(item['hit'] for item in relations)
                row['relationCases'] = len(relations)
        builds.append(row)
    report = read(corpus + '-updates.json')
    assert report['completed'] and report['restoredInput'] and report['restoredIndexesVerified'], corpus
    for operation in report['operations']:
        metric = operation['measurement']
        updates.append({'corpus': corpus, 'tool': operation['tool'], 'mode': operation['mode'],
                        'status': metric['status'], 'seconds': metric['wallSeconds'] if metric['wallSeconds'] is not None else metric['wallSecondsIncludingSupervisor'],
                        'checks': operation.get('checks'), 'semantics': operation.get('semantics')})
        if operation['mode'] == 'delta-update':
            updates[-1]['fellBackToFullBuild'] = 'falling back to normal build' in (RESULTS / f"{operation['tool']}-{corpus}-delta-update.stderr").read_text()
delta = read('zoekt-delta-updates.json')
assert len(delta) == 3
for record in delta:
    assert record['completed'] and record['restoredInput'] and not record['restoredChecks']['probeHit'] and record['restoredChecks']['baselineHitsPreserved']
    metric = record['measurement']
    updates.append({'corpus': record['corpus'], 'tool': 'zoekt', 'mode': record['mode'], 'status': metric['status'],
                    'seconds': metric['wallSeconds'] if metric['wallSeconds'] is not None else metric['wallSecondsIncludingSupervisor'],
                    'checks': record['checks'], 'fellBackToFullBuild': record['fellBackToFullBuild']})
result = {'builds': builds, 'updates': updates, 'inputAndPublishedIndexesRestored': True}
(RESULTS / 'summary.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print('SUMMARY_COMPLETE')
