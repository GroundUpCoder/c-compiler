# SDL3 gamepad surface entirely absent and untracked

**Class: feature-gap (surveyed, not exercised live). Filed by #508 Pass B round 2 at commit e704f078.**

## The gap

No `SDL_Gamepad`/`SDL_GetGamepads`/`SDL_OpenGamepad`/`SDL_GamepadButton` surface exists anywhere: 0 hits in the shipped `/usr/include/SDL.h` header block, compiler.js, and host.js (positive control: `SDL_OpenAudioDeviceStream` hits 6). Nothing in the open queue tracks it (searched 2026-08-13). Honest per PRINCIPLES — absent, not faked — but for a gamedev-primary platform the absence itself deserves a tracked decision.

**Scope honesty: this pass did not exercise gamepad live** (headless has no controller; the dogfood game used keyboard). Filed on static evidence + expectation, flagged as such.

## The shape of an implementation

- Browser tier: the Web Gamepad API (`navigator.getGamepads()`) polls cleanly from the worker via the existing input plumbing; SDL3's gamepad event + polling surface maps naturally.
- Headless tier: no backing device — absence stays honest there (enumerate zero gamepads, exactly what upstream SDL does on a controller-less box). `wmctl`-style injection for tests would follow the INJECT_KEY precedent if wanted.

## Gamedev justification

Controllers are a first-class game input; the epic should hold a deliberate implement/defer decision rather than an untracked hole.

Evidence: symbol survey at e704f078 (grep counts in the pass log), `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/`.
