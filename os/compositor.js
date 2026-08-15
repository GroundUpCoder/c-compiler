// compositor.js — the browser half of the kernel compositor (todos/WM.md;
// scene state lives in kernel.js "WM surfaces"). Runs INSIDE the kernel
// worker on the master offscreen canvas transferred from os.html: per rAF it
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

// Textured quads with per-vertex color (the color modulates the sampled
// texel — a 1x1 white texture turns it into a solid fill), plus a per-quad
// rounded-rect SDF (todos/0063, the Aero wave): every vertex carries its
// offset from a MASK rect's center, the mask's half extents, a corner
// radius, and a mode. mode 0 = plain quad (everything pre-0063); mode 1 =
// clip to the rounded mask rect (window frame corners); mode 2 = drop
// shadow (alpha falls off with distance OUTSIDE the mask rect). Same base
// shape as host.js's RENDER_WGSL; alpha-blended source-over.
var COMP_WGSL = `
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f,
            @location(2) local: vec2f, @location(3) mask: vec3f, @location(4) mode: f32 };
@vertex fn vs(@location(0) pos: vec2f, @location(1) uv: vec2f, @location(2) color: vec4f,
              @location(3) rect: vec4f, @location(4) misc: vec2f) -> VO {
  var o: VO;
  o.pos = vec4f(pos, 0.0, 1.0);
  o.uv = uv;
  o.color = color;
  o.local = rect.xy;                 // px offset from the mask rect's center
  o.mask = vec3f(rect.zw, misc.x);   // half extents + corner radius
  o.mode = misc.y;
  return o;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
const SHADOW_EXT: f32 = 14.0;        // shadow reach in px — MUST MATCH the
                                     // quad expansion in the JS below
@fragment fn fs(v: VO) -> @location(0) vec4f {
  var c = textureSample(tex, samp, v.uv) * v.color;
  if (v.mode > 0.5) {
    // Signed distance to the rounded mask rect (negative inside).
    let q = abs(v.local) - (v.mask.xy - vec2f(v.mask.z));
    let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - v.mask.z;
    if (v.mode > 1.5) {              // drop shadow: quadratic falloff
      let t = clamp(1.0 - d / SHADOW_EXT, 0.0, 1.0);
      c.a = c.a * t * t;
    } else {                         // rounded-corner clip, 1px AA edge
      c.a = c.a * clamp(0.5 - d, 0.0, 1.0);
    }
  }
  return c;
}
`;

function startCompositor(kernel, canvas, device) {
  var K = KERNEL;
  // Label text renders via the kernel's ksvc text service (todos/0275) —
  // unreachable in a real boot (kernel-worker hard-failed before us), but
  // the compositor states its requirement: no quiet textless desktop.
  var svc = kernel.textService;
  if (!svc) throw new Error('compositor: kernel has no text service (ksvc)');
  var gctx = canvas.getContext('webgpu');
  if (!gctx) throw new Error('compositor: no webgpu canvas context');
  var format = navigator.gpu.getPreferredCanvasFormat();
  var confW = -1, confH = -1;   // reconfigure on screen-resize (todos/0023)

  // ---- device-derived state: everything here is (re)built by initGpuState,
  // because the device is NOT immortal (#551): Chromium destroys this
  // worker's device when a blocked process worker exhausts its lifetime
  // ImageBitmap-ship budget (~16.7k transfers from a never-yielding worker),
  // and any real GPU reset lands the same way. Loud-by-design (todos/0055)
  // was a BOOT rule; a running OS must survive transient loss — on
  // device.lost we say so loudly, re-acquire, rebuild, and redraw
  // (shm surfaces re-upload from their SABs, gpu surfaces re-import the
  // kernel-held newest bitmap, labels re-rasterize via ksvc).
  var shader, pipeline, sampler, linSampler, whiteTex, whiteBind, blitBuf;
  var deviceLost = false;

  function bindWith(tex, samp) {
    return device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: samp }, { binding: 1, resource: tex.createView() }],
    });
  }
  function bindFor(tex) { return bindWith(tex, sampler); }

  function initGpuState() {
    shader = device.createShaderModule({ code: COMP_WGSL });
    pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shader, entryPoint: 'vs',
        buffers: [{
          arrayStride: 56,   // pos(2) uv(2) color(4) rect(4) misc(2) f32s (0063)
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
            { shaderLocation: 2, offset: 16, format: 'float32x4' },
            { shaderLocation: 3, offset: 32, format: 'float32x4' },
            { shaderLocation: 4, offset: 48, format: 'float32x2' },
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
    // dst-viewport mapping the headless composite uses. The linear sampler
    // is the glass blur chain's workhorse (todos/0063): each bilinear
    // resample is a 2x2 box filter.
    sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    linSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    whiteTex = device.createTexture({
      size: { width: 1, height: 1 }, format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    device.queue.writeTexture({ texture: whiteTex }, new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 }, { width: 1, height: 1 });
    whiteBind = bindFor(whiteTex);
    // The static fullscreen quad the blit/blur passes draw (NDC corners, so
    // it fits any target size).
    blitBuf = device.createBuffer({ size: 6 * 56, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    var bd = new Float32Array(6 * 14);
    var corners = [[-1, 1, 0, 0], [1, 1, 1, 0], [-1, -1, 0, 1],
                   [-1, -1, 0, 1], [1, 1, 1, 0], [1, -1, 1, 1]];
    for (var i = 0; i < 6; i++) {
      var o = i * 14;
      bd[o] = corners[i][0]; bd[o + 1] = corners[i][1];
      bd[o + 2] = corners[i][2]; bd[o + 3] = corners[i][3];
      bd[o + 4] = 1; bd[o + 5] = 1; bd[o + 6] = 1; bd[o + 7] = 1;
    }
    device.queue.writeBuffer(blitBuf, 0, bd);
    // Everything cached against the OLD device is dead: per-surface textures
    // (re-upload from SAB / re-import the held bitmap on the next draw),
    // label textures (re-rasterize), glass chain, the vertex buffer, and the
    // canvas configuration (confW forces a reconfigure in draw()).
    shmCache.clear();
    gpuCache.clear();
    labels.clear();
    glass = null;
    vbuf = null; vbufBytes = 0;
    confW = -1; confH = -1;
  }

  // device.lost -> loud + recover (#551). The guard keeps a stale device's
  // lost (the one we just replaced) from re-triggering recovery.
  function hookLost(dev) {
    dev.lost.then(function (info) {
      if (dev !== device) return;
      var msg = '[compositor] WebGPU device lost: reason=' + ((info && info.reason) || '?') +
                ' ' + ((info && info.message) || 'unknown') + ' — attempting recovery';
      console.error(msg);
      try { self.postMessage({ type: 'boot-log', msg: msg }); } catch (e) {}
      deviceLost = true;
      stats.deviceLosses++;
      recoverDevice();
    });
  }
  function recoverDevice() {
    var attempt = 0;
    var tryOnce = function () {
      attempt++;
      navigator.gpu.requestAdapter().then(function (ad) {
        if (!ad) throw new Error('no WebGPU adapter');
        return ad.requestDevice();
      }).then(function (dev) {
        device = dev;
        hookLost(dev);
        initGpuState();
        lastSig = null;                     // full redraw — every cache is cold
        deviceLost = false;
        stats.recoveries++;
        console.error('[compositor] device recovered (attempt ' + attempt + ')');
        try { self.postMessage({ type: 'boot-log', msg: '[compositor] device recovered' }); } catch (e) {}
        kernel.compSetParked(false);
        armed = true;
        requestAnimationFrame(draw);
      }).catch(function (e) {
        if (attempt < 5) { setTimeout(tryOnce, 300 * attempt); return; }
        var msg = '[compositor] device recovery FAILED after ' + attempt +
                  ' attempts (' + (e && e.message) + ') — desktop is dead';
        console.error(msg);
        try { self.postMessage({ type: 'boot-log', msg: msg }); } catch (e2) {}
      });
    };
    tryOnce();
  }
  hookLost(device);

  var norm = function (c) { return [c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255]; };
  var CLEAR_DESKTOP = { r: K.WM_COLORS.desktop[0] / 255, g: K.WM_COLORS.desktop[1] / 255,
                        b: K.WM_COLORS.desktop[2] / 255, a: 1 };
  var COL_FOCUS = norm(K.WM_COLORS.titleFocused);
  var COL_BLUR = norm(K.WM_COLORS.titleBlurred);
  var COL_CLOSE = norm(K.WM_COLORS.closeBox);
  var COL_BORDER = norm(K.WM_COLORS.border);
  var WHITE = [1, 1, 1, 1];
  var BLACK = [0, 0, 0, 1];
  // Glass-mode title tints (todos/0063): the same focus colors, translucent
  // so the blurred backdrop shows through.
  var COL_FOCUS_GLASS = [COL_FOCUS[0], COL_FOCUS[1], COL_FOCUS[2], 0.55];
  var COL_BLUR_GLASS = [COL_BLUR[0], COL_BLUR[1], COL_BLUR[2], 0.55];

  // ---- per-frame quad batch: one vertex buffer, one draw per contiguous
  // same-texture run (chrome runs batch on the white texture). With glass
  // OFF the whole frame is ONE segment = one render pass, exactly the 0055
  // shape. Glass (todos/0063) splits the frame into segments: a segment
  // whose `blur` flag is set gets the downsample/blur chain run over
  // everything already composited before its quads draw, so its glass
  // chrome samples what is genuinely BEHIND that window.
  var vdata = new Float32Array(14 * 6 * 256);
  var vfloats = 0;
  var segments = [];             // { blur, runs: [{ bind, quads }] }
  var runs = null;               // current segment's runs
  var frameW = 1, frameH = 1;
  var vbuf = null, vbufBytes = 0;   // persistent, grown — never per-frame churn

  function newSegment(blur) {
    runs = [];
    segments.push({ blur: !!blur, runs: runs });
  }

  // opts (all optional): u0/v0/u1/v1 explicit texture coords; mode/radius +
  // mx/my/mw/mh the SDF mask rect (defaults to the quad itself) — see the
  // shader comment. Plain callers just omit opts.
  function pushQuad(bind, x, y, w, h, color, opts) {
    var u0 = 0, v0 = 0, u1 = 1, v1 = 1, mode = 0, radius = 0;
    var mx = x, my = y, mw = w, mh = h;
    if (opts) {
      if (opts.u0 !== undefined) { u0 = opts.u0; v0 = opts.v0; u1 = opts.u1; v1 = opts.v1; }
      mode = opts.mode || 0;
      radius = opts.radius || 0;
      if (opts.mx !== undefined) { mx = opts.mx; my = opts.my; mw = opts.mw; mh = opts.mh; }
    }
    if (vfloats + 84 > vdata.length) {
      var nd = new Float32Array(vdata.length * 2);
      nd.set(vdata.subarray(0, vfloats));
      vdata = nd;
    }
    var cx = mx + mw / 2, cy = my + mh / 2, hw = mw / 2, hh = mh / 2;
    var n = vfloats, d = vdata;
    var vert = function (sx, sy, pu, pv) {
      d[n] = sx / frameW * 2 - 1; d[n + 1] = 1 - sy / frameH * 2;
      d[n + 2] = pu; d[n + 3] = pv;
      d[n + 4] = color[0]; d[n + 5] = color[1]; d[n + 6] = color[2]; d[n + 7] = color[3];
      d[n + 8] = sx - cx; d[n + 9] = sy - cy;
      d[n + 10] = hw; d[n + 11] = hh;
      d[n + 12] = radius; d[n + 13] = mode;
      n += 14;
    };
    vert(x, y, u0, v0); vert(x + w, y, u1, v0); vert(x, y + h, u0, v1);
    vert(x, y + h, u0, v1); vert(x + w, y, u1, v0); vert(x + w, y + h, u1, v1);
    vfloats = n;
    var last = runs.length ? runs[runs.length - 1] : null;
    if (last && last.bind === bind) last.quads++;
    else runs.push({ bind: bind, quads: 1 });
  }

  // ---- Aero chrome constants (todos/0063) ----
  var OV_CAPTION_H = 24;                    // overview caption strip per row —
                                           // MUST MATCH wm.c OV_CAPTION_H so the
                                           // browser caption lands in the space
                                           // the layout reserved (todos/EXPOSE)
  var CORNER_R = 7;                        // frame corner radius, px
  var SHADOW_EXT = 14;                     // MUST MATCH the shader constant
  var SHADOW_DY = 3;                       // shadow drop below the frame
  var SHADOW_FOCUS = [0, 0, 0, 0.5];       // focused window: deeper shadow
  var SHADOW_BLUR = [0, 0, 0, 0.3];
  var GLASS_TINT = [0.75, 0.8, 0.86, 0.5]; // whitish Aero frame tint

  // ---- glass render targets (todos/0063), created on first use and on
  // resize: the scene composites into sceneTex; the blur chain is three
  // bilinear downsamples + one upsample (scene -> 1/2 -> 1/4 -> 1/8 -> 1/4),
  // each a fullscreen blit — every resample is a 2x2 box filter, so glass
  // chrome samples a ~cheap-Kawase blur of what's behind it.
  var glass = null;   // { w, h, scene, sceneView, sceneBlit, texes, views, linBinds }
  function makeTarget(w, h) {
    return device.createTexture({
      size: { width: Math.max(1, w), height: Math.max(1, h) }, format: format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }
  function ensureGlassTargets() {
    if (glass && glass.w === frameW && glass.h === frameH) return glass;
    if (glass) glass.all.forEach(function (t) { t.destroy(); });
    var scene = makeTarget(frameW, frameH);
    var half = makeTarget(frameW >> 1, frameH >> 1);
    var quarter = makeTarget(frameW >> 2, frameH >> 2);
    var eighth = makeTarget(frameW >> 3, frameH >> 3);
    glass = {
      w: frameW, h: frameH,
      all: [scene, half, quarter, eighth],
      sceneView: scene.createView(),
      halfView: half.createView(), quarterView: quarter.createView(),
      eighthView: eighth.createView(),
      sceneBlit: bindFor(scene),               // final 1:1 blit to the canvas
      sceneLin: bindWith(scene, linSampler),
      halfLin: bindWith(half, linSampler),
      quarterLin: bindWith(quarter, linSampler),   // what glass chrome samples
      eighthLin: bindWith(eighth, linSampler),
    };
    return glass;
  }
  function blitPass(enc, view, bind) {
    var p = enc.beginRenderPass({
      colorAttachments: [{ view: view, loadOp: 'clear', storeOp: 'store',
                           clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    p.setPipeline(pipeline);
    p.setVertexBuffer(0, blitBuf);
    p.setBindGroup(0, bind);
    p.draw(6);
    p.end();
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

  // ---- label textures: title text, the close 'x' and Exposé captions
  // rasterized by the kernel's ksvc text service (todos/0275 — OUR
  // FreeType/fontchain stack; the Canvas2D path is DELETED, not gated),
  // uploaded via writeTexture once per distinct string+width and reused
  // every frame. Straight-alpha bytes + the pipeline's src-alpha blend =
  // correct output; heights come from the render header (~28 at 20px, the
  // v133 rhythm). Placement contract: quad y = centerY - h/2, matching
  // kernel.js _blitLabel — the two composites place text identically.
  var LABEL_PX = K.WM_LABEL_PX;              // 20 — the ONE shared constant
  var labels = new Map();   // rgba|width|text -> { tex, bind, w, h }
  function labelFor(text, maxW, rgba) {
    // measure-first key: a short title doesn't churn the cache as maxW
    // slides during a resize drag (sub-ms warm-cache wasm call).
    var w = Math.max(1, Math.min(svc.measure(text, LABEL_PX, 1), Math.ceil(maxW)));
    var key = rgba + '|' + w + '|' + text;
    var c = labels.get(key);
    if (c) return c;
    if (labels.size >= 96) {   // bounded: titles are few; rebuilt next frame
      labels.forEach(function (v) { v.tex.destroy(); });
      labels.clear();
    }
    var r = svc.render(text, LABEL_PX, Math.ceil(maxW), rgba, 1 /* bold */);
    var tex = device.createTexture({
      size: { width: Math.max(1, r.w), height: r.h }, format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    if (r.w) device.queue.writeTexture({ texture: tex }, r.bytes,
      { bytesPerRow: r.w * 4 }, { width: r.w, height: r.h });
    c = { tex: tex, bind: bindFor(tex), w: r.w, h: r.h };
    labels.set(key, c);
    return c;
  }

  // Where a minimizing window flies to (todos/0063): a slab at the bottom
  // edge under the window's center — the taskbar strip, without needing to
  // know the WM's button layout. k in [0,1] walks start -> target.
  function animRect(a, k) {
    var cx = Math.max(32, Math.min(a.x + a.w / 2, frameW - 32));
    var tx = cx - 24, ty = frameH - 22, tw = 48, th = 14;
    return { x: a.x + (tx - a.x) * k, y: a.y + (ty - a.y) * k,
             w: a.w + (tw - a.w) * k, h: a.h + (th - a.h) * k };
  }

  // Linear interpolate a rect (todos/EXPOSE enter/exit flies) — k in [0,1].
  function lerpRect(x0, y0, w0, h0, x1, y1, w1, h1, k) {
    return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k,
             w: w0 + (w1 - w0) * k, h: h0 + (h1 - h0) * k };
  }

  // Overview / Exposé pass (todos/EXPOSE-MISSION-CONTROL.md): live seq-gated
  // miniatures at the WM's cell rects — each a drop shadow + rounded border
  // (the 0063 SDF chrome) under the surface's OWN texture quad (shmBindFor/
  // gpuBindFor unchanged, so gpu apps miniature LIVE, not black), a caption
  // under the cell, and a navy highlight border on the hovered cell. Minimized
  // windows draw their still-live buffers like any other. The enter fly
  // (forward records) interpolates each miniature from its window's real rect.
  function drawOverview(scene, now) {
    var ov = scene.overview;
    var flying = scene.overviewAnims && scene.overviewAnims.length &&
                 !scene.overviewAnims[0].reverse;
    for (var i = 0; i < ov.cells.length; i++) {
      var c = ov.cells[i];
      var s = surfById(scene, c.sid);
      if (!s) continue;
      var rect = { x: c.x, y: c.y, w: c.w, h: c.h };
      if (flying) {
        for (var a = 0; a < scene.overviewAnims.length; a++) {
          var an = scene.overviewAnims[a];
          if (an.sid !== c.sid) continue;
          var lin = (now - an.t0) / K.WM_ANIM_MS;
          if (lin >= 0 && lin < 1) {
            var k = 1 - (1 - lin) * (1 - lin);   // ease-out, real -> cell
            rect = lerpRect(an.rx, an.ry, an.rw, an.rh, an.cx, an.cy, an.cw, an.ch, k);
          }
          break;
        }
      }
      var hov = c.sid === ov.hoverSid;
      pushQuad(whiteBind, rect.x - SHADOW_EXT, rect.y + SHADOW_DY - SHADOW_EXT,
        rect.w + 2 * SHADOW_EXT, rect.h + 2 * SHADOW_EXT, SHADOW_BLUR,
        { mode: 2, radius: CORNER_R, mx: rect.x, my: rect.y + SHADOW_DY,
          mw: rect.w, mh: rect.h });
      var B = 3;
      pushQuad(whiteBind, rect.x - B, rect.y - B, rect.w + 2 * B, rect.h + 2 * B,
        hov ? COL_FOCUS : COL_BORDER, { mode: 1, radius: CORNER_R });
      pushQuad(s.bitmap ? gpuBindFor(s) : shmBindFor(s),
               rect.x, rect.y, rect.w, rect.h, WHITE);
      // Caption in the reserved strip under the SETTLED cell — same text +
      // geometry as the headless composite's _blitLabel (todos/0275).
      var cap = labelFor(s.title || ('pid ' + s.pid), Math.max(8, c.w), 0xFFFFFFFF);
      pushQuad(cap.bind, c.x + (c.w - cap.w) / 2, c.y + c.h + 2, cap.w, cap.h, WHITE);
    }
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

  // ---- on-demand compositing (todos/0169, IDLE-POWER pieces A+B; absorbs
  // the reverted 0160 damage skip). The compositor used to run one full
  // WebGPU pass every rAF forever. Now each frame computes DIRTY = (scene
  // signature changed) OR (a minimize/restore fly anim is active); a clean
  // frame skips the submit, and once nothing needs the frame CLOCK either
  // (no pcb wantFrame pin, no vsync waiter — kernel.compKeepAlive) and a
  // short GRACE coast has drained, the rAF itself parks: zero ticks, zero
  // submits, zero app-worker wakeups on a settled screen.
  //
  // The signature folds in what `scene.version` (kernel _wmVersion) does
  // NOT cover: canvas size, active-anim count, and each drawn surface's
  // PIXEL content (shm SH_SEQ / gpu bitmap identity — presents bump
  // neither version nor geometry). When unsure we submit: a stale frame is
  // the classic damage bug; a redundant submit is merely wasted.
  //
  // Parking is safe because every wake source rings back in (the
  // IDLE-POWER wake table): _bumpWm routes ALL version bumps through
  // scheduleFrame (kernel.wmOnDamage below); gpu presents already message
  // the kernel (_wmFrame arms); shm presents and vsync arms re-read the
  // per-pcb KP_COMP_PARKED word host-side and post want-frame (the Dekker
  // pair — compSetParked stores PARKED on every page FIRST, then this
  // park re-reads every ARMED/wantFrame/seq, so a racing waiter or present
  // is either seen here or sees the flag and rings). GRACE is an armed-
  // frame counter, not wall-clock (it suspends cleanly with a stopped
  // rAF), and an optimization only — correctness holds at GRACE=0.
  //
  // `frozen` is the synthetic vsync-stop test probe (os-compositor.mjs):
  // Playwright cannot really hide a tab (background throttling is
  // disabled), so the hidden-tab honest pause is asserted by freezing the
  // clock and watching the wake counters go flat.
  var stats = { frames: 0, submits: 0, skipped: 0, parks: 0, wakes: 0,
                deviceLosses: 0, recoveries: 0 };   // #551 recovery accounting
  self.__compositorStats = stats;   // test probe (tests/browser/os-compositor.mjs)
  initGpuState();                   // first build of the device-derived state
  var lastSig = null;
  var armed = true;                 // the boot rAF at the bottom
  var frozen = false;
  var GRACE_FRAMES = 3;             // clean frames to coast before parking
  var grace = 0;

  function sceneSignature(scene) {
    var sig = [scene.version, frameW, frameH, scene.anims.length];
    // Overview (todos/EXPOSE): fold its identity + hover + live-miniature
    // pixels (INCLUDING minimized windows, which the normal loop skips but the
    // overview draws) and the active enter/exit fly count so the anim ticks.
    if (scene.overview) {
      sig.push('ov', scene.overview.hoverSid | 0, scene.overview.cells.length);
      for (var oi = 0; oi < scene.overview.cells.length; oi++) {
        var oc = scene.overview.cells[oi];
        var osf = surfById(scene, oc.sid);
        sig.push(oc.sid, oc.x, oc.y, oc.w, oc.h,
          osf ? (osf.bitmap ? osf.bitmap : Atomics.load(osf.i32, K.SH_SEQ)) : 0);
      }
    }
    if (scene.overviewAnims && scene.overviewAnims.length)
      sig.push('ova', scene.overviewAnims.length, scene.overviewAnims[0].t0);
    for (var i = 0; i < scene.surfaces.length; i++) {
      var s = scene.surfaces[i];
      if (!s.mapped || s.minimized) continue;   // not sampled this frame
      // gpu: the ImageBitmap identity (=== compares by ref); shm: the
      // frameSeq the seq-gated upload already reads.
      sig.push(s.sid, s.bitmap ? s.bitmap : Atomics.load(s.i32, K.SH_SEQ));
    }
    return sig;
  }
  function surfById(scene, sid) {
    for (var i = 0; i < scene.surfaces.length; i++)
      if (scene.surfaces[i].sid === sid) return scene.surfaces[i];
    return null;
  }
  function sigEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Re-arm the parked rAF — the single wake entry point: kernel damage
  // (wmOnDamage), want-frame doorbells, and the kernel-worker's raw input/
  // resize/drop handlers all land here. No-op while armed or frozen.
  function scheduleFrame() {
    if (frozen || armed || deviceLost) return;   // recovery re-arms itself (#551)
    armed = true;
    stats.wakes++;
    kernel.compSetParked(false);
    requestAnimationFrame(draw);
  }

  // Synthetic vsync-stop (test-only, the hidden-tab stand-in): stop the
  // clock — the next draw() drops its rAF without ticking, exactly what a
  // really-hidden tab does to us.
  function setFrozen(on) {
    frozen = !!on;
    if (!frozen) { armed = false; scheduleFrame(); }
  }

  // Park decision, from the post-prune scene of the frame just drawn or
  // skipped: coast out the GRACE, keep armed while anyone needs the clock,
  // else Dekker store-then-check and stop the rAF chain.
  function maybePark() {
    if (grace > 0 || kernel.compKeepAlive()) { requestAnimationFrame(draw); return; }
    kernel.compSetParked(true);
    if (kernel.compKeepAlive() ||
        !sigEqual(sceneSignature(kernel.wmScene()), lastSig)) {
      kernel.compSetParked(false);        // a waiter/present raced in: stay armed
      requestAnimationFrame(draw);
      return;
    }
    armed = false;
    stats.parks++;
  }

  function draw() {
    if (frozen) { armed = false; return; }   // synthetic vsync-stop (probe)
    // Device lost (#551): stop the rAF chain AND the vsync clock (an honest
    // pause, like a hidden tab) until recoverDevice re-arms us.
    if (deviceLost) { armed = false; return; }
    // Vsync broadcast (todos/0100): this rAF IS the system frame clock —
    // tick before anything can early-return, so SDL frame loops stay paced
    // even on degenerate-canvas frames. Presents made while we render land
    // in the next wmScene sample, exactly one composite behind.
    kernel.vsyncTick();
    var scene = kernel.wmScene();
    frameW = canvas.width; frameH = canvas.height;
    if (frameW < 1 || frameH < 1) { requestAnimationFrame(draw); return; }
    stats.frames++;
    // Damage skip: identical scene and no active animation — keep ticking
    // (or park via maybePark), but don't re-submit the pass.
    var sig = sceneSignature(scene);
    var ovAnimActive = scene.overviewAnims && scene.overviewAnims.length &&
                       (Date.now() - scene.overviewAnims[0].t0) < K.WM_ANIM_MS;
    if (lastSig !== null && scene.anims.length === 0 && !ovAnimActive &&
        sigEqual(sig, lastSig)) {
      stats.skipped++;
      if (grace > 0) grace--;
      maybePark();
      return;
    }
    lastSig = sig;
    grace = GRACE_FRAMES;
    // Reconfigure on screen-resize (todos/0023) — the canonical dance;
    // resizing the offscreen canvas invalidates the swap chain size.
    if (frameW !== confW || frameH !== confH) {
      gctx.configure({ device: device, format: format, alphaMode: 'opaque' });
      confW = frameW; confH = frameH;
    }
    vfloats = 0; segments.length = 0; newSegment(false);
    var now = Date.now();   // anim clock — the epoch the kernel stamps t0 with

    // Overview / Exposé (todos/EXPOSE-MISSION-CONTROL.md): a full presentation
    // takeover — the normal surface loop is replaced by the overview pass
    // (live seq-gated miniatures at the WM's cell rects). The exit fly runs on
    // the normal path (overview already cleared) as an overlay below.
    if (scene.overview) drawOverview(scene, now);
    else {
    for (var i = 0; i < scene.surfaces.length; i++) {
      var s = scene.surfaces[i];
      // Minimize/restore animation (todos/0063): a transient kernel record;
      // the content flies to/from the taskbar strip and fades — a 200ms
      // flourish drawn WITHOUT chrome, never hit-testable (the kernel's
      // minimized/hit-test state is already final). An anchored child
      // resolves its ROOT's record (animRootSid, the kernel-computed group
      // fly linkage) so the whole subtree rides one fly as a rigid group.
      var animKey = s.animRootSid || s.sid;
      var anim = null, ak = 0;
      for (var an = 0; an < scene.anims.length; an++)
        if (scene.anims[an].sid === animKey) { anim = scene.anims[an]; break; }
      if (anim) {
        var lin = (now - anim.t0) / K.WM_ANIM_MS;
        if (lin >= 1 || lin < 0) anim = null;
        else ak = 1 - (1 - lin) * (1 - lin);   // ease-out
      }
      // Group fly (the ONE anchor exception, see kernel wmScene): while the
      // root's fly is live, draw the child ONLY as a quad inside the root's
      // interpolated rect — its stored x/y is the settled position, so an
      // ungated draw would park the bar detached at the destination for the
      // whole fly (the pre-fix restore pop). The anim record carries the
      // root's transition geometry (x/y/w/h), so the child maps into the
      // flying rect by plain proportional transform, same fade as the root.
      if (s.parentSid && s.animRootSid) {
        if (anim) {
          var gk = anim.kind === 'min' ? ak : 1 - ak;
          var gr = animRect(anim, gk);
          pushQuad(s.bitmap ? gpuBindFor(s) : shmBindFor(s),
                   gr.x + (s.x - anim.x) * gr.w / anim.w,
                   gr.y + (s.y - anim.y) * gr.h / anim.h,
                   s.dstW * gr.w / anim.w, s.dstH * gr.h / anim.h,
                   [1, 1, 1, anim.kind === 'min' ? 1 - ak : ak]);
          continue;
        }
        // Fly expired between the kernel's prune and this frame: a still-
        // minimized root means the child is about to leave the scene —
        // draw nothing; a restored root falls through to the normal path.
        var groot = surfById(scene, s.animRootSid);
        if (groot && groot.minimized) continue;
      }
      if (s.minimized) {                       // off screen, still in the scene
        if (anim && anim.kind === 'min') {
          var mr = animRect(anim, ak);
          pushQuad(s.bitmap ? gpuBindFor(s) : shmBindFor(s), mr.x, mr.y, mr.w, mr.h,
                   [1, 1, 1, 1 - ak]);
        }
        continue;
      }
      if (!s.mapped) continue;                 // awaiting the WM's placement
                                               // (todos/0069)
      if (anim && anim.kind === 'restore') {   // fly back out of the bar
        var rr = animRect(anim, 1 - ak);
        pushQuad(s.bitmap ? gpuBindFor(s) : shmBindFor(s), rr.x, rr.y, rr.w, rr.h,
                 [1, 1, 1, ak]);
        continue;                              // chrome lands with the anim
      }
      var dw = s.dstW, dh = s.dstH;            // on-screen viewport (todos/0024)
      var focused = s.sid === scene.focusSid;
      // Chrome frame first (the resize border sits UNDER title+client),
      // then client pixels; the next window in z covers both — painter's
      // algorithm, exactly the Canvas2D ordering. Since 0063 the frame is a
      // rounded-corner SDF quad over a drop shadow; in glass mode it is the
      // blurred backdrop + tint instead of the flat face gray.
      if (!s.borderless) {
        var fx = s.x - K.WM_BORDER, fy = s.y - K.WM_TITLE_H - K.WM_BORDER;
        var fw = dw + 2 * K.WM_BORDER, fh = K.WM_TITLE_H + dh + 2 * K.WM_BORDER;
        pushQuad(whiteBind, fx - SHADOW_EXT, fy + SHADOW_DY - SHADOW_EXT,
          fw + 2 * SHADOW_EXT, fh + 2 * SHADOW_EXT,
          focused ? SHADOW_FOCUS : SHADOW_BLUR,
          { mode: 2, radius: CORNER_R, mx: fx, my: fy + SHADOW_DY, mw: fw, mh: fh });
        if (scene.glass) {
          // Glass (todos/0063): blur everything composited so far (= what
          // is below this window), then draw the frame sampling it.
          var gt = ensureGlassTargets();
          newSegment(true);
          pushQuad(gt.quarterLin, fx, fy, fw, fh, WHITE,
            { mode: 1, radius: CORNER_R, u0: fx / frameW, v0: fy / frameH,
              u1: (fx + fw) / frameW, v1: (fy + fh) / frameH });
          pushQuad(whiteBind, fx, fy, fw, fh, GLASS_TINT, { mode: 1, radius: CORNER_R });
        } else {
          pushQuad(whiteBind, fx, fy, fw, fh, COL_BORDER, { mode: 1, radius: CORNER_R });
        }
      }
      pushQuad(s.bitmap ? gpuBindFor(s) : shmBindFor(s), s.x, s.y, dw, dh, WHITE);
      if (s.borderless) continue;              // taskbar-class: bare pixels
      pushQuad(whiteBind, s.x, s.y - K.WM_TITLE_H, dw, K.WM_TITLE_H,
        scene.glass ? (focused ? COL_FOCUS_GLASS : COL_BLUR_GLASS)
                    : (focused ? COL_FOCUS : COL_BLUR));
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
      if (nxx >= s.x) pushQuad(whiteBind, nxx + 4, by + 14, 10, 2, BLACK);  // min: the bar
      if (mxx >= s.x) {                                                    // max: hollow box
        pushQuad(whiteBind, mxx + 4, by + 4, 12, 2, BLACK);
        pushQuad(whiteBind, mxx + 4, by + 14, 12, 1, BLACK);
        pushQuad(whiteBind, mxx + 4, by + 4, 1, 11, BLACK);
        pushQuad(whiteBind, mxx + 15, by + 4, 1, 11, BLACK);
      }
      var xg = labelFor('x', 32, 0x000000FF);
      pushQuad(xg.bind, bx + 5, by + K.WM_CLOSE_W / 2 + 1 - xg.h / 2, xg.w, xg.h, WHITE);
      var tl = labelFor(s.title || ('pid ' + s.pid),
        Math.max(8, dw - 3 * (K.WM_CLOSE_W + K.WM_BOX_GAP) - 16), 0xFFFFFFFF);
      pushQuad(tl.bind, s.x + 6, s.y - K.WM_TITLE_H / 2 - tl.h / 2, tl.w, tl.h, WHITE);
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
    // Overview EXIT fly (todos/EXPOSE): overview is already cleared (windows
    // drawn normally above), so overlay each reverse fly — the miniature
    // shrinking back out of its cell into the window — as a fading scaled quad.
    if (scene.overviewAnims && scene.overviewAnims.length &&
        scene.overviewAnims[0].reverse) {
      for (var xa = 0; xa < scene.overviewAnims.length; xa++) {
        var xan = scene.overviewAnims[xa];
        var xlin = (now - xan.t0) / K.WM_ANIM_MS;
        if (xlin < 0 || xlin >= 1) continue;
        var xk = 1 - (1 - xlin) * (1 - xlin);   // ease-out, cell -> real
        var xs = surfById(scene, xan.sid);
        if (!xs) continue;
        var xr = lerpRect(xan.cx, xan.cy, xan.cw, xan.ch,
                          xan.rx, xan.ry, xan.rw, xan.rh, xk);
        pushQuad(xs.bitmap ? gpuBindFor(xs) : shmBindFor(xs),
                 xr.x, xr.y, xr.w, xr.h, [1, 1, 1, 1 - xk]);
      }
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
    var canvasView = gctx.getCurrentTexture().createView();
    var first = 0;   // running vertex offset — segments share the one vbuf
    var drawSegment = function (pass, seg) {
      if (!seg.runs.length) return;
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, vbuf);
      for (var q = 0; q < seg.runs.length; q++) {
        pass.setBindGroup(0, seg.runs[q].bind);
        pass.draw(seg.runs[q].quads * 6, 1, first);
        first += seg.runs[q].quads * 6;
      }
    };
    if (segments.length === 1) {
      // No glass chrome this frame: ONE pass straight to the canvas — the
      // 0055 shape, byte-for-byte the pre-0063 fast path.
      var pass = enc.beginRenderPass({
        colorAttachments: [{
          view: canvasView,
          loadOp: 'clear', storeOp: 'store', clearValue: CLEAR_DESKTOP,   // the desktop fill
        }],
      });
      drawSegment(pass, segments[0]);
      pass.end();
    } else {
      // Glass (todos/0063): composite into sceneTex segment by segment;
      // before a blur segment's quads draw, run the downsample chain over
      // what's already there — its glass chrome then samples exactly the
      // content below that window. One final 1:1 blit presents the scene.
      var gt2 = ensureGlassTargets();
      for (var si = 0; si < segments.length; si++) {
        if (segments[si].blur) {
          blitPass(enc, gt2.halfView, gt2.sceneLin);
          blitPass(enc, gt2.quarterView, gt2.halfLin);
          blitPass(enc, gt2.eighthView, gt2.quarterLin);
          blitPass(enc, gt2.quarterView, gt2.eighthLin);   // up: softens
        }
        var sp = enc.beginRenderPass({
          colorAttachments: [{
            view: gt2.sceneView, loadOp: si === 0 ? 'clear' : 'load',
            storeOp: 'store', clearValue: CLEAR_DESKTOP,
          }],
        });
        drawSegment(sp, segments[si]);
        sp.end();
      }
      blitPass(enc, canvasView, gt2.sceneBlit);
    }
    device.queue.submit([enc.finish()]);
    stats.submits++;
    requestAnimationFrame(draw);   // a dirty frame always re-arms (GRACE fresh)
  }
  // Every kernel-side scene change (all _bumpWm sites, gpu presents,
  // want-frame doorbells) re-arms the parked rAF through this hook.
  kernel.wmOnDamage(scheduleFrame);
  requestAnimationFrame(draw);
  return { scheduleFrame: scheduleFrame, setFrozen: setFrozen, stats: stats,
           // Test hook (#551, tests/browser/os-devloss.mjs): destroy the live
           // device — fires the REAL lost path, recovery included.
           killDevice: function () { try { device.destroy(); } catch (e) {} } };
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
    // SDL wheel units are NOTCHES (±1 per detent), not pixels — consumers
    // scale by WHEEL_DELTA (user32) or count events. Convert DOM deltas per
    // mode: pixels ~100/notch (Chrome), lines 3/notch, pages ~3 notches.
    var notch = ev.deltaMode === 1 ? 1 / 3 : ev.deltaMode === 2 ? 3 : 1 / 100;
    kernel.wmPointer('wheel', ev.x, ev.y,
      { wheelX: ev.deltaX * notch, wheelY: -ev.deltaY * notch, direction: 0 });
  } else if (ev.kind === 'padconn') {
    // Gamepads (#607): os.html's Gamepad API poller already diffed and
    // SDL-mapped (W3C standard mapping -> SDL button/axis ids); these are
    // real user input, so opts.user stamps the kernel idle clock.
    kernel.padConnect(ev.slot | 0, ev.name, { user: true });
  } else if (ev.kind === 'paddis') {
    kernel.padDisconnect(ev.slot | 0);
  } else if (ev.kind === 'padbtn') {
    kernel.padButton(ev.slot | 0, ev.btn | 0, !!ev.down, { user: true });
  } else if (ev.kind === 'padaxis') {
    kernel.padAxis(ev.slot | 0, ev.axis | 0, ev.v | 0, { user: true });
  }
}

if (typeof self !== 'undefined') {
  self.OS_COMPOSITOR = { startCompositor: startCompositor, routeInput: routeInput };
}
