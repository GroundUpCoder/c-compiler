from common import *
import sys
out=checked_out(sys.argv[1]);launch=json.loads((out/'launch.json').read_text())
state={'at':now(),'observerPid':os.getpid(),'launch':launch,'turn':run(['cc-meta','thread','01a08ad0-20f6-7115-8ac9-1064edae5a1f'])}
if (out/'supervisor.json').exists():state['supervisor']=json.loads((out/'supervisor.json').read_text())
if launch.get('socket'):
    state['pane']=run([PLAN['executables']['tmux'],'-S',launch['socket'],'list-panes','-a','-F','#{pid} #{pane_pid} #{pane_dead} #{pane_dead_status} #{pane_dead_signal}'])
    pids=[]
    if state['pane']['exit']==0:pids.extend(state['pane']['stdout'].split()[:2])
    if state.get('supervisor',{}).get('child'):pids.append(str(state['supervisor']['child']['pid']))
    if pids:state['processes']=run(['ps','-p',','.join(pids),'-o','pid,ppid,pgid,stat,lstart,etime,command'])
state['locks']=lock_observation()
try:verify();state['pinsUnchanged']=True
except Exception as e:state.update(pinsUnchanged=False,pinError=repr(e))
p=out/('observation-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')+'.json');save(p,state);print(p);print(json.dumps(state,indent=2))
