#!/usr/bin/env node
// adapt.mjs — the MECHANICAL adaptation transform for #723 (#529-B).
//
// Reads the pristine upstream sources (committed next to this script,
// SHA-256-pinned in tests/unit/sdl_load_wav/upstream.json) and emits the
// adapted __SDL_wave.h / __SDL_wave.c that compiler.js embeds. Every edit is
// an exact-string replacement asserted to apply EXACTLY ONCE — a drifted
// pristine file or a stale pattern fails loud. This script is the executable
// form of the adaptation ledger: run it and diff its output against the
// embedded copies to verify the decoder body is upstream-verbatim outside the
// listed edits.
//
//   node adapt.mjs --dev out.c     # single concatenated TU for standalone
//                                  # compile testing (header inlined)
//   node adapt.mjs --print h|c     # print one adapted file
//
// Ledger summary (full entries in upstream.json):
//   H1   SDL_internal.h include -> pragma once + provenance/altered marker
//   E1   altered-source marking after the zlib notice
//   E2   SDL_internal.h include -> builtin includes + compat prelude +
//        allocation seam (+injection countdown) + private FILE*/const-mem IO
//        adapter spelled with the upstream call-site names (TU-local statics)
//   E3   HAVE_LIMITS_H guard -> unconditional <limits.h> (in E2's includes)
//   E4   "SDL_wave.h"/"SDL_sysaudio.h" includes -> <__SDL_wave.h> (sysaudio
//        provided nothing this TU uses)
//   E5   SDL_WAVE_DEBUG_LOG_FORMAT / SDL_WAVE_DEBUG_DUMP_FORMAT functions and
//        call sites removed (debug logging, per the adaptation boundary)
//   E6   WaveGet{RiffSize,Truncation,FactChunk}Hint bodies frozen to the
//        upstream 3.4.0 defaults (NoHint) — SDL_HINT_WAVE_* not consulted
//   E7   SDL_HINT_WAVE_CHUNK_LIMIT lookup removed — chunkcountlimit frozen to
//        the upstream default 10000
//   E8   SDL_LoadWAV_IO made static (public SDL_IOStream is ABSENT; the
//        public surface gains ONLY SDL_LoadWAV)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pristineC = fs.readFileSync(path.join(HERE, 'upstream/SDL_wave.c'), 'utf8');
const pristineH = fs.readFileSync(path.join(HERE, 'upstream/SDL_wave.h'), 'utf8');

function replaceOnce(text, from, to, label) {
  const i = text.indexOf(from);
  if (i < 0) throw new Error(`edit ${label}: pattern not found`);
  if (text.indexOf(from, i + 1) >= 0) throw new Error(`edit ${label}: pattern not unique`);
  return text.slice(0, i) + to + text.slice(i + from.length);
}

// Cut [startMarker, endMarker] inclusive (both must be unique).
function cutOnce(text, startMarker, endMarker, label) {
  const a = text.indexOf(startMarker);
  if (a < 0 || text.indexOf(startMarker, a + 1) >= 0) throw new Error(`cut ${label}: start not unique/found`);
  const b = text.indexOf(endMarker, a);
  if (b < 0) throw new Error(`cut ${label}: end not found`);
  return text.slice(0, a) + text.slice(b + endMarker.length);
}

const ALTERED = `/* ==== ALTERED SOURCE (gucOS, ticket #723) ====================================
   This file is an ADAPTATION of SDL's src/audio/SDL_wave.c at tag
   release-3.4.0, commit a962f40bbba175e9716557a25d5d7965f134a3d3 — it is NOT
   the original software. Per the zlib license above, this altered version is
   plainly marked as such. The decoder logic (RIFF parsing, format validation,
   PCM normalization, MS/IMA ADPCM, A-law, mu-law, fact/padding/overflow/
   zero-length handling, error cleanup) is upstream-verbatim; only SDL-internal
   scaffolding was replaced. The complete adaptation ledger, with the SHA-256
   of the imported originals, lives at tests/unit/sdl_load_wav/upstream.json,
   and logs/2026-08-20/529b-evidence/adapt.mjs regenerates this file from the
   pristine source mechanically.
   ============================================================================ */
`;

// ---- the adapted header -----------------------------------------------------

let h = pristineH;
h = replaceOnce(h, '#include "SDL_internal.h"', `#pragma once
${ALTERED}
/* Consumed only by the builtin __SDL_wave.c (demand-linked when a program
   references SDL_LoadWAV). Uint8/Sint64/... come from <SDL.h>, which the TU
   includes first. */`, 'H1');

// ---- the adapted source -----------------------------------------------------

const PRELUDE = `/* ==== gucOS adaptation prelude (#723) — everything between these fences is
   NEW code, not upstream. The decoder below is upstream-verbatim outside the
   ledgered edits (tests/unit/sdl_load_wav/upstream.json). ==== */
#include <SDL.h>
#include <stdbool.h> /* <SDL.h> supplies bool but (deliberately) not the
                        true/false macros; this TU uses them bare */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <stdint.h>

/* Upstream-internal scaffolding mapped to builtin equivalents. wasm32 is
   little-endian, so the LE byte swap is identity. */
#define SDL_zero(x) memset(&(x), 0, sizeof((x)))
#define SDL_zerop(x) memset((x), 0, sizeof(*(x)))
#define SDL_zeroa(x) memset((x), 0, sizeof((x)))
#define SDL_memcmp memcmp
#define SDL_arraysize(array) (sizeof(array) / sizeof(array[0]))
#define SDL_Swap32LE(x) (x)
#define SDL_MAX_SINT32 ((Sint32)0x7FFFFFFF)
#define SDL_MAX_SINT64 ((Sint64)0x7FFFFFFFFFFFFFFFLL)
#define SDL_MAX_UINT32 ((Uint32)0xFFFFFFFFu)
#define SDL_PRIu32 "u"
#define SDL_FALLTHROUGH
/* Upstream default build shape: neither SDL_DISABLE_INVALID_PARAMS nor
   SDL_ASSERT_INVALID_PARAMS is defined, so CHECK_PARAM is a plain if. */
#define CHECK_PARAM(invalid) if (invalid)
/* <SDL.h> publishes no *LE format names (wasm32 is LE — same values) and no
   SDL_AUDIO_UNKNOWN; private spellings of the upstream values. */
#define SDL_AUDIO_UNKNOWN 0
#define SDL_AUDIO_S16LE SDL_AUDIO_S16
#define SDL_AUDIO_S32LE SDL_AUDIO_S32
#define SDL_AUDIO_F32LE SDL_AUDIO_F32

/* Allocation seam: the SDL heap plus a deterministic failure-injection
   countdown for the #723 ownership/cleanup suite. __sdl_wave_alloc_countdown
   is a TEST-ONLY knob (reserved __ name, declared in no public header):
   N >= 0 makes the (N+1)th allocation in this TU fail once, then disarms;
   -1 (the resting state) never fires. A NULL return — injected or real —
   sets the SDL error, so OOM always surfaces named (upstream can surface OOM
   with a stale error string; declared divergence, ledger A1). */
int __sdl_wave_alloc_countdown = -1;
static bool wave_alloc_fail(void) {
    if (__sdl_wave_alloc_countdown < 0) return false;
    if (__sdl_wave_alloc_countdown == 0) {
        __sdl_wave_alloc_countdown = -1;
        SDL_SetError("Out of memory");
        return true;
    }
    __sdl_wave_alloc_countdown--;
    return false;
}
static void *wave_malloc(size_t size) {
    if (wave_alloc_fail()) return NULL;
    void *p = SDL_malloc(size);
    if (!p) SDL_SetError("Out of memory");
    return p;
}
static void *wave_calloc(size_t nmemb, size_t size) {
    if (wave_alloc_fail()) return NULL;
    void *p = SDL_calloc(nmemb, size);
    if (!p) SDL_SetError("Out of memory");
    return p;
}
static void *wave_realloc(void *mem, size_t size) {
    if (wave_alloc_fail()) return NULL;
    void *p = SDL_realloc(mem, size);
    if (!p) SDL_SetError("Out of memory");
    return p;
}
#define SDL_malloc wave_malloc
#define SDL_calloc wave_calloc
#define SDL_realloc wave_realloc

/* Private IO adapter over FILE* / const memory — the SDL_IOStream replacement.
   Public SDL_IOStream stays ABSENT; these are TU-LOCAL statics spelled with
   the upstream names so every decoder call site below stays byte-verbatim.
   Only the operations the decoder uses exist: SEEK_SET seeks, reads, tell,
   size. Positions clamp to this ILP32 libc's 31-bit long — a >2 GiB WAV fails
   its seek loud instead of decoding wrong (ledger A2). */
typedef struct SDL_IOStream {
    FILE *fp;         /* file-backed when non-NULL */
    const Uint8 *mem; /* const-memory-backed otherwise */
    size_t memsize;
    size_t mempos;
} SDL_IOStream;
#define SDL_IO_SEEK_SET 0

static size_t SDL_ReadIO(SDL_IOStream *s, void *ptr, size_t size) {
    if (size == 0) return 0;
    if (s->fp) return fread(ptr, 1, size, s->fp);
    {
        size_t avail = s->memsize - s->mempos;
        if (size > avail) size = avail;
        memcpy(ptr, s->mem + s->mempos, size);
        s->mempos += size;
        return size;
    }
}
static Sint64 SDL_SeekIO(SDL_IOStream *s, Sint64 offset, int whence) {
    (void)whence; /* SDL_IO_SEEK_SET only */
    if (offset < 0) return -1;
    if (s->fp) {
        if (offset > (Sint64)LONG_MAX) return -1;
        if (fseek(s->fp, (long)offset, SEEK_SET) != 0) return -1;
        return offset;
    }
    if ((Uint64)offset > (Uint64)s->memsize) return -1;
    s->mempos = (size_t)offset;
    return offset;
}
static Sint64 SDL_TellIO(SDL_IOStream *s) {
    if (s->fp) {
        long p = ftell(s->fp);
        return p < 0 ? -1 : (Sint64)p;
    }
    return (Sint64)s->mempos;
}
static Sint64 SDL_GetIOSize(SDL_IOStream *s) {
    long cur, end;
    if (!s->fp) return (Sint64)s->memsize;
    cur = ftell(s->fp);
    if (cur < 0) return -1;
    if (fseek(s->fp, 0, SEEK_END) != 0) return -1;
    end = ftell(s->fp);
    if (fseek(s->fp, cur, SEEK_SET) != 0) return -1;
    return end < 0 ? -1 : (Sint64)end;
}
static bool SDL_ReadU8(SDL_IOStream *s, Uint8 *value) {
    return SDL_ReadIO(s, value, 1) == 1;
}
static bool SDL_ReadU16LE(SDL_IOStream *s, Uint16 *value) {
    Uint8 b[2];
    if (SDL_ReadIO(s, b, 2) != 2) return false;
    *value = (Uint16)(b[0] | ((Uint16)b[1] << 8));
    return true;
}
static bool SDL_ReadU32LE(SDL_IOStream *s, Uint32 *value) {
    Uint8 b[4];
    if (SDL_ReadIO(s, b, 4) != 4) return false;
    *value = (Uint32)b[0] | ((Uint32)b[1] << 8) | ((Uint32)b[2] << 16) | ((Uint32)b[3] << 24);
    return true;
}
static SDL_IOStream *SDL_IOFromConstMem(const void *mem, int size) {
    SDL_IOStream *s;
    if (!mem || size < 0) {
        SDL_InvalidParamError("mem");
        return NULL;
    }
    s = (SDL_IOStream *)SDL_calloc(1, sizeof(*s));
    if (!s) return NULL;
    s->mem = (const Uint8 *)mem;
    s->memsize = (size_t)size;
    return s;
}
static SDL_IOStream *SDL_IOFromFile(const char *file, const char *mode) {
    FILE *fp;
    SDL_IOStream *s;
    (void)mode; /* "rb" only */
    if (!file || !*file) {
        SDL_InvalidParamError("path");
        return NULL;
    }
    fp = fopen(file, "rb");
    if (!fp) {
        SDL_SetError("Couldn't open %s", file);
        return NULL;
    }
    s = (SDL_IOStream *)SDL_calloc(1, sizeof(*s));
    if (!s) {
        fclose(fp);
        return NULL;
    }
    s->fp = fp;
    return s;
}
static bool SDL_CloseIO(SDL_IOStream *s) {
    bool ok = true;
    if (!s) return true;
    if (s->fp) ok = (fclose(s->fp) == 0);
    SDL_free(s);
    return ok;
}
/* ==== end of adaptation prelude — the upstream decoder follows ==== */`;

let c = pristineC;

// E1: altered marking directly after the license comment.
c = replaceOnce(c, '*/\n#include "SDL_internal.h"', '*/\n' + ALTERED + '#include "SDL_internal.h"', 'E1');

// E2: SDL_internal.h -> the prelude.
c = replaceOnce(c, '#include "SDL_internal.h"', PRELUDE, 'E2');

// E3: HAVE_LIMITS_H guard -> unconditional include already in the prelude.
c = replaceOnce(c, `#ifdef HAVE_LIMITS_H
#include <limits.h>
#endif
`, '', 'E3');

// E4: local includes -> builtin header; SDL_sysaudio.h unused here.
c = replaceOnce(c, `#include "SDL_wave.h"
#include "SDL_sysaudio.h"`, '#include <__SDL_wave.h>', 'E4');

// E5: the two debug-logging functions and their call sites.
c = cutOnce(c, '#ifdef SDL_WAVE_DEBUG_LOG_FORMAT\nstatic void WaveDebugLogFormat',
  'SDL_LogDebug(SDL_LOG_CATEGORY_AUDIO, fmtstr, waveformat, format->frequency, wavechannel, format->bitspersample, wavebps, wavebpsunit);\n}\n#endif\n\n', 'E5a');
c = cutOnce(c, '#ifdef SDL_WAVE_DEBUG_DUMP_FORMAT\nstatic void WaveDebugDumpFormat',
  'SDL_free(dumpstr);\n}\n#endif\n\n', 'E5b');
c = replaceOnce(c, `#ifdef SDL_WAVE_DEBUG_LOG_FORMAT
    WaveDebugLogFormat(file);
#endif
#ifdef SDL_WAVE_DEBUG_DUMP_FORMAT
    WaveDebugDumpFormat(file, RIFFchunk.length, fmtchunk.length, datachunk.length);
#endif

`, '', 'E5c');

// E6: the three hint getters frozen to the upstream 3.4.0 defaults.
c = replaceOnce(c, `static WaveRiffSizeHint WaveGetRiffSizeHint(void)
{
    const char *hint = SDL_GetHint(SDL_HINT_WAVE_RIFF_CHUNK_SIZE);

    if (hint) {
        if (SDL_strcmp(hint, "force") == 0) {
            return RiffSizeForce;
        } else if (SDL_strcmp(hint, "ignore") == 0) {
            return RiffSizeIgnore;
        } else if (SDL_strcmp(hint, "ignorezero") == 0) {
            return RiffSizeIgnoreZero;
        } else if (SDL_strcmp(hint, "maximum") == 0) {
            return RiffSizeMaximum;
        }
    }

    return RiffSizeNoHint;
}`, `static WaveRiffSizeHint WaveGetRiffSizeHint(void)
{
    /* gucOS (#723): frozen to the upstream 3.4.0 default — the
       SDL_HINT_WAVE_RIFF_CHUNK_SIZE lookup is not consulted (ledger E6). */
    return RiffSizeNoHint;
}`, 'E6a');
c = replaceOnce(c, `static WaveTruncationHint WaveGetTruncationHint(void)
{
    const char *hint = SDL_GetHint(SDL_HINT_WAVE_TRUNCATION);

    if (hint) {
        if (SDL_strcmp(hint, "verystrict") == 0) {
            return TruncVeryStrict;
        } else if (SDL_strcmp(hint, "strict") == 0) {
            return TruncStrict;
        } else if (SDL_strcmp(hint, "dropframe") == 0) {
            return TruncDropFrame;
        } else if (SDL_strcmp(hint, "dropblock") == 0) {
            return TruncDropBlock;
        }
    }

    return TruncNoHint;
}`, `static WaveTruncationHint WaveGetTruncationHint(void)
{
    /* gucOS (#723): frozen to the upstream 3.4.0 default — the
       SDL_HINT_WAVE_TRUNCATION lookup is not consulted (ledger E6). */
    return TruncNoHint;
}`, 'E6b');
c = replaceOnce(c, `static WaveFactChunkHint WaveGetFactChunkHint(void)
{
    const char *hint = SDL_GetHint(SDL_HINT_WAVE_FACT_CHUNK);

    if (hint) {
        if (SDL_strcmp(hint, "truncate") == 0) {
            return FactTruncate;
        } else if (SDL_strcmp(hint, "strict") == 0) {
            return FactStrict;
        } else if (SDL_strcmp(hint, "ignorezero") == 0) {
            return FactIgnoreZero;
        } else if (SDL_strcmp(hint, "ignore") == 0) {
            return FactIgnore;
        }
    }

    return FactNoHint;
}`, `static WaveFactChunkHint WaveGetFactChunkHint(void)
{
    /* gucOS (#723): frozen to the upstream 3.4.0 default — the
       SDL_HINT_WAVE_FACT_CHUNK lookup is not consulted (ledger E6). */
    return FactNoHint;
}`, 'E6c');

// E7: the chunk-limit hint lookup; the local that carried it.
c = replaceOnce(c, `    Uint32 chunkcountlimit = 10000;
`, `    Uint32 chunkcountlimit = 10000; /* gucOS (#723): frozen upstream default —
                                       SDL_HINT_WAVE_CHUNK_LIMIT is not
                                       consulted (ledger E7) */
`, 'E7a');
c = replaceOnce(c, `    const Sint64 flen = SDL_GetIOSize(src);   // this might be -1 if the IOStream can't determine the total size.
    const char *hint;
`, `    const Sint64 flen = SDL_GetIOSize(src);   // this might be -1 if the IOStream can't determine the total size.
`, 'E7b');
c = replaceOnce(c, `    hint = SDL_GetHint(SDL_HINT_WAVE_CHUNK_LIMIT);
    if (hint) {
        unsigned int count;
        if (SDL_sscanf(hint, "%u", &count) == 1) {
            chunkcountlimit = count <= SDL_MAX_UINT32 ? count : SDL_MAX_UINT32;
        }
    }

`, '', 'E7c');

// E8: SDL_LoadWAV_IO is TU-private — the public surface gains only SDL_LoadWAV.
c = replaceOnce(c, `bool SDL_LoadWAV_IO(SDL_IOStream *src, bool closeio, SDL_AudioSpec *spec, Uint8 **audio_buf, Uint32 *audio_len)
{`, `/* gucOS (#723): static — public SDL_IOStream is ABSENT, so this stays a
   TU-private helper (ledger E8). The public surface gains only SDL_LoadWAV. */
static bool SDL_LoadWAV_IO(SDL_IOStream *src, bool closeio, SDL_AudioSpec *spec, Uint8 **audio_buf, Uint32 *audio_len)
{`, 'E8');

// Post-conditions: nothing SDL-internal survives.
for (const forbidden of ['SDL_GetHint', 'SDL_LogDebug', 'SDL_sscanf', 'SDL_strcmp',
                         'SDL_strlcat', 'SDL_snprintf', 'SDL_internal.h', 'SDL_sysaudio.h',
                         'SDL_WAVE_DEBUG']) {
  if (c.includes(forbidden)) throw new Error('adapted source still mentions ' + forbidden);
}
if (!/\nstatic bool SDL_LoadWAV_IO\(/.test(c)) throw new Error('SDL_LoadWAV_IO not static');

// ---- output -------------------------------------------------------------------

const args = process.argv.slice(2);
if (args[0] === '--dev') {
  // single TU: header inlined ahead of the source (minus its include of it)
  const single = c.replace('#include <__SDL_wave.h>', h.replace('#pragma once\n', ''));
  fs.writeFileSync(args[1], single);
  console.log('wrote ' + args[1]);
} else if (args[0] === '--print') {
  process.stdout.write(args[1] === 'h' ? h : c);
} else {
  console.log('adapted OK: header %d bytes, source %d bytes', h.length, c.length);
}
