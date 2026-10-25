#!/usr/bin/env python3
"""Summarize the final measured configurations and their correctness gates."""
import json
from pathlib import Path
import re
import statistics

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'benchmarks/results'
PERFORMANCE = RESULTS / 'performance'


def read(file):
    return json.loads(file.read_text())


def measurement(directory, name):
    result = read(directory / f'{name}.json')
    assert result['status'] == 'success', name
    assert result['memoryLimitGiB'] == 12 and not result.get('leftoverProcessIdsTerminated'), name
    return {key: result.get(key) for key in ('wallSeconds', 'gnuTimeMaxRssKiB',
        'sampledProcessTreeRssSumBytes', 'cgroupMemoryPeakBytes', 'systemdUnit')}


def cpu_seconds(directory, name):
    text = (directory / f'{name}.time').read_text()
    return sum(float(re.search(label + r': ([\d.]+)', text)[1]) for label in
               (r'User time \(seconds\)', r'System time \(seconds\)'))


rows = []
for corpus in ('pageindex', 'typescript', 'linux'):
    directory = PERFORMANCE / ('final-linux' if corpus == 'linux' else 'final')
    baseline = RESULTS / 'competitors'
    old_name = f'codeindex-{corpus}'
    old = measurement(baseline, f'{old_name}-build')
    new = measurement(directory, f'{corpus}-build')
    query = read(directory / f'{corpus}-query.json')['rows']
    audit = read(directory / f'{corpus}-audit.json')
    assert all(row['hitAt10'] for row in query)
    assert not audit['missingFiles'] and not audit['digestMismatches']
    restored = read(directory / f'{corpus}-update-verification.json')
    assert restored['completed'] and restored['restored']
    facts = read(directory / f'{corpus}-equivalence.stdout')
    updated_facts = read(PERFORMANCE / ('update-equivalence-linux' if corpus == 'linux' else 'update-equivalence') / f'{corpus}.json')
    assert facts['equivalent'] and updated_facts['equivalent']
    rows.append({'corpus': corpus, 'resultsDirectory': str(directory.relative_to(ROOT)),
        'implementationRevision': read(directory / 'environment.json')['optimizedRevision'],
        'baselineBuild': old, 'build': new,
        'buildReductionPercent': (1 - new['wallSeconds'] / old['wallSeconds']) * 100,
        'baselineCpuSeconds': cpu_seconds(baseline, f'{old_name}-build'),
        'cpuSeconds': cpu_seconds(directory, f'{corpus}-build'),
        'baselineNoop': measurement(baseline, f'{old_name}-noop'),
        'noop': measurement(directory, f'{corpus}-noop'),
        'baselineUpdate': measurement(baseline, f'{old_name}-update'),
        'update': measurement(directory, f'{corpus}-update'),
        'buildStats': read(directory / f'{corpus}-build.stdout')['stats'],
        'updateStats': read(directory / f'{corpus}-update.stdout')['stats'],
        'storage': read(directory / f'{corpus}-storage.json'),
        'queryHits': sum(row['hitAt10'] for row in query), 'queryCases': len(query),
        'queryMedianMs': statistics.median(row['medianMs'] for row in query),
        'baselineQueryMedianMs': statistics.median(row['medianMs'] for row in read(baseline / f'{old_name}-query.json')['rows']),
        'evidenceChecked': audit['evidenceChecked'], 'fullEquivalence': facts,
        'updateEquivalence': updated_facts, 'restored': True})

summary = {'baselineRevision': read(PERFORMANCE / 'final/environment.json')['baselineRevision'],
    'memoryLimitGiB': 12, 'swapLimitBytes': 0, 'repetitionsPerConfiguration': 1,
    'rows': rows, 'typescriptSerial': measurement(PERFORMANCE / 'serial', 'typescript-build'),
    'node24': measurement(PERFORMANCE / 'checks-release', 'node24'),
    'node22': measurement(PERFORMANCE / 'checks-release', 'node22'),
    'inputVerification': measurement(PERFORMANCE, 'input-verification'),
    'retainedFailedAudits': ['update-equivalence-measurement.json', 'update-equivalence-linux-failed-v4-measurement.json'],
    'failureResolution': 'Cscope 15.9 macro tails and multiline source fragments reparse in 413a915; final Linux update passes strict full-body equivalence'}
(PERFORMANCE / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
print('SUMMARY_VERIFIED')
