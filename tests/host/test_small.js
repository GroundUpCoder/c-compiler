'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const runModule = require('../../host.js');
const COMMON = require('../../os/os-common.js');
const sibling = require('../../tools/small-sibling.js');
const ROOT = path.resolve(__dirname, '../..');
const B = runModule.BLOCK_FS;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'small-sibling-'));
  try {
    const root = path.join(tmp, 'c-compiler'); fs.mkdirSync(root);
    const manifest = { system: { dirs: [], files: {} } };
    assert.equal(sibling.fold(root, manifest), manifest);
    fs.mkdirSync(path.join(tmp, 'small'));
    assert.throws(() => sibling.snapshot(root), /invalid Small sibling/);
    if (fs.existsSync(path.resolve(ROOT, '../small'))) {
      fs.copyFileSync(path.resolve(ROOT, '../small/small.js'), path.join(tmp, 'small/small.js'));
      fs.cpSync(path.resolve(ROOT, '../small/root'), path.join(tmp, 'small/root'), {recursive:true});
      const initial = sibling.snapshot(root).sha256;
      const extra = path.join(tmp, 'small/root/extra.wc');
      fs.writeFileSync(extra, 'class Extra {}');
      assert.notEqual(sibling.snapshot(root).sha256, initial);
      fs.unlinkSync(extra);
      assert.equal(sibling.snapshot(root).sha256, initial);
      fs.renameSync(path.join(tmp,'small'), path.join(tmp,'small-away'));
      assert.equal(sibling.snapshot(root), null);
    }
    const img = path.join(tmp, 'system.img');
    assert.equal(sibling.metadataMatches(img, null), false);
    fs.writeFileSync(img + '.small.json', JSON.stringify({format:1,smallSnapshot:null}));
    assert.equal(sibling.metadataMatches(img, null), true);
    assert.equal(sibling.metadataMatches(img, 'a'.repeat(64)), false);
    fs.writeFileSync(img + '.small.json', '{broken');
    assert.equal(sibling.metadataMatches(img, null), false);
  } finally { fs.rmSync(tmp, {recursive:true, force:true}); }
  const snap = sibling.snapshot(ROOT);
  if (!snap) { console.log('PASS Small absent/invalid discovery; installed integration not run (optional sibling absent)'); return; }
  assert.equal(snap.sha256, sibling.snapshot(ROOT).sha256);
  const folded = sibling.fold(ROOT, { system: { dirs: [], files: {} } });
  const store = new B.MemoryByteStore(4 << 20);
  const bfs = B.createV4(store);
  bfs.mkdir('/usr', 0o755);
  for (const dir of folded.system.dirs) bfs.mkdir(dir, 0o755);
  for (const [p, e] of Object.entries(folded.system.files)) if (e.content !== undefined) COMMON.writeFile(bfs, p, e.content);
  bfs.mkdir('/work', 0o755);
  COMMON.writeFile(bfs, '/work/message.wc', `class Message { static str text() { return "안녕 Small"; } }`);
  COMMON.writeFile(bfs, '/work/main.wc', `from "./message.wc" import Message;
    import std.Memory;
    import gucos.Runtime;
    @import("c", "getpid") int getpid();
    @import("c", "close") int close(int fd);
    @import("c", "write") int write(int fd, int ptr, int size);
    int main(int argc, int argv, int envp) {
      System.out.println(Message.text());
      System.err.println("diagnostic");
      int ptr = Memory.malloc(1); Memory.storeByte(ptr, 88);
      int n = write(1, ptr, 1); Memory.free(ptr);
      int missing = close(99999);
      if (missing != -1 || Runtime.errno() != 9 || envp == 0 || Runtime.environment() != envp) return 98;
      return argc == 2 && Memory.loadInt(argv) != 0 && getpid() == 73 && n == 1 ? 7 : 99;
    }`);
  const driver = COMMON.createCcDriver(null, bfs);
  const compiled = await driver(['/usr/bin/small', 'main.wc', '-o', 'app'], '/work');
  assert.equal(compiled.exitCode, 0, compiled.stderr);
  const bytes = COMMON.readFileBytes(bfs, '/work/app');
  assert.ok(bytes && bytes.length);
  // Reassign descriptor 1 through the actual filesystem, rather than capture
  // the console callback: this catches bypasses of pipes/redirection.
  const out = bfs.open('/work/output', 0x241, 0o644);
  bfs.dup2(out, 1); bfs.close(out);
  const err = bfs.open('/work/errors', 0x241, 0o644);
  bfs.dup2(err, 2); bfs.close(err);
  const code = await runModule({bytes, args:['/work/app','arg'], pid:73, env:{SMALL_TEST:'yes'},
    blockFsFactory: async ctx => ({c:bfs.toWasmEnv(ctx)}),
    writeOut: () => { throw new Error('bypassed stdout fd'); },
    writeErr: () => { throw new Error('bypassed stderr fd'); },
  });
  assert.equal(code, 7);
  assert.equal(COMMON.readFileText(bfs, '/work/output'), '안녕 Small\nX');
  assert.equal(COMMON.readFileText(bfs, '/work/errors'), 'diagnostic\n');
  const old = Buffer.from(bytes);
  COMMON.writeFile(bfs, '/work/main.wc', 'int main() { return absent; }');
  const bad = await driver(['small', 'main.wc', '-o', 'app'], '/work');
  assert.equal(bad.exitCode, 1); assert.match(bad.stderr, /absent/);
  assert.deepEqual(Buffer.from(COMMON.readFileBytes(bfs, '/work/app')), old);
  console.log('PASS Small discovery, installed compilation, imports, allocator, args, exit, UTF-8, redirected stdout/stderr, C service calls, diagnostics');
})().catch(e => {console.error(e);process.exitCode=1;});
