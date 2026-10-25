#!/usr/bin/env python3
"""Invoke the real synchronous watch handler for one known changed path.

Includes database open/persist in process wall time. Excludes OS notification and
its default two-second debounce. This is not the CLI's full-rebuild `update`.
"""
import asyncio
import json
from pathlib import Path
import sys
import time
from codegraphcontext.core.database_falkordb import FalkorDBManager
from codegraphcontext.core.jobs import JobManager
from codegraphcontext.core.watcher import RepositoryEventHandler
from codegraphcontext.tools.graph_builder import GraphBuilder

start = time.perf_counter()
manager = FalkorDBManager(db_path=sys.argv[1])
loop = asyncio.new_event_loop()
try:
    builder = GraphBuilder(manager, JobManager(), loop)
    handler = RepositoryEventHandler(builder, Path(sys.argv[2]), perform_initial_scan=False)
    startup = time.perf_counter()
    handler.imports_map = builder.pre_scan_imports(handler._iter_supported_files())
    ready = time.perf_counter()
    handler._handle_modification(str(Path(sys.argv[3]).resolve()))
    finished = time.perf_counter()
    print(json.dumps({'operation': 'RepositoryEventHandler._handle_modification',
                      'startupSeconds': startup - start, 'importPreparationSeconds': ready - startup, 'handlerSeconds': finished - ready,
                      'knownChangedPath': sys.argv[3],
                      'excludes': 'OS notification and two-second debounce'}))
finally:
    manager.close_driver(teardown=True)
    loop.close()
