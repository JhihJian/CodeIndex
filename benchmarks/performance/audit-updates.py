#!/usr/bin/env python3
"""Compare retained update snapshots without changing sources or publication pointers."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser()
p.add_argument('--baseline-stores', type=Path, required=True)
p.add_argument('--optimized-stores', type=Path, required=True)
p.add_argument('--inputs', type=Path, required=True)
p.add_argument('--run-results', type=Path, required=True)
p.add_argument('--results', type=Path, required=True)
p.add_argument('--corpora', nargs='+', choices=['pageindex', 'typescript', 'linux'], default=['pageindex', 'typescript', 'linux'])
a = p.parse_args()
a.results.mkdir(parents=True, exist_ok=False)


def snapshot(store, identity):
    matches = [file.parent for file in store.glob('*/snapshots/*/manifest.json')
               if json.loads(file.read_text())['snapshotId'] == identity]
    if len(matches) != 1:
        raise RuntimeError(f'Expected one snapshot for {identity}, found {len(matches)}')
    return matches[0]


reports = []
with tempfile.TemporaryDirectory(prefix='codeindex-update-equivalence-') as temporary:
    for corpus in a.corpora:
        update = json.loads((a.run_results / f'{corpus}-update.stdout').read_text())
        verification = json.loads((a.run_results / f'{corpus}-update-verification.json').read_text())
        assert verification['completed'] and verification['restored']
        before = snapshot(a.baseline_stores / corpus, update['snapshotId'])
        after = snapshot(a.optimized_stores / corpus, update['snapshotId'])
        inventory = json.loads((a.inputs / f'{corpus}.files.json').read_text())
        changed = verification['file']
        digest = hashlib.sha256((after / 'tree' / changed).read_bytes()).hexdigest()
        assert digest == verification['updatedFileDigest']
        assert hashlib.sha256((before / 'tree' / changed).read_bytes()).hexdigest() == digest
        for item in inventory:
            if item['path'] == changed:
                item['digest'] = digest
                item['bytes'] = (after / 'tree' / changed).stat().st_size
        inventory_file = Path(temporary) / f'{corpus}.json'
        inventory_file.write_text(json.dumps(inventory), encoding='utf-8')
        result = subprocess.check_output(['node', '--max-old-space-size=2048',
            str(ROOT / 'benchmarks/performance/equivalence.mjs'), str(before), str(after), str(inventory_file)], text=True)
        report = dict(json.loads(result), corpus=corpus, snapshotId=update['snapshotId'],
                      baselineSnapshot=str(before), optimizedSnapshot=str(after),
                      changedFile=changed, changedFileDigest=digest)
        assert report['equivalent']
        (a.results / f'{corpus}.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        reports.append(report)
print(json.dumps(reports, indent=2))
