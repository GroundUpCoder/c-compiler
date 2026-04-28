/*
 * Peanut-GB demo for the C-to-WASM compiler.
 *
 * Usage:
 *   ./a.out -a compile -o /tmp/gb.wasm samples/gameboy/*.c
 *   node host.js /tmp/gb.wasm [rom.gb]
 *
 * If no ROM file is provided, a built-in test ROM is used that draws
 * a scrolling checkerboard border pattern.
 *
 * Controls:
 *   Arrow keys  = D-pad
 *   Z           = A button
 *   X           = B button
 *   Enter       = Start
 *   Right Shift = Select
 */

/* Peanut-GB config — must come before include */
#define PEANUT_GB_IS_LITTLE_ENDIAN 1
#define ENABLE_SOUND 1
#define ENABLE_LCD 1
#define PEANUT_GB_12_COLOUR 0

#include <stdint.h>

/* uint_fast types missing from this compiler's stdint.h */
typedef uint8_t   uint_fast8_t;
typedef uint32_t  uint_fast16_t;
typedef uint32_t  uint_fast32_t;
typedef int32_t   int_fast16_t;
typedef int32_t   int_fast32_t;
#define INT_FAST16_MAX INT32_MAX

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <SDL.h>

#include "gbapu.h"

/* ── Audio ──────────────────────────────────────────────────────── */
static gbapu_t apu;
static SDL_AudioDeviceID audio_dev;

#define AUDIO_RATE       44100
#define AUDIO_BUF_FRAMES 735   /* ~1 GB frame at 44100/59.73 */
#define AUDIO_QUEUE_TARGET (AUDIO_RATE * 4 / 10) /* ~100ms stereo S16 bytes */

/* Peanut-GB audio callbacks — must precede peanut_gb.h include */
uint8_t audio_read(uint16_t addr) {
    return gbapu_read(&apu, addr);
}

void audio_write(uint16_t addr, uint8_t val) {
    gbapu_write(&apu, addr, val);
}

#include "peanut_gb.h"

/* ── Display ─────────────────────────────────────────────────────── */
#define LCD_WIDTH  160
#define LCD_HEIGHT 144
#define SCALE      3

static SDL_Window   *window;
static SDL_Surface  *surface;

/* RGBA32 framebuffer */
static uint32_t fb[LCD_WIDTH * LCD_HEIGHT];

/* Classic green palette (lightest → darkest), ABGR8888 format for SDL_PIXELFORMAT_RGBA32 */
static const uint32_t palette[4] = {
    0xFF0FBC9B,
    0xFF0FAC8B,
    0xFF306230,
    0xFF0F380F,
};

/* ── Emulator state ──────────────────────────────────────────────── */
static struct gb_s gb;

#define ROM_MAX (8 * 1024 * 1024)  /* 8 MB max ROM (MBC5) */
static uint8_t rom_data[ROM_MAX];
static uint8_t cart_ram[32768];

/* ── Peanut-GB callbacks ─────────────────────────────────────────── */
static uint8_t rom_read(struct gb_s *gb, const uint_fast32_t addr) {
    (void)gb;
    if (addr >= ROM_MAX) {
        printf("ROM read out of bounds: 0x%X\n", (unsigned)addr);
        return 0xFF;
    }
    return rom_data[addr];
}

static uint8_t cart_ram_read(struct gb_s *gb, const uint_fast32_t addr) {
    (void)gb;
    if (addr >= 32768) {
        printf("Cart RAM read out of bounds: 0x%X\n", (unsigned)addr);
        return 0xFF;
    }
    return cart_ram[addr];
}

static void cart_ram_write(struct gb_s *gb, const uint_fast32_t addr,
                           const uint8_t val) {
    (void)gb;
    if (addr >= 32768) {
        printf("Cart RAM write out of bounds: 0x%X\n", (unsigned)addr);
        return;
    }
    cart_ram[addr] = val;
}

static void error_handler(struct gb_s *gb, const enum gb_error_e err,
                           const uint16_t addr) {
    (void)gb;
    const char *s;
    switch (err) {
    case GB_INVALID_OPCODE: s = "invalid opcode"; break;
    case GB_INVALID_READ:   s = "invalid read";   break;
    case GB_INVALID_WRITE:  s = "invalid write";  break;
    default:                s = "unknown";         break;
    }
    printf("GB error: %s at 0x%04X\n", s, addr);
}

/* LCD line callback: convert 2-bit pixel data → RGBA32 framebuffer */
static void lcd_draw_line(struct gb_s *gb, const uint8_t *pixels,
                          const uint_fast8_t line) {
    (void)gb;
    uint32_t *row = &fb[line * LCD_WIDTH];
    for (int x = 0; x < LCD_WIDTH; x++)
        row[x] = palette[pixels[x] & 0x03];
}

/* ── Built-in test ROM ───────────────────────────────────────────── */
static void build_test_rom(void) {
    memset(rom_data, 0x00, ROM_MAX);

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

/* ── Input ───────────────────────────────────────────────────────── */
static void handle_input(void) {
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        if (event.type == SDL_QUIT) {
            exit(0);
        }
        if (event.type == SDL_KEYDOWN || event.type == SDL_KEYUP) {
            int pressed = (event.type == SDL_KEYDOWN);
            uint8_t mask = 0;
            switch (event.key.keysym.sym) {
            case SDLK_RIGHT:  mask = JOYPAD_RIGHT;  break;
            case SDLK_LEFT:   mask = JOYPAD_LEFT;   break;
            case SDLK_UP:     mask = JOYPAD_UP;     break;
            case SDLK_DOWN:   mask = JOYPAD_DOWN;   break;
            case 'z':         mask = JOYPAD_A;      break;
            case 'x':         mask = JOYPAD_B;      break;
            case SDLK_RETURN: mask = JOYPAD_START;  break;
            case SDLK_RSHIFT: mask = JOYPAD_SELECT; break;
            }
            if (mask) {
                if (pressed)
                    gb.direct.joypad &= ~mask;   /* active low */
                else
                    gb.direct.joypad |= mask;
            }
        }
    }
}

/* ── Frame loop ──────────────────────────────────────────────────── */
#define FRAME_TIME_MS  (1000.0 / VERTICAL_SYNC)  /* ~16.74 ms */
#define MAX_CATCHUP_FRAMES 4  /* don't spiral if too far behind */

static double next_frame_time;

static void frame_callback(void) {
    double now = (double)SDL_GetTicks();

    /* First call: initialize timing */
    if (next_frame_time == 0.0)
        next_frame_time = now;

    /* Too early — skip this callback */
    if (now < next_frame_time)
        return;

    /* Run however many frames we owe, up to a cap */
    int frames = 0;
    while (next_frame_time <= now && frames < MAX_CATCHUP_FRAMES) {
        handle_input();
        gb_run_frame(&gb);
        next_frame_time += FRAME_TIME_MS;
        frames++;
    }

    /* If we're still behind after max catchup, reset to avoid spiral */
    if (next_frame_time <= now)
        next_frame_time = now + FRAME_TIME_MS;

    /* Feed audio queue */
    if (audio_dev) {
        while ((int)SDL_GetQueuedAudioSize(audio_dev) < AUDIO_QUEUE_TARGET) {
            int16_t audio_buf[AUDIO_BUF_FRAMES * 2];
            gbapu_generate(&apu, audio_buf, AUDIO_BUF_FRAMES);
            SDL_QueueAudio(audio_dev, audio_buf, sizeof(audio_buf));
        }
    }

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
    SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO);
    window  = SDL_CreateWindow("Peanut-GB",
                  0, 0, LCD_WIDTH * SCALE, LCD_HEIGHT * SCALE, 0);
    surface = SDL_GetWindowSurface(window);

    if (argc > 1) {
        FILE *f = fopen(argv[1], "rb");
        if (!f) {
            printf("Cannot open ROM: %s\n", argv[1]);
            return 1;
        }
        size_t n = fread(rom_data, 1, ROM_MAX, f);
        fclose(f);
        if (n < 0x150) {
            printf("ROM too small (%d bytes)\n", (int)n);
            return 1;
        }
        printf("Loaded ROM: %d bytes\n", (int)n);
    } else {
        build_test_rom();
        printf("Using built-in test ROM\n");
    }

    enum gb_init_error_e ret = gb_init(&gb, rom_read, cart_ram_read,
                                       cart_ram_write, error_handler, 0);
    if (ret != GB_INIT_NO_ERROR) {
        printf("gb_init failed: %d\n", (int)ret);
        return 1;
    }

    gb_init_lcd(&gb, lcd_draw_line);

    char title[16];
    gb_get_rom_name(&gb, title);
    printf("ROM: %s\n", title);

    /* Audio setup */
    gbapu_init(&apu, AUDIO_RATE);
    {
        SDL_AudioSpec want;
        memset(&want, 0, sizeof(want));
        want.freq = AUDIO_RATE;
        want.format = AUDIO_S16;
        want.channels = 2;
        audio_dev = SDL_OpenAudioDevice(0, 0, &want, 0, 0);
        if (audio_dev)
            SDL_PauseAudioDevice(audio_dev, 0);
    }

    __setAnimationFrameFunc(frame_callback);
    return 0;
}
