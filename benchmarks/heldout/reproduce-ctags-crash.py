#!/usr/bin/env python3
"""Reproduce the frozen Ctags failure on one untouched LLVM input file."""
import hashlib
import json
from pathlib import Path
import resource
import subprocess
import sys

ctags, repository = sys.argv[1:]
source = Path(repository) / 'clang/test/Parser/parser_overflow.c'
original = source.read_bytes()
command = [ctags, '--options=NONE', '--output-format=json', '--languages=C,C++', '--sort=no',
    '--fields=+neKStiaZ', '--fields=-P', '--extras=-p', '--kinds-C=+p', '--kinds-C++=+p',
    '-f', '/dev/null', str(source)]
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
result = subprocess.run(command, check=False)
assert source.read_bytes() == original
print(json.dumps({'command': command, 'path': str(source), 'bytes': len(original),
    'sha256': hashlib.sha256(original).hexdigest(), 'returnCode': result.returncode,
    'segmentationFaultReproduced': result.returncode == -11,
    'scope': 'One original file, identical CodeIndex Ctags parsing options, core dumps disabled; diagnostic only'}, indent=2))
