'use strict';
const corpus=require('./exceptions.js');
const lines=['mkdir -p /root/objc-exceptions','cd /root/objc-exceptions'];
const write=(name,source)=>lines.push("cat > '"+name+"' <<'OBJC_EXCEPTION_SOURCE_END'",source,'OBJC_EXCEPTION_SOURCE_END');
let count=0;
for(const [name,source] of corpus.positive) {
  write(name+'.m',source);
  lines.push('cc -g '+name+'.m -o case.out && ./case.out || exit 1',"echo 'OBJC-EH-PASS "+name+"'");count++;
}
for(const [name,source] of Object.entries(corpus.crossFiles)) write(name.slice(7),source);
for(const [name,inputs] of corpus.cross) {
  lines.push('cc -g '+inputs.join(' ')+' -o case.out && ./case.out || exit 1',"echo 'OBJC-EH-PASS "+name+"'");count++;
}
for(const test of corpus.fatal) if(!test.cap && !test.hostError && !test.ceiling) {
  write(test.name+'.m',test.source);
  lines.push('cc -g '+test.name+'.m -o case.out || exit 1','./case.out > outcome.log 2>&1','result=$?');
  lines.push(test.trap ? 'test "$result" != 0 || exit 1' : 'test "$result" = '+test.exit+' || exit 1');
  if(test.pattern) lines.push("grep '"+test.pattern.source+"' outcome.log || exit 1");
  lines.push("if grep BAD outcome.log; then exit 1; fi", "echo 'OBJC-EH-PASS "+test.name+"'");count++;
}
lines.push('echo OBJC-EH-COUNT='+count);
module.exports={source:lines.join('\n')+'\n',count};
