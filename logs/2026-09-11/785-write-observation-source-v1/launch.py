from common import *
import sys,tempfile
job=sys.argv[1];assert job=='gate'
out=Path(tempfile.mkdtemp(prefix='durable-run-'+job+'-',dir=ROOT/'build/trap783'))
state={'status':'preflight','job':job,'at':now(),'launcherPid':os.getpid(),'plan':str(PREP/'run.json')}
def checkpoint():save(out/'launch.json',state)
checkpoint();print('MANIFEST',out/'launch.json',flush=True)
try:
    grant=json.loads((PREP/('authorization-'+job+'.json')).read_text())
    assert job in grant['allowedJobs'] and grant['commentId'] and grant['text'].strip(),'actual job grant required'
    assert grant['planSha256']==sha(PREP/'run.json'),'plan mismatch'
    state['authorization']=grant;checkpoint()
    with (PREP/('claimed-'+job+'.json')).open('x') as f:json.dump({'grant':grant,'at':now(),'run':str(out)},f,indent=2)
    config=dict(PLAN['runtimeTemplate'],grantReference=grant['commentId'],allowedKinds=[PLAN['runtimeKind']],output=str(out/'payload'))
    with (PREP/'authorized-config.json').open('x') as f:json.dump(config,f,indent=2)
    state['runtimeConfigSha256']=sha(PREP/'authorized-config.json');checkpoint()
    verify()
    if job=='gate':
        assert grant.get('allowCanonicalStaleRecovery') is True,'explicit canonical recovery permission required'
        assert grant.get('independentControlsAcceptanceCommentId'),'independent control acceptance prerequisite'
    state['locksBefore']=lock_observation();checkpoint()
    if job=='gate':
        for name,item in state['locksBefore'].items():
            if not item['exists']:continue
            # Conservative admission: even a possibly recycled live PID stops
            # this wrapper. Only the unchanged dispatcher may recover a lock.
            assert item.get('alive') is False and item.get('ps',{}).get('exit')==1,'live or ambiguous lock owner: '+name
            assert Path(item['path']).read_text()==item['text'],'lock changed while observing'
            (out/(name+'-before.lock')).write_bytes(Path(item['path']).read_bytes())
    else:
        for name,pin in PLAN['originalLiveLockPins'].items():assert sha(PLAN['lockPaths'][name])==pin,'original lock changed'
    state['health']=run([PLAN['executables']['node'],str(PREP/'health.cjs')]);checkpoint()
    assert state['health']['exit']==0,'resource refusal'
    disk=run(['df','-k',str(ROOT)]);state['disk']=disk;checkpoint()
    assert disk['exit']==0 and int(disk['stdout'].splitlines()[-1].split()[3])>=PLAN['minimumFreeKiB'],'disk refusal'
    if job=='gate':
        assert PLAN['workloadKind']=='focused785-'+PLAN['runtimeKind'],'workload scope mismatch'
        check=run([PLAN['executables']['node'],'--check',str(ROOT/PLAN['syntaxTarget'])]);state['instrumentSyntax']=check;checkpoint()
        assert check['exit']==0,'instrument syntax refusal'
    verify()
    # Re-read ownership immediately before submission; native lock acquisition
    # remains the final arbiter of any race with another lane.
    if job=='gate':
        state['locksAtSubmission']=lock_observation();checkpoint()
        for item in state['locksAtSubmission'].values():
            assert not item['exists'] or (item.get('alive') is False and item.get('ps',{}).get('exit')==1),'lock contention before submission'
    socket=Path(tempfile.mkdtemp(prefix='cc783-'))/'s';assert len(str(socket).encode())<104
    cmd=[PLAN['executables']['tmux'],'-S',str(socket),'-f',str(PREP/'tmux.conf'),'new-session','-d','-s','job','-c',str(ROOT),PLAN['executables']['python'],str(PREP/'supervisor.py'),str(out)]
    state.update(socket=str(socket),command=cmd,status='submitting');checkpoint()
    env=dict(os.environ);env.pop('TMUX',None)
    r=subprocess.run(cmd,cwd=ROOT,env=env,capture_output=True,text=True,timeout=30)
    state['tmuxLaunch']={'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr};checkpoint()
    assert r.returncode==0,'submission failure, no retry'
    state['tmuxIdentity']=run([PLAN['executables']['tmux'],'-S',str(socket),'display-message','-p','-t','job','#{pid} #{pane_pid}'])
    state.update(status='submitted-awaiting-observation',end=now());checkpoint();print(json.dumps(state,indent=2))
except Exception as e:
    state.update(status='refused-or-submission-error',error=repr(e),end=now());checkpoint();raise
