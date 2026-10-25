#!/usr/bin/env python3
"""Check actual File nodes against the exact supplied inventory."""
import json
from pathlib import Path
import sys
from codegraphcontext.core.database_falkordb import FalkorDBManager

manager = FalkorDBManager(db_path=sys.argv[1])
root = Path(sys.argv[2])
expected = {item['path'] for item in json.loads(Path(sys.argv[3]).read_text(encoding='utf-8'))}
try:
    with manager.get_driver().session() as session:
        paths = [row['path'] for row in session.run('MATCH (f:File) RETURN f.path AS path').data()]
    found = {str(Path(path).relative_to(root)) for path in paths if Path(path).is_relative_to(root)}
    print(json.dumps({'inputFiles': len(expected), 'indexedInputFiles': len(expected & found),
                      'missingFiles': sorted(expected - found), 'additionalFiles': sorted(found - expected)}, indent=2))
finally:
    manager.close_driver()
