#!/usr/bin/env python3
"""Coverage, source evidence, content retrieval and direct-call checks."""
import html
import re
from common import ROOT, Study, load, options, save

args = options(__doc__).parse_args()
study = Study(args)
revisions = {row['name']: row['inputGitRevision'] for row in load(study.data / 'inputs/inputs.json')}


def evidence(corpus, tool, report, questions, kind):
    source = study.source(corpus)
    expected = {row['query']: row for row in load(questions)}
    errors, absent, locations = [], [], []
    snippets, metadata = 0, 0
    for row in report['rows']:
        expected_line_seen = False
        oracle = expected[row['query']]
        for file in row['files']:
            target = source / file['path']
            if not target.is_file():
                absent.append(file['path'])
                continue
            lines = target.read_text(encoding='utf-8', errors='replace').splitlines()
            for line in file.get('lines', []):
                number = line.get('line')
                if isinstance(number, str) and number.isdigit():
                    number = int(number)
                excerpt = line.get('source') or ''
                if tool == 'opengrok':
                    excerpt = html.unescape(re.sub(r'<[^>]*>', '', excerpt))
                rendered = excerpt.splitlines()
                if file['path'] in oracle['expectedPaths'] and isinstance(number, int):
                    expected_line_seen |= number <= oracle['expectedLine'] < number + max(1, len(rendered))
                if not excerpt:
                    metadata += 1
                    continue
                actual = lines[number - 1:number - 1 + len(rendered)] if isinstance(number, int) and number > 0 else []
                snippets += 1
                if len(actual) != len(rendered) or any(text.strip() not in raw.strip() for text, raw in zip(rendered, actual)):
                    errors.append({'query': row['query'], 'path': file['path'], 'line': number, 'returned': excerpt, 'actual': '\n'.join(actual)})
        locations.append({'query': row['query'], 'hitAt10': row['hitAt10'], 'expectedLineReturned': expected_line_seen})
    save(study.results / f'{tool}-{corpus}-{kind}-evidence.json', {'snippetsChecked': snippets, 'metadataOnlyLocations': metadata, 'mismatches': errors, 'absentPaths': absent, 'locations': locations})


for corpus in args.corpora:
    source = study.source(corpus)
    inventory = study.data / 'inputs' / f'{corpus}.files.json'
    questions = study.questions(corpus)
    for tool in args.tool_names:
        prefix = f'{tool}-{corpus}'
        if load(study.results / f'{prefix}-build.json')['status'] != 'success':
            continue
        store = study.store(tool, corpus)
        adapters = ROOT / 'benchmarks/competitors'
        if tool == 'codeindex':
            command = ['node', adapters / 'codeindex-audit.mjs', store, inventory, questions]
        elif tool == 'opengrok':
            command = ['java', '-cp', f'{study.tools}:{study.tools}/opengrok-1.14.20/lib/*', 'OpenGrokAudit', store / 'config.xml', inventory, questions]
        elif tool == 'zoekt':
            command = [study.tools / 'zoekt-audit', store, inventory, source, revisions[corpus]]
        else:
            command = [study.tools / 'cgc-venv/bin/python', adapters / 'cgc-audit.py', store, source, inventory]
        study.adapter(prefix + '-audit', command)
        if tool == 'cgc':
            study.adapter(prefix + '-definitions', [study.tools / 'cgc-venv/bin/python', ROOT / 'benchmarks/heldout/cgc-definition-audit.py', store, source, questions])
        study.relation_query(tool, corpus, store, prefix + '-relations')
        query_file = study.results / f'{prefix}-query.json'
        if query_file.exists():
            evidence(corpus, tool, load(query_file), questions, 'symbol')
        content_questions = ROOT / 'benchmarks/heldout/questions' / f'{corpus}-content.json'
        _, content_command = study.commands(tool, corpus, store, content_questions, mode='text')
        content = study.adapter(prefix + '-content-query', content_command)
        if content is not None:
            evidence(corpus, tool, content, content_questions, 'content')
    study.verify(corpus, revisions[corpus])
if 'llvm' in args.corpora:
    study.adapter('ctags-llvm-overflow-diagnostic', ['python3', ROOT / 'benchmarks/heldout/reproduce-ctags-crash.py', study.ctags, study.source('llvm')])
    study.verify('llvm', revisions['llvm'])
print('AUDITS_COMPLETE', flush=True)
