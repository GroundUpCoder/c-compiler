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
//   surf SAB    — shm transport: front-buffer pixels; copied into a cached
//                 ImageData only when frameSeq changes (move/z changes
//                 redraw from the cache with no SAB traffic).
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

  function surfaceImage(surf) {
    var seq = Atomics.load(surf.i32, K.SH_SEQ);
    var c = caches.get(surf.sid);
    if (c && c.seq === seq) return c.img;
    var bytes = surf.w * surf.h * 4;
    var front = Atomics.load(surf.i32, K.SH_FLIP) & 1;
    // Copy out of the SAB (ImageData can't view shared memory).
    var px = new Uint8ClampedArray(bytes);
    px.set(new Uint8Array(surf.sab, K.SH_HDR_BYTES + front * bytes, bytes));
    var img = new ImageData(px, surf.w, surf.h);
    caches.set(surf.sid, { seq: seq, img: img });
    return img;
  }

  function draw() {
    var scene = kernel.wmScene();
    ctx.fillStyle = COL_DESKTOP;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < scene.surfaces.length; i++) {
      var s = scene.surfaces[i];
      if (s.minimized) continue;               // off screen, still in the scene
      // Client pixels first, chrome after (they don't overlap; the next
      // window in z covers both — painter's algorithm).
      if (s.bitmap) {
        ctx.drawImage(s.bitmap, s.x, s.y, s.w, s.h);
      } else {
        ctx.putImageData(surfaceImage(s), s.x, s.y);
      }
      if (s.borderless) continue;              // taskbar-class: bare pixels
      ctx.fillStyle = s.sid === scene.focusSid ? COL_FOCUS : COL_BLUR;
      ctx.fillRect(s.x, s.y - K.WM_TITLE_H, s.w, K.WM_TITLE_H);
      ctx.fillStyle = COL_CLOSE;
      ctx.fillRect(s.x + s.w - K.WM_CLOSE_W - K.WM_CLOSE_PAD,
        s.y - K.WM_TITLE_H + K.WM_CLOSE_PAD, K.WM_CLOSE_W, K.WM_CLOSE_W);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 11px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('x', s.x + s.w - K.WM_CLOSE_W - K.WM_CLOSE_PAD + 5,
        s.y - K.WM_TITLE_H + K.WM_CLOSE_PAD + K.WM_CLOSE_W / 2 + 1);
      ctx.fillStyle = '#fff';
      ctx.fillText(s.title || ('pid ' + s.pid), s.x + 6, s.y - K.WM_TITLE_H / 2,
        Math.max(8, s.w - K.WM_CLOSE_W - 16));
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
    kernel.wmPointer('move', ev.x, ev.y, { buttons: state });
  } else if (ev.kind === 'down' || ev.kind === 'up') {
    kernel.wmPointer(ev.kind, ev.x, ev.y, { button: (ev.button | 0) + 1 });
  } else if (ev.kind === 'wheel') {
    var scale = ev.deltaMode === 1 ? 20 : ev.deltaMode === 2 ? 600 : 1;
    kernel.wmPointer('wheel', ev.x, ev.y,
      { wheelX: ev.deltaX * scale, wheelY: -ev.deltaY * scale, direction: 0 });
  }
}

if (typeof self !== 'undefined') {
  self.OS_COMPOSITOR = { startCompositor: startCompositor, routeInput: routeInput };
}
