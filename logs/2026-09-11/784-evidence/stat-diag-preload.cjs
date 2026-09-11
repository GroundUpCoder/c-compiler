const fs = require('fs');
const drive = require('/Users/jku/git/c-compiler-small-callbacks/tests/kernel/lib/drive.js');
const original = drive.driveBoot;
const source = '#include <sys/stat.h>\n#include <stdio.h>\nint main(void){struct stat a,b; int x=stat("/usr/local/bin/python",&a),y=stat("/usr/bin/cmdalt",&b); printf("STAT_IDENTITY %d %d %u %u %u %u\\n",x,y,(unsigned)a.st_dev,(unsigned)a.st_ino,(unsigned)b.st_dev,(unsigned)b.st_ino);return 0;}';
function quote(s) {return "'"+s.replaceAll("'", "'\\''")+"'";}
drive.driveBoot = (script, opts) => {
  let text = Array.isArray(script) ? script.join('\n') : script;
  if (text.includes('echo ==shadowwhich')) {
    text = text.replace('echo ==shadowwhich', [
      "printf '%s\\n' "+quote(source)+" > /tmp/stat-identity.c",
      'cc /tmp/stat-identity.c -o /tmp/stat-identity',
      '/tmp/stat-identity', 'echo ==shadowwhich'
    ].join('\n'));
  }
  const r = original(text,opts);
  fs.appendFileSync('/tmp/784-stat-diag-transcript.log', r.stdout+'\n'+r.stderr);
  return r;
};
