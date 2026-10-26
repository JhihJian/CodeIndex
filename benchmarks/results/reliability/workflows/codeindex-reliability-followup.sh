#!/bin/bash
set -euo pipefail
cd /data/dev/CodeIndex-worktrees/feature/parser-reliability
ulimit -c 0
python3 benchmarks/competitors/measure.py --output benchmarks/results/reliability/checks/node22-verified --memory-gib 12 --seconds 600 -- /usr/bin/env PATH="/home/jhihjian/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH" /home/jhihjian/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node --test
python3 - <<'PY'
from pathlib import Path
s=Path('benchmarks/results/reliability/checks/node22-verified.stdout').read_text()
assert '# tests 122' in s or 'tests 122' in s
assert '# fail 0' in s or 'fail 0' in s
PY
python3 benchmarks/reliability/run-updates.py --data /data/dev/CodeIndex/.data/reliability --tools /data/dev/benchmark-tools --results benchmarks/results/reliability --tool-names codeindex
echo FOLLOWUP_COMPLETE
