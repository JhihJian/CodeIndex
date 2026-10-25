#!/usr/bin/env python3
"""Explain parser coverage and captured line mismatches after restoration."""
from common import ROOT, Study, TOOL_NAMES, load, options, save

args = options(__doc__).parse_args()
study = Study(args)
for corpus in args.corpora:
    restored = load(study.results / f'{corpus}-updates.json')
    assert restored['completed'] and restored['restored'], corpus
    if load(study.results / f'codeindex-{corpus}-build.json')['status'] == 'success':
        study.adapter(f'codeindex-{corpus}-parser-status', ['node', ROOT / 'benchmarks/heldout/codeindex-parser-status.mjs', study.store('codeindex', corpus), corpus, study.relations()])
    for tool in TOOL_NAMES:
        rows = []
        for kind in ('symbol', 'content'):
            evidence = study.results / f'{tool}-{corpus}-{kind}-evidence.json'
            if not evidence.exists():
                continue
            for item in load(evidence)['mismatches']:
                lines = (study.source(corpus) / item['path']).read_text(encoding='utf-8', errors='replace').splitlines()
                excerpt = item['returned'].splitlines()
                matching = []
                for line in range(max(1, item['line'] - 5), item['line'] + 6):
                    actual = lines[line - 1:line - 1 + len(excerpt)]
                    if len(actual) == len(excerpt) and all(a.strip() in b.strip() for a, b in zip(excerpt, actual)):
                        matching.append(line)
                rows.append({'kind': kind, 'query': item['query'], 'path': item['path'],
                    'returnedLine': item['line'], 'matchingSourceStartLines': matching})
        if rows:
            save(study.results / f'{tool}-{corpus}-line-alignment-diagnostic.json', {
                'method': 'Offline comparison of captured mismatches against unchanged source; search five lines around returned line; scoring unchanged', 'rows': rows})
    study.verify(corpus, restored['originalRevision'])
print('DIAGNOSTICS_COMPLETE', flush=True)
