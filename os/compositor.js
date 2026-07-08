// compositor.js — the browser half of the kernel compositor (todos/WM.md;
// scene state lives in kernel.js "WM surfaces"). Runs INSIDE the kernel
// worker on a master OffscreenCanvas transferred from os.html: per rAF it
// draws the scene bottom-up — desktop, then each surface's pixels + its
// kernel chrome (same WM_* metrics/colors that drive hit-testing and the
// headless screenshot composite, so what you click is what you see).
//
// Pixel sources per surface (transport is per-surface, invisible to apps):
//   surf.bitmap — gpu transport: the latest ImageBitmap the process handed
//                 over at present (kernel closes superseded ones).
//   surf SAB    — shm transport: front-buffer pixels; painted into a cached
//                 per-surface scratch OffscreenCanvas only when frameSeq
//                 changes (move/z changes redraw from the cache with no SAB
//                 traffic), then drawImage'd at the surface's dst viewport
//                 (todos/0024) with smoothing OFF — nearest-neighbor, the
//                 same mapping as the headless composite.
//
// Canvas2D on purpose (v1): the scene is single-digit quads and the chrome
// is rects + text — a WebGPU pass buys nothing here yet. The bitmap
// drawImage path is still GPU-composited by the browser.
'use strict';

/* global KERNEL */

function startCompositor(kernel, canvas) {
  var ctx = canvas.getContext('2d');
  var K = KERNEL;
  var caches = new Map();   // sid -> { seq, img }
  var rgba = function (c) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] / 255) + ')'; };
  var COL_DESKTOP = rgba(K.WM_COLORS.desktop);
  var COL_FOCUS = rgba(K.WM_COLORS.titleFocused);
  var COL_BLUR = rgba(K.WM_COLORS.titleBlurred);
  var COL_CLOSE = rgba(K.WM_COLORS.closeBox);
  var COL_BORDER = rgba(K.WM_COLORS.border);

  function surfaceCanvas(surf) {
    var seq = Atomics.load(surf.i32, K.SH_SEQ);
    var c = caches.get(surf.sid);
    // Size check: after a resize ack the surface has a FRESH SAB whose seq
    // restarts, so seq alone could collide with the stale old-size pixels.
    if (c && c.seq === seq && c.cnv.width === surf.w && c.cnv.height === surf.h) return c.cnv;
    if (!c || c.cnv.width !== surf.w || c.cnv.height !== surf.h) {
      var cnv = new OffscreenCanvas(surf.w, surf.h);
      c = { seq: -1, cnv: cnv, ctx: cnv.getContext('2d') };
      caches.set(surf.sid, c);
    }
    var bytes = surf.w * surf.h * 4;
    var front = Atomics.load(surf.i32, K.SH_FLIP) & 1;
    // Copy out of the SAB (ImageData can't view shared memory).
    var px = new Uint8ClampedArray(bytes);
    px.set(new Uint8Array(surf.sab, K.SH_HDR_BYTES + front * bytes, bytes));
    c.ctx.putImageData(new ImageData(px, surf.w, surf.h), 0, 0);
    c.seq = seq;
    return c.cnv;
  }

  function draw() {
    var scene = kernel.wmScene();
    // Nearest-neighbor scaling (todos/0024) — pixel-art correct, and the
    // same mapping the headless composite uses. Re-set per frame: resizing
    // the OffscreenCanvas (screen-resize, todos/0023) resets context state.
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = COL_DESKTOP;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < scene.surfaces.length; i++) {
      var s = scene.surfaces[i];
      if (s.minimized) continue;               // off screen, still in the scene
      var dw = s.dstW, dh = s.dstH;            // on-screen viewport (todos/0024)
      // Chrome frame first (the resize border sits UNDER title+client),
      // then client pixels; the next window in z covers both — painter's
      // algorithm.
      if (!s.borderless) {
        ctx.fillStyle = COL_BORDER;
        ctx.fillRect(s.x - K.WM_BORDER, s.y - K.WM_TITLE_H - K.WM_BORDER,
          dw + 2 * K.WM_BORDER, K.WM_TITLE_H + dh + 2 * K.WM_BORDER);
      }
      ctx.drawImage(s.bitmap || surfaceCanvas(s), s.x, s.y, dw, dh);
      if (s.borderless) continue;              // taskbar-class: bare pixels
      ctx.fillStyle = s.sid === scene.focusSid ? COL_FOCUS : COL_BLUR;
      ctx.fillRect(s.x, s.y - K.WM_TITLE_H, dw, K.WM_TITLE_H);
      ctx.fillStyle = COL_CLOSE;
      ctx.fillRect(s.x + dw - K.WM_CLOSE_W - K.WM_CLOSE_PAD,
        s.y - K.WM_TITLE_H + K.WM_CLOSE_PAD, K.WM_CLOSE_W, K.WM_CLOSE_W);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 11px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('x', s.x + dw - K.WM_CLOSE_W - K.WM_CLOSE_PAD + 5,
        s.y - K.WM_TITLE_H + K.WM_CLOSE_PAD + K.WM_CLOSE_W / 2 + 1);
      ctx.fillStyle = '#fff';
      ctx.fillText(s.title || ('pid ' + s.pid), s.x + 6, s.y - K.WM_TITLE_H / 2,
        Math.max(8, dw - K.WM_CLOSE_W - 16));
    }
    // Resize rubber band (todos/0019): Win95 outline semantics — the drag
    // only previews; the client renegotiates once, at release.
    if (scene.resizeDrag) {
      for (var r = 0; r < scene.surfaces.length; r++) {
        var rs = scene.surfaces[r];
        if (rs.sid !== scene.resizeDrag.sid) continue;
        ctx.strokeStyle = '#000';
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(rs.x - 0.5, rs.y - K.WM_TITLE_H - 0.5,
          scene.resizeDrag.curW + 1, K.WM_TITLE_H + scene.resizeDrag.curH + 1);
        ctx.setLineDash([]);
        break;
      }
    }
    // Drop caches of destroyed surfaces.
    if (caches.size > scene.surfaces.length) {
      var live = new Set(scene.surfaces.map(function (s) { return s.sid; }));
      caches.forEach(function (v, sid) { if (!live.has(sid)) caches.delete(sid); });
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

/* Raw UI-bridge input -> kernel routing. `ev` is the plain object os.html
 * ships (DOM events don't structured-clone); keys are re-shaped into the
 * duck-typed event SDL_WEB's mappers expect. */
function routeInput(kernel, sdlWeb, ev) {
  if (ev.kind === 'key') {
    var fake = {
      code: ev.code, key: ev.key, repeat: !!ev.repeat,
      getModifierState: function (k) { return !!(ev.mods && ev.mods[k]); },
    };
    var m = sdlWeb.keyMsg(fake, !!ev.down);
    kernel.wmKey(!!ev.down, m.scancode, m.sym, m.mod, m.repeat);
  } else if (ev.kind === 'move') {
    // DOM buttons bitmask -> SDL state mask (left/right/middle bit order differs).
    var b = ev.buttons | 0, state = 0;
    if (b & 1) state |= 1;
    if (b & 2) state |= 4;
    if (b & 4) state |= 2;
    // Pointer-locked moves (todos/0018) carry movementX/Y deltas instead of
    // coordinates; the kernel's locked routing consumes opts.dx/dy.
    if (ev.locked) kernel.wmPointer('move', 0, 0, { buttons: state, dx: ev.dx, dy: ev.dy });
    else kernel.wmPointer('move', ev.x, ev.y, { buttons: state });
  } else if (ev.kind === 'lockchange') {
    // The page's pointerlockchange report (todos/0018): flips the kernel
    // between locked (relative to the focused surface) and normal routing.
    kernel.wmPointerLockChanged(!!ev.active);
  } else if (ev.kind === 'down' || ev.kind === 'up') {
    // ev.t (event timestamp) feeds the kernel's title double-click
    // detection (todos/0025) — real inter-click gap, not worker latency.
    kernel.wmPointer(ev.kind, ev.x, ev.y, { button: (ev.button | 0) + 1, t: ev.t });
  } else if (ev.kind === 'wheel') {
    var scale = ev.deltaMode === 1 ? 20 : ev.deltaMode === 2 ? 600 : 1;
    kernel.wmPointer('wheel', ev.x, ev.y,
      { wheelX: ev.deltaX * scale, wheelY: -ev.deltaY * scale, direction: 0 });
  }
}

if (typeof self !== 'undefined') {
  self.OS_COMPOSITOR = { startCompositor: startCompositor, routeInput: routeInput };
}
