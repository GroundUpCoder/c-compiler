# #751 — capture GPU surfaces through the compositor

The in-OS game development loop needs screenshots of the recommended GPU
rendering tier, including when an agent reads the resulting PNG. At entry
5afcb26b, kernel.js wmScreenshot and wmThumbnail read the shm plane even when
the compositor rendered an ImageBitmap instead. The result was a valid image
of unrelated zero bytes. RED bfb40a1d pins five failures at the WMP boundary.

The compositor owns GPU textures and supplies one captureSurface capability:
import the current bitmap through gpuBindFor, submit copyTextureToBuffer,
map the staging buffer, remove row padding, and release it. GPU textures now
have COPY_SRC usage. Staging allocation is bounded to 64 MiB across in-flight
requests; exhaustion returns EBUSY, not an unbounded queue. Validation and map
errors propagate as EIO, absent capability as ENOSYS, an unready-size frame as
EAGAIN. The bitmap copy is submitted before yielding, so the kernel can keep
closing superseded bitmaps without waiting for captures. Device error scopes
are popped in that same turn so overlapping requests cannot cross scopes.

wmCapture snapshots geometry and CPU pixels and asks that capability only
for required GPU surfaces. All WMP capture operations use it. The existing
screen/overview compositing and thumbnail box filtering consume those pixels;
anchored thumbnail children keep their existing semantics. No parallel
renderer, bitmap ownership protocol, periodic readback, or fake shm frame.
Synchronous kernel pixel helpers explicitly refuse GPU surfaces without
provided readback. Screen screenshots retain the existing documented kernel
chrome; browser glass/shadows/rounded corners remain visual furniture.

Focused evidence before the final load repeats:

- 751-red.log: five GPU capture assertions fail on the unfixed implementation.
- 751-complete: eight freshly executed kernel files pass, including real Dawn
  gpubox rendering and WM service, anchored, aero, policy and fatal paths.
- 751-browser-rerun: decoded gucOS PNGs match the independent page pixels of a
  frozen GPU cube. Shot, thumbnail, screen, anchored shm menu and 321px resized
  stride padding pass. The first attempt only failed the test's CRLF transfer
  assumption, corrected by normalizing carriage returns.
- The first failure-injection test mistakenly invoked nonexistent wmctl title;
  its failure is retained in 751-complete. Corrected test destroys the real
  staging buffer at the second resized capture via routed compositor source;
  it verifies exit1, stderr error, no PNG, then a successful next capture.

Aggregate full gate, standard flake tripwire and final manual use remain
campaign obligations. No merge or deployment is claimed here.

Final focused load evidence: 751-flake completed PASS, 3/3 real Chromium
repeats under load10 (139.0/164.0/148.4s). Each executed the real destroyed-map
failure discriminator and recovered capture. Carried suite rows are not counted
as execution. No test processes remain from these focused invocations.
