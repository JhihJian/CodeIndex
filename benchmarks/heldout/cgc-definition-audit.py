#!/usr/bin/env python3
"""Read-only scoped graph inspection, separate from public query rankings."""
import json
from pathlib import Path
import sys
from codegraphcontext.core.database_falkordb import FalkorDBManager

store, source, questions = sys.argv[1:]
manager = FalkorDBManager(db_path=store)
try:
    rows = []
    with manager.get_driver().session() as session:
        for question in json.loads(Path(questions).read_text(encoding='utf-8')):
            for path in question['expectedPaths']:
                matches = []
                for label in ('Function', 'Class'):
                    found = session.run(f'''MATCH (n:{label})
                        WHERE n.path=$path AND (n.name=$name OR n.name ENDS WITH $cpp OR n.name ENDS WITH $dotted)
                        RETURN n.name AS name, n.line_number AS line, labels(n) AS labels,
                               n.source AS source''',
                        path=str(Path(source) / path), name=question['query'],
                        cpp='::' + question['query'], dotted='.' + question['query']).data()
                    for item in found:
                        source_text = item.pop('source') or ''
                        item['sourceLines'] = len(source_text.splitlines())
                        item['expectedLineCovered'] = isinstance(item['line'], int) and item['line'] <= question['expectedLine'] < item['line'] + item['sourceLines']
                    matches.extend(found)
                rows.append({'query': question['query'], 'expectedPath': path, 'scopedMatch': bool(matches),
                    'expectedLineCovered': any(item['expectedLineCovered'] for item in matches), 'matches': matches})
    print(json.dumps({'definitionProbes': rows, 'scope': 'Exact expected file and identifier leaf, independent of the public API limit and ranking'}, indent=2))
finally:
    manager.close_driver(teardown=True)
