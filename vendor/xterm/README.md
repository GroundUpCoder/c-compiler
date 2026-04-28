# xterm.js

Terminal emulator for the browser.

- **Source**: https://github.com/xtermjs/xterm.js
- **License**: MIT (see LICENSE)
- **Packages**: `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`

## How these files were produced

The vendored files are built from the npm packages using esbuild. A script
(`tools/vendor-xterm.py` in the old repo) automates the process:

1. Create a temporary pnpm project
2. `pnpm add @xterm/xterm @xterm/addon-fit esbuild`
3. Bundle each package into a standalone IIFE script with esbuild
4. Copy `xterm.css` from the installed package

The IIFE bundles expose `window.Terminal` and `window.FitAddon` as globals.

## Contents

- `xterm.js` — bundled Terminal class (IIFE)
- `xterm-addon-fit.js` — bundled FitAddon class (IIFE)
- `xterm.css` — xterm stylesheet
- `LICENSE` — MIT license from upstream
