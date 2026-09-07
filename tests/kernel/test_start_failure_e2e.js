#!/usr/bin/env node
'use strict';
// #752: force the actual Instance constructor to fail in a real worker;
// parent waitpid and redirected child stderr are the instruments.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const K = require('../../kernel.js');
const B = require('../../host.js').BLOCK_FS;
const OS = require('../../os/os-common.js');
const {mkdtempOwned} = require('../lib/harness-temp.js');
const tmp = mkdtempOwned('start-failure-');
const root = path.resolve(__dirname, '../..');
const init = `
#include <spawn.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <stdio.h>
int main(void) {
  char *names[] = {"/oom", "/link", "/trap", "/clean"};
  for (int i=0; i<4; i++) {
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addopen(&fa, 2, names[i]+1, O_WRONLY|O_CREAT|O_TRUNC, 0600);
    char *argv[] = {names[i], 0}; pid_t pid; int st;
    int e = posix_spawn(&pid, names[i], &fa, 0, argv, 0);
    posix_spawn_file_actions_destroy(&fa);
    if (e || waitpid(pid, &st, 0) != pid) return 1;
    printf("%s exited=%d code=%d signaled=%d sig=%d\\n", names[i],
      WIFEXITED(st), WEXITSTATUS(st), WIFSIGNALED(st), WTERMSIG(st));
  }
  return 0;
}`;
function compile(name, source) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p + '.c', source);
  cp.execFileSync(process.execPath, [path.join(root, 'compiler.js'), p+'.c', '-o', p+'.wasm']);
  return fs.readFileSync(p+'.wasm');
}
const images = new Map([
  ['/init', compile('init', init)],
  ['/oom', compile('clean', 'int main(void) { return 23; }')],
  ['/trap', compile('trap', 'int main(void) { volatile int n=0; return 7/n; }')],
]);
images.set('/link', images.get('/oom')); images.set('/clean', images.get('/oom'));
const wrapper = path.join(tmp, 'host-wrapper.js');
fs.writeFileSync(wrapper, `
const p = require('worker_threads').workerData.path;
if (p === '/oom' || p === '/link') WebAssembly.Instance = function () {
  if (p === '/oom') throw new RangeError('WebAssembly.Instance(): Out of memory: forced allocation failure');
  throw new WebAssembly.LinkError('forced missing import');
};
module.exports = require(${JSON.stringify(path.join(root, 'host.js'))});
`);
const bfs = B.createV4(new B.MemoryByteStore(8<<20));
bfs.mkdir('/errors', 0o700);
let out = '', halt;
const ended = new Promise(r => halt = r);
const kernel = new K.Kernel({fs: bfs,
  createWorker: K.nodeCreateWorker({hostPath: wrapper, kernelPath: path.join(root, 'kernel.js')}),
  loadImage: p => images.get(p),
  onOutput: (pid, fd, bytes) => out += Buffer.from(bytes).toString(),
  onHalt: halt,
});
const watchdog = setTimeout(() => {console.error('start failure timeout: '+out); process.exit(1);}, 30000);
(async () => {
  try {
    await kernel.boot({path:'/init', argv:['init'], cwd:'/errors'});
    assert.strictEqual(await ended, 0, out);
    for (const name of ['oom', 'link']) {
      assert(out.includes('/'+name+' exited=1 code=127 signaled=0 sig=0'), out);
      const err = OS.readFileText(bfs, '/errors/'+name);
      assert(err && err.includes('could not start /'+name), String(err));
      assert(err.includes(name === 'oom' ? 'forced allocation failure' : 'forced missing import'), err);
      assert(!err.includes('backtrace'), err);
    }
    assert(out.includes('/trap exited=0 code=0 signaled=1 sig=11'), out);
    assert(out.includes('/clean exited=1 code=23 signaled=0 sig=0'), out);
    assert(!out.includes('could not start'), 'redirected diagnostics escaped to console: '+out);
    assert.strictEqual(kernel.processCount(), 0);
    console.log('forced Instance OOM/LinkError: exit127 + child fd2; real trap SIGSEGV; clean exit23');
  } finally {clearTimeout(watchdog);}
})().catch(e => {console.error(e); process.exitCode=1;});
