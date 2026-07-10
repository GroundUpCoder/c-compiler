/*
 * SameBoy frontend for the C-to-WASM compiler — the accuracy/GBC sibling of
 * vendor/gameboy (Peanut-GB). This is the default .gb/.gbc handler (0072
 * store points at /bin/sameboy); Peanut-GB stays as the lighter alternate.
 *
 * Usage:
 *   node compiler.js vendor/sameboy/bin.json -a compile -o sameboy.html
 *   sameboy [--dmg|--cgb] [rom.gb|rom.gbc]
 *
 * Model selection: --dmg / --cgb force a model; otherwise the ROM header's
 * CGB flag (0x143 bit 7) picks CGB-E or DMG-B. SameBoy's own MIT boot ROMs
 * (v1.0.3 release binaries) are embedded — see bootroms.c.
 *
 * If no ROM file is provided, a built-in test ROM draws a scrolling
 * checkerboard border pattern (same program as vendor/gameboy's).
 *
 * Controls (same as vendor/gameboy):
 *   Arrow keys  = D-pad
 *   Z           = A button
 *   X           = B button
 *   Enter       = Start
 *   Right Shift = Select
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <SDL.h>

#include "gb.h"
#include "bootroms.h"

/* ── Display ─────────────────────────────────────────────────────── */
#define LCD_WIDTH  160
#define LCD_HEIGHT 144
#define SCALE      3

static SDL_Window  *window;
static SDL_Surface *surface;

/* SameBoy renders whole frames into this via GB_set_pixels_output */
static uint32_t fb[LCD_WIDTH * LCD_HEIGHT];
static int frame_ready;

/* ── Audio ──────────────────────────────────────────────────────── */
#define AUDIO_RATE         44100
#define AUDIO_QUEUE_TARGET (AUDIO_RATE * 4 / 10) /* ~100ms of stereo S16 bytes */

static SDL_AudioStream *audio_dev;

/* Samples accumulate here as the core emits them; the frame loop drains
   them into the SDL stream, dropping when the queue is already full so a
   non-consuming (headless) embedder can't grow memory unboundedly. */
#define AUDIO_ACC_FRAMES 4096
static int16_t audio_acc[AUDIO_ACC_FRAMES * 2];
static unsigned audio_acc_len; /* in frames */

static void sample_callback(GB_gameboy_t *gb, GB_sample_t *sample) {
    (void)gb;
    if (audio_acc_len >= AUDIO_ACC_FRAMES) return;
    audio_acc[audio_acc_len * 2]     = sample->left;
    audio_acc[audio_acc_len * 2 + 1] = sample->right;
    audio_acc_len++;
}

/* ── Emulator state ──────────────────────────────────────────────── */
static GB_gameboy_t gb;

static uint8_t *rom_data;
static size_t rom_size;

/* ── SameBoy callbacks ───────────────────────────────────────────── */
static uint32_t rgb_encode(GB_gameboy_t *gb, uint8_t r, uint8_t g, uint8_t b) {
    (void)gb;
    /* SDL_PIXELFORMAT_RGBA32: bytes R,G,B,A — little-endian ABGR value */
    return 0xFF000000u | ((uint32_t)b << 16) | ((uint32_t)g << 8) | r;
}

static void vblank(GB_gameboy_t *gb, GB_vblank_type_t type) {
    (void)gb;
    if (type != GB_VBLANK_TYPE_REPEAT) frame_ready = 1;
}

static void boot_rom_load(GB_gameboy_t *gb, GB_boot_rom_t type) {
    switch (type) {
    case GB_BOOT_ROM_CGB_0:
    case GB_BOOT_ROM_CGB:
    case GB_BOOT_ROM_CGB_E:
    case GB_BOOT_ROM_AGB_0:
    case GB_BOOT_ROM_AGB:
        GB_load_boot_rom_from_buffer(gb, cgb_boot, sizeof(cgb_boot));
        break;
    default: /* DMG_0/DMG/MGB/SGB/SGB2 — SGB models are never selected here */
        GB_load_boot_rom_from_buffer(gb, dmg_boot, sizeof(dmg_boot));
        break;
    }
}

/* ── Built-in test ROM (same program as vendor/gameboy's) ────────── */
static void build_test_rom(void) {
    rom_size = 32768;
    rom_data = calloc(1, rom_size);

    /* Entry: NOP; JP $0150 */
    rom_data[0x100] = 0x00;
    rom_data[0x101] = 0xC3;
    rom_data[0x102] = 0x50;
    rom_data[0x103] = 0x01;

    /* Nintendo logo (48 bytes at 0x104) */
    static const uint8_t logo[48] = {
        0xCE,0xED,0x66,0x66,0xCC,0x0D,0x00,0x0B,
        0x03,0x73,0x00,0x83,0x00,0x0C,0x00,0x0D,
        0x00,0x08,0x11,0x1F,0x88,0x89,0x00,0x0E,
        0xDC,0xCC,0x6E,0xE6,0xDD,0xDD,0xD9,0x99,
        0xBB,0xBB,0x67,0x63,0x6E,0x0E,0xEC,0xCC,
        0xDD,0xDC,0x99,0x9F,0xBB,0xB9,0x33,0x3E,
    };
    memcpy(&rom_data[0x104], logo, 48);

    /* Title */
    rom_data[0x134] = 'T'; rom_data[0x135] = 'E';
    rom_data[0x136] = 'S'; rom_data[0x137] = 'T';

    /* Cartridge type 0x00 = ROM only, ROM 32 KB, no RAM */
    rom_data[0x147] = 0x00;
    rom_data[0x148] = 0x00;
    rom_data[0x149] = 0x00;

    /* Header checksum (bytes 0x134-0x14C) */
    {
        uint8_t ck = 0;
        for (int i = 0x134; i <= 0x14C; i++)
            ck = ck - rom_data[i] - 1;
        rom_data[0x14D] = ck;
    }

    /* ── GB machine code at 0x0150 ─────────────────────────────── */
    int pc = 0x0150;

    /* --- wait for VBlank so we can safely touch VRAM ------------ */
    int wait_vb = pc;
    rom_data[pc++] = 0xF0; rom_data[pc++] = 0x44;  /* LDH A,($44) ; LY   */
    rom_data[pc++] = 0xFE; rom_data[pc++] = 0x90;  /* CP  $90             */
    rom_data[pc++] = 0x20;                          /* JR  NZ, wait_vb    */
    rom_data[pc++] = (uint8_t)(wait_vb - pc);

    /* --- disable LCD -------------------------------------------- */
    rom_data[pc++] = 0x3E; rom_data[pc++] = 0x00;  /* LD  A, $00         */
    rom_data[pc++] = 0xE0; rom_data[pc++] = 0x40;  /* LDH ($40), A ;LCDC */

    /* --- tile 1: solid block (16 bytes of $FF at $8010) --------- */
    rom_data[pc++] = 0x21; rom_data[pc++] = 0x10;
    rom_data[pc++] = 0x80;                          /* LD  HL, $8010      */
    rom_data[pc++] = 0x3E; rom_data[pc++] = 0xFF;  /* LD  A, $FF         */
    rom_data[pc++] = 0x06; rom_data[pc++] = 0x10;  /* LD  B, $10         */
    int f1 = pc;
    rom_data[pc++] = 0x22;                          /* LD  (HL+), A       */
    rom_data[pc++] = 0x05;                          /* DEC B              */
    rom_data[pc++] = 0x20;                          /* JR  NZ, f1         */
    rom_data[pc++] = (uint8_t)(f1 - pc);

    /* --- tile 2: checkerboard (8 rows, $AA/$55 pattern) --------- */
    rom_data[pc++] = 0x06; rom_data[pc++] = 0x08;  /* LD  B, $08         */
    int ck = pc;
    rom_data[pc++] = 0x3E; rom_data[pc++] = 0xAA;  /* LD  A, $AA         */
    rom_data[pc++] = 0x22;                          /* LD  (HL+), A       */
    rom_data[pc++] = 0x3E; rom_data[pc++] = 0x55;  /* LD  A, $55         */
    rom_data[pc++] = 0x22;                          /* LD  (HL+), A       */
    rom_data[pc++] = 0x05;                          /* DEC B              */
    rom_data[pc++] = 0x20;                          /* JR  NZ, ck         */
    rom_data[pc++] = (uint8_t)(ck - pc);

    /* --- fill tilemap: border (tile 1) + inner (tile 2) --------- */

    /* top row: 20 × tile 1 */
    rom_data[pc++] = 0x21; rom_data[pc++] = 0x00;
    rom_data[pc++] = 0x98;                          /* LD  HL, $9800      */
    rom_data[pc++] = 0x06; rom_data[pc++] = 0x14;  /* LD  B, 20          */
    rom_data[pc++] = 0x3E; rom_data[pc++] = 0x01;  /* LD  A, $01         */
    int tr = pc;
    rom_data[pc++] = 0x22;                          /* LD  (HL+), A       */
    rom_data[pc++] = 0x05;                          /* DEC B              */
    rom_data[pc++] = 0x20;                          /* JR  NZ, tr         */
    rom_data[pc++] = (uint8_t)(tr - pc);

    /* skip 12 cols to next row */
    rom_data[pc++] = 0x7D;                          /* LD  A, L           */
    rom_data[pc++] = 0xC6; rom_data[pc++] = 0x0C;  /* ADD A, $0C         */
    rom_data[pc++] = 0x6F;                          /* LD  L, A           */
    rom_data[pc++] = 0x30; rom_data[pc++] = 0x01;  /* JR  NC, +1         */
    rom_data[pc++] = 0x24;                          /* INC H              */

    /* 16 middle rows */
    rom_data[pc++] = 0x16; rom_data[pc++] = 0x10;  /* LD  D, $10         */
    int mr = pc;
    /* left edge */
    rom_data[pc++] = 0x3E; rom_data[pc++] = 0x01;  /* LD  A, $01         */
    rom_data[pc++] = 0x22;                          /* LD  (HL+), A       */
    /* 18 inner tiles of checker */
    rom_data[pc++] = 0x06; rom_data[pc++] = 0x12;  /* LD  B, 18          */
    rom_data[pc++] = 0x3E; rom_data[pc++] = 0x02;  /* LD  A, $02         */
    int cf = pc;
    rom_data[pc++] = 0x22;                          /* LD  (HL+), A       */
    rom_data[pc++] = 0x05;                          /* DEC B              */
    rom_data[pc++] = 0x20;                          /* JR  NZ, cf         */
    rom_data[pc++] = (uint8_t)(cf - pc);
    /* right edge */
    rom_data[pc++] = 0x3E; rom_data[pc++] = 0x01;  /* LD  A, $01         */
    rom_data[pc++] = 0x22;                          /* LD  (HL+), A       */
    /* skip 12 */
    rom_data[pc++] = 0x7D;                          /* LD  A, L           */
    rom_data[pc++] = 0xC6; rom_data[pc++] = 0x0C;  /* ADD A, $0C         */
    rom_data[pc++] = 0x6F;                          /* LD  L, A           */
    rom_data[pc++] = 0x30; rom_data[pc++] = 0x01;  /* JR  NC, +1         */
    rom_data[pc++] = 0x24;                          /* INC H              */
    rom_data[pc++] = 0x15;                          /* DEC D              */
    rom_data[pc++] = 0x20;                          /* JR  NZ, mr         */
    rom_data[pc++] = (uint8_t)(mr - pc);

    /* bottom row: 20 × tile 1 */
    rom_data[pc++] = 0x06; rom_data[pc++] = 0x14;  /* LD  B, 20          */
    rom_data[pc++] = 0x3E; rom_data[pc++] = 0x01;  /* LD  A, $01         */
    int br = pc;
    rom_data[pc++] = 0x22;                          /* LD  (HL+), A       */
    rom_data[pc++] = 0x05;                          /* DEC B              */
    rom_data[pc++] = 0x20;                          /* JR  NZ, br         */
    rom_data[pc++] = (uint8_t)(br - pc);

    /* --- palette & LCD enable ----------------------------------- */
    rom_data[pc++] = 0x3E; rom_data[pc++] = 0xE4;  /* LD  A, $E4 ; BGP   */
    rom_data[pc++] = 0xE0; rom_data[pc++] = 0x47;  /* LDH ($47), A       */
    rom_data[pc++] = 0x3E; rom_data[pc++] = 0x91;  /* LD  A, $91 ; LCDC  */
    rom_data[pc++] = 0xE0; rom_data[pc++] = 0x40;  /* LDH ($40), A       */

    /* --- main loop: scroll background each frame ---------------- */
    int ml = pc;
    /* wait VBlank */
    int wv = pc;
    rom_data[pc++] = 0xF0; rom_data[pc++] = 0x44;  /* LDH A,($44)        */
    rom_data[pc++] = 0xFE; rom_data[pc++] = 0x90;  /* CP  $90             */
    rom_data[pc++] = 0x20;                          /* JR  NZ, wv          */
    rom_data[pc++] = (uint8_t)(wv - pc);
    /* increment SCX */
    rom_data[pc++] = 0xF0; rom_data[pc++] = 0x43;  /* LDH A,($43) ; SCX  */
    rom_data[pc++] = 0x3C;                          /* INC A              */
    rom_data[pc++] = 0xE0; rom_data[pc++] = 0x43;  /* LDH ($43), A       */
    /* wait for non-VBlank */
    int wn = pc;
    rom_data[pc++] = 0xF0; rom_data[pc++] = 0x44;  /* LDH A,($44)        */
    rom_data[pc++] = 0xFE; rom_data[pc++] = 0x90;  /* CP  $90             */
    rom_data[pc++] = 0x28;                          /* JR  Z, wn          */
    rom_data[pc++] = (uint8_t)(wn - pc);
    /* loop */
    rom_data[pc++] = 0x18;                          /* JR  ml              */
    rom_data[pc++] = (uint8_t)(ml - pc);
}

/* ── Battery saves ───────────────────────────────────────────────── */
static char sav_path[1024];

static void save_battery(void) {
    if (sav_path[0]) GB_save_battery(&gb, sav_path);
}

/* ── Input ───────────────────────────────────────────────────────── */
static void handle_input(void) {
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        if (event.type == SDL_EVENT_QUIT) {
            save_battery();
            exit(0);
        }
        if (event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP) {
            int pressed = (event.type == SDL_EVENT_KEY_DOWN);
            int key = -1;
            switch (event.key.key) {
            case SDLK_RIGHT:  key = GB_KEY_RIGHT;  break;
            case SDLK_LEFT:   key = GB_KEY_LEFT;   break;
            case SDLK_UP:     key = GB_KEY_UP;     break;
            case SDLK_DOWN:   key = GB_KEY_DOWN;   break;
            case 'z':         key = GB_KEY_A;      break;
            case 'x':         key = GB_KEY_B;      break;
            case SDLK_RETURN: key = GB_KEY_START;  break;
            case SDLK_RSHIFT: key = GB_KEY_SELECT; break;
            }
            if (key >= 0) GB_set_key_state(&gb, (GB_key_t)key, pressed);
        }
    }
}

/* ── Frame loop ──────────────────────────────────────────────────── */
#define FRAME_TIME_MS      (1000.0 * 70224.0 / 4194304.0) /* ~16.74 ms */
#define MAX_CATCHUP_FRAMES 4  /* don't spiral if too far behind */

static double next_frame_time;

static void frame_callback(void) {
    double now = (double)SDL_GetTicks();

    if (next_frame_time == 0.0)
        next_frame_time = now;

    if (now < next_frame_time)
        return;

    int frames = 0;
    while (next_frame_time <= now && frames < MAX_CATCHUP_FRAMES) {
        handle_input();
        GB_run_frame(&gb);
        next_frame_time += FRAME_TIME_MS;
        frames++;
    }

    if (next_frame_time <= now)
        next_frame_time = now + FRAME_TIME_MS;

    /* Drain accumulated audio, dropping if the queue is already full */
    if (audio_dev && audio_acc_len) {
        if ((int)SDL_GetAudioStreamQueued(audio_dev) < AUDIO_QUEUE_TARGET)
            SDL_PutAudioStreamData(audio_dev, audio_acc,
                                   audio_acc_len * 2 * sizeof(int16_t));
        audio_acc_len = 0;
    }

    if (!frame_ready)
        return;
    frame_ready = 0;

    /* Scale fb[] → window surface */
    uint32_t *dst = (uint32_t *)surface->pixels;
    int win_w = LCD_WIDTH * SCALE;
    for (int sy = 0; sy < LCD_HEIGHT; sy++) {
        for (int dy = 0; dy < SCALE; dy++) {
            uint32_t *row = &dst[(sy * SCALE + dy) * win_w];
            for (int sx = 0; sx < LCD_WIDTH; sx++) {
                uint32_t px = fb[sy * LCD_WIDTH + sx];
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
    int force_model = 0; /* 0 = header-based, 'd' = DMG, 'c' = CGB */

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--dmg") == 0)      force_model = 'd';
        else if (strcmp(argv[i], "--cgb") == 0) force_model = 'c';
        else rom_path = argv[i];
    }

    if (rom_path) {
        FILE *f = fopen(rom_path, "rb");
        if (!f) {
            printf("Cannot open ROM: %s\n", rom_path);
            return 1;
        }
        fseek(f, 0, SEEK_END);
        long n = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (n < 0x150) {
            printf("ROM too small (%ld bytes)\n", n);
            fclose(f);
            return 1;
        }
        rom_size = (size_t)n;
        rom_data = malloc(rom_size);
        if (!rom_data || fread(rom_data, 1, rom_size, f) != rom_size) {
            printf("Cannot read ROM: %s\n", rom_path);
            fclose(f);
            return 1;
        }
        fclose(f);
        printf("Loaded ROM: %ld bytes\n", n);
        snprintf(sav_path, sizeof(sav_path), "%s.sav", rom_path);
    } else {
        build_test_rom();
        printf("Using built-in test ROM\n");
    }

    GB_model_t model;
    if (force_model == 'd')      model = GB_MODEL_DMG_B;
    else if (force_model == 'c') model = GB_MODEL_CGB_E;
    else model = (rom_data[0x143] & 0x80) ? GB_MODEL_CGB_E : GB_MODEL_DMG_B;

    GB_init(&gb, model);
    GB_set_boot_rom_load_callback(&gb, boot_rom_load);
    GB_set_pixels_output(&gb, fb);
    GB_set_rgb_encode_callback(&gb, rgb_encode);
    GB_set_vblank_callback(&gb, vblank);
    GB_load_rom_from_buffer(&gb, rom_data, rom_size);
    if (sav_path[0]) GB_load_battery(&gb, sav_path); /* no-op if absent */

    printf("SameBoy core, model %s\n", GB_is_cgb(&gb) ? "CGB-E" : "DMG-B");

    SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO);
    window  = SDL_CreateWindow("SameBoy",
                  LCD_WIDTH * SCALE, LCD_HEIGHT * SCALE, 0);
    surface = SDL_GetWindowSurface(window);

    /* Audio */
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
    GB_set_sample_rate(&gb, AUDIO_RATE);
    GB_apu_set_sample_callback(&gb, sample_callback);

    __setAnimationFrameFunc(frame_callback);
    return 0;
}
