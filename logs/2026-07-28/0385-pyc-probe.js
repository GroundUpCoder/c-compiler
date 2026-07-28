'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { ensureMinimalImage, startServer } = require(path.join(ROOT, 'tests/kernel/lib/gucman.js'));
const { driveBoot, freshImage } = require(path.join(ROOT, 'tests/kernel/lib/drive.js'));
(async () => {
  const MIN = ensureMinimalImage();
  const { image } = freshImage('os-0385p-');
  fs.copyFileSync(MIN, image);
  const port = await startServer(path.join(ROOT, 'dist', 'packages'));
  const r = driveBoot([
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'gucman install python-clang >/dev/null 2>&1; echo RC=$?',
    'python-clang -c pass 2>&1; echo P1=$?',
    'echo VAR_PYC=$(find /var/cache -name "*.pyc" 2>/dev/null | wc -l)',
    'echo OPT_PYC=$(find /opt -name "*.pyc" 2>/dev/null | wc -l)',
    '/opt/python-clang/bin/python-clang.wasm -c pass 2>&1; echo P2=$?',
    'echo OPT_PYC2=$(find /opt -name "*.pyc" 2>/dev/null | wc -l)',
    'python-clang -c "import sys; print(sys.dont_write_bytecode, sys.pycache_prefix)"',
  ], { image, args: ['--packages=none'], timeout: 300000 });
  console.log(String(r.stdout).split('\n').filter(l => /RC=|P1=|P2=|PYC|False|True|None|\/var/.test(l)).join('\n'));
  process.exit(0);
})();
