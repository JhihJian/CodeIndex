#!/usr/bin/env python3
"""小仓回归、历史输入保全和最终环境记录。"""
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'heldout'))
from common import ROOT, Study, git, load, options, save

args = options(__doc__).parse_args()
assert args.data.resolve().name == args.results.resolve().name == 'reliability'
study = Study(args)
historical = study.data.parent
pageindex = study.data / 'inputs/pageindex'
if not pageindex.exists():
    subprocess.run(['cp', '-a', '--reflink=auto', str(historical / 'competitors/inputs/pageindex'), str(pageindex)], check=True)
store = study.data / 'indexes/codeindex/pageindex'
assert study.measure('pageindex-build', ['node', ROOT / 'bin/codeindex.js', 'index', '--repo', pageindex, '--store', store, '--workers', '4'])['status'] == 'success'
page_result = study.adapter('pageindex-audit', ['node', ROOT / 'benchmarks/reliability/pageindex-check.mjs', store, historical / 'competitors/inputs/pageindex.files.json'])
assert page_result and all(row['hit'] for row in page_result['rows'])
preserved = []
for dataset, cases in [('heldout', 'heldout'), ('competitors', 'competitors')]:
    value = study.adapter(f'{dataset}-preservation', ['node', ROOT / 'benchmarks/heldout/verify-preservation.mjs',
        historical / dataset / 'inputs', ROOT / 'benchmarks' / cases / 'relation-cases.json'], 1800)
    assert value and value['verified']
    preserved.append(value)
inputs = []
for corpus in args.corpora:
    report = load(study.results / f'{corpus}-updates.json')
    study.verify(corpus, report['originalRevision'])
    source = study.source(corpus)
    file = source / report['path']
    assert source.resolve() == source and file.resolve() == file and file.stat().st_nlink == 1
    assert file.stat().st_mtime_ns == report['originalMtimeNs']
    original = historical / 'heldout/inputs' / corpus / report['path']
    assert (file.stat().st_dev, file.stat().st_ino) != (original.stat().st_dev, original.stat().st_ino)
    # Restored pointer must be the exact snapshot used for baseline query measurements.
    pointer = next(study.store('codeindex', corpus).glob('*/published.json'))
    baseline = load(study.results / f'codeindex-{corpus}-query.json')
    assert load(pointer)['snapshotId'] == baseline['snapshotId']
    inputs.append({'corpus': corpus, 'restored': True, 'independentInode': True, 'mtimeRestored': True,
                   'pointerSha256': hashlib.sha256(pointer.read_bytes()).hexdigest()})
pointer = historical / 'linux-native-v3/repo-67168d4b0edd4e638610/published.json'
assert hashlib.sha256(pointer.read_bytes()).hexdigest() == '5dc17ffa3995cf7df4aac79e6fb9d2241213bc9306aa0f32d0559dedc42531a8'
assert not git(ROOT, 'diff', '8892304', '--', 'benchmarks/results/heldout', 'benchmarks/results/competitors', 'benchmarks/results/performance')
assert not git(ROOT, 'diff', 'dec7a41', '--', 'src', 'bin', 'package.json', 'package-lock.json')
assert study.measure('checks/static', ['npm', 'run', 'check'], 300)['status'] == 'success'
versions = {}
for name, command in {'node24': ['node', '--version'], 'node22': ['/home/jhihjian/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node', '--version'],
                      'python': ['python3.14', '--version'], 'ctags': [study.ctags, '--version'],
                      'cscope': [str(Path.home() / '.local/bin/cscope'), '-V']}.items():
    versions[name] = subprocess.check_output(command, stderr=subprocess.STDOUT, text=True).strip()
executables = [Path(study.ctags).resolve(), (Path.home() / '.local/bin/cscope').resolve(), (Path.home() / '.local/bin/python3.14').resolve()]
save(study.results / 'environment.json', {'productCommit': git(ROOT, 'rev-parse', 'dec7a41'), 'platform': platform.platform(),
    'machine': platform.machine(), 'versions': versions,
    'executableSha256': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in executables},
    'inputManifestSha256': {c: hashlib.sha256((study.data / 'inputs' / f'{c}.files.json').read_bytes()).hexdigest() for c in args.corpora},
    'memoryLimitGiB': 12, 'swapAllowed': False})
save(study.results / 'final-verification.json', {'verified': True, 'historicalInputs': preserved,
    'newInputs': inputs, 'historicalResultsUnchanged': True, 'productionPointerUnchanged': True,
    'productSourcesMatchMeasuredCommit': True, 'pageindex': page_result})
print('FINAL_VERIFICATION_COMPLETE', flush=True)
