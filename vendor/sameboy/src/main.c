/*
 * SameBoy frontend for the C-to-WASM compiler — the accuracy/GBC sibling of
 * vendor/gameboy (Peanut-GB). This is the default .gb/.gbc handler (0072
 * store points at /bin/sameboy); Peanut-GB stays as the lighter alternate.
 *
 * Since todos/0260 (menu arch M3, §4.b) this is a WIN32 app — the CPU half
 * of the "one system, BOTH transports" proof: the menu experience (model,
 * tracking, popups-as-children, dismissal, agent targets) is the SAME
 * menucore path gpubox (M2, GPU transport) and notepad ride; the only
 * divergence from gpubox is the client present, which here is the normal
 * GDI bitmap transport (SetDIBits into a 160x144 bitmap, StretchBlt x3
 * into the client via GetDC/ReleaseDC — NOT CS_OWNCLIENT: user32 owns the
 * window surface exactly as for any CPU app). The frame callback pumps
 * PeekMessage (menu tracking, WM_TIMERs and the agent socket ride it),
 * then runs the UNCHANGED GB_run_frame cadence and blits.
 *
 * Usage:
 *   node compiler.js vendor/sameboy/bin.json -a compile -o sameboy.html
 *   sameboy [--dmg|--cgb] [rom.gb|rom.gbc]
 *
 * Menu:
 *   File      > Open ROM... (real comdlg32 GetOpenFileNameW -> the live
 *               reload path: battery save, GB_load_rom_from_buffer,
 *               GB_switch_model_and_reset), Quit
 *   Emulation > Pause, Reset, Auto Model / Force DMG / Force CGB
 *               (GB_switch_model_and_reset with the current cart)
 *   Options   > Palette > Greyscale / DMG Green / MGB / GB Light
 *               (GB_set_palette — DMG rendering only), Mute
 *   Save states are deliberately absent: core/save_state.c is not compiled
 *   into this port (bin.json sources), so offering the items would be a lie.
 *
 * Model selection: --dmg / --cgb force a model; otherwise the ROM header's
 * CGB flag (0x143 bit 7) picks CGB-E or DMG-B. SameBoy's own MIT boot ROMs
 * (v1.0.3 release binaries) are embedded — see bootroms.c.
 *
 * If no ROM file is provided, a built-in test ROM draws a scrolling
 * checkerboard border pattern (same program as vendor/gameboy's).
 *
 * Controls (same as vendor/gameboy, now via WM_KEYDOWN/UP):
 *   Arrow keys  = D-pad
 *   Z           = A button
 *   X           = B button
 *   Enter       = Start
 *   Shift       = Select
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>
#include <commdlg.h>
#include <SDL.h>

#include "gb.h"
#include "bootroms.h"

/* ── Display ─────────────────────────────────────────────────────── */
#define LCD_WIDTH  160
#define LCD_HEIGHT 144
#define SCALE      3

static HWND hwnd;
static HDC memdc;                /* holds the 160x144 frame bitmap */
static HBITMAP hbm;

/* SameBoy renders whole frames into this via GB_set_pixels_output */
static uint32_t fb[LCD_WIDTH * LCD_HEIGHT];
static int frame_ready;

/* ── Menu ────────────────────────────────────────────────────────── */
#define ID_OPEN        101
#define ID_QUIT        102
#define ID_PAUSE       201
#define ID_RESET       202
#define ID_MODEL_AUTO  211       /* ..213 contiguous: radio group */
#define ID_MODEL_DMG   212
#define ID_MODEL_CGB   213
#define ID_PAL_GREY    301       /* ..304 contiguous: radio group */
#define ID_PAL_DMG     302
#define ID_PAL_MGB     303
#define ID_PAL_GBL     304
#define ID_MUTE        311

static int paused;
static int muted;

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
static int force_model; /* 0 = header-based, 'd' = DMG, 'c' = CGB */

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

/* ── Model / ROM handling ────────────────────────────────────────── */
static GB_model_t pick_model(void) {
    if (force_model == 'd') return GB_MODEL_DMG_B;
    if (force_model == 'c') return GB_MODEL_CGB_E;
    return (rom_data[0x143] & 0x80) ? GB_MODEL_CGB_E : GB_MODEL_DMG_B;
}

static int read_rom_file(const char *path, uint8_t **out, size_t *out_size) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        printf("Cannot open ROM: %s\n", path);
        return 0;
    }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0x150) {
        printf("ROM too small (%ld bytes)\n", n);
        fclose(f);
        return 0;
    }
    uint8_t *buf = malloc((size_t)n);
    if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) {
        printf("Cannot read ROM: %s\n", path);
        free(buf);
        fclose(f);
        return 0;
    }
    fclose(f);
    printf("Loaded ROM: %ld bytes\n", n);
    fflush(stdout);
    *out = buf;
    *out_size = (size_t)n;
    return 1;
}

/* ── Frame present: fb -> DIB -> 160x144 bitmap -> StretchBlt x3 ─── */
static double next_frame_time;

static void present_frame(HDC dc) {
    /* rgb_encode() fills fb[] in SDL RGBA byte order (r in the low byte,
       kept verbatim from the SDL frontend); a 32bpp DIB word is 0xRRGGBB —
       swizzle into the staging buffer, then SetDIBits swizzles back into
       the bitmap's RGBA span. Greys and palette shades round-trip exactly
       (the e2e asserts the precise GB_PALETTE_* values). */
    static uint32_t dib[LCD_WIDTH * LCD_HEIGHT];
    for (int i = 0; i < LCD_WIDTH * LCD_HEIGHT; i++) {
        uint32_t v = fb[i];
        dib[i] = ((v & 0xFF) << 16) | (v & 0xFF00) | ((v >> 16) & 0xFF);
    }
    BITMAPINFO bmi;
    memset(&bmi, 0, sizeof(bmi));
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = LCD_WIDTH;
    bmi.bmiHeader.biHeight = -LCD_HEIGHT;        /* top-down, like fb */
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    SetDIBits(memdc, hbm, 0, LCD_HEIGHT, dib, &bmi, DIB_RGB_COLORS);
    StretchBlt(dc, 0, 0, LCD_WIDTH * SCALE, LCD_HEIGHT * SCALE,
               memdc, 0, 0, LCD_WIDTH, LCD_HEIGHT, SRCCOPY);
}

/* ── Menu construction & dispatch ────────────────────────────────── */
static void build_menu(HWND h) {
    HMENU file = CreatePopupMenu();
    AppendMenuA(file, MF_STRING, ID_OPEN, "&Open ROM...");
    AppendMenuA(file, MF_SEPARATOR, 0, NULL);
    AppendMenuA(file, MF_STRING, ID_QUIT, "&Quit");

    HMENU emu = CreatePopupMenu();
    AppendMenuA(emu, MF_STRING, ID_PAUSE, "&Pause");
    AppendMenuA(emu, MF_STRING, ID_RESET, "&Reset");
    AppendMenuA(emu, MF_SEPARATOR, 0, NULL);
    AppendMenuA(emu, MF_STRING | (force_model == 0 ? MF_CHECKED : 0),
                ID_MODEL_AUTO, "&Auto Model");
    AppendMenuA(emu, MF_STRING | (force_model == 'd' ? MF_CHECKED : 0),
                ID_MODEL_DMG, "Force &DMG");
    AppendMenuA(emu, MF_STRING | (force_model == 'c' ? MF_CHECKED : 0),
                ID_MODEL_CGB, "Force &CGB");

    HMENU pal = CreatePopupMenu();
    AppendMenuA(pal, MF_STRING | MF_CHECKED, ID_PAL_GREY, "&Greyscale");
    AppendMenuA(pal, MF_STRING, ID_PAL_DMG, "&DMG Green");
    AppendMenuA(pal, MF_STRING, ID_PAL_MGB, "&MGB");
    AppendMenuA(pal, MF_STRING, ID_PAL_GBL, "GB &Light");

    HMENU opts = CreatePopupMenu();
    AppendMenuA(opts, MF_POPUP, (UINT_PTR)pal, "&Palette");
    AppendMenuA(opts, MF_STRING, ID_MUTE, "&Mute");

    HMENU bar = CreateMenu();
    AppendMenuA(bar, MF_POPUP, (UINT_PTR)file, "&File");
    AppendMenuA(bar, MF_POPUP, (UINT_PTR)emu, "&Emulation");
    AppendMenuA(bar, MF_POPUP, (UINT_PTR)opts, "&Options");
    SetMenu(h, bar);
}

/* Exclusive check within a contiguous id range (model / palette radios). */
static void check_radio(HWND h, int lo, int hi, int sel) {
    for (int id = lo; id <= hi; id++)
        CheckMenuItem(GetMenu(h), (UINT)id,
                      MF_BYCOMMAND | (id == sel ? MF_CHECKED : MF_UNCHECKED));
}

static void a2w(const char *s, WCHAR *o, int cap) {
    int i = 0;
    for (; s[i] && i < cap - 1; i++) o[i] = (WCHAR)(unsigned char)s[i];
    o[i] = 0;
}
static void w2a(const WCHAR *w, char *o, int cap) {
    int i = 0;
    for (; w[i] && i < cap - 1; i++) o[i] = (char)w[i];
    o[i] = 0;
}

/* File > Open ROM...: the real comdlg32 modal into the live-reload path.
 * The dialog pumps inside this WM_COMMAND dispatch (the frame callback is
 * blocked, so the emulator naturally pauses while it is up — the modal
 * contract), and the agent drives it: settext EDIT + click Open. */
static void open_rom_dialog(void) {
    WCHAR wf[512];
    wf[0] = 0;
    OPENFILENAMEW ofn;
    memset(&ofn, 0, sizeof(ofn));
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = hwnd;
    ofn.lpstrFile = wf;
    ofn.nMaxFile = 512;
    ofn.lpstrTitle = u"Open ROM";
    ofn.Flags = OFN_FILEMUSTEXIST;
    if (!GetOpenFileNameW(&ofn)) return;

    char path[512];
    w2a(wf, path, sizeof(path));
    uint8_t *nd;
    size_t ns;
    if (!read_rom_file(path, &nd, &ns)) {
        MessageBox(hwnd, "Cannot load that file as a ROM.", "SameBoy", MB_OK);
        return;
    }
    save_battery();                  /* the outgoing game keeps its progress */
    free(rom_data);
    rom_data = nd;
    rom_size = ns;
    snprintf(sav_path, sizeof(sav_path), "%s.sav", path);
    GB_load_rom_from_buffer(&gb, rom_data, rom_size);
    GB_switch_model_and_reset(&gb, pick_model());
    GB_load_battery(&gb, sav_path);  /* no-op if absent */
    printf("SameBoy core, model %s\n", GB_is_cgb(&gb) ? "CGB-E" : "DMG-B");
    fflush(stdout);
    next_frame_time = 0.0;           /* re-baseline: no catch-up burst */
}

static const GB_palette_t *const dmg_palettes[4] = {
    &GB_PALETTE_GREY, &GB_PALETTE_DMG, &GB_PALETTE_MGB, &GB_PALETTE_GBL,
};

static LRESULT CALLBACK wndproc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        build_menu(h);
        return 0;
    case WM_COMMAND: {
        int id = LOWORD(wp);
        switch (id) {
        case ID_OPEN:
            open_rom_dialog();
            return 0;
        case ID_QUIT:
            PostMessage(h, WM_CLOSE, 0, 0);
            return 0;
        case ID_PAUSE:
            paused = !paused;
            CheckMenuItem(GetMenu(h), ID_PAUSE,
                          MF_BYCOMMAND | (paused ? MF_CHECKED : MF_UNCHECKED));
            if (!paused) next_frame_time = 0.0;  /* re-baseline, no burst */
            printf("sameboy: pause %s\n", paused ? "on" : "off");
            fflush(stdout);
            return 0;
        case ID_RESET:
            GB_reset(&gb);
            printf("sameboy: reset\n");
            fflush(stdout);
            return 0;
        case ID_MODEL_AUTO:
        case ID_MODEL_DMG:
        case ID_MODEL_CGB:
            force_model = id == ID_MODEL_DMG ? 'd'
                        : id == ID_MODEL_CGB ? 'c' : 0;
            GB_switch_model_and_reset(&gb, pick_model());
            check_radio(h, ID_MODEL_AUTO, ID_MODEL_CGB, id);
            printf("SameBoy core, model %s\n", GB_is_cgb(&gb) ? "CGB-E" : "DMG-B");
            fflush(stdout);
            return 0;
        case ID_PAL_GREY:
        case ID_PAL_DMG:
        case ID_PAL_MGB:
        case ID_PAL_GBL:
            GB_set_palette(&gb, dmg_palettes[id - ID_PAL_GREY]);
            check_radio(h, ID_PAL_GREY, ID_PAL_GBL, id);
            printf("sameboy: palette %d\n", id - ID_PAL_GREY);
            fflush(stdout);
            return 0;
        case ID_MUTE:
            muted = !muted;
            CheckMenuItem(GetMenu(h), ID_MUTE,
                          MF_BYCOMMAND | (muted ? MF_CHECKED : MF_UNCHECKED));
            return 0;
        }
        return 0;
    }
    case WM_KEYDOWN:
    case WM_KEYUP: {
        int key = -1;
        switch (wp) {
        case VK_RIGHT:  key = GB_KEY_RIGHT;  break;
        case VK_LEFT:   key = GB_KEY_LEFT;   break;
        case VK_UP:     key = GB_KEY_UP;     break;
        case VK_DOWN:   key = GB_KEY_DOWN;   break;
        case 'Z':       key = GB_KEY_A;      break;
        case 'X':       key = GB_KEY_B;      break;
        case VK_RETURN: key = GB_KEY_START;  break;
        case VK_SHIFT:  key = GB_KEY_SELECT; break;
        }
        if (key >= 0) GB_set_key_state(&gb, (GB_key_t)key, msg == WM_KEYDOWN);
        return 0;
    }
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        if (dc) present_frame(dc);
        EndPaint(h, &ps);
        return 0;
    }
    case WM_CLOSE:
        save_battery();
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ── Frame loop ──────────────────────────────────────────────────── */
#define FRAME_TIME_MS      (1000.0 * 70224.0 / 4194304.0) /* ~16.74 ms */
#define MAX_CATCHUP_FRAMES 4  /* don't spiral if too far behind */

static void frame_callback(void) {
    /* The win32 pump (menu arch §4.b): posted messages, menu tracking,
     * key input and the agent socket ride PeekMessage — the same pump
     * shape as gpubox (§4.a); only the client present below differs. */
    MSG m;
    while (PeekMessage(&m, NULL, 0, 0, PM_REMOVE)) {
        if (m.message == WM_QUIT) {
            save_battery();
            exit(0);
        }
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    if (paused) return;

    double now = (double)SDL_GetTicks();

    if (next_frame_time == 0.0)
        next_frame_time = now;

    if (now < next_frame_time)
        return;

    int frames = 0;
    while (next_frame_time <= now && frames < MAX_CATCHUP_FRAMES) {
        GB_run_frame(&gb);
        next_frame_time += FRAME_TIME_MS;
        frames++;
    }

    if (next_frame_time <= now)
        next_frame_time = now + FRAME_TIME_MS;

    /* Drain accumulated audio, dropping if the queue is already full */
    if (audio_dev && audio_acc_len) {
        if (!muted && (int)SDL_GetAudioStreamQueued(audio_dev) < AUDIO_QUEUE_TARGET)
            SDL_PutAudioStreamData(audio_dev, audio_acc,
                                   audio_acc_len * 2 * sizeof(int16_t));
        audio_acc_len = 0;
    }

    if (!frame_ready)
        return;
    frame_ready = 0;

    HDC dc = GetDC(hwnd);
    if (dc) {
        present_frame(dc);
        ReleaseDC(hwnd, dc);     /* present: shm mailbox flip */
    }
}

/* ── Entry point ─────────────────────────────────────────────────── */
int main(int argc, char **argv) {
    const char *rom_path = NULL;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--dmg") == 0)      force_model = 'd';
        else if (strcmp(argv[i], "--cgb") == 0) force_model = 'c';
        else rom_path = argv[i];
    }

    if (rom_path) {
        if (!read_rom_file(rom_path, &rom_data, &rom_size)) return 1;
        snprintf(sav_path, sizeof(sav_path), "%s.sav", rom_path);
    } else {
        build_test_rom();
        printf("Using built-in test ROM\n");
    }

    GB_init(&gb, pick_model());
    GB_set_boot_rom_load_callback(&gb, boot_rom_load);
    GB_set_pixels_output(&gb, fb);
    GB_set_rgb_encode_callback(&gb, rgb_encode);
    GB_set_vblank_callback(&gb, vblank);
    GB_load_rom_from_buffer(&gb, rom_data, rom_size);
    if (sav_path[0]) GB_load_battery(&gb, sav_path); /* no-op if absent */

    printf("SameBoy core, model %s\n", GB_is_cgb(&gb) ? "CGB-E" : "DMG-B");

    /* Window: a normal win32 top-level (fixed-size — no WS_THICKFRAME;
     * fixed windows scale via SET_DST like doom/quake). AdjustWindowRect
     * reserves the menu bar strip above the 480x432 client. */
    WNDCLASS wc;
    memset(&wc, 0, sizeof(wc));
    wc.lpfnWndProc = wndproc;
    wc.lpszClassName = "sameboy";
    RegisterClass(&wc);
    RECT r;
    SetRect(&r, 0, 0, LCD_WIDTH * SCALE, LCD_HEIGHT * SCALE);
    AdjustWindowRect(&r, 0, TRUE);
    hwnd = CreateWindowEx(0, "sameboy", "SameBoy", 0, 0, 0,
                          r.right - r.left, r.bottom - r.top,
                          NULL, NULL, NULL, NULL);
    if (!hwnd) { fprintf(stderr, "sameboy: no window\n"); return 3; }

    /* Frame transport: one 160x144 bitmap in a memory DC, StretchBlt x3
     * into the client each present. */
    {
        HDC dc = GetDC(hwnd);
        hbm = CreateCompatibleBitmap(dc, LCD_WIDTH, LCD_HEIGHT);
        memdc = CreateCompatibleDC(dc);
        SelectObject(memdc, hbm);
        ReleaseDC(hwnd, dc);
    }

    /* Audio (unchanged from the SDL frontend — user32 owns VIDEO init,
     * the audio subsystem is additive) */
    SDL_Init(SDL_INIT_AUDIO);
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
