import os,subprocess,json,pathlib
rows=[]
for n in range(1,4):
 for mode in ['baseline','current']:
  env=os.environ.copy()
  if mode=='baseline': env['NODE_OPTIONS']='-r /tmp/784-browser-baseline-preload.cjs'
  else: env.pop('NODE_OPTIONS',None)
  path=f'/tmp/784-sedit-{mode}-{n}.log'
  with open(path,'w') as f: r=subprocess.run(['node','tests/browser/os-sedit.mjs'],env=env,stdout=f,stderr=subprocess.STDOUT,timeout=90)
  rows.append({'mode':mode,'run':n,'exit':r.returncode,'log':path})
  pathlib.Path('/tmp/784-sedit-repeats.json').write_text(json.dumps(rows,indent=2)+'\n')
  print(rows[-1],flush=True)
