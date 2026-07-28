'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { ensureMinimalImage, startServer } = require(path.join(ROOT, 'tests/kernel/lib/gucman.js'));
const { driveBoot, freshImage } = require(path.join(ROOT, 'tests/kernel/lib/drive.js'));
(async () => {
  const MIN = ensureMinimalImage();
  const { image } = freshImage('os-0385c-');
  fs.copyFileSync(MIN, image);
  const port = await startServer(path.join(ROOT, 'dist', 'packages'));
  const r = driveBoot([
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'gucman install python-clang >/dev/null 2>&1; echo RC=$?',
    'strace -f -o /root/ch.txt python --version >/dev/null 2>&1',
    'echo @@SPAWNS',
    'grep -c "SPAWN" /root/ch.txt',
    'grep "SPAWN" /root/ch.txt | head -20',
    'echo @@LINES; wc -l /root/ch.txt',
  ], { image, args: ['--packages=none'], timeout: 300000 });
  const out = String(r.stdout);
  console.log(out.slice(out.indexOf('@@SPAWNS')));
  process.exit(0);
})();
