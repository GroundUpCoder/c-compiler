#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');const ROOT=path.resolve(__dirname,'../..');let fails=0;
function ok(n,x){console.log((x?'  ok   ':'  FAIL ')+n);if(!x)fails++;}
const h=fs.readFileSync(path.join(ROOT,'os/win32/gucedit.h'),'utf8');const u=fs.readFileSync(path.join(ROOT,'os/win32/user32.c'),'utf8');
ok('ABI v1 is private and fixed-size',/GUCEDIT_ABI_VERSION 1u/.test(h)&&/sizeof\(GUCEDIT_STYLE_V1\) == 20/.test(h));
ok('generation is exact-byte-change bound at EN_CHANGE',/memcmp\(st->buf, st->generationBytes/.test(u)&&/textGeneration/.test(u));
ok('stale generation has distinct error',/GUCEDIT_ERROR_STALE_GENERATION/.test(u));
ok('validation rejects LF spans and UTF-8 continuation endpoints',/memchr\(st->buf \+ sp->start, '\\n'/.test(u)&&/0xc0\) == 0x80/.test(u));
ok('allocation failure preserves prior style allocation',/if \(!copy\).*ERROR_NOT_ENOUGH_MEMORY/.test(u)&&/free\(st->styles\); st->styles = copy/.test(u));
ok('destroy frees styles',/free\(st->styles\); st->styles = NULL/.test(u));
process.exit(fails?1:0);
