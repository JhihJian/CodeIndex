#!/usr/bin/env python3
import json
from pathlib import Path
import sys
import time
from codegraphcontext.core.database_falkordb import FalkorDBManager
from codegraphcontext.tools.code_finder import CodeFinder

database, root, corpus, case_file = sys.argv[1:]
manager = FalkorDBManager(db_path=database)
try:
    finder = CodeFinder(manager)
    rows = []
    for case in json.loads(Path(case_file).read_text())[corpus]:
        definitions = finder.find_by_function_name(case['caller'], False, root)
        candidates = [item for item in definitions if Path(item['path']) == Path(root) / case['path']
                      and item['name'].replace('::', '.').split('.')[-1] == case['caller']]
        if not candidates:
            rows.append(dict(case, hit=False, reason='caller definition missing'))
            continue
        caller = candidates[0]['name']
        start = time.perf_counter()
        relations = finder.what_does_function_call(caller, path=str(Path(root) / case['path']), repo_path=root, limit=256)
        elapsed = (time.perf_counter() - start) * 1000
        matches = [edge for edge in relations if edge['called_function'].replace('::', '.').split('.')[-1] == case['callee']]
        rows.append(dict(case, resolvedCaller=caller, hit=bool(matches), elapsedMs=elapsed, totalCalls=len(relations), matches=matches))
    print(json.dumps({'tool':'CodeGraphContext', 'corpus':corpus, 'rows':rows}, indent=2))
finally:
    manager.close_driver()
