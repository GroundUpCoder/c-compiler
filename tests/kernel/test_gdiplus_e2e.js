#!/usr/bin/env node
// gdiplus-mini acceptance, headless (ticket #94 / 0453): the flat GDI+
// shim (os/win32/gdiplus.c + include/gdiplusflat.h) derived from ReactOS
// shimgvw @ e3e58ac1, driven in a booted OS through
// `/usr/bin/gdiplusdemo selftest` (os/win32/gdiplusdemo.c — the gdidemo
// selftest pattern: memory DCs, no window, printf).
//
// What this file adds ON TOP of the in-OS selftest's own asserts:
//
//   1. THE COUNT IS PINNED. The selftest prints "N/N PASS"; this asserts
//      N is EXACTLY the expected number. A suite that silently loses legs
//      still prints PASS — pinning is what makes a shrink visible. Raise
//      the pin deliberately when you add legs.
//   2. NAMED LEGS, not just the total. The acceptance arms that are most
//      worth faking (a per-format decode, its can-fail control, the
//      non-1:1 draw) are asserted BY NAME, so "PASS" cannot come from a
//      suite that skipped them.
//   3. THE LOUD PATH IS REALLY LOUD. Arm 2 says an unimplemented thing
//      must never look like success. The selftest proves the STATUS is an
//      error; this proves the DIAGNOSTIC reached stderr — the two halves
//      of WIN32_UNSUPPORTED.
//   4. THE SAVE PATH TOUCHED THE REAL FILESYSTEM. GdipSaveImageToFile's
//      round-trip is asserted in-process by the selftest; here the files
//      are stat'd from the shell, so an encoder that "succeeded" without
//      writing anything is caught.
//
// Run: node tests/kernel/test_gdiplus_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// Pin: os/win32/gdiplusdemo.c's check() calls. Bump WITH the source.
const EXPECT_CHECKS = 123;

const { image } = freshImage('os-gdiplus-');

const script = [
  // stderr to a file then cat, the gdi32/user32 e2e pattern: app stderr
  // does not reliably interleave into the piped tty stream.
  'cd /root',
  'gdiplusdemo selftest 2>/tmp/gp.err',
  'echo SELFTEST-EXIT=$?',
  'echo ==stderr-begin',
  'cat /tmp/gp.err',
  'echo ==stderr-end',
  // The save round trip must have left real bytes on the real fs.
  'echo ==files',
  'ls -l /root/gdiplus-rt.png /root/gdiplus-rt.bmp /root/gdiplus-in.png',
  'echo ==done',
  'exit',
].join('\n');

const r = driveBoot(script, { image, timeout: 600000 });
const out = r.stdout || '';
const lines = out.split('\n');

check('session exits clean', r.status === 0,
  String(r.status) + ' ' + (r.stderr || '').slice(-300));
check('selftest exit 0', lines.includes('SELFTEST-EXIT=0'),
  JSON.stringify(lines.filter(l => l.startsWith('SELFTEST-EXIT')).slice(0, 2)));

// --- 1. the pinned total ---------------------------------------------
const verdict = lines.find(l => l.startsWith('GDIPLUS-SELFTEST:'));
check('selftest reports PASS', !!verdict && / PASS$/.test(verdict.trim()),
  JSON.stringify(verdict) + ' ' + JSON.stringify(lines.filter(l => l.startsWith('FAIL ')).slice(0, 12)));
check(`selftest ran EXACTLY ${EXPECT_CHECKS} checks (a shrink is a regression)`,
  !!verdict && verdict.trim() === `GDIPLUS-SELFTEST: ${EXPECT_CHECKS}/${EXPECT_CHECKS} PASS`,
  JSON.stringify(verdict));

// --- 2. the arms, by name --------------------------------------------
const ok = new Set(lines.filter(l => l.startsWith('ok ')).map(l => l.slice(3).trim()));
function arm(label, names) {
  const missing = names.filter(n => !ok.has(n));
  check(label, missing.length === 0, 'missing: ' + JSON.stringify(missing));
}

// arm 3 — decode proven per format, each with its can-fail control.
arm('arm3 PNG decodes through the shim (pixels + alpha flags) and CAN FAIL',
  ['png_load', 'png_width', 'png_height', 'png_rawformat', 'png_flags_alpha',
   'png_pixels', 'png_corrupt_rejected']);
arm('arm3 BMP decodes through the shim (bottom-up flipped) and CAN FAIL',
  ['bmp_load', 'bmp_rawformat', 'bmp_pixels_bottom_up_flipped',
   'bmp_truncated_rejected']);
// A 24bpp BMP has no alpha mask and must not claim one: a viewer reads
// exactly these bits to decide whether to paint a checkerboard behind it.
arm('a 24bpp BMP reports NO alpha (not a blanket HasAlpha)',
  ['bmp24_reports_no_alpha']);
arm('arm3 JPEG decodes through the shim and CAN FAIL (longjmp error manager)',
  ['jpeg_load', 'jpeg_rawformat', 'jpeg_top_block', 'jpeg_bottom_block',
   'jpeg_corrupt_rejected']);
arm('arm3 GIF decodes through the shim (both frames + delays + loop) and CAN FAIL',
  ['gif_load', 'gif_rawformat', 'gif_framecount', 'gif_frame0_pixels',
   'gif_select_frame1', 'gif_frame1_pixels', 'gif_framedelay_item',
   'gif_loopcount_item', 'gif_truncated_header_rejected']);

// arm 4 — the draw path at a non-1:1 scale; the mode under test is NEAREST.
arm('arm4 the 2x NEAREST draw is exact, every destination pixel asserted',
  ['draw2x_interp', 'draw2x_draw', 'draw2x_nearest_blocks_exact',
   'draw2x_subrect_exact', 'draw_halfpixel_origin_exact']);
// A source rect outside the image would need a wrap-mode fill that does
// not exist; StretchBlt would silently skip those pixels and the call
// would still return Ok. It must refuse instead.
arm('an out-of-bounds source rect is REFUSED, not silently part-drawn',
  ['draw_src_overruns_image_refused', 'draw_src_negative_origin_refused',
   'draw_src_out_of_bounds_refused_without_attrs']);
// A non-nearest mode is accepted (recording state is a setter's contract)
// and the draw succeeds, but the RESULT is the documented nearest one.
arm('a non-nearest interpolation mode is accepted and drawn nearest, provably',
  ['interp_bilinear_accepted', 'interp_bilinear_draw_ok',
   'interp_bilinear_is_really_nearest']);
// RotateFlip turns EVERY frame or none: a per-frame commit that gave up
// partway would leave frames disagreeing with the image's own dimensions.
arm('RotateFlip turns every frame of an animation, at the new extent',
  ['gif_rotate90', 'gif_rotate90_dims', 'gif_rotate90_frame0_pixels',
   'gif_rotate90_frame1_pixels', 'gif_rotate_back']);

// arm 2 — the fail-loud refusals, and the frame/codec surface behind them.
arm('arm2 unsupported requests return a real error status',
  ['pre_startup_refused', 'startup_bad_version_refused', 'save_jpeg_refused',
   'save_encoderparams_refused', 'draw_nonpixel_unit_refused',
   'draw_abort_callback_refused', 'unknown_signature_refused',
   'gif_wrong_dimension_refused', 'rotate_bad_type_refused',
   'encoders_short_buffer_refused']);
arm('rotate/flip is a pixel loop (StretchBlt refuses mirroring extents)',
  ['rotate90_pixels', 'rotate_roundtrip_pixels', 'flipx_pixels']);
arm('the static codec tables and the save round trips',
  ['encoders_bmp_and_png', 'decoders_all_four_formats', 'save_png_pixels',
   'save_bmp_pixels', 'loadfromfile_png']);
arm('the ole32 memory IStream the loader path rides on',
  ['stream_stat', 'stream_read', 'stream_seek_end', 'stream_short_read_ok',
   'stream_wrong_iid_refused', 'stream_release']);
// SIZE_T is 32-bit and IStream speaks 64-bit offsets. Every crossing must
// REFUSE: a wrapped offset or length is a write outside the HGLOBAL, and a
// truncated SetSize is an S_OK whose size is not the one requested.
arm('64-bit stream offsets are REFUSED at the 32-bit boundary, never truncated',
  ['stream_setsize_beyond_address_range_refused',
   'stream_seek_beyond_address_range_refused',
   'stream_seek_near_top_ok', 'stream_write_offset_overflow_refused']);

// --- 3. the diagnostic really reached stderr -------------------------
const errBlock = out.slice(out.indexOf('==stderr-begin'), out.indexOf('==stderr-end'));
check('WIN32_UNSUPPORTED is LOUD: refusals print a "win32: unsupported" line',
  /win32: unsupported gdiplus call before GdiplusStartup/.test(errBlock) &&
  /win32: unsupported GdipSaveImageToFile: no encoder for CLSID/.test(errBlock) &&
  /win32: unsupported GdipDrawImageRectRect srcUnit/.test(errBlock),
  JSON.stringify(errBlock.slice(0, 600)));
check('the alpha gap is RECORDED, not absorbed (SRCCOPY does not composite; #285)',
  /win32: unsupported GdipDrawImageRectRect: image has alpha but the blit is SRCCOPY/.test(errBlock),
  JSON.stringify(errBlock.slice(0, 600)));
// The two narrowings that return Ok are the ones most able to hide, so
// their diagnostics are asserted here by name — the in-process selftest
// can see the status but has nothing to read stderr back from.
check('a non-nearest interpolation mode announces the nearest substitution',
  /win32: unsupported GdipDrawImageRectRect interpolation mode \d+ \(drawn NEAREST/.test(errBlock),
  JSON.stringify(errBlock.slice(0, 900)));
check('an out-of-bounds source rect names the wrap mode it would have needed',
  /win32: unsupported GdipDrawImageRectRect source rect .* leaves the \d+x\d+ image; wrap mode/.test(errBlock),
  JSON.stringify(errBlock.slice(0, 900)));
check('the 32-bit stream boundary refusals are LOUD too',
  /win32: unsupported IStream::Write of \d+ bytes at offset \d+ would overflow/.test(errBlock) &&
  /win32: unsupported IStream::SetSize beyond the address range/.test(errBlock),
  JSON.stringify(errBlock.slice(0, 900)));

// --- 4. the save path wrote real bytes -------------------------------
const fileBlock = out.slice(out.indexOf('==files'), out.indexOf('==done'));
for (const f of ['gdiplus-rt.png', 'gdiplus-rt.bmp', 'gdiplus-in.png']) {
  const line = fileBlock.split('\n').find(l => l.includes(f));
  const size = line ? Number((line.trim().split(/\s+/)[4] || '0')) : 0;
  check(`save/load touched the real fs: ${f} exists and is non-empty`,
    !!line && size > 0, JSON.stringify(line));
}

console.log(failures ? `\nFAILED (${failures})` : '\nPASS');
process.exit(failures ? 1 : 0);
