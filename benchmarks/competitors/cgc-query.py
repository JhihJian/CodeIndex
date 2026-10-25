#!/usr/bin/env python3
"""Exercise public CodeFinder methods against the default FalkorDB Lite backend."""
import json
from pathlib import Path
import statistics
import sys
import time

from codegraphcontext.core.database_falkordb import FalkorDBManager
from codegraphcontext.tools.code_finder import CodeFinder

if len(sys.argv) != 5:
    raise SystemExit('usage: cgc-query.py DATABASE REPOSITORY QUESTIONS symbol|text')
database, repository, question_file, mode = sys.argv[1:]
questions = json.loads(Path(question_file).read_text(encoding='utf-8'))
started = time.perf_counter()
manager = FalkorDBManager(db_path=database)
manager.get_driver()
finder = CodeFinder(manager)
load_ms = (time.perf_counter() - started) * 1000
rows = []
try:
    for question in questions:
        timings = []
        for repetition in range(21):
            begin = time.perf_counter()
            if mode == 'symbol':
                results = finder.find_by_function_name(question['query'], False, repository)
                results += finder.find_by_class_name(question['query'], False, repository)
            else:
                results = finder.find_by_content(question['query'], repository)
            elapsed = (time.perf_counter() - begin) * 1000
            if repetition == 0:
                cold = elapsed
            else:
                timings.append(elapsed)
        files = []
        seen = set()
        for item in results:
            relative = str(Path(item['path']).relative_to(repository))
            if relative in seen:
                continue
            seen.add(relative)
            files.append({'path': relative, 'symbol': item.get('name'), 'lines': [
                {'line': item.get('line_number'), 'source': '\n'.join((item.get('source') or '').splitlines()[:3])}
            ]})
            if len(files) == 10:
                break
        rows.append({'query': question['query'], 'hitAt10': any(item['path'] in question.get('expectedPaths', []) for item in files),
                     'coldMs': cold, 'medianMs': statistics.median(timings), 'files': files})
    counts = {}
    with manager.get_driver().session() as session:
        for key, query in [('nodes', 'MATCH (n) RETURN count(n) AS n'),
                           ('relations', 'MATCH ()-[r]->() RETURN count(r) AS n'),
                           ('files', 'MATCH (n:File) RETURN count(n) AS n'),
                           ('functions', 'MATCH (n:Function) RETURN count(n) AS n'),
                           ('classes', 'MATCH (n:Class) RETURN count(n) AS n')]:
            counts[key] = session.run(query).single()['n']
    print(json.dumps({'tool': 'CodeGraphContext', 'backend': 'FalkorDB Lite', 'loadMs': load_ms,
                      'mode': mode, 'warmup': 1, 'repetitions': 20, 'rows': rows, 'counts': counts}, indent=2))
finally:
    manager.close_driver()
