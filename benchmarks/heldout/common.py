"""Shared adapters and bounded execution for the held-out repository study."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
TOOL_NAMES = ('codeindex', 'opengrok', 'zoekt', 'cgc')
CORPORA = ('cpython', 'vscode', 'llvm')


def options(description):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--tools', type=Path, required=True)
    parser.add_argument('--results', type=Path, default=ROOT / 'benchmarks/results/heldout')
    parser.add_argument('--corpora', nargs='+', choices=CORPORA, default=list(CORPORA))
    parser.add_argument('--tool-names', nargs='+', choices=TOOL_NAMES, default=list(TOOL_NAMES))
    return parser


def load(file):
    return json.loads(Path(file).read_text(encoding='utf-8'))


def save(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix(file.suffix + '.pending')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    temporary.replace(file)


def git(source, *arguments):
    return subprocess.check_output(['git', '-C', str(source), *arguments], text=True).strip()


def warm(directory):
    for parent, _, names in os.walk(directory):
        for name in names:
            file = Path(parent) / name
            if not file.is_symlink():
                with file.open('rb') as stream:
                    while stream.read(1024 * 1024):
                        pass


def storage(paths):
    seen, total = set(), 0
    for base in paths:
        for file in base.rglob('*') if base.is_dir() else [base]:
            if not file.is_file() or file.is_symlink():
                continue
            stat = file.stat()
            key = stat.st_dev, stat.st_ino
            if key not in seen:
                seen.add(key)
                total += stat.st_size
    return {'bytes': total, 'scope': 'All regular index artifacts, hard links counted once; source input and Git excluded'}


def interrupt(signum, frame):
    raise KeyboardInterrupt


class Study:
    def __init__(self, args):
        self.data, self.tools, self.results = args.data.resolve(), args.tools.resolve(), args.results.resolve()
        self.results.mkdir(parents=True, exist_ok=True)
        self.lock = (self.data / '.study.lock').open('a+')
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.ctags = os.environ.get('CODEINDEX_CTAGS', str(Path.home() / '.local/bin/ctags-universal'))
        self.env = dict(os.environ, CTAGS_COMMAND=self.ctags, SCIP_INDEXER='false', ENABLE_AUTO_WATCH='false', INDEX_SOURCE='true', CODEINDEX_WORKERS='4')
        self.env.pop('NODE_OPTIONS', None)
        self.active_unit = None
        signal.signal(signal.SIGTERM, interrupt)

    def source(self, corpus):
        return self.data / 'inputs' / corpus

    def store(self, tool, corpus, repeat=1):
        return self.data / ('indexes' if repeat == 1 else f'repeat-{repeat}') / tool / corpus

    def questions(self, corpus):
        return ROOT / 'benchmarks/heldout/questions' / f'{corpus}.json'

    def relations(self):
        return ROOT / 'benchmarks/heldout/relation-cases.json'

    def paths(self, tool, store):
        return [store, Path(str(store) + '.settings')] if tool == 'cgc' else [store]

    def commands(self, tool, corpus, store, questions=None, mode='symbol'):
        source = self.source(corpus)
        questions = questions or self.questions(corpus)
        adapters = ROOT / 'benchmarks/competitors'
        if tool == 'codeindex':
            build = ['node', ROOT / 'bin/codeindex.js', 'index', '--repo', source, '--store', store, '--workers', '4', '--progress']
            query = ['node', adapters / 'codeindex-query.mjs', store, questions]
        elif tool == 'opengrok':
            build = ['java', '-Xmx8g', '-jar', self.tools / 'opengrok-1.14.20/lib/opengrok.jar', '-s', source, '-d', store / 'data', '-W', store / 'config.xml', '-c', self.ctags, '-S']
            query = ['java', '-cp', f'{self.tools}:{self.tools}/opengrok-1.14.20/lib/*', 'OpenGrokQuery', store / 'config.xml', questions, mode]
        elif tool == 'zoekt':
            build = [self.tools / 'zoekt-git-index', '-index', store, '-require_ctags', '-file_limit', '5242880', source]
            query = [self.tools / 'zoekt-query', store, questions, mode]
        else:
            build = [self.tools / 'cgc-venv/bin/cgc', '--database', 'falkordb', '--path', store, 'index', source, '--no-progress']
            query = [self.tools / 'cgc-venv/bin/python', adapters / 'cgc-query.py', store, source, questions, mode]
        return list(map(str, build)), list(map(str, query))

    def measure(self, name, command, seconds=1800):
        prefix = self.results / name
        if prefix.with_suffix('.json').exists():
            return load(prefix.with_suffix('.json'))
        print(time.strftime('%H:%M:%S'), name, flush=True)
        child = subprocess.Popen([sys.executable, str(ROOT / 'benchmarks/competitors/measure.py'), '--output', str(prefix), '--memory-gib', '12', '--seconds', str(seconds), '--', *map(str, command)], cwd=ROOT, env=self.env, stdout=subprocess.DEVNULL)
        self.active_unit = f'codeindex-benchmark-{child.pid}.scope'
        try:
            child.wait()
        except BaseException:
            child.terminate()
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                subprocess.run(['systemctl', '--user', 'kill', '--signal=SIGKILL', '--kill-whom=all', self.active_unit], capture_output=True)
                child.kill()
                child.wait()
            raise
        finally:
            group = subprocess.run(['systemctl', '--user', 'show', self.active_unit, '--property=ControlGroup', '--value'], capture_output=True, text=True).stdout.strip()
            procs = Path('/sys/fs/cgroup' + group) / 'cgroup.procs' if group else None
            if procs and procs.exists() and procs.read_text().strip():
                raise RuntimeError(f'Remaining descendants in {self.active_unit}')
            self.active_unit = None
        result = load(prefix.with_suffix('.json'))
        print(name, result['status'], result['wallSeconds'], flush=True)
        return result

    def adapter(self, name, command, seconds=300):
        report = self.measure(name + '-measurement', command, seconds)
        if report['status'] != 'success':
            return None
        value = load(self.results / (name + '-measurement.stdout'))
        save(self.results / (name + '.json'), value)
        return value

    def clean_generated(self, corpus, prefix):
        source = self.source(corpus)
        ignore = source / '.cgcignore'
        tracked = subprocess.run(['git', '-C', str(source), 'ls-files', '--error-unmatch', '.cgcignore'], capture_output=True).returncode == 0
        if ignore.exists() and not tracked:
            (self.results / f'{prefix}-generated-ignore.txt').write_bytes(ignore.read_bytes())
            ignore.unlink()

    def verify(self, corpus, expected_revision=None):
        source = self.source(corpus)
        inventory = load(self.data / 'inputs' / f'{corpus}.files.json')
        for item in inventory:
            assert hashlib.sha256((source / item['path']).read_bytes()).hexdigest() == item['digest'], item['path']
        tracked = subprocess.check_output(['git', '-C', str(source), 'ls-files', '-z']).decode().rstrip('\0').split('\0')
        assert set(tracked) == {item['path'] for item in inventory}
        assert not git(source, 'status', '--porcelain')
        if expected_revision:
            assert git(source, 'rev-parse', 'HEAD') == expected_revision

    def relation_query(self, tool, corpus, store, name):
        if tool not in ('codeindex', 'cgc'):
            return None
        adapters = ROOT / 'benchmarks/competitors'
        command = (['node', adapters / 'codeindex-relations.mjs', store, corpus, self.relations()] if tool == 'codeindex' else
            [self.tools / 'cgc-venv/bin/python', adapters / 'cgc-relations.py', store, self.source(corpus), corpus, self.relations()])
        return self.adapter(name, command)
