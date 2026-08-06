// Sweep membership for doom-motion-check.mjs (ticket #543) — the callback-
// model timing guard on the compiler-emitted doom.html (SDL_GetTicks is the
// only thing advancing the game; a frozen canvas means timing broke). Same
// shape and rationale as os-doompage-renders.mjs: rebuild-if-stale, then run
// the manual driver unchanged so it finally has a suite that can go red.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFreshDoomPage } from './lib/doom-artifacts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
ensureFreshDoomPage();
const r = spawnSync(process.execPath, [path.join(__dirname, 'doom-motion-check.mjs')],
  { stdio: 'inherit' });
process.exit(r.status ?? 1);
