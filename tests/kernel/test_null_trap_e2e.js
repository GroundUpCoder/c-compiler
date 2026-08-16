#!/usr/bin/env node
'use strict';
// #709: shipped /bin/cc -> process-worker crash path -> shell status 139.
const { driveBoot, section } = require('./lib/drive.js');
const lines = [
  "cat > /root/null.c << 'EOF'", 'struct S{int x;};',
  'static int f(struct S*p){return p->x;}',
  'int main(void){struct S*p=0;return f(p);}', 'EOF',
  'cd /root && cc -g --trap-null-dereference null.c -o null.out',
  'echo ==run', './null.out; echo RC=$?', 'echo ==done',
  'cc null.c -o plain.out && echo PLAIN-COMPILED', 'exit',
];
const r = driveBoot(lines, { prefix: 'os-null-trap-', timeout: 600000, quiet: false });
const out = section(r.stdout, 'run') + '\n' + String(r.stderr || '');
let failures = 0;
function check(name, ok) { console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + name); if (!ok) failures++; }
check('boot session exits clean', r.status === 0);
check('generated source marker reaches crash log', /__cc_null_dereference\[\/root\/null\.c:2:member\]/.test(out));
check('named C caller follows marker', /at f /.test(out) || /at main /.test(out));
check('shell reports SIGSEGV convention 139', /RC=139/.test(out));
check('default-off compile succeeds', /PLAIN-COMPILED/.test(String(r.stdout)));
process.exit(failures ? 1 : 0);
