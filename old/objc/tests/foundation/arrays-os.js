'use strict';
const files=require('./files'),corpus=require('./arrays-corpus');
const lines=['mkdir -p /root/arrays779','cd /root/arrays779'];
const names=[...new Set([...corpus.programs.flatMap(p=>p.inputs),'array-cross.h'])];
for(const name of names)lines.push("cat > '"+name+"' <<'ARRAY779_SOURCE_END'",files['/tests/'+name],'ARRAY779_SOURCE_END');
const programs=corpus.programs.filter(p=>!p.capMemory);
for(const p of programs){
 lines.push('cc -g '+p.inputs.join(' ')+' -o case.out || exit 1');
 if(p.failure){
  lines.push('./case.out '+(p.args||[]).join(' ')+' > failure.log 2>&1','result=$?','test "$result" = 134 || exit 1',"grep '"+p.failure.source+"' failure.log || exit 1");
 }else lines.push('./case.out || exit 1');
 lines.push("echo 'ARRAY779-OS-PASS "+p.name+"'");
}
lines.push('echo ARRAY779-OS-COUNT='+programs.length);
module.exports={source:lines.join('\n')+'\n',count:programs.length,names:programs.map(p=>p.name)};
