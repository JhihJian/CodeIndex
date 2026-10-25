#!/usr/bin/env python3
"""Wait for the serial build matrix, then run audits and restorative update probes."""
from pathlib import Path
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[2]
marker = root / '.data/competitors/builds.exit'
while not marker.exists():
    time.sleep(10)
if marker.read_text().strip() != '0':
    raise SystemExit('Build runner failed; inspect builds.log before resuming follow-up')
for script in ['run-audits.py', 'run-updates.py']:
    subprocess.run([sys.executable, str(root / 'benchmarks/competitors' / script), *sys.argv[1:]], cwd=root, check=True)
print('FOLLOWUP_COMPLETE', flush=True)
