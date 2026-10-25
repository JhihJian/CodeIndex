import hashlib,json,pathlib,sys,difflib
base=pathlib.Path('/data/dev/CodeIndex/.data/competitors/codeindex/linux')
new=pathlib.Path('/data/dev/CodeIndex/.data/performance-v4/linux')
def locate(root):
 for p in root.glob('*/snapshots/*/manifest.json'):
  if 'a7cbbe6d6900f2666cbc329e' in json.loads(p.read_text())['snapshotId']:return p.parent/'native/cscope.out'
def groups(file):
 out={};name='header';h=hashlib.sha256();start=0;offset=0
 with file.open('rb') as f:
  for line in f:
   if line.startswith(b'\t@'):
    out[name]=(h.hexdigest(),start,offset-start);name=line[2:].rstrip(b'\n').decode('utf8');h=hashlib.sha256();start=offset
   h.update(line);offset+=len(line)
 out[name]=(h.hexdigest(),start,offset-start)
 return out
oldfile,newfile=locate(base),locate(new)
a,b=groups(oldfile),groups(newfile)
diff=[k for k in a.keys()|b.keys() if a.get(k,('?',))[0]!=b.get(k,('?',))[0]]
print(json.dumps({'old':str(oldfile),'new':str(newfile),'oldGroups':len(a),'newGroups':len(b),'diff':diff},indent=2))
for name in diff[:8]:
 print('GROUP',name,a.get(name),b.get(name))
 if name not in a or name not in b:continue
 parts=[]
 for file,g in ((oldfile,a),(newfile,b)):
  with file.open('rb') as f:f.seek(g[name][1]);parts.append(f.read(g[name][2]).splitlines())
 for line in list(difflib.unified_diff([repr(x) for x in parts[0]],[repr(x) for x in parts[1]],n=2))[:45]:print(line)
