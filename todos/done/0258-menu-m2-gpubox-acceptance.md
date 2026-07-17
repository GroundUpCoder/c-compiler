# 0258 — Menu M2: gpubox win32 menu acceptance gate

- **Status**: done (image v118; ticket #66)

Convert gpubox to a minimal win32 app with a File/Options menu + Options▸Spin,
proving a GPU app's menu is first-class on the same code path as notepad's.
Introduces CS_OWNCLIENT + GetWindowSDL (app-presented-client seam, A6) and the
A14 no-Dawn survival mode. Gate: headless-no-Dawn e2e (test_gpubox_menu_e2e.js) +
os-gpubox real-cube browser leg; kernel 84/84, sweep 27/27, compiler.js untouched.
wm.c menucore reseat deferred to M4. See logs/2026-07-17/menu-m2-gpubox-acceptance.md.
