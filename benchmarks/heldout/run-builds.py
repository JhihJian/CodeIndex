#!/usr/bin/env python3
"""Three fresh builds for successful combinations; failures retain their first outcome."""
import shutil
from common import ROOT, Study, TOOL_NAMES, load, options, save, storage, warm

parser = options(__doc__)
parser.add_argument('--repetitions', type=int, choices=(1, 2, 3), default=3)
args = parser.parse_args()
study = Study(args)

for repetition in range(1, args.repetitions + 1):
    order = list(TOOL_NAMES)
    order = order[repetition - 1:] + order[:repetition - 1]
    for corpus in args.corpora:
        for tool in order:
            if tool not in args.tool_names:
                continue
            primary = f'{tool}-{corpus}'
            name = primary if repetition == 1 else f'repeat{repetition}-{primary}'
            if repetition > 1 and (load(study.results / f'{primary}-build.json')['status'] != 'success' or not (study.results / f'{primary}-query.json').exists()):
                continue
            store = study.store(tool, corpus, repetition)
            build, query = study.commands(tool, corpus, store)
            metric_file = study.results / f'{name}-build.json'
            if not metric_file.exists():
                if store.exists() and (store.is_file() or any(store.iterdir())):
                    raise RuntimeError(f'Fresh output required: {store}')
                store.parent.mkdir(parents=True, exist_ok=True)
                if tool == 'opengrok':
                    store.mkdir(exist_ok=True)
                warm(study.source(corpus))
            metric = study.measure(name + '-build', build)
            study.clean_generated(corpus, name)
            study.verify(corpus)
            if metric['status'] != 'success':
                continue
            size_file = study.results / f'{name}-storage.json'
            if not size_file.exists():
                save(size_file, storage(study.paths(tool, store)))
            if not (study.results / f'{name}-query.json').exists():
                result = study.adapter(name + '-query', query)
                if result is None:
                    continue
            if repetition > 1:
                # Only the primary indexes are needed for full audits and updates.
                # Keep raw build/query/storage records for every repetition.
                for output in study.paths(tool, store):
                    if output.is_dir():
                        shutil.rmtree(output)
                    elif output.exists():
                        output.unlink()
print('BUILDS_COMPLETE', flush=True)
