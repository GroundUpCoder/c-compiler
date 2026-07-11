/*
 * mGBA frontend for the C-to-WASM compiler (todos/0112).
 *
 * Game Boy Advance emulator: drives mGBA's `mCore` interface directly (the
 * same seam the fuzz/perf harnesses use) rather than porting the Qt/SDL app.
 * GBA-only build — GB/GBC stay with /bin/sameboy; mGBA's GB core is not
 * compiled in here (see vendor/mgba/README.md).
 *
 * This file is our glue, not mGBA-derived; it is Apache-2.0 like the rest of
 * the c-compiler tree (the mGBA core sources under vendor/mgba/ stay MPL-2.0).
 *
 * Usage:
 *   node compiler.js vendor/mgba/bin.json -a compile -o mgba.html
 *   mgba [rom.gba]
 *
 * With no ROM a built-in test ROM (a MODE 3 bitmap fill drawn by a handful of
 * hand-assembled ARM words) paints a recognizable frame — the headless
 * pixel-test target, mirroring /bin/gameboy and /bin/sameboy's bare mode.
 *
 * Controls:
 *   Arrow keys  = D-pad
 *   Z           = A          X           = B
 *   A           = L          S           = R
 *   Enter       = Start      Right Shift = Select
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <SDL.h>

#include <mgba/core/core.h>
#include <mgba/core/blip_buf.h>
#include <mgba/gba/core.h>
#include <mgba/internal/gba/gba.h>
#include <mgba/internal/gba/input.h>
#include <mgba-util/vfs.h>

/* ── Display ─────────────────────────────────────────────────────── */
#define GBA_W 240
#define GBA_H 160
#define SCALE 2

static SDL_Window  *window;
static SDL_Surface *surface;

/* mGBA renders whole frames into this (32-bit RGBA, stride = GBA_W). */
static color_t fb[GBA_W * GBA_H];

/* ── Audio ──────────────────────────────────────────────────────── */
#define AUDIO_RATE         32768
#define AUDIO_QUEUE_TARGET (AUDIO_RATE * 4 / 10) /* ~100ms of stereo S16 bytes */
#define AUDIO_MAX_FRAMES   2048
static SDL_AudioStream *audio_dev;
static int16_t audio_buf[AUDIO_MAX_FRAMES * 2];

/* ── Emulator state ──────────────────────────────────────────────── */
static struct mCore *core;

/* ── Built-in test ROM: MODE 3 bitmap fill (hand-assembled ARM) ──── */
static uint8_t *rom_data;
static size_t rom_size;

static void emit32(uint8_t *p, size_t off, uint32_t w) {
    p[off]     = (uint8_t)(w);
    p[off + 1] = (uint8_t)(w >> 8);
    p[off + 2] = (uint8_t)(w >> 16);
    p[off + 3] = (uint8_t)(w >> 24);
}

static void build_test_rom(void) {
    rom_size = 0x200;
    rom_data = calloc(1, rom_size);

    /* ROM header: word 0 is `b 0xC0` (0xEA branch — byte[3]==0xEA is the
       GBA ROM magic mGBA checks). offset = (0xC0 - 8) / 4 = 0x2E. */
    emit32(rom_data, 0x00, 0xEA000000u | 0x2E);
    rom_data[0xB2] = 0x96; /* second GBA ROM magic byte */

    /* code @ 0xC0 (ARM state, cond AL):
         MOV  r0, #0x04000000   ; REG base
         MOV  r1, #0x0400
         ADD  r1, r1, #3        ; DISPCNT = 0x0403 (mode 3, BG2 on)
         STR  r1, [r0]
         MOV  r0, #0x06000000   ; VRAM
         MOV  r1, #0x1F         ; BGR555 red
         ORR  r1, r1, r1, LSL #16
         MOV  r2, #0x4B
         MOV  r2, r2, LSL #8    ; r2 = 0x4B00 = 240*160/2 words
       fill:
         STR  r1, [r0], #4
         SUBS r2, r2, #1
         BNE  fill
       done:
         B    done */
    size_t pc = 0xC0;
    emit32(rom_data, pc, 0xE3A00404); pc += 4; /* MOV r0,#0x04000000 */
    emit32(rom_data, pc, 0xE3A01C04); pc += 4; /* MOV r1,#0x0400     */
    emit32(rom_data, pc, 0xE2811003); pc += 4; /* ADD r1,r1,#3       */
    emit32(rom_data, pc, 0xE5801000); pc += 4; /* STR r1,[r0]        */
    emit32(rom_data, pc, 0xE3A00406); pc += 4; /* MOV r0,#0x06000000 */
    emit32(rom_data, pc, 0xE3A0101F); pc += 4; /* MOV r1,#0x1F       */
    emit32(rom_data, pc, 0xE1811801); pc += 4; /* ORR r1,r1,r1,LSL#16*/
    emit32(rom_data, pc, 0xE3A0204B); pc += 4; /* MOV r2,#0x4B       */
    emit32(rom_data, pc, 0xE1A02402); pc += 4; /* MOV r2,r2,LSL#8    */
    size_t fill = pc;
    emit32(rom_data, pc, 0xE4801004); pc += 4; /* STR r1,[r0],#4     */
    emit32(rom_data, pc, 0xE2522001); pc += 4; /* SUBS r2,r2,#1      */
    /* BNE fill : offset = (fill - (pc + 8)) / 4 */
    {
        int32_t off = ((int32_t)fill - ((int32_t)pc + 8)) / 4;
        emit32(rom_data, pc, 0x1A000000u | (off & 0x00FFFFFFu)); pc += 4;
    }
    emit32(rom_data, pc, 0xEAFFFFFE); pc += 4; /* B . (spin)         */
}

/* ── Input ───────────────────────────────────────────────────────── */
static void handle_input(void) {
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        if (event.type == SDL_EVENT_QUIT)
            exit(0);
        if (event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP) {
            int pressed = (event.type == SDL_EVENT_KEY_DOWN);
            int key = -1;
            switch (event.key.key) {
            case SDLK_RIGHT:  key = GBA_KEY_RIGHT;  break;
            case SDLK_LEFT:   key = GBA_KEY_LEFT;   break;
            case SDLK_UP:     key = GBA_KEY_UP;     break;
            case SDLK_DOWN:   key = GBA_KEY_DOWN;   break;
            case 'z':         key = GBA_KEY_A;      break;
            case 'x':         key = GBA_KEY_B;      break;
            case 'a':         key = GBA_KEY_L;      break;
            case 's':         key = GBA_KEY_R;      break;
            case SDLK_RETURN: key = GBA_KEY_START;  break;
            case SDLK_RSHIFT: key = GBA_KEY_SELECT; break;
            }
            if (key >= 0) {
                if (pressed) core->addKeys(core, 1u << key);
                else         core->clearKeys(core, 1u << key);
            }
        }
    }
}

/* ── Frame loop ──────────────────────────────────────────────────── */
#define FRAME_TIME_MS      (1000.0 / 59.7275)  /* GBA vblank rate */
#define MAX_CATCHUP_FRAMES 4

static double next_frame_time;

static void drain_audio(void) {
    if (!audio_dev) {
        /* No sink: still consume the core's audio so blip doesn't overflow. */
        blip_clear(core->getAudioChannel(core, 0));
        blip_clear(core->getAudioChannel(core, 1));
        return;
    }
    int avail = blip_samples_avail(core->getAudioChannel(core, 0));
    if (avail <= 0) return;
    if (avail > AUDIO_MAX_FRAMES) avail = AUDIO_MAX_FRAMES;
    blip_read_samples(core->getAudioChannel(core, 0), audio_buf,     avail, 1);
    blip_read_samples(core->getAudioChannel(core, 1), audio_buf + 1, avail, 1);
    if ((int)SDL_GetAudioStreamQueued(audio_dev) < AUDIO_QUEUE_TARGET)
        SDL_PutAudioStreamData(audio_dev, audio_buf, avail * 2 * (int)sizeof(int16_t));
}

static void frame_callback(void) {
    double now = (double)SDL_GetTicks();
    if (next_frame_time == 0.0) next_frame_time = now;
    if (now < next_frame_time) return;

    int frames = 0;
    while (next_frame_time <= now && frames < MAX_CATCHUP_FRAMES) {
        handle_input();
        core->runFrame(core);
        drain_audio();
        next_frame_time += FRAME_TIME_MS;
        frames++;
    }
    if (next_frame_time <= now)
        next_frame_time = now + FRAME_TIME_MS;

    /* Scale fb[] → window surface */
    uint32_t *dst = (uint32_t *)surface->pixels;
    int win_w = GBA_W * SCALE;
    for (int sy = 0; sy < GBA_H; sy++) {
        for (int dy = 0; dy < SCALE; dy++) {
            uint32_t *row = &dst[(sy * SCALE + dy) * win_w];
            for (int sx = 0; sx < GBA_W; sx++) {
                uint32_t px = (uint32_t)fb[sy * GBA_W + sx];
                for (int dx = 0; dx < SCALE; dx++)
                    row[sx * SCALE + dx] = px;
            }
        }
    }
    SDL_UpdateWindowSurface(window);
}

/* ── Entry point ─────────────────────────────────────────────────── */
int main(int argc, char **argv) {
    const char *rom_path = NULL;
    for (int i = 1; i < argc; i++)
        rom_path = argv[i];

    core = GBACoreCreate();
    if (!core) {
        printf("mgba: failed to create GBA core\n");
        return 1;
    }
    core->init(core);
    mCoreInitConfig(core, NULL);

    unsigned w, h;
    core->desiredVideoDimensions(core, &w, &h);
    core->setVideoBuffer(core, fb, w);

    struct VFile *rom;
    if (rom_path) {
        rom = VFileOpen(rom_path, O_RDONLY);
        if (!rom) {
            printf("mgba: cannot open ROM: %s\n", rom_path);
            return 1;
        }
        printf("mgba: loading %s\n", rom_path);
    } else {
        build_test_rom();
        rom = VFileFromMemory(rom_data, rom_size);
        printf("mgba: using built-in test ROM\n");
    }
    if (!core->loadROM(core, rom)) {
        printf("mgba: failed to load ROM\n");
        return 1;
    }

    core->reset(core);
    blip_set_rates(core->getAudioChannel(core, 0), GBA_ARM7TDMI_FREQUENCY, AUDIO_RATE);
    blip_set_rates(core->getAudioChannel(core, 1), GBA_ARM7TDMI_FREQUENCY, AUDIO_RATE);

    char title[17] = {0};
    core->getGameTitle(core, title);
    printf("mgba: GBA core ready (%s)\n", title[0] ? title : "no title");

    SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO);
    window  = SDL_CreateWindow("mGBA", GBA_W * SCALE, GBA_H * SCALE, 0);
    surface = SDL_GetWindowSurface(window);

    {
        SDL_AudioSpec want;
        memset(&want, 0, sizeof(want));
        want.freq = AUDIO_RATE;
        want.format = SDL_AUDIO_S16;
        want.channels = 2;
        audio_dev = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &want, 0, 0);
        if (audio_dev)
            SDL_ResumeAudioStreamDevice(audio_dev);
    }

    __setAnimationFrameFunc(frame_callback);
    return 0;
}
