#!/usr/bin/env node
'use strict';
// 0060: the Win32 port compile-test harness in --check mode — every
// ports.json target must match its expected status (controls gdidemo/
// ctldemo link with ZERO missing symbols; the vendored corpus reaches
// the link stage) and the committed os/win32/PORTS.md must be current.
// A FAIL here means: regenerate the report (node tools/win32ports.js),
// or a header/veneer change broke a port's compile — see the diff.
var { spawnSync } = require('child_process');
var path = require('path');

var r = spawnSync(process.execPath,
  [path.join(__dirname, '../../tools/win32ports.js'), '--check'],
  { stdio: 'inherit' });
process.exit(r.status === 0 ? 0 : 1);
