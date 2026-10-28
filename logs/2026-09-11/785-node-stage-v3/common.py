from pathlib import Path
import os,json,hashlib,subprocess,datetime
PREP=Path(__file__).resolve().parent
PLAN=json.loads((PREP/'run.json').read_text())
ROOT=Path(PLAN['root'])
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(p,value):
    p=Path(p);tmp=p.with_suffix(p.suffix+'.tmp')
    with tmp.open('w') as f:
        json.dump(value,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
    os.replace(tmp,p)
def run(args):
    r=subprocess.run(args,cwd=ROOT,capture_output=True,text=True,timeout=30)
    return {'command':args,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
def identity(pid):
    r=run(['ps','-p',str(pid),'-o','pid=,ppid=,pgid=,lstart=,command='])
    if r['exit']!=0:raise RuntimeError('identity unavailable: '+str(r))
    return r['stdout'].strip()
def verify():
    config_path=PREP/'authorized-config.json'
    if config_path.exists():
        config_value=json.loads(config_path.read_text());observation_out=checked_out(Path(config_value['output']).parent)
        observed={'at':now(),'pid':os.getpid(),'source':{},'absolute':{}}
        for category,pins,base in [('source',PLAN['sourceVerification'],ROOT),('absolute',PLAN['absolutePins'],Path('/'))]:
            for name in pins:
                try:observed[category][name]=sha(base/name)
                except Exception as error:observed[category][name]={'error':repr(error)}
        save(observation_out/('source-check-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')+'.json'),observed)
    for f,h in PLAN['preparedFiles'].items():assert sha(PREP/f)==h, f
    for f,h in PLAN['absolutePins'].items():assert sha(f)==h,f
    for f,h in PLAN['sourceVerification'].items():assert sha(ROOT/f)==h,f
    assert run(['git','rev-parse','HEAD'])['stdout'].strip()==PLAN['base'],'HEAD drift'
    assert run(['git','write-tree'])['stdout'].strip()==PLAN['stagedTree'],'index drift'
    assert run(['git','diff','--exit-code'])['exit']==0,'unstaged tracked delta'
    config=PREP/'authorized-config.json'
    if config.exists():
        value=json.loads(config.read_text());run_out=checked_out(Path(value['output']).parent)
        launch=json.loads((run_out/'launch.json').read_text())
        assert sha(config)==launch['runtimeConfigSha256'],'authorized config drift'
        expected=dict(PLAN['runtimeTemplate'],grantReference=launch['authorization']['commentId'],allowedKinds=['node-worker'],output=str(run_out/'payload'))
        assert value==expected,'unexpected runtime config delta'
    for key in PLAN['forbiddenEnvironment']:
        assert not os.environ.get(key),'guard/environment override: '+key

def lock_observation():
    result={}
    for name,path in PLAN['lockPaths'].items():
        p=Path(path);item={'path':path,'exists':p.exists()}
        if p.exists():
            data=p.read_bytes();item.update(sha256=sha(p),text=data.decode('utf8'),mtimeNs=p.stat().st_mtime_ns)
            try:
                pid=json.loads(data)['pid'];assert isinstance(pid,int) and pid>1
                item['pid']=pid
                try:os.kill(pid,0);item['alive']=True
                except ProcessLookupError:item['alive']=False
                except PermissionError:item['alive']='unknown'
                item['ps']=run(['ps','-p',str(pid),'-o','pid,ppid,pgid,lstart,command'])
            except Exception as e:item['parseOrObservationError']=repr(e)
        result[name]=item
    return result

def checked_out(value):
    p=Path(value).resolve()
    assert p.parent==ROOT/'build/trap783' and p.name.startswith('durable-run-'),'unexpected run path'
    return p
