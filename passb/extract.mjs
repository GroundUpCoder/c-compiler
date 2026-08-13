#!/usr/bin/env node
// Extract files from the pass-B root image to the host (read-only walk).
// usage: node passb/extract.mjs <in-image-path> <os-path> <out-dir>
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const BLOCK_FS = require('../host.js').BLOCK_FS ?? globalThis.BLOCK_FS;
const COMMON = require('../os/os-common.js');

const [img, osPath, outDir] = process.argv.slice(2);
const store = new COMMON.NodeFileStore(fs, img, false);
const bfs = BLOCK_FS.createV4(store, { readonly: true });

function copy(p, out) {
  const st = bfs.stat(p);
  if (!st) throw new Error('stat failed: ' + p);
  if ((st.mode & 0o170000) === 0o040000) {
    fs.mkdirSync(out, { recursive: true });
    const dh = bfs.opendir(p);
    for (;;) {
      const ent = bfs.readdir(dh);
      if (!ent) break;
      const name = typeof ent === 'string' ? ent : ent.name;
      if (name === '.' || name === '..') continue;
      copy(path.posix.join(p, name), path.join(out, name));
    }
    bfs.closedir(dh);
  } else {
    const fd = bfs.open(p, 0);
    const chunks = [];
    const buf = new Uint8Array(65536);
    for (;;) {
      const n = bfs.read(fd, buf, buf.length);   // BlockFS.read(fd, buf, count)
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.slice(0, n)));
    }
    bfs.close(fd);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.concat(chunks));
    console.log(`${p} -> ${out} (${fs.statSync(out).size} bytes)`);
  }
}
copy(osPath, outDir);
