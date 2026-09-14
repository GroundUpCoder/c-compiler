import subprocess, pathlib, time, json, tempfile, os, datetime
base=pathlib.Path("build/789-quake-acceptance")
assert not os.environ.get("CC_OS_BOOT_TIMEOUT_MS"), "inner budget override present"
cmd=["node","tests/kernel/run.js","--serial","--filter=test_os_boot.js"]
t0=time.time()
with (base/"boot-serial-v1.log").open("w") as stream, (base/"boot-samples-v1.jsonl").open("w") as samples:
 child=subprocess.Popen(cmd,stdout=stream,stderr=subprocess.STDOUT)
 offsets={}; known_dirs=set()
 def sample():
  now=time.time(); raw=subprocess.check_output(["ps","-axo","pid=,ppid=,rss=,%cpu=,time=,etime=,command="],text=True)
  procs={}
  for line in raw.splitlines():
   f=line.strip().split(None,6)
   if len(f)==7:
    try: procs[int(f[0])]={"pid":int(f[0]),"ppid":int(f[1]),"rssKiB":int(f[2]),"cpuPercent":float(f[3]),"cpuTime":f[4],"elapsed":f[5],"command":f[6]}
    except ValueError: pass
  selected={child.pid}
  for _ in range(10): selected.update(p["pid"] for p in procs.values() if p["ppid"] in selected)
  tree=[procs[p] for p in selected if p in procs]
  for p in tree:
   if "tests/kernel/test_os_boot.js" in p["command"]:
    known_dirs.update(pathlib.Path(tempfile.gettempdir()).glob("os-boot-"+str(p["pid"])+"-*"))
  files=[]
  for d in known_dirs:
   if not d.exists(): continue
   for f in d.iterdir():
    try:
     s=f.stat();r={"path":str(f),"bytes":s.st_size,"mtime":s.st_mtime}
     if f.name.endswith(".lock"): r["lock"]=f.read_text()
     files.append(r)
    except FileNotFoundError: pass
  logs=[]
  for f in [base/"boot-serial-v1.log",pathlib.Path("build/test-kernel/test_os_boot.js.log")]:
   if f.exists():
    b=f.read_bytes();old=offsets.get(str(f),0)
    if len(b)>old:logs.append({"path":str(f),"newText":b[old:].decode(errors="replace")})
    offsets[str(f)]=len(b)
  samples.write(json.dumps({"utc":datetime.datetime.now(datetime.timezone.utc).isoformat(),"elapsedSeconds":now-t0,"processes":tree,"files":files,"logs":logs})+"\n");samples.flush()
 while child.poll() is None:
  sample();time.sleep(2)
 sample()
 result={"command":cmd,"exitCode":child.returncode,"elapsedSeconds":time.time()-t0,"innerBudgetMs":300000,"outerBudgetMs":900000,"sourceChanged":False,"samplingIntervalSeconds":2}
 (base/"boot-result-v1.json").write_text(json.dumps(result,indent=2)+"\n")
 print(json.dumps(result),flush=True)
 raise SystemExit(child.returncode)
