#!/usr/bin/env python3
"""Run pinned indexers sequentially on prepared copies. Existing measurements are retained."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--tools', type=Path, required=True)
parser.add_argument('--corpora', nargs='+', default=['pageindex', 'typescript', 'linux'])
parser.add_argument('--tool-names', nargs='+', default=['codeindex', 'opengrok', 'zoekt', 'cgc'])
args = parser.parse_args()
tools = args.tools.resolve()
data = ROOT / '.data/competitors'
results = ROOT / 'benchmarks/results/competitors'
results.mkdir(parents=True, exist_ok=True)
ctags = os.environ.get('CODEINDEX_CTAGS', str(Path.home() / '.local/bin/ctags-universal'))
environment = dict(os.environ, CTAGS_COMMAND=ctags, SCIP_INDEXER='false', ENABLE_AUTO_WATCH='false')
questions = {'pageindex': 'questions-identifiers-pageindex.json', 'typescript': 'questions-identifiers-typescript.json', 'linux': 'questions-linux-c.json'}


def warm_files(directory):
    """Warm both the working tree and Git objects before each independent build."""
    for parent, _, names in os.walk(directory):
        for name in names:
            file = Path(parent) / name
            if file.is_symlink():
                continue
            with file.open('rb') as stream:
                while stream.read(1024 * 1024):
                    pass


def storage_bytes(paths):
    total, seen = 0, set()
    for base in paths:
        files = base.rglob('*') if base.is_dir() else [base]
        for file in files:
            if not file.is_file() or file.is_symlink():
                continue
            stat = file.stat()
            identity = (stat.st_dev, stat.st_ino)
            if identity not in seen:
                seen.add(identity)
                total += stat.st_size
    return total


for corpus in args.corpora:
    source = data / 'inputs' / corpus
    question_file = ROOT / 'benchmarks' / questions[corpus]
    for tool in args.tool_names:
        prefix = results / f'{tool}-{corpus}'
        output = data / tool / corpus
        output.parent.mkdir(parents=True, exist_ok=True)
        if tool == 'codeindex':
            command = ['node', str(ROOT / 'bin/codeindex.js'), 'index', '--repo', str(source), '--store', str(output), '--progress']
            query = ['node', str(ROOT / 'benchmarks/competitors/codeindex-query.mjs'), str(output), str(question_file)]
            storage_paths = [output]
        elif tool == 'opengrok':
            output.mkdir(exist_ok=True)
            command = ['java', '-Xmx8g', '-jar', str(tools / 'opengrok-1.14.20/lib/opengrok.jar'), '-s', str(source), '-d', str(output / 'data'), '-W', str(output / 'config.xml'), '-c', ctags, '-S']
            query = ['java', '-cp', f'{tools}:{tools}/opengrok-1.14.20/lib/*', 'OpenGrokQuery', str(output / 'config.xml'), str(question_file), 'symbol']
            storage_paths = [output]
        elif tool == 'zoekt':
            command = [str(tools / 'zoekt-git-index'), '-index', str(output), '-require_ctags', '-file_limit', '5242880', str(source)]
            query = [str(tools / 'zoekt-query'), str(output), str(question_file), 'symbol']
            storage_paths = [output]
        else:
            command = [str(tools / 'cgc-venv/bin/cgc'), '--database', 'falkordb', '--path', str(output), 'index', str(source), '--no-progress']
            query = [str(tools / 'cgc-venv/bin/python'), str(ROOT / 'benchmarks/competitors/cgc-query.py'), str(output), str(source), str(question_file), 'symbol']
            storage_paths = [output, Path(str(output) + '.settings')]
        measurement = Path(str(prefix) + '-build.json')
        if not measurement.exists():
            if output.is_file() or (output.is_dir() and any(output.iterdir())):
                raise RuntimeError(f'Fresh build requires an empty output: {output}')
            print(f'{time.strftime("%Y-%m-%dT%H:%M:%S")} warming {tool} {corpus}', flush=True)
            warm_files(source)
            print(f'{time.strftime("%Y-%m-%dT%H:%M:%S")} building {tool} {corpus}', flush=True)
            subprocess.run([sys.executable, str(ROOT / 'benchmarks/competitors/measure.py'), '--output', str(prefix) + '-build', '--seconds', '1800', '--', *command], cwd=ROOT, env=environment)
        report = json.loads(measurement.read_text(encoding='utf-8'))
        generated_ignore = source / '.cgcignore'
        tracked_ignore = subprocess.run(['git', '-C', str(source), 'ls-files', '--error-unmatch', '.cgcignore'], capture_output=True).returncode == 0
        if tool == 'cgc' and generated_ignore.exists() and not tracked_ignore:
            Path(str(prefix) + '-generated-ignore.txt').write_bytes(generated_ignore.read_bytes())
            generated_ignore.unlink()
        status = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True)
        if status:
            raise RuntimeError(f'Input changed unexpectedly: {source}\n{status}')
        if report['status'] != 'success':
            print(f'{tool} {corpus}: {report["status"]}, no usable completed index', flush=True)
            continue
        size_file = Path(str(prefix) + '-storage.json')
        if not size_file.exists():
            size_file.write_text(json.dumps({'paths': list(map(str, storage_paths)), 'bytes': storage_bytes(storage_paths), 'scope': 'Regular artifact files; hard links counted once; original working tree and Git objects excluded'}, indent=2) + '\n', encoding='utf-8')
        query_file = Path(str(prefix) + '-query.json')
        if query_file.exists():
            try:
                json.loads(query_file.read_text(encoding='utf-8'))['rows']
            except (ValueError, KeyError):
                query_file.rename(Path(str(prefix) + '-query.failed'))
        if not query_file.exists():
            print(f'{time.strftime("%Y-%m-%dT%H:%M:%S")} querying {tool} {corpus}', flush=True)
            pending = Path(str(prefix) + '-query.pending')
            failure = None
            try:
                with pending.open('w', encoding='utf-8') as stdout, Path(str(prefix) + '-query.stderr').open('w', encoding='utf-8') as stderr:
                    completed = subprocess.run(query, cwd=ROOT, env=environment, stdout=stdout, stderr=stderr, timeout=180)
                if completed.returncode:
                    failure = f'exit {completed.returncode}'
                else:
                    json.loads(pending.read_text(encoding='utf-8'))['rows']
            except (subprocess.TimeoutExpired, ValueError, KeyError) as error:
                failure = str(error)
            if failure:
                pending.rename(Path(str(prefix) + '-query.failed'))
                Path(str(prefix) + '-query-status.json').write_text(json.dumps({'status': 'failed', 'reason': failure}, indent=2) + '\n', encoding='utf-8')
                print(f'{tool} {corpus}: query adapter failed, inspect stderr', flush=True)
                continue
            pending.rename(query_file)
        query_report = json.loads(query_file.read_text(encoding='utf-8'))
        print(f'{tool} {corpus}: {report["wallSeconds"]}s, {sum(row["hitAt10"] for row in query_report["rows"])}/{len(query_report["rows"])} target paths', flush=True)
print('BUILDS_COMPLETE', flush=True)
