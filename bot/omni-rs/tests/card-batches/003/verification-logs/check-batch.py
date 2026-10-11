import argparse, hashlib, json, pathlib, subprocess, sys
p=argparse.ArgumentParser(); p.add_argument('mode',choices=['native','wasm']); p.add_argument('catalog'); p.add_argument('batch'); p.add_argument('log'); a=p.parse_args()
root=pathlib.Path.cwd() # Run from the repository root.
batch=root/'bot/omni-rs/tests/card-batches'/a.batch
index=json.loads((batch/'receipt-index.json').read_text())
exe=[str(root/'target/release/omni-rs'),'check'] if a.mode=='native' else ['node','bot/omni/wasm/check.js']
results=[]
with open(a.log,'w') as log:
 for corpus in index['corpora']:
  folder=batch/corpus['directory']; pool=folder/'pool.json'
  assert hashlib.sha256(pool.read_bytes()).hexdigest()==corpus['poolSha256']
  files=[]
  for fixture in corpus['fixtures']:
   f=folder/fixture['file']; assert hashlib.sha256(f.read_bytes()).hexdigest()==fixture['sha256']; files.append(str(f))
  cmd=exe+files+['--pool',str(pool),'--catalogue',a.catalog]
  result=subprocess.run(cmd,cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  log.write(result.stdout); log.flush()
  row={'corpus':corpus['directory'],'files':len(files),'code':result.returncode}; results.append(row); print(json.dumps(row),flush=True)
  if result.returncode:
   failures=[]
   for f in files:
    item=subprocess.run(exe+[f,'--pool',str(pool),'--catalogue',a.catalog],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    if item.returncode:failures.append({'file':f,'code':item.returncode,'output':item.stdout})
   log.write(json.dumps({'individualFailures':failures},indent=2)+'\n'); log.flush()
   print(json.dumps({'failures':[{'file':f['file'],'code':f['code'],'summary':f['output'][:380]} for f in failures]}),flush=True)
pathlib.Path(a.log+'.summary.json').write_text(json.dumps({'engine':a.mode,'catalogueSha256':hashlib.sha256(pathlib.Path(a.catalog).read_bytes()).hexdigest(),'batch':a.batch,'results':results},indent=2)+'\n')
sys.exit(any(x['code'] for x in results))
