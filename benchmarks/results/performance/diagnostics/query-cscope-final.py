import pathlib,json,subprocess,hashlib
base=pathlib.Path('/data/dev/CodeIndex/.data/competitors/codeindex/linux');new=pathlib.Path('/data/dev/CodeIndex/.data/performance-v5/linux')
def locate(root):
 for p in root.glob('*/snapshots/*/manifest.json'):
  if 'a7cbbe6d6900f2666cbc329e' in json.loads(p.read_text())['snapshotId']:return p.parent/'native/cscope.out'
out=[]
for symbol in ('field_name','ctx','codeindex_benchmark_update_probe_20261025'):
 results=[]
 for root in (base,new):
  r=subprocess.run([str(pathlib.Path.home()/'.local/bin/cscope'),'-d','-L','-q','-f',str(locate(root)),'-0',symbol],stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
  results.append(set(r.stdout.splitlines()))
 out.append({'symbol':symbol,'old':len(results[0]),'new':len(results[1]),'added': [x.decode(errors='replace') for x in sorted(results[1]-results[0])][:20], 'removed':[x.decode(errors='replace') for x in sorted(results[0]-results[1])][:20]})
print(json.dumps(out,indent=2))
