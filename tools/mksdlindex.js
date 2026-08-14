#!/usr/bin/env node
'use strict';
// mksdlindex.js — regenerate os/doc/sdl-api-index.md from the SDL surface
// compiler.js actually ships (#677).
//
// WHY THIS EXISTS
// ---------------
// GCODE.md (correctly) tells the in-OS agent "the headers are the
// authoritative surface — read the header, don't assume stock SDL3". The
// measured consequence (#508 Pass B): ~17 of 34 rounds of a fresh gcode
// session went to grepping /usr/include/SDL.h to reconstruct the API before
// the first line of game code. This tool renders that surface as ONE compact
// doc — one line per symbol, grouped, plus the "notably absent" list (the
// expensive failure is an agent assuming stock SDL3).
//
// THE ANTI-DRIFT SHAPE (the mkmpgenhdr.js + #505 precedents)
// ----------------------------------------------------------
// The doc is GENERATED from compiler.js's builtin header map — the same
// `createDefaultPPRegistry().standardHeaders` seam test_gcode_orientation.js
// pins — and COMMITTED at os/doc/sdl-api-index.md, baked by the uniform
// image.json doc wiring. `--check` regenerates and diffs; the host suite
// runs it (tests/host/test_sdl_api_index.js), so the committed doc cannot
// silently drift from the header block.
//
// Two loud-failure guards make the generator itself hard to rot:
//   - every extracted function must match exactly one GROUP rule, and every
//     header declaration must classify — an unrecognized shape throws;
//   - every name in the curated NOTABLY-ABSENT list is verified absent from
//     the (comment-stripped) surface at generation time, so filling an
//     absence (#672's SDL_RenderTextureRotated is the live precedent) makes
//     regeneration REFUSE until the list is updated — the PRINCIPLES.md
//     two-sided-edit rule, enforced mechanically.
//
// Usage:
//   node tools/mksdlindex.js              # regenerate os/doc/sdl-api-index.md
//   node tools/mksdlindex.js --check     # regenerate to memory, diff against
//                                        # the committed file, exit 1 if stale

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'os', 'doc', 'sdl-api-index.md');

// ---- the surface: which builtin headers the index covers ------------------
// SDL.h is the core; the subsidiary headers are part of the app-facing SDL
// surface (each pulls its own TU). __SDL_internal.h is private and excluded;
// SDL3/SDL.h and SDL3/SDL_main.h are forwarding shims, described in prose.
const CORE_HEADER = 'SDL.h';
const SUB_HEADERS = [
  { key: 'SDL_popup.h', include: '<SDL_popup.h>',
    title: 'Popup windows',
    note: 'Anchored borderless child windows (menus/tooltips). Flags must include SDL_WINDOW_POPUP_MENU (holds the grab; outside press dismisses via SDL_EVENT_WINDOW_CLOSE_REQUESTED) or SDL_WINDOW_TOOLTIP (no grab).' },
  { key: 'SDL3_image/SDL_image.h', include: '<SDL3_image/SDL_image.h>',
    title: 'Image loading (SDL_image)',
    note: 'PNG is the only decoder shipped (libpng). IMG_Load returns a heap SDL_Surface (free with SDL_DestroySurface); on a minimal boot `gucman install libpng` first.' },
  { key: 'sdl3webgpu.h', include: '<sdl3webgpu.h>',
    title: 'WebGPU bridge',
    note: 'Raw GPU access for an SDL window (with <webgpu.h>). A window uses EITHER SDL_UpdateWindowSurface/SDL_Renderer OR WebGPU, never both.' },
];
const MAIN_HEADER = '__SDL_main.h';   // callback prototypes only (rest is impl)

// ---- function groups ------------------------------------------------------
// Ordered; first matching rule wins; a prototype matching NO rule throws
// (the loud-failure guard: a new SDL symbol either lands in a family
// automatically or forces a deliberate taxonomy decision here).
const GROUPS = [
  { title: 'Init & lifecycle',
    re: /^SDL_(Init|InitSubSystem|QuitSubSystem|WasInit|Quit)$/ },
  { title: 'Main loop (callback model — #define SDL_MAIN_USE_CALLBACKS, no main())',
    re: /^SDL_App|^__setAnimationFrameFunc$/,
    note: 'THE sanctioned loop for GPU-presenting apps: SDL_AppIterate runs once per composited frame (~60 Hz). A blocking loop that presents GPU frames is killed at its second present (exit 69) — see sdl-gucos.md. __setAnimationFrameFunc is the low-level frame seam the callback model rides.' },
  { title: 'Events',
    re: /Event/,
    note: 'event.key.key is the MODIFIER-APPLIED ASCII char for printable keys (compare \'r\', \'R\', \'3\'); physical keys are event.key.scancode (SDL_SCANCODE_*). SDLK_* constants exist only for special keys — see the constants section.' },
  { title: 'Input state (keyboard / mouse snapshots)',
    re: /Keyboard|Mouse|ModState/,
    note: 'Snapshots advance as events are pumped. SDL_GetGlobalMouseState ALWAYS fails by design (0 mask + SDL error): a process only sees pointer events routed to its own windows.' },
  { title: 'Window & window surface',
    re: /Window|^SDL_DestroySurface$/,
    note: 'SDL_SetWindowPosition and SDL_SetWindowIcon are honest accept-and-succeed no-ops — the WM owns placement; no taskbar-icon pipe yet.' },
  { title: 'Renderer & textures (2D accelerated)',
    re: /Render|Texture/,
    note: 'SDL_CreateRenderer(win, NULL) = the GPU tier (requires the callback main loop). "software" (or SDL_RENDER_DRIVER=software) = CPU into the window surface, blocking loops legal. Any other driver name fails.' },
  { title: 'Timing',
    re: /Ticks|Performance|^SDL_Delay$/,
    note: 'SDL_GetPerformanceFrequency() == 1000000000 (ns units). SDL_Delay waits AT LEAST the asked time.' },
  { title: 'Audio (push model)',
    re: /Audio/,
    note: 'Push PCM with SDL_PutAudioStreamData. On a HEADLESS boot the queue never drains — top up only while SDL_GetAudioStreamQueued is below a cap, never wait for drain (sdl-gucos.md).' },
  { title: 'Clipboard',
    re: /Clipboard/,
    note: 'Text only; one system-wide slot. SDL_GetClipboardText never returns NULL ("" when empty); free the result with SDL_free.' },
  { title: 'Cursors (system shapes only)',
    re: /Cursor/ },
  { title: 'Error handling',
    re: /Error/ },
  { title: 'Hints',
    re: /Hint/ },
  { title: 'Filesystem paths',
    re: /^SDL_Get(BasePath|PrefPath)$/,
    note: 'SDL_GetBasePath is cached/SDL-owned (do not free); SDL_GetPrefPath ($HOME/.local/share/<org>/<app>/) is caller-freed with SDL_free.' },
  { title: 'Memory, random, log',
    re: /^SDL_(free|malloc|calloc|realloc|srand|rand|rand_bits|randf|Log)$/,
    note: 'SDL and libc pointers are interchangeable here (one heap). SDL_rand(n) is upstream’s exact generator, uniform over [0, n).' },
];

// ---- constant clusters ----------------------------------------------------
// Ordered prefix match (first cluster with a matching prefix wins); a
// constant matching NO cluster throws.
const CLUSTERS = [
  { title: 'SDL_INIT_* — SDL_Init subsystem flags', prefixes: ['SDL_INIT_'] },
  { title: 'SDL_WINDOWPOS_*', prefixes: ['SDL_WINDOWPOS_'] },
  { title: 'SDL_WINDOW_* — window create flags', prefixes: ['SDL_WINDOW_'] },
  { title: 'SDL_EVENT_* — event types (event.type)', prefixes: ['SDL_EVENT_'],
    note: 'Of the WINDOW_* block only RESIZED, FOCUS_GAINED/LOST and CLOSE_REQUESTED are delivered today; the rest exist for source compatibility.' },
  { title: 'SDLK_* — special-key keysyms (event.key.key): the COMPLETE list', prefixes: ['SDLK_'],
    note: 'Only the names above exist. Letters, digits and punctuation have NO SDLK_ constants — event.key.key carries the modifier-applied ASCII char, so compare char literals (\'a\', \'R\', \'3\'). There are no SDLK_KP_* keypad constants.' },
  { title: 'SDL_KMOD_* — modifier flags (event.key.mod)', prefixes: ['SDL_KMOD_'] },
  { title: 'SDL_SCANCODE_* — physical keys (event.key.scancode), full USB-HID table', prefixes: ['SDL_SCANCODE_'] },
  { title: 'Mouse buttons & wheel', prefixes: ['SDL_BUTTON_', 'SDL_MOUSEWHEEL_'] },
  { title: 'Audio formats & device', prefixes: ['SDL_AUDIO_'] },
  { title: 'Pixel formats & helpers', prefixes: ['SDL_PIXELFORMAT_', 'SDL_PIXEL', 'SDL_PACKEDORDER_', 'SDL_ISPIXELFORMAT_'],
    note: 'Every texture/surface is RGBA bytes in memory; use SDL_PIXELFORMAT_RGBA32.' },
  { title: 'Hint names', prefixes: ['SDL_HINT_'] },
  { title: 'Error helper', prefixes: ['SDL_InvalidParamError'] },
  { title: 'Veneer sentinel', prefixes: ['IMG_SURFACE_OWNED'],
    note: 'Set in SDL_Surface.flags on heap surfaces this runtime owns (IMG_Load results) — how SDL_DestroySurface knows to free.' },
];

// ---- the notably-absent list ---------------------------------------------
// Curated, but MECHANICALLY VERIFIED at every generation: each `absent` name
// must not appear in the comment-stripped surface (present => refuse, naming
// the two-sided edit) and each `see` name must appear (so the "use X
// instead" advice cannot rot either). #672 is the live precedent: an
// "absent" claim about SDL_RenderTextureRotated would refuse today.
const ABSENT = [
  { label: 'SDL_ttf: no `TTF_*` function exists; `#include <SDL_ttf.h>` fails. Draw text with FreeType (`<ft2build.h>`) + the shipped fonts under `/usr/share/fonts/`, or an embedded bitmap font — see sdl-gucos.md.',
    absent: ['TTF_Init', 'TTF_OpenFont', 'TTF_RenderText_Solid'] },
  { label: 'Render targets: `SDL_SetRenderTarget` / `SDL_GetRenderTarget`. SDL_TEXTUREACCESS_TARGET is defined, but rendering INTO a texture is not available — compose CPU-side and upload with SDL_UpdateTexture.',
    absent: ['SDL_SetRenderTarget', 'SDL_GetRenderTarget'],
    see: ['SDL_TEXTUREACCESS_TARGET', 'SDL_UpdateTexture'] },
  { label: 'Texture pixel access: `SDL_LockTexture` / `SDL_UnlockTexture` — upload with SDL_UpdateTexture instead.',
    absent: ['SDL_LockTexture', 'SDL_UnlockTexture'],
    see: ['SDL_UpdateTexture'] },
  { label: 'Renderer state: `SDL_SetRenderViewport`, `SDL_SetRenderClipRect`, `SDL_SetRenderScale`, `SDL_SetRenderLogicalPresentation`, `SDL_RenderReadPixels`, `SDL_GetRenderOutputSize` — none exist; draw in window pixels 1:1.',
    absent: ['SDL_SetRenderViewport', 'SDL_SetRenderClipRect', 'SDL_SetRenderScale',
             'SDL_SetRenderLogicalPresentation', 'SDL_RenderReadPixels', 'SDL_GetRenderOutputSize'] },
  { label: 'Gamepad / joystick: no device API at all (`SDL_OpenGamepad`, `SDL_GetGamepads`, `SDL_OpenJoystick`, …). The SDL_INIT_GAMEPAD / SDL_INIT_JOYSTICK flag constants exist, but input is keyboard + mouse only.',
    absent: ['SDL_OpenGamepad', 'SDL_GetGamepads', 'SDL_OpenJoystick', 'SDL_GetJoysticks'],
    see: ['SDL_INIT_GAMEPAD', 'SDL_INIT_JOYSTICK'] },
  { label: 'Surface toolkit: `SDL_CreateSurface`, `SDL_BlitSurface`, `SDL_FillSurfaceRect`, `SDL_ConvertSurface`, `SDL_LoadBMP` — the only SDL_Surfaces are window surfaces and IMG_Load results; write `->pixels` directly.',
    absent: ['SDL_CreateSurface', 'SDL_BlitSurface', 'SDL_FillSurfaceRect', 'SDL_ConvertSurface', 'SDL_LoadBMP'] },
  { label: 'Audio files & mixing: `SDL_LoadWAV` and SDL_mixer (`Mix_*`) — parse audio data yourself and push PCM through SDL_PutAudioStreamData (one stream per concurrent sound; the OS mixes).',
    absent: ['SDL_LoadWAV', 'Mix_OpenAudio'],
    see: ['SDL_PutAudioStreamData'] },
  { label: 'Window management: `SDL_ShowWindow`, `SDL_HideWindow`, `SDL_RaiseWindow`, `SDL_MinimizeWindow`, `SDL_MaximizeWindow`, `SDL_SetWindowFullscreen` — the WM owns placement and chrome.',
    absent: ['SDL_ShowWindow', 'SDL_HideWindow', 'SDL_RaiseWindow', 'SDL_MinimizeWindow',
             'SDL_MaximizeWindow', 'SDL_SetWindowFullscreen'] },
  { label: 'Text input & custom cursors: `SDL_StartTextInput` (use key events — event.key.key is already the applied character) and `SDL_CreateCursor` (system cursor shapes only, via SDL_CreateSystemCursor).',
    absent: ['SDL_StartTextInput', 'SDL_StopTextInput', 'SDL_CreateCursor', 'SDL_CreateColorCursor'],
    see: ['SDL_CreateSystemCursor'] },
  { label: 'stdinc wrappers: `SDL_snprintf`, `SDL_strlcpy`, `SDL_memcpy`, `SDL_sinf`, … — use libc (`<stdio.h>`, `<string.h>`, `<math.h>`); SDL and libc share one heap here.',
    absent: ['SDL_snprintf', 'SDL_strlcpy', 'SDL_memcpy', 'SDL_sinf'] },
  { label: 'Threads, IO abstraction, properties, message boxes, GL: `SDL_CreateThread` (single-threaded platform), `SDL_IOStream`/`SDL_RWops` (use stdio), `SDL_GetWindowProperties`, `SDL_ShowSimpleMessageBox`, `SDL_GL_*` — GPU access is `<webgpu.h>` + `<sdl3webgpu.h>`.',
    absent: ['SDL_CreateThread', 'SDL_IOFromFile', 'SDL_RWFromFile', 'SDL_GetWindowProperties',
             'SDL_ShowSimpleMessageBox', 'SDL_GL_CreateContext'] },
  { label: '`SDL_RenderDebugText` — absent; debug/HUD text is FreeType or a bitmap font.',
    absent: ['SDL_RenderDebugText'] },
];

// ---- parsing --------------------------------------------------------------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

// Split a comment-stripped header into preprocessor defines and top-level C
// statements, then classify every statement. Anything unrecognized throws —
// this generator would rather fail than silently drop surface.
function parseHeader(name, src) {
  const defines = [];
  const cLines = [];
  const lines = stripComments(src).split('\n');
  for (let i = 0; i < lines.length; i++) {
    let t = lines[i].trim();
    if (t.startsWith('#')) {
      while (t.endsWith('\\') && i + 1 < lines.length) t = t.slice(0, -1).trim() + ' ' + lines[++i].trim();
      const m = /^#\s*define\s+(\w+)(\([^)]*\))?\s*(.*)$/.exec(t);
      if (m) defines.push({ name: m[1], params: m[2] || '', value: m[3].replace(/\s+/g, ' ').trim() });
      continue;   // all other preprocessor lines (#pragma/#include/#if*/#endif) carry no surface
    }
    cLines.push(lines[i]);
  }

  const stmts = [];
  let depth = 0, cur = '';
  for (const ch of cLines.join('\n')) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    cur += ch;
    if (ch === ';' && depth === 0) { stmts.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) throw new Error(name + ': unterminated trailing declaration: ' + cur.trim().slice(0, 100));

  const protos = [], types = [], enums = [], anonEnumBodies = [];
  for (const raw of stmts) {
    const s = raw.replace(/\s+/g, ' ').trim().replace(/\s*;$/, '');
    if (!s) continue;
    let m;
    if (s.startsWith('__require_source')) continue;
    if ((m = /^typedef enum (\w+) \{ (.*) \} \1$/.exec(s))) { enums.push({ name: m[1], body: m[2] }); continue; }
    if ((m = /^typedef enum \{ (.*) \} (\w+)$/.exec(s))) { enums.push({ name: m[2], body: m[1] }); continue; }
    if ((m = /^enum \{ (.*) \}$/.exec(s))) { anonEnumBodies.push(m[1]); continue; }
    if ((m = /^typedef (struct|union) (\w+) \{ (.*) \} \2$/.exec(s))) { types.push({ kind: m[1], name: m[2], body: m[3] }); continue; }
    if ((m = /^typedef struct (\w+) (\w+)$/.exec(s)) && m[1] === m[2]) { types.push({ kind: 'opaque', name: m[2] }); continue; }
    if ((m = /^typedef (.+?) \(\s?\*(\w+)\)\((.*)\)$/.exec(s))) { types.push({ kind: 'fnptr', name: m[2], ret: m[1], args: m[3] }); continue; }
    if ((m = /^typedef ([\w ]+?) (\w+)$/.exec(s))) { types.push({ kind: 'alias', name: m[2], def: m[1] }); continue; }
    if ((m = /^([\w][\w\s\*]*?[\s\*])(\w+) ?\((.*)\)$/.exec(s))) { protos.push({ ret: m[1].trim(), name: m[2], args: m[3].trim() }); continue; }
    throw new Error(name + ': unclassified declaration (extend parseHeader deliberately): ' + s.slice(0, 120));
  }
  return { defines, protos, types, enums, anonEnumBodies, stripped: stripComments(src) };
}

// Enum body "A = 1, B, C = 5" -> [{name, value}] with C's implicit +1 rule.
function enumMembers(body) {
  const out = [];
  let next = 0;
  for (const part of body.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\w+)(?: = (.+))?$/.exec(t);
    if (!m) throw new Error('unparseable enum member: ' + t);
    let val;
    if (m[2] !== undefined) {
      val = m[2].trim();
      const n = Number(val);
      next = Number.isNaN(n) ? NaN : n + 1;
    } else {
      if (Number.isNaN(next)) throw new Error('implicit enum value after a non-numeric one: ' + t);
      val = String(next);
      next += 1;
    }
    out.push({ name: m[1], value: val });
  }
  return out;
}

function groupFor(fnName) {
  for (const g of GROUPS) if (g.re.test(fnName)) return g.title;
  throw new Error('function matches no GROUP rule — assign it deliberately in tools/mksdlindex.js: ' + fnName);
}

function clusterFor(constName) {
  for (const c of CLUSTERS) if (c.prefixes.some((p) => constName.startsWith(p))) return c.title;
  throw new Error('constant matches no CLUSTER prefix — assign it deliberately in tools/mksdlindex.js: ' + constName);
}

// The absence gate: every claimed-absent name must NOT appear (as a whole
// word) in the comment-stripped surface; every `see` anchor MUST appear.
function assertAbsent(entries, strippedSurface) {
  for (const e of entries) {
    for (const n of e.absent) {
      if (new RegExp('\\b' + n + '\\b').test(strippedSurface))
        throw new Error('"notably absent" claims ' + n + ' but the header surface HAS it — ' +
          'the absence was filled (two-sided edit, todos/PRINCIPLES.md): update the ABSENT list in tools/mksdlindex.js');
    }
    for (const n of (e.see || [])) {
      if (!new RegExp('\\b' + n + '\\b').test(strippedSurface))
        throw new Error('"notably absent" advice points at ' + n + ' but the header surface LACKS it — fix the `see` anchor in tools/mksdlindex.js');
    }
  }
  // Family sweeps: nothing TTF_/Mix_-shaped may exist anywhere in the surface.
  const fam = /\b(TTF|Mix)_\w+/.exec(strippedSurface);
  if (fam) throw new Error('surface grew a ' + fam[0] + ' symbol — the SDL_ttf/SDL_mixer absence claims are stale');
}

// ---- emission -------------------------------------------------------------

function fmtProto(p) {
  const sep = p.ret.endsWith('*') ? '' : ' ';
  return p.ret + sep + p.name + '(' + p.args + ');';
}

function packTokens(tokens, width) {
  const lines = [];
  let cur = '';
  for (const t of tokens) {
    if (cur && (cur.length + 2 + t.length) > width) { lines.push(cur); cur = t; }
    else cur = cur ? cur + '  ' + t : t;
  }
  if (cur) lines.push(cur);
  return lines;
}

function generate() {
  const CompilerJS = require(path.join(ROOT, 'compiler.js'));
  const headers = CompilerJS.createDefaultPPRegistry().standardHeaders;
  for (const k of [CORE_HEADER, MAIN_HEADER, ...SUB_HEADERS.map((h) => h.key)])
    if (!headers.get(k)) throw new Error('standardHeaders has no ' + k + ' — the header map moved; resync tools/mksdlindex.js');

  const core = parseHeader(CORE_HEADER, headers.get(CORE_HEADER));
  const subs = SUB_HEADERS.map((h) => ({ ...h, parsed: parseHeader(h.key, headers.get(h.key)) }));

  // __SDL_main.h is mostly implementation; only the four app-callback
  // prototypes are surface. Extract them narrowly and assert the count.
  const mainSrc = stripComments(headers.get(MAIN_HEADER));
  const appProtos = [];
  for (const m of mainSrc.matchAll(/^(SDL_AppResult|void) (SDL_App\w+)\((.*)\);$/gm))
    appProtos.push({ ret: m[1], name: m[2], args: m[3] });
  if (appProtos.length !== 4)
    throw new Error('expected exactly 4 SDL_App* callback prototypes in __SDL_main.h, found ' + appProtos.length);

  // Group the core functions (+ the app callbacks, which the GROUPS table
  // routes to the main-loop group). Sub-header functions group by ORIGIN.
  const grouped = new Map(GROUPS.map((g) => [g.title, []]));
  for (const p of [...core.protos, ...appProtos]) grouped.get(groupFor(p.name)).push(p);

  // Cluster the constants: core #defines + anonymous-enum members (scancodes).
  const clustered = new Map(CLUSTERS.map((c) => [c.title, []]));
  for (const d of core.defines)
    clustered.get(clusterFor(d.name)).push(d.params
      ? { kind: 'macro', name: d.name, params: d.params, value: d.value }
      : { kind: 'const', name: d.name, value: d.value });
  for (const body of core.anonEnumBodies)
    for (const m of enumMembers(body))
      clustered.get(clusterFor(m.name)).push({ kind: 'const', name: m.name, value: m.value });

  // The absence gate runs over the whole app-facing surface.
  const strippedSurface = [core.stripped, mainSrc, ...subs.map((s) => s.parsed.stripped)].join('\n');
  assertAbsent(ABSENT, strippedSurface);

  const out = [];
  const push = (s) => out.push(s);
  push('# gucOS SDL API index — every symbol the shipped `<SDL.h>` surface has');
  push('');
  push('> GENERATED FILE — do not edit. `node tools/mksdlindex.js` (host repo)');
  push('> regenerates it from the compiler’s builtin SDL headers, and the host');
  push('> suite fails if it drifts. In-OS, this file describes exactly what');
  push('> `/usr/include/SDL.h` ships.');
  push('');
  push('This platform is a documented SUBSET of SDL3, spelled like SDL3 (bool');
  push('returns, float mouse coords, flat key events, Uint64 ticks). Everything');
  push('listed below EXISTS today; the last section lists what notably does NOT.');
  push('Main-loop, audio-backlog and text RULES: `/usr/share/doc/sdl-gucos.md` —');
  push('read it before writing SDL code.');
  push('');
  push('Includes: `#include <SDL.h>` (or `<SDL3/SDL.h>` — same header).');
  push('`#define SDL_MAIN_USE_CALLBACKS` before the include opts into the');
  push('callback main loop. Optional subsidiary headers: `<SDL_popup.h>`,');
  push('`<SDL3_image/SDL_image.h>`, `<sdl3webgpu.h>` (each pulls its own');
  push('implementation; sections below).');
  push('');
  push('## Functions');
  for (const g of GROUPS) {
    const fns = grouped.get(g.title);
    if (!fns.length) throw new Error('GROUP rule matched nothing (stale rule?): ' + g.title);
    push('');
    push('### ' + g.title);
    if (g.note) { push(''); push(g.note); }
    push('');
    push('```c');
    for (const p of fns) push(fmtProto(p));
    push('```');
  }
  for (const s of subs) {
    push('');
    push('### ' + s.title + ' — `#include ' + s.include + '`');
    push('');
    push(s.note);
    push('');
    push('```c');
    for (const p of s.parsed.protos) push(fmtProto(p));
    push('```');
  }
  push('');
  push('## Types');
  push('');
  push('```c');
  for (const t of [...core.types, ...subs.flatMap((s) => s.parsed.types)]) {
    if (t.kind === 'opaque') push('typedef struct ' + t.name + ' ' + t.name + ';   /* opaque */');
    else if (t.kind === 'alias') push('typedef ' + t.def + ' ' + t.name + ';');
    else if (t.kind === 'fnptr') push('typedef ' + t.ret + ' (*' + t.name + ')(' + t.args + ');');
    else push('typedef ' + t.kind + ' ' + t.name + ' { ' + t.body + ' } ' + t.name + ';');
  }
  push('```');
  push('');
  push('Enums:');
  push('');
  push('```c');
  for (const e of [...core.enums, ...subs.flatMap((s) => s.parsed.enums)])
    push('typedef enum ' + e.name + ' { ' + e.body + ' } ' + e.name + ';');
  push('```');
  push('');
  push('## Constants');
  for (const c of CLUSTERS) {
    const items = clustered.get(c.title);
    if (!items.length) throw new Error('CLUSTER matched nothing (stale cluster?): ' + c.title);
    push('');
    push('### ' + c.title);
    push('');
    push('```');
    const packable = [];
    for (const it of items) {
      if (it.kind === 'macro') push(it.name + it.params + ' ' + it.value);
      else if (/ /.test(it.value)) push(it.name + ' = ' + it.value);
      else packable.push(it.name + '=' + it.value);
    }
    for (const line of packTokens(packable, 88)) push(line);
    push('```');
    if (c.note) { push(''); push(c.note); }
  }
  push('');
  push('## Notably ABSENT (do not assume stock SDL3)');
  push('');
  push('Every claim in this list is re-verified against the header surface each');
  push('time this file is generated — an entry here is absent TODAY, not folklore.');
  push('An absent symbol fails loud at compile time (“Undeclared identifier”).');
  push('');
  for (const e of ABSENT) push('- ' + e.label);
  push('');
  return out.join('\n');
}

// The --check comparator, exported for the host test's red controls.
function check(targetPath) {
  const want = generate();
  let have = null;
  try { have = fs.readFileSync(targetPath, 'utf8'); } catch (e) { /* missing = stale */ }
  if (have === want) return { ok: true };
  let hint = 'file missing';
  if (have !== null) {
    const a = have.split('\n'), b = want.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { hint = 'first difference at line ' + (i + 1) + ':\n  committed: ' + (a[i] || '<eof>') + '\n  generated: ' + (b[i] || '<eof>'); break; }
    }
  }
  return { ok: false, hint };
}

module.exports = { generate, check, groupFor, clusterFor, assertAbsent, parseHeader, OUT };

if (require.main === module) {
  // Cross-tree preflight (todos/0341): this tool writes os/doc/ next to
  // itself; a cross-tree launch would rewrite another tree's committed doc.
  require(path.join(__dirname, '../tests/lib/tree-guard.js'))
    .assertSameTree(__dirname, { label: 'tools/mksdlindex.js' });

  if (process.argv.includes('--check')) {
    const r = check(OUT);
    if (!r.ok) {
      console.error('sdl-api-index STALE: os/doc/sdl-api-index.md does not match the header surface.');
      console.error(r.hint);
      console.error('Regenerate: node tools/mksdlindex.js');
      process.exit(1);
    }
    console.log('sdl-api-index in sync');
  } else {
    fs.writeFileSync(OUT, generate());
    console.log('wrote ' + path.relative(ROOT, OUT));
  }
}
