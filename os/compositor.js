// compositor.js — the browser half of the kernel compositor (todos/WM.md;
// scene state lives in kernel.js "WM surfaces"). Runs INSIDE the kernel
// worker on a master OffscreenCanvas transferred from os.html: per rAF it
// renders the scene bottom-up in ONE WebGPU render pass (todos/0055, the
// pass WM.md designed) — desktop clear, then per surface its pixels as a
// z-ordered textured quad + its kernel chrome (same WM_* metrics/colors
// that drive hit-testing and the headless screenshot composite, so what
// you click is what you see).
//
// Pixel sources per surface (transport is per-surface, invisible to apps):
//   surf.bitmap — gpu transport: the latest ImageBitmap the process handed
//                 over at present, imported via copyExternalImageToTexture
//                 (identity-gated: one import per NEW bitmap; the kernel
//                 keeps closing superseded ones — lifetime discipline
//                 unchanged). gpubox frames never touch a CPU pixel path.
//   surf SAB    — shm transport: front-buffer pixels, writeTexture-uploaded
//                 into a cached per-surface GPUTexture only when frameSeq
//                 changes (move/z changes redraw from the cache with no SAB
//                 traffic), sampled NEAREST at the surface's dst viewport
//                 (todos/0024) — the same mapping as the headless composite.
//
// Chrome (border, title bar, boxes, rubber band) is flat-color quads over a
// shared 1x1 white texture; title text and the close-box 'x' rasterize
// through a throwaway 2D canvas into small cached label textures (a texture
// SOURCE, not scene assembly). There is deliberately NO Canvas2D fallback
// (decision 2026-07-09, logs/2026-07-09/webgpu-mvu-direction.md): the
// platform's compositor IS WebGPU; kernel-worker.js guards boot with a loud
// boot-nogpu screen when no device exists.
'use strict';

/* global KERNEL */

// Textured quads with per-vertex color (positions already in NDC; the color
// modulates the sampled texel — a 1x1 white texture turns it into a solid
// fill). Same shape as host.js's RENDER_WGSL; alpha-blended source-over.
var COMP_WGSL = `
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f };
@vertex fn vs(@location(0) pos: vec2f, @location(1) uv: vec2f, @location(2) color: vec4f) -> VO {
  var o: VO;
  o.pos = vec4f(pos, 0.0, 1.0);
  o.uv = uv;
  o.color = color;
  return o;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment fn fs(v: VO) -> @location(0) vec4f {
  return textureSample(tex, samp, v.uv) * v.color;
}
`;

function startCompositor(kernel, canvas, device) {
  var K = KERNEL;
  var gctx = canvas.getContext('webgpu');
  if (!gctx) throw new Error('compositor: no webgpu canvas context');
  var format = navigator.gpu.getPreferredCanvasFormat();
  var confW = -1, confH = -1;   // reconfigure on screen-resize (todos/0023)

  // Loud by design (todos/0055): there is no fallback compositor, so a lost
  // device means a dead desktop — surface it on the boot log, don't fade.
  device.lost.then(function (info) {
    var msg = '[compositor] WebGPU device lost: ' + ((info && info.message) || 'unknown');
    console.error(msg);
    try { self.postMessage({ type: 'boot-log', msg: msg }); } catch (e) {}
  });

  var shader = device.createShaderModule({ code: COMP_WGSL });
  var pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shader, entryPoint: 'vs',
      buffers: [{
        arrayStride: 32,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' },
          { shaderLocation: 1, offset: 8, format: 'float32x2' },
          { shaderLocation: 2, offset: 16, format: 'float32x4' },
        ],
      }],
    },
    fragment: {
      module: shader, entryPoint: 'fs',
      targets: [{
        format: format,
        // Source-over, matching the Canvas2D path this replaces (label
        // textures have antialiased alpha edges; app pixels are opaque).
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
  });
  // Nearest sampling (todos/0024) — pixel-art correct, and the same
  // dst-viewport mapping the headless composite uses.
  var sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
  function bindFor(tex) {
    return device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: tex.createView() }],
    });
  }

  var whiteTex = device.createTexture({
    size: { width: 1, height: 1 }, format: 'rgba8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  device.queue.writeTexture({ texture: whiteTex }, new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4 }, { width: 1, height: 1 });
  var whiteBind = bindFor(whiteTex);

  var norm = function (c) { return [c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255]; };
  var CLEAR_DESKTOP = { r: K.WM_COLORS.desktop[0] / 255, g: K.WM_COLORS.desktop[1] / 255,
                        b: K.WM_COLORS.desktop[2] / 255, a: 1 };
  var COL_FOCUS = norm(K.WM_COLORS.titleFocused);
  var COL_BLUR = norm(K.WM_COLORS.titleBlurred);
  var COL_CLOSE = norm(K.WM_COLORS.closeBox);
  var COL_BORDER = norm(K.WM_COLORS.border);
  var WHITE = [1, 1, 1, 1];
  var BLACK = [0, 0, 0, 1];

  // ---- per-frame quad batch: one vertex buffer, one pass, one draw per
  // contiguous same-texture run (chrome runs batch on the white texture).
  var vdata = new Float32Array(8 * 6 * 256);
  var vfloats = 0;
  var runs = [];                 // { bind, quads }
  var frameW = 1, frameH = 1;
  var vbuf = null, vbufBytes = 0;   // persistent, grown — never per-frame churn

  function pushQuad(bind, x, y, w, h, color, u0, v0, u1, v1) {
    if (u0 === undefined) { u0 = 0; v0 = 0; u1 = 1; v1 = 1; }
    if (vfloats + 48 > vdata.length) {
      var nd = new Float32Array(vdata.length * 2);
      nd.set(vdata.subarray(0, vfloats));
      vdata = nd;
    }
    var x0 = x / frameW * 2 - 1, y0 = 1 - y / frameH * 2;
    var x1 = (x + w) / frameW * 2 - 1, y1 = 1 - (y + h) / frameH * 2;
    var n = vfloats, d = vdata;
    var vert = function (px, py, pu, pv) {
      d[n] = px; d[n + 1] = py; d[n + 2] = pu; d[n + 3] = pv;
      d[n + 4] = color[0]; d[n + 5] = color[1]; d[n + 6] = color[2]; d[n + 7] = color[3];
      n += 8;
    };
    vert(x0, y0, u0, v0); vert(x1, y0, u1, v0); vert(x0, y1, u0, v1);
    vert(x0, y1, u0, v1); vert(x1, y0, u1, v0); vert(x1, y1, u1, v1);
    vfloats = n;
    var last = runs.length ? runs[runs.length - 1] : null;
    if (last && last.bind === bind) last.quads++;
    else runs.push({ bind: bind, quads: 1 });
  }

  // ---- shm surfaces: per-surface GPUTexture, upload gated on frameSeq
  // (same seq/size discipline as the old scratch-canvas cache).
  var shmCache = new Map();   // sid -> { seq, w, h, tex, bind, scratch }
  function shmBindFor(surf) {
    var seq = Atomics.load(surf.i32, K.SH_SEQ);
    var c = shmCache.get(surf.sid);
    // Size check: after a resize ack the surface has a FRESH SAB whose seq
    // restarts, so seq alone could collide with the stale old-size pixels.
    if (!c || c.w !== surf.w || c.h !== surf.h) {
      if (c) c.tex.destroy();
      var tex = device.createTexture({
        size: { width: surf.w, height: surf.h }, format: 'rgba8unorm',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      c = { seq: seq - 1, w: surf.w, h: surf.h, tex: tex, bind: bindFor(tex),
            scratch: new Uint8Array(surf.w * surf.h * 4) };
      shmCache.set(surf.sid, c);
    }
    if (c.seq !== seq) {
      var bytes = surf.w * surf.h * 4;
      var front = Atomics.load(surf.i32, K.SH_FLIP) & 1;
      // Copy out of the SAB (writeTexture wants non-racing bytes; same copy
      // the putImageData path made).
      c.scratch.set(new Uint8Array(surf.sab, K.SH_HDR_BYTES + front * bytes, bytes));
      device.queue.writeTexture({ texture: c.tex }, c.scratch,
        { bytesPerRow: surf.w * 4 }, { width: surf.w, height: surf.h });
      c.seq = seq;
    }
    return c.bind;
  }

  // ---- gpu surfaces: import the arriving ImageBitmap, once per bitmap
  // (identity-gated — the kernel swaps surf.bitmap at present and closes
  // the superseded one; we never close, so the discipline is unchanged).
  var gpuCache = new Map();   // sid -> { bmp, w, h, tex, bind }
  function gpuBindFor(surf) {
    var bmp = surf.bitmap;
    var c = gpuCache.get(surf.sid);
    if (!c || c.bmp !== bmp) {
      var w = bmp.width, h = bmp.height;
      if (!c || c.w !== w || c.h !== h) {
        if (c) c.tex.destroy();
        var tex = device.createTexture({
          size: { width: w, height: h }, format: 'rgba8unorm',
          // RENDER_ATTACHMENT: copyExternalImageToTexture requires it.
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING |
                 GPUTextureUsage.RENDER_ATTACHMENT,
        });
        c = { bmp: null, w: w, h: h, tex: tex, bind: bindFor(tex) };
        gpuCache.set(surf.sid, c);
      }
      device.queue.copyExternalImageToTexture({ source: bmp }, { texture: c.tex },
        { width: c.w, height: c.h });
      c.bmp = bmp;
    }
    return c.bind;
  }

  // ---- label textures: title text and the close 'x' rasterized via a
  // throwaway 2D canvas (a texture SOURCE, not scene assembly), uploaded
  // once per distinct string+width and reused every frame.
  var LABEL_FONT = 'bold 11px sans-serif';
  var LABEL_H = 16;   // fits 11px bold with middle baseline at LABEL_H/2
  var labelCanvas = new OffscreenCanvas(8, LABEL_H);
  var labelCtx = labelCanvas.getContext('2d');
  var labels = new Map();   // color|width|text -> { tex, bind, w }
  function labelFor(text, maxW, cssColor) {
    labelCtx.font = LABEL_FONT;   // canvas resizes reset context state
    var w = Math.max(1, Math.min(Math.ceil(labelCtx.measureText(text).width), Math.ceil(maxW)));
    var key = cssColor + '|' + w + '|' + text;
    var c = labels.get(key);
    if (c) return c;
    if (labels.size >= 96) {   // bounded: titles are few; rebuilt next frame
      labels.forEach(function (v) { v.tex.destroy(); });
      labels.clear();
    }
    labelCanvas.width = w; labelCanvas.height = LABEL_H;
    labelCtx.font = LABEL_FONT;
    labelCtx.textBaseline = 'middle';
    labelCtx.fillStyle = cssColor;
    labelCtx.fillText(text, 0, LABEL_H / 2, maxW);   // maxWidth squishes, as before
    var tex = device.createTexture({
      size: { width: w, height: LABEL_H }, format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: labelCanvas }, { texture: tex },
      { width: w, height: LABEL_H });
    c = { tex: tex, bind: bindFor(tex), w: w };
    labels.set(key, c);
    return c;
  }

  // Resize rubber band (todos/0019): Win95 outline semantics — 4-on/4-off
  // hairline dashes (was setLineDash([4,4]) strokeRect), outer 1px ring.
  function dashOutline(x, y, w, h) {
    for (var dx = 0; dx < w; dx += 8) {
      pushQuad(whiteBind, x + dx, y, Math.min(4, w - dx), 1, BLACK);
      pushQuad(whiteBind, x + dx, y + h - 1, Math.min(4, w - dx), 1, BLACK);
    }
    for (var dy = 0; dy < h; dy += 8) {
      pushQuad(whiteBind, x, y + dy, 1, Math.min(4, h - dy), BLACK);
      pushQuad(whiteBind, x + w - 1, y + dy, 1, Math.min(4, h - dy), BLACK);
    }
  }

  function draw() {
    var scene = kernel.wmScene();
    frameW = canvas.width; frameH = canvas.height;
    if (frameW < 1 || frameH < 1) { requestAnimationFrame(draw); return; }
    // Reconfigure on screen-resize (todos/0023) — the canonical dance;
    // resizing the OffscreenCanvas invalidates the swap chain size.
    if (frameW !== confW || frameH !== confH) {
      gctx.configure({ device: device, format: format, alphaMode: 'opaque' });
      confW = frameW; confH = frameH;
    }
    vfloats = 0; runs.length = 0;

    for (var i = 0; i < scene.surfaces.length; i++) {
      var s = scene.surfaces[i];
      if (s.minimized || !s.mapped) continue;  // off screen, still in the scene
                                               // (unmapped: awaiting the WM's
                                               // placement, todos/0069)
      var dw = s.dstW, dh = s.dstH;            // on-screen viewport (todos/0024)
      // Chrome frame first (the resize border sits UNDER title+client),
      // then client pixels; the next window in z covers both — painter's
      // algorithm, exactly the Canvas2D ordering.
      if (!s.borderless) {
        pushQuad(whiteBind, s.x - K.WM_BORDER, s.y - K.WM_TITLE_H - K.WM_BORDER,
          dw + 2 * K.WM_BORDER, K.WM_TITLE_H + dh + 2 * K.WM_BORDER, COL_BORDER);
      }
      pushQuad(s.bitmap ? gpuBindFor(s) : shmBindFor(s), s.x, s.y, dw, dh, WHITE);
      if (s.borderless) continue;              // taskbar-class: bare pixels
      pushQuad(whiteBind, s.x, s.y - K.WM_TITLE_H, dw, K.WM_TITLE_H,
        s.sid === scene.focusSid ? COL_FOCUS : COL_BLUR);
      // Title-bar boxes, Win95 order [min][max][close] (todos/0030) — the
      // same offsets as the kernel hit test and the headless composite;
      // flat-rect glyphs (bar / hollow box) + the rasterized 'x'.
      var bx = s.x + dw - K.WM_CLOSE_W - K.WM_CLOSE_PAD;
      var by = s.y - K.WM_TITLE_H + K.WM_CLOSE_PAD;
      var mxx = bx - K.WM_CLOSE_W - K.WM_BOX_GAP;
      var nxx = mxx - K.WM_CLOSE_W - K.WM_BOX_GAP;
      pushQuad(whiteBind, bx, by, K.WM_CLOSE_W, K.WM_CLOSE_W, COL_CLOSE);
      // Each box only if it fits inside the title — same gate as the
      // kernel hit test and the headless composite.
      if (mxx >= s.x) pushQuad(whiteBind, mxx, by, K.WM_CLOSE_W, K.WM_CLOSE_W, COL_CLOSE);
      if (nxx >= s.x) pushQuad(whiteBind, nxx, by, K.WM_CLOSE_W, K.WM_CLOSE_W, COL_CLOSE);
      if (nxx >= s.x) pushQuad(whiteBind, nxx + 3, by + 11, 8, 2, BLACK);   // min: the bar
      if (mxx >= s.x) {                                                    // max: hollow box
        pushQuad(whiteBind, mxx + 3, by + 3, 10, 2, BLACK);
        pushQuad(whiteBind, mxx + 3, by + 11, 10, 1, BLACK);
        pushQuad(whiteBind, mxx + 3, by + 3, 1, 9, BLACK);
        pushQuad(whiteBind, mxx + 12, by + 3, 1, 9, BLACK);
      }
      var xg = labelFor('x', 32, '#000');
      pushQuad(xg.bind, bx + 5, by + K.WM_CLOSE_W / 2 + 1 - LABEL_H / 2, xg.w, LABEL_H, WHITE);
      var tl = labelFor(s.title || ('pid ' + s.pid),
        Math.max(8, dw - 3 * (K.WM_CLOSE_W + K.WM_BOX_GAP) - 16), '#fff');
      pushQuad(tl.bind, s.x + 6, s.y - K.WM_TITLE_H / 2 - LABEL_H / 2, tl.w, LABEL_H, WHITE);
    }
    // Resize rubber band (todos/0019): the drag only previews; the client
    // renegotiates once, at release.
    if (scene.resizeDrag) {
      for (var r = 0; r < scene.surfaces.length; r++) {
        var rs = scene.surfaces[r];
        if (rs.sid !== scene.resizeDrag.sid) continue;
        dashOutline(rs.x - 1, rs.y - K.WM_TITLE_H - 1,
          scene.resizeDrag.curW + 2, K.WM_TITLE_H + scene.resizeDrag.curH + 2);
        break;
      }
    }
    // Drop caches of destroyed surfaces.
    if (shmCache.size + gpuCache.size > scene.surfaces.length) {
      var live = new Set(scene.surfaces.map(function (s2) { return s2.sid; }));
      [shmCache, gpuCache].forEach(function (cache) {
        cache.forEach(function (v, sid) {
          if (!live.has(sid)) { v.tex.destroy(); cache.delete(sid); }
        });
      });
    }

    var needed = vfloats * 4;
    if (needed > vbufBytes) {
      if (vbuf) vbuf.destroy();
      vbufBytes = Math.max(needed * 2, 65536);
      vbuf = device.createBuffer({ size: vbufBytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (vfloats) device.queue.writeBuffer(vbuf, 0, vdata, 0, vfloats);
    var enc = device.createCommandEncoder();
    var pass = enc.beginRenderPass({
      colorAttachments: [{
        view: gctx.getCurrentTexture().createView(),
        loadOp: 'clear', storeOp: 'store', clearValue: CLEAR_DESKTOP,   // the desktop fill
      }],
    });
    if (vfloats) {
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, vbuf);
      var first = 0;
      for (var q = 0; q < runs.length; q++) {
        pass.setBindGroup(0, runs[q].bind);
        pass.draw(runs[q].quads * 6, 1, first);
        first += runs[q].quads * 6;
      }
    }
    pass.end();
    device.queue.submit([enc.finish()]);
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
