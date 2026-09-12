'use strict';
const assert = require('assert/strict');
const path = require('path');
const {driveBoot} = require('./lib/drive.js');
const sibling = require('../../tools/small-sibling.js');
const ROOT = path.resolve(__dirname, '../..');
if (!sibling.snapshot(ROOT)) {
  console.log('SKIP Small e2e: optional sibling absent');
  process.exit(0);
}
const r = driveBoot([
  "cat > /root/small-test.wc <<'SMALL_SOURCE'",
  'import std.Memory;',
  'import java.util.ArrayList;',
  '@import("c", "getpid") int getpid();',
  'int main(int argc, int argv, int envp) {',
  '  System.out.println("SMALL-runtime");',
  '  int caught = 0; try { new ArrayList<String>().get(0); } catch (RuntimeException error) { caught++; } finally { caught += 10; }',
  '  if (caught != 11) return 98;',
  '  System.err.println("SMALL-error");',
  '  return argc == 2 && Memory.loadInt(argv) != 0 && envp != 0 && getpid() > 0 ? 23 : 99;',
  '}',
  'SMALL_SOURCE',
  'small /root/small-test.wc -o /root/sapp || exit 91',
  '/root/sapp arg > /root/small.out 2> /root/small.err',
  'test "$?" = 23 || exit 92',
  'grep -q SMALL-runtime /root/small.out || exit 93',
  'grep -q SMALL-error /root/small.err || exit 94',
  '/root/sapp arg 2>/dev/null | cat > /root/small.pipe',
  'grep -q SMALL-runtime /root/small.pipe || exit 95',
  'echo SMALL-END-TO-END',
  'exit 0',
], {prefix:'small-e2e-'});
assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
assert.match(r.stdout, /SMALL-END-TO-END/);
console.log('PASS Small compiled inside gucOS: startup, args/env, exit status, C service, redirection and pipe');
