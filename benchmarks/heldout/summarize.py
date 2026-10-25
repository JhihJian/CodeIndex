#!/usr/bin/env python3
"""Summarize completed measurements without dropping failures or quality gaps."""
import argparse
from pathlib import Path
import re
from statistics import median
from common import CORPORA, ROOT, TOOL_NAMES, load, save


def distribution(values):
    values = [value for value in values if value is not None]
    return {'n': len(values), 'median': median(values), 'min': min(values), 'max': max(values)} if values else None


def cpu_seconds(file):
    text = file.read_text(encoding='utf-8')
    values = [re.search(rf'{kind} time \(seconds\):\s*([0-9.]+)', text) for kind in ('User', 'System')]
    return sum(float(value[1]) for value in values) if all(values) else None


def optional(file):
    return load(file) if file.exists() else None


def summarize(results):
    rows = []
    for corpus in CORPORA:
        updates = load(results / f'{corpus}-updates.json')
        assert updates['completed'] and updates['restored'], corpus
        for tool in TOOL_NAMES:
            name = f'{tool}-{corpus}'
            builds, queries, sizes, cpus = [], [], [], []
            for prefix in (name, f'repeat2-{name}', f'repeat3-{name}'):
                metric = optional(results / f'{prefix}-build.json')
                if metric is None:
                    continue
                builds.append(metric)
                cpus.append(cpu_seconds(results / f'{prefix}-build.time'))
                query = optional(results / f'{prefix}-query.json')
                if query is not None:
                    queries.append(query)
                size = optional(results / f'{prefix}-storage.json')
                if size is not None:
                    sizes.append(size['bytes'])
            assert builds, name
            if builds[0]['status'] == 'success' and (results / f'{name}-query.json').exists():
                assert len(builds) == 3, name
            query_measurements = [optional(results / f'{prefix}-query-measurement.json') for prefix in (name, f'repeat2-{name}', f'repeat3-{name}')]
            audit = optional(results / f'{name}-audit.json')
            definitions = optional(results / f'{name}-definitions.json') or audit
            relations = optional(results / f'{name}-relations.json')
            content = optional(results / f'{name}-content-query.json')
            row = {'corpus': corpus, 'tool': tool, 'buildStatuses': [item['status'] for item in builds],
                'buildSeconds': distribution([item['wallSeconds'] for item in builds]),
                'supervisedSeconds': distribution([item['wallSecondsIncludingSupervisor'] for item in builds]),
                'attempts': [{'status': item['status'], 'wallSeconds': item['wallSeconds'],
                    'supervisedSeconds': item['wallSecondsIncludingSupervisor'], 'timeLimitSeconds': item['timeLimitSeconds']} for item in builds],
                'cpuSeconds': distribution(cpus),
                'gnuTimeMaxRssMiB': distribution([item['gnuTimeMaxRssKiB'] / 1024 if item['gnuTimeMaxRssKiB'] is not None else None for item in builds]),
                'sampledTreeRssMiB': distribution([item['sampledProcessTreeRssSumBytes'] / 2**20 if item['workloadSampled'] else None for item in builds]),
                'cgroupPeakGiB': distribution([item['cgroupMemoryPeakBytes'] / 2**30 if item['cgroupMemoryPeakBytes'] is not None else None for item in builds]),
                'indexMiB': distribution([size / 2**20 for size in sizes]),
                'queryStatuses': [item['status'] for item in query_measurements if item is not None],
                'symbolHitsByRun': [sum(item['hitAt10'] for item in query['rows']) for query in queries],
                'symbolQuestions': len(load(ROOT / f'benchmarks/heldout/questions/{corpus}.json')),
                'hotQueryMs': distribution([item['medianMs'] for query in queries for item in query['rows']]),
                'firstQueryMs': distribution([item['coldMs'] for query in queries for item in query['rows']]),
                'loadMs': distribution([query['loadMs'] for query in queries]),
                'symbolMisses': [item['query'] for item in queries[0]['rows'] if not item['hitAt10']] if queries else None,
                'indexedFiles': audit.get('indexedInputFiles') if audit else None,
                'missingFiles': len(audit['missingFiles']) if audit else None,
                'definitionProbes': definitions.get('definitionProbes') if definitions else None,
                'coverage': audit.get('coverage') if audit else None,
                'contentOmittedFiles': len(audit.get('contentOmitted', [])) if audit else None,
                'contentHits': sum(item['hitAt10'] for item in content['rows']) if content else None,
                'contentQuestions': len(load(ROOT / f'benchmarks/heldout/questions/{corpus}-content.json')),
                'relations': {'hits': sum(item['hit'] for item in relations['rows']), 'questions': len(relations['rows'])} if relations else None,
                'evidence': {kind: optional(results / f'{name}-{kind}-evidence.json') for kind in ('symbol', 'content')},
                'updates': [{'mode': item['mode'], 'status': item['measurement']['status'], 'seconds': item['measurement']['wallSeconds'], 'checks': item.get('checks'), 'semantics': item.get('semantics')} for item in updates['operations'] if item['tool'] == tool],
                'restored': updates.get('restoredChecks', {}).get(tool)}
            rows.append(row)
    return {'method': 'Three fresh builds for initially successful build/query pairs; failures retained once. Ranges summarize actual observations, not confidence intervals. Hot queries summarize per-question medians of 20 runs. Memory statistics use their separate original definitions.', 'rows': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', type=Path, default=ROOT / 'benchmarks/results/heldout')
    args = parser.parse_args()
    report = summarize(args.results)
    save(args.results / 'summary.json', report)
    for row in report['rows']:
        print(row['corpus'], row['tool'], row['buildStatuses'], row['buildSeconds'], row['symbolHitsByRun'])
