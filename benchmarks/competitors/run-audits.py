#!/usr/bin/env python3
"""Run read-only audits after all build measurements have finished."""
import argparse
import html
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / '.data/competitors'
RESULTS = ROOT / 'benchmarks/results/competitors'
p = argparse.ArgumentParser()
p.add_argument('--tools', type=Path, required=True)
a = p.parse_args()
tools = a.tools.resolve()
questions = {'pageindex':'questions-identifiers-pageindex.json', 'typescript':'questions-identifiers-typescript.json', 'linux':'questions-linux-c.json'}
env = dict(os.environ, SCIP_INDEXER='false', ENABLE_AUTO_WATCH='false')
revisions = {item['name']: item['inputGitRevision'] for item in json.loads((DATA / 'inputs/inputs.json').read_text())}

def audit(command, output, required):
    if output.exists():
        try:
            data = json.loads(output.read_text())
            if required in data:
                return
        except ValueError:
            pass
    pending = output.with_suffix('.pending')
    with pending.open('w') as stdout, output.with_suffix('.stderr').open('w') as stderr:
        subprocess.run(list(map(str, command)), env=env, cwd=ROOT, stdout=stdout, stderr=stderr, check=True, timeout=180)
    data = json.loads(pending.read_text())
    if required not in data:
        raise ValueError(f'Incomplete audit: {output}')
    pending.replace(output)

for corpus, question_name in questions.items():
    root = DATA / 'inputs' / corpus
    inventory = DATA / 'inputs' / f'{corpus}.files.json'
    question_file = ROOT / 'benchmarks' / question_name
    for tool in ['codeindex', 'opengrok', 'zoekt', 'cgc']:
        prefix = RESULTS / f'{tool}-{corpus}'
        build = json.loads(Path(str(prefix) + '-build.json').read_text())
        if build['status'] != 'success': continue
        store = DATA / tool / corpus
        if tool == 'codeindex': command = ['node', ROOT / 'benchmarks/competitors/codeindex-audit.mjs', store, inventory, question_file]
        elif tool == 'opengrok': command = ['java', '-cp', f'{tools}:{tools}/opengrok-1.14.20/lib/*', 'OpenGrokAudit', store / 'config.xml', inventory, question_file]
        elif tool == 'zoekt': command = [tools / 'zoekt-audit', store, inventory, root, revisions[corpus]]
        else: command = [tools / 'cgc-venv/bin/python', ROOT / 'benchmarks/competitors/cgc-audit.py', store, root, inventory]
        output = Path(str(prefix) + '-audit.json')
        print('audit', tool, corpus, flush=True)
        audit(command, output, 'sourceDigestMismatches' if tool == 'zoekt' else 'inputFiles')
        if tool == 'zoekt':
            query_output = Path(str(prefix) + '-query.json')
            old_query = Path(str(prefix) + '-query-match-limit200.json')
            if not old_query.exists() and query_output.exists():
                query_output.rename(old_query)
            audit([tools / 'zoekt-query', store, question_file, 'symbol'], query_output, 'rows')
        if corpus in ['pageindex', 'linux'] and tool in ['codeindex', 'cgc']:
            output = Path(str(prefix) + '-relations.json')
            if tool == 'codeindex': command = ['node', ROOT / 'benchmarks/competitors/codeindex-relations.mjs', store, corpus, ROOT / 'benchmarks/competitors/relation-cases.json']
            else: command = [tools / 'cgc-venv/bin/python', ROOT / 'benchmarks/competitors/cgc-relations.py', store, root, corpus, ROOT / 'benchmarks/competitors/relation-cases.json']
            audit(command, output, 'rows')
        query_file = Path(str(prefix) + '-query.json')
        if not query_file.exists(): continue
        snippets, metadata, errors, absent = 0, 0, [], []
        for row in json.loads(query_file.read_text())['rows']:
            for file in row['files']:
                source = root / file['path']
                if not source.is_file():
                    absent.append(file['path'])
                    continue
                lines = source.read_text(encoding='utf-8', errors='replace').splitlines()
                for line in file.get('lines', []):
                    number = line.get('line')
                    if isinstance(number, str) and number.isdigit():
                        number = int(number)
                    excerpt = line.get('source') or ''
                    if not excerpt:
                        metadata += 1
                        continue
                    if tool == 'opengrok': excerpt = html.unescape(re.sub(r'<[^>]*>', '', excerpt))
                    rendered = excerpt.splitlines()
                    actual = lines[number - 1:number - 1 + len(rendered)] if isinstance(number, int) and number > 0 else []
                    snippets += 1
                    if len(rendered) != len(actual) or any(text.strip() not in raw.strip() for text, raw in zip(rendered, actual)):
                        errors.append({'query':row['query'], 'path':file['path'], 'line':number, 'returned':excerpt, 'actual':'\n'.join(actual)})
        Path(str(prefix) + '-evidence-check.json').write_text(json.dumps({'snippetsChecked':snippets, 'metadataOnlyLocations':metadata, 'mismatches':errors, 'absentPaths':absent}, indent=2) + '\n', encoding='utf-8')
print('AUDITS_COMPLETE', flush=True)
