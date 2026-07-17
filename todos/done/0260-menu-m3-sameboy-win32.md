# 0260 — Menu M3: SameBoy win32 conversion (the both-transports proof)

- **Status**: done (image v120; ticket #67; dev log logs/2026-07-18/menu-m3-sameboy-win32.md)
- **Design**: menu arch §4.b (the canonical uniform-menu design note); M2 = todos/done/0258, M4 = todos/done/0259

## Goal

Convert the SameBoy frontend (vendor/sameboy/src/main.c, port glue only —
GB_run_frame cadence + rgb_encode untouched) into a win32 app on the uniform
menu facility — the LAST menu milestone, the "one system, BOTH transports"
proof: a CPU app presenting through the normal GDI bitmap transport gets the
identical menucore menu path gpubox (M2, GPU transport) rides.

## Plan

- RegisterClass + CreateWindowEx + WndProc (NOT CS_OWNCLIENT — the client is
  a normal user32-owned surface), GB buttons via WM_KEYDOWN/UP, framebuffer
  via SetDIBits into a 160x144 bitmap + StretchBlt ×3 through GetDC/ReleaseDC,
  PeekMessage pump in the __setAnimationFrameFunc callback.
- Menu at WM_CREATE: File ▸ Open ROM… (comdlg32 GetOpenFileNameW → live ROM
  reload: battery save, GB_load_rom_from_buffer, GB_switch_model_and_reset) /
  Quit; Emulation ▸ Pause / Reset / Auto-DMG-CGB model radios; Options ▸
  Palette submenu (GB_set_palette, nested cascade) / Mute. Save states
  deliberately absent (core/save_state.c is not in this build — honest gap).
- bin.json gains deps os/win32/lib.json; image v119→v120.

## Acceptance

- test_sameboy_e2e.js menu legs red→green: menubar anchored child, "#32768"
  popup, Pause freeze (byte-identical shots), exact GB_PALETTE_DMG bytes via
  the nested submenu action, Open ROM through the real modal + clean menu
  Quit, COLOR_MENU composite over the live shm client (§3.4 probe).
- New os-sameboy.mjs browser leg: live animation through the GDI transport,
  popup over the client, visible palette swap, menu Quit.
- Kernel suite + browser sweep green; compiler.js untouched.
