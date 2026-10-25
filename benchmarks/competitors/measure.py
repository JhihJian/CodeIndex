#!/usr/bin/env python3
"""Measure an isolated command, including child processes, without mixing benchmark jobs."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--seconds', type=int, default=1800)
parser.add_argument('--memory-gib', type=int, default=12)
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ['--'] else args.command
if not command:
    parser.error('a command is required')
prefix = Path(args.output).resolve()
prefix.parent.mkdir(parents=True, exist_ok=True)
unit = f'codeindex-benchmark-{os.getpid()}'
invocation = ['systemd-run', '--user', '--quiet', '--scope', '--unit', unit,
              '-p', f'MemoryMax={args.memory_gib}G', '-p', 'MemorySwapMax=0',
              '/usr/bin/time', '-v', '-o', str(prefix) + '.time', *command]
started = time.monotonic()
peak_rss = 0
workload_sampled = False
peak_cgroup = 0
tracked = set()
timed_out = False
scope_path = None
leftover_pids = []
pagesize = os.sysconf('SC_PAGE_SIZE')
interrupted = False

def interrupt(signum, frame):
    raise KeyboardInterrupt

signal.signal(signal.SIGTERM, interrupt)

def stop_scope(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    subprocess.run(['systemctl', '--user', 'kill', '--signal=SIGKILL', unit + '.scope'], capture_output=True)
    process.wait(timeout=15)
    if scope_path:
        for _ in range(50):
            if not (scope_path / 'cgroup.procs').exists() or not (scope_path / 'cgroup.procs').read_text().strip():
                return
            time.sleep(0.1)
        raise RuntimeError(f'Scope still has processes: {scope_path}')

with open(str(prefix) + '.stdout', 'w', encoding='utf-8') as stdout, open(str(prefix) + '.stderr', 'w', encoding='utf-8') as stderr:
    process = subprocess.Popen(invocation, stdout=stdout, stderr=stderr, start_new_session=True)
    tracked.add(process.pid)
    try:
        while process.poll() is None:
            pending = list(tracked)
            visited = set()
            rss = 0
            while pending:
                pid = pending.pop()
                if pid in visited:
                    continue
                visited.add(pid)
                try:
                    children = Path(f'/proc/{pid}/task/{pid}/children').read_text().split()
                    pending.extend(map(int, children))
                    tracked.update(map(int, children))
                    rss += int(Path(f'/proc/{pid}/statm').read_text().split()[1]) * pagesize
                    cgroup = Path(f'/proc/{pid}/cgroup').read_text().strip().split('::')[-1]
                    if f'{unit}.scope' in cgroup:
                        workload_sampled = True
                        scope_path = Path('/sys/fs/cgroup') / cgroup.lstrip('/')
                        peak_file = scope_path / 'memory.peak'
                        peak_cgroup = max(peak_cgroup, int(peak_file.read_text()))
                except (OSError, ValueError, IndexError):
                    continue
            peak_rss = max(peak_rss, rss)
            if time.monotonic() - started > args.seconds:
                timed_out = True
                break
            time.sleep(0.25)
    except KeyboardInterrupt:
        interrupted = True
    finally:
        if scope_path is None:
            control_group = subprocess.run(['systemctl', '--user', 'show', unit + '.scope', '--property=ControlGroup', '--value'], capture_output=True, text=True).stdout.strip()
            if control_group:
                scope_path = Path('/sys/fs/cgroup') / control_group.lstrip('/')
        if scope_path is not None and scope_path.exists():
            try:
                peak_cgroup = max(peak_cgroup, int((scope_path / 'memory.peak').read_text()))
                leftover_pids = list(map(int, (scope_path / 'cgroup.procs').read_text().split()))
            except OSError:
                pass
        stop_scope(process)
    exit_code = process.returncode
systemd_result = subprocess.run(['systemctl', '--user', 'show', unit + '.scope', '--property=Result', '--value'], capture_output=True, text=True).stdout.strip() or None
wall = time.monotonic() - started
text = Path(str(prefix) + '.time').read_text() if Path(str(prefix) + '.time').exists() else ''
match = re.search(r'Maximum resident set size \(kbytes\): (\d+)', text)
elapsed = re.search(r'Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): ([\d:.]+)', text)
wall_seconds = None
if elapsed:
    wall_seconds = 0
    for part in elapsed[1].split(':'):
        wall_seconds = wall_seconds * 60 + float(part)
report = {'command': command, 'cwd': os.getcwd(), 'systemdUnit': unit + '.scope', 'systemdResult': systemd_result,
          'status': 'interrupted' if interrupted else 'timeout' if timed_out else 'oom' if systemd_result == 'oom-kill' else 'success' if exit_code == 0 else 'failed',
          'exitCode': exit_code, 'wallSeconds': wall_seconds, 'wallSecondsIncludingSupervisor': wall,
          'timeLimitSeconds': args.seconds, 'memoryLimitGiB': args.memory_gib,
          'gnuTimeMaxRssKiB': int(match[1]) if match else None,
          'sampledProcessTreeRssSumBytes': (peak_rss or None) if workload_sampled else None, 'workloadSampled': workload_sampled, 'cgroupMemoryPeakBytes': peak_cgroup or None,
          'sampleIntervalSeconds': 0.25, 'leftoverProcessIdsTerminated': leftover_pids,
          'memoryNotes': 'RSS sum can double-count shared pages; cgroup memory includes page cache; GNU time max RSS is not simultaneous tree total'}
Path(str(prefix) + '.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
raise SystemExit(0 if report['status'] == 'success' else 1)
