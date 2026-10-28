from common import *
import sys,time,signal,shutil,secrets
out=checked_out(sys.argv[1]);launch=json.loads((out/'launch.json').read_text());job=launch['job']
state={'status':'starting','job':job,'start':now(),'pid':os.getpid(),'ppid':os.getppid(),'pgid':os.getpgrp(),'identity':identity(os.getpid()),'signals':[]}
child=None;pending=[];stopping=None;stop_at=None;exit_status=1
# Queue only: signal handlers must never re-enter file checkpointing or Popen.
def caught(sig,frame):pending.append(sig)
for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:signal.signal(sig,caught)
def checkpoint():save(out/'supervisor.json',state)
def send_group(sig,kind):
    if child is None or child.poll() is not None:return
    event={'at':now(),'monotonic':time.monotonic(),'kind':kind,'signal':int(sig),'pgid':child.pid}
    # Child is unreaped and was spawned as this supervisor's group leader.
    assert os.getpgid(child.pid)==child.pid,'owned child group changed'
    try:os.killpg(child.pid,sig);event['sent']=True
    except ProcessLookupError:event['alreadyGone']=True
    state['signals'].append(event);checkpoint()
def service():
    global stopping,stop_at
    while pending:
        sig=pending.pop(0)
        state['signals'].append({'at':now(),'monotonic':time.monotonic(),'kind':'received','signal':sig})
        first=stopping is None
        if first:stopping=sig
        send_group(sig,'forwarded')
        if first:stop_at=time.monotonic()
        checkpoint()
checkpoint()
try:
    assert sha(PREP/'run.json')==launch['authorization']['planSha256'],'plan drift'
    verify()
    service()
    if stopping:raise RuntimeError('interrupted before child launch')
    args=PLAN['gateCommand'] if job=='gate' else [PLAN['executables']['node'],'-r',str(ROOT/'tests/lib/parent-watch.js'),str(PREP/'control.cjs'),job,str(out/'control.jsonl')]
    state.update(command=args,status='launching-child');checkpoint()
    with (out/'stdout.log').open('wb') as stdout,(out/'stderr.log').open('wb') as stderr:
        child=subprocess.Popen(args,cwd=ROOT,env=dict(os.environ,CC_HARNESS_GROUP_LEADER='1'),stdout=stdout,stderr=stderr,start_new_session=True)
        state['child']={'pid':child.pid,'pgid':os.getpgid(child.pid),'identity':identity(child.pid),'start':now()}
        state['status']='running';checkpoint();service()
        deadline=time.monotonic()+PLAN['deadlinesSeconds'][job]
        while child.poll() is None:
            service()
            if time.monotonic()>=deadline and not state.get('deadlineExceeded'):
                state['deadlineExceeded']=True;send_group(signal.SIGTERM,'deadline-term');stop_at=time.monotonic()
            if stop_at is not None and time.monotonic()-stop_at>=5 and not state.get('escalated'):
                state['escalated']=True;send_group(signal.SIGKILL,'escalated')
            state['heartbeatAt']=now();checkpoint();time.sleep(.2)
        code=child.wait()
    state['child'].update(returncode=code,exitCode=code if code>=0 else None,signal=-code if code<0 else None,end=now())
    service()
    state['status']='interrupted' if stopping else ('deadline-exceeded' if state.get('deadlineExceeded') else 'exited-awaiting-evidence-audit')
    exit_status=128+stopping if stopping else (1 if state.get('deadlineExceeded') else (code if 0<=code<=255 else 1))
except BaseException as e:
    state.update(status='supervisor-error',error=repr(e))
    if child is not None:
        if child.poll() is None:
            send_group(signal.SIGTERM,'error-term')
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:send_group(signal.SIGKILL,'error-kill');child.wait()
        state.setdefault('child',{})['returncode']=child.returncode
    exit_status=128+stopping if stopping else 1
finally:
    state['phase']='finalizing';checkpoint()
    try:
        service()
        try:
            verify();state['sourceUnchanged']=True
        except Exception as e:
            state.update(sourceUnchanged=False,pinError=repr(e));exit_status=1
        service();checkpoint()
        if job=='gate':
            # Archive evidence even on red. Copies never establish a verdict.
            archive=out/'gate-artifacts';archive.mkdir(exist_ok=True)
            state['archive']={'files':{},'errors':[]}
            for folder in [str(out/'payload')]:
                service()
                base=ROOT/folder
                if not base.exists():continue
                for p in base.rglob('*'):
                    service()
                    if not p.is_file():continue  # retain every scoped payload byte, including transformed JS and package tarballs
                    try:
                        dest=archive/p.relative_to(ROOT);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dest)
                        state['archive']['files'][str(p.relative_to(ROOT))]=sha(dest)
                    except Exception as e:state['archive']['errors'].append({'path':str(p),'error':repr(e)})
                    service()
            checkpoint()
        if job=='late-finalization':
            # Real child completion and pin verification precede admission.
            # This bounded rendezvous deliberately leaves the queue unserviced
            # until the common terminal drain; no error/signal is synthesized.
            assert child.returncode==0 and state['child']['returncode']==0
            assert state['sourceUnchanged'] and not stopping and not pending
            fixture=out/'control.jsonl';archived=out/'late-control-archive.jsonl'
            shutil.copyfile(fixture,archived)
            assert sha(fixture)==sha(archived),'late fixture archive mismatch'
            nonce=secrets.token_hex(32)
            state['lateBoundary']={'state':'admitted-awaiting-intent','nonce':nonce,'admittedAt':now(),'childReturncode':child.returncode,'childRecord':dict(state['child']),'archiveSha256':sha(archived)}
            checkpoint()
            # All timeout arithmetic stays in this process. The nonce and
            # acknowledged file hashes establish cross-process causality.
            deadline=time.monotonic()+15
            intent_path=out/'late-signal-intent.json'
            while not intent_path.exists() and time.monotonic()<deadline:
                assert not pending,'signal before controller intent'
                time.sleep(.05)
            assert intent_path.exists(),'late intent deadline'
            intent=json.loads(intent_path.read_text())
            assert intent['nonce']==nonce and intent['supervisorPid']==os.getpid()
            assert identity(intent['controllerPid'])==intent['controllerIdentity']
            assert not pending,'signal before admission acknowledgement'
            state['lateBoundary'].update(state='armed-awaiting-signal',intentSha256=sha(intent_path),controllerPid=intent['controllerPid'])
            checkpoint()
            deadline=time.monotonic()+15
            while not pending and time.monotonic()<deadline:time.sleep(.05)
            if not pending:raise RuntimeError('late-finalization signal admission expired')
            state['lateBoundary'].update(state='signal-queued-awaiting-send-receipt',queuedSignals=list(pending),observedAt=now(),observedMonotonic=time.monotonic())
            checkpoint()
            receipt_path=out/'late-signal-sent.json';deadline=time.monotonic()+5
            while not receipt_path.exists() and time.monotonic()<deadline:time.sleep(.05)
            assert receipt_path.exists(),'missing successful-send receipt'
            receipt=json.loads(receipt_path.read_text())
            assert receipt['nonce']==nonce and receipt['supervisorPid']==os.getpid() and receipt['controllerPid']==intent['controllerPid']
            assert receipt['signalSent']==15 and receipt['intentSha256']==sha(intent_path)
            state['lateBoundary'].update(state='signal-queued-before-terminal-drain',sendReceiptSha256=sha(receipt_path))
            checkpoint()

    except BaseException as e:
        state['finalizationError']=repr(e);exit_status=1
    finally:
        # Terminal cutover: after ALL handlers are restored, a newly delivered
        # termination signal has its native disposition, never an abandoned
        # Python queue. Signals queued during the three replacements are still
        # drained below. A native signal during terminal checkpoint/exit can
        # prevent the final manifest; retained tmux status is authoritative.
        # No child is running here: its actual outcome was recorded separately.
        for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:
            signal.signal(sig,signal.SIG_DFL)
        service()
        state['terminalSignalPolicy']='native-default-after-handler-cutover'
        if stopping:
            state['status']='interrupted';exit_status=128+stopping
        elif state.get('finalizationError') or state.get('pinError') or state.get('archive',{}).get('errors'):
            state['status']='finalization-error';exit_status=1
        elif state.get('error'):
            state['status']='supervisor-error';exit_status=1
        elif state.get('deadlineExceeded'):
            state['status']='deadline-exceeded';exit_status=1
        else:
            state['status']='exited-awaiting-evidence-audit'
        state.update(phase='terminal',end=now(),intendedExitCode=exit_status)
        checkpoint()
sys.exit(exit_status)
