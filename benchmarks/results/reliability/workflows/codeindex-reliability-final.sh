#!/usr/bin/env bash
set -euo pipefail
cd /data/dev/CodeIndex-worktrees/feature/parser-reliability
ulimit -c 0
results=benchmarks/results/reliability
python3 benchmarks/competitors/measure.py --output "$results/checks/node24" --memory-gib 12 --seconds 600 -- node --test
python3 -c 'import json; assert json.load(open("benchmarks/results/reliability/checks/node24.json"))["status"] == "success"'
python3 benchmarks/competitors/measure.py --output "$results/checks/node22" --memory-gib 12 --seconds 600 -- env PATH="/home/jhihjian/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH" node --test
python3 -c 'import json; assert json.load(open("benchmarks/results/reliability/checks/node22.json"))["status"] == "success"'
python3 benchmarks/heldout/run-builds.py --data /data/dev/CodeIndex/.data/reliability --tools /data/dev/benchmark-tools --results "$results" --tool-names codeindex
for corpus in cpython vscode llvm; do
  python3 benchmarks/competitors/measure.py --output "$results/$corpus-audit" --memory-gib 12 --seconds 1800 -- node benchmarks/reliability/audit.mjs "/data/dev/CodeIndex/.data/reliability/indexes/codeindex/$corpus" "$corpus" "/data/dev/CodeIndex/.data/reliability/inputs/$corpus.files.json"
  python3 benchmarks/competitors/measure.py --output "$results/$corpus-relations" --memory-gib 12 --seconds 300 -- node benchmarks/competitors/codeindex-relations.mjs "/data/dev/CodeIndex/.data/reliability/indexes/codeindex/$corpus" "$corpus" benchmarks/heldout/relation-cases.json
done
echo FINAL_BUILDS_AND_AUDITS_COMPLETE
