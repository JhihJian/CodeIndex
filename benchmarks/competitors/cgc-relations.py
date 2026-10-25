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
        start = time.perf_counter()
        relations = finder.what_does_function_call(case['caller'], path=str(Path(root) / case['path']), repo_path=root, limit=256)
        elapsed = (time.perf_counter() - start) * 1000
        matches = [edge for edge in relations if edge['called_function'] == case['callee']]
        rows.append(dict(case, hit=bool(matches), elapsedMs=elapsed, totalCalls=len(relations), matches=matches))
    print(json.dumps({'tool':'CodeGraphContext', 'corpus':corpus, 'rows':rows}, indent=2))
finally:
    manager.close_driver()
