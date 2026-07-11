/*
 *  c-compiler puNES frontend (GPLv3): the SDL3 entry point.
 *
 *  Replaces puNES's Qt shell (core/main.c + gui/*). We do the core's power-on
 *  sequence by hand (memmap/ppu init → emu_turn_on), then run one NES frame per
 *  host animation-frame, read the PPU's completed palette-index buffer straight
 *  out of nes[0].p.ppu_screen, map it through an RGB NES palette into the SDL
 *  window surface, drain the APU ring into the SDL audio stream, and feed the
 *  keyboard into controller port 0.
 *
 *  With no ROM argument a built-in NROM test ROM fills the screen (the headless
 *  pixel-test target, mirroring /bin/sameboy and /bin/mgba).
 *
 *  Controls: arrows = D-pad, Z = A, X = B, Enter = Start, Right Shift = Select.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <SDL.h>

#include "common.h"
#include "info.h"
#include "conf.h"
#include "nes.h"
#include "emu.h"
#include "ppu.h"
#include "memmap.h"
#include "input.h"
#include "clock.h"

/* ── from our other frontend TUs ─────────────────────────────────────── */
void pn_config_defaults(void);
int pn_snd_drain(SWORD *out, int max);
int pn_snd_channels(void);
int pn_snd_samplerate(void);

/* ── display ─────────────────────────────────────────────────────────── */
#define NES_W SCR_COLUMNS   /* 256 */
#define NES_H SCR_ROWS      /* 240 */
#define SCALE 2

static SDL_Window  *window;
static SDL_Surface *surface;
static uint32_t fb[NES_W * NES_H];

/* Standard NES palette (2C02), RGB — the common "FCEUX"-style values. */
static const uint8_t nes_pal[64][3] = {
	{ 84, 84, 84},{  0, 30,116},{  8, 16,144},{ 48,  0,136},{ 68,  0,100},{ 92,  0, 48},{ 84,  4,  0},{ 60, 24,  0},
	{ 32, 42,  0},{  8, 58,  0},{  0, 64,  0},{  0, 60,  0},{  0, 50, 60},{  0,  0,  0},{  0,  0,  0},{  0,  0,  0},
	{152,150,152},{  8, 76,196},{ 48, 50,236},{ 92, 30,228},{136, 20,176},{160, 20,100},{152, 34, 32},{120, 60,  0},
	{ 84, 90,  0},{ 40,114,  0},{  8,124,  0},{  0,118, 40},{  0,102,120},{  0,  0,  0},{  0,  0,  0},{  0,  0,  0},
	{236,238,236},{ 76,154,236},{120,124,236},{176, 98,236},{228, 84,236},{236, 88,180},{236,106,100},{212,136, 32},
	{160,170,  0},{116,196,  0},{ 76,208, 32},{ 56,204,108},{ 56,180,204},{ 60, 60, 60},{  0,  0,  0},{  0,  0,  0},
	{236,238,236},{168,204,236},{188,188,236},{212,178,236},{236,174,236},{236,174,212},{236,180,176},{228,196,144},
	{204,210,120},{180,222,120},{168,226,144},{152,226,180},{160,214,228},{160,162,160},{  0,  0,  0},{  0,  0,  0},
};

/* ── audio ───────────────────────────────────────────────────────────── */
#define AUDIO_QUEUE_TARGET_MS 100
static SDL_AudioStream *audio_dev;
static SWORD audio_acc[8192];

/* ── controller state (port 0) ──────────────────────────────────────── */
static void set_button(int idx, int pressed) {
	port[0].data.treated[idx] = pressed ? PRESSED : RELEASED;
}

static void handle_input(void) {
	SDL_Event event;
	while (SDL_PollEvent(&event)) {
		if (event.type == SDL_EVENT_QUIT) {
			SDL_Quit();
			exit(0);
		}
		if (event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP) {
			int pressed = (event.type == SDL_EVENT_KEY_DOWN);
			switch (event.key.key) {
			case SDLK_RIGHT:  set_button(RIGHT, pressed);  break;
			case SDLK_LEFT:   set_button(LEFT, pressed);   break;
			case SDLK_UP:     set_button(UP, pressed);     break;
			case SDLK_DOWN:   set_button(DOWN, pressed);   break;
			case 'z':         set_button(BUT_A, pressed);  break;
			case 'x':         set_button(BUT_B, pressed);  break;
			case SDLK_RETURN: set_button(START, pressed);  break;
			case SDLK_RSHIFT: set_button(SELECT, pressed); break;
			}
		}
	}
}

/* ── present the PPU's completed frame ───────────────────────────────── */
static void present(void) {
	_ppu_screen_buffer *sb = nes[0].p.ppu_screen.last_completed_wr;
	int win_w = NES_W * SCALE;

	if (!sb || !sb->data) {
		return;
	}
	for (int y = 0; y < NES_H; y++) {
		WORD *src = sb->line[y];
		for (int x = 0; x < NES_W; x++) {
			int idx = src[x] & 0x3F;
			const uint8_t *c = nes_pal[idx];
			/* SDL_PIXELFORMAT_RGBA32: little-endian value 0xAABBGGRR */
			fb[y * NES_W + x] = 0xFF000000u | ((uint32_t)c[2] << 16) | ((uint32_t)c[1] << 8) | c[0];
		}
	}
	{
		uint32_t *dst = (uint32_t *)surface->pixels;
		for (int sy = 0; sy < NES_H; sy++) {
			for (int dy = 0; dy < SCALE; dy++) {
				uint32_t *row = &dst[(sy * SCALE + dy) * win_w];
				for (int sx = 0; sx < NES_W; sx++) {
					uint32_t px = fb[sy * NES_W + sx];
					for (int dx = 0; dx < SCALE; dx++) {
						row[sx * SCALE + dx] = px;
					}
				}
			}
		}
		SDL_UpdateWindowSurface(window);
	}
}

/* ── frame loop ──────────────────────────────────────────────────────── */
static void frame_callback(void) {
	handle_input();
	emu_frame();
	present();

	if (audio_dev) {
		int target = pn_snd_samplerate() * pn_snd_channels() * 2 * AUDIO_QUEUE_TARGET_MS / 1000;
		int n = pn_snd_drain(audio_acc, (int)(sizeof(audio_acc) / sizeof(audio_acc[0])));
		if (n && ((int)SDL_GetAudioStreamQueued(audio_dev) < target)) {
			SDL_PutAudioStreamData(audio_dev, audio_acc, n * (int)sizeof(SWORD));
		}
	}
}

/* ── built-in NROM test ROM ──────────────────────────────────────────────
 * A minimal NROM-256 image whose 6502 waits out the PPU warm-up, writes a
 * distinctive backdrop colour ($21, a bright blue) into palette entry 0 and
 * turns rendering on. The whole visible frame is therefore that one CPU-chosen
 * colour — the same "solid fill" acceptance shape as /bin/mgba's MODE 3 red
 * test ROM: it proves the ROM loaded (mapper 0), the 6502 executed, the PPU
 * applied the palette and the frame reached the SDL surface (i.e. not a
 * cleared/host-default window). */
static uint8_t test_rom[16 + 32768 + 8192];
static size_t build_test_rom(void) {
	uint8_t *h = test_rom;
	uint8_t *prg = test_rom + 16;

	memset(test_rom, 0, sizeof(test_rom));
	/* iNES header: NROM-256 (2x16K PRG), 1x8K CHR, horizontal mirroring */
	h[0] = 'N'; h[1] = 'E'; h[2] = 'S'; h[3] = 0x1A;
	h[4] = 2;
	h[5] = 1;
	h[6] = 0x00;

	/* reset vector → $8000; IRQ → $8000 (harmless); NMI patched below */
	prg[0x7FFC] = 0x00; prg[0x7FFD] = 0x80;
	prg[0x7FFE] = 0x00; prg[0x7FFF] = 0x80;

	{
		int pc = 0;
		#define EMIT(b) prg[pc++] = (uint8_t)(b)
		#define LDA_IMM(v) do { EMIT(0xA9); EMIT(v); } while (0)
		#define LDX_IMM(v) do { EMIT(0xA2); EMIT(v); } while (0)
		#define STA_PPU(reg) do { EMIT(0x8D); EMIT(reg); EMIT(0x20); } while (0)
		#define STX_PPU(reg) do { EMIT(0x8E); EMIT(reg); EMIT(0x20); } while (0)
		/* SEI; CLD */
		EMIT(0x78); EMIT(0xD8);
		/* PPU off while it warms up */
		LDX_IMM(0x00); STX_PPU(0x00); STX_PPU(0x01);
		/* wait two vblanks so the PPU is ready to accept $2000/$2001 writes —
		 * enabling rendering before warm-up is silently ignored (real 2C02
		 * behaviour puNES emulates). */
		{
			int vw1 = pc;                 /* BIT $2002 ; BPL vw1 */
			EMIT(0x2C); EMIT(0x02); EMIT(0x20);
			EMIT(0x10); EMIT((vw1 - (pc + 1)) & 0xFF);
			int vw2 = pc;
			EMIT(0x2C); EMIT(0x02); EMIT(0x20);
			EMIT(0x10); EMIT((vw2 - (pc + 1)) & 0xFF);
		}
		/* backdrop colour $21 (bright blue) into palette entry 0 @ $3F00 */
		LDA_IMM(0x3F); STA_PPU(0x06);
		LDA_IMM(0x00); STA_PPU(0x06);
		LDA_IMM(0x21); STA_PPU(0x07);
		/* reset VRAM address + scroll to top-left, then enable rendering */
		LDA_IMM(0x00); STA_PPU(0x06); STA_PPU(0x06);
		LDA_IMM(0x00); STA_PPU(0x05); STA_PPU(0x05);
		LDA_IMM(0x1E); STA_PPU(0x01);   /* show background + sprites */
		LDA_IMM(0x80); STA_PPU(0x00);   /* NMI on, bg pattern table 0 */
		/* forever: JMP self */
		int self = pc;
		EMIT(0x4C); EMIT((self + 0x8000) & 0xFF); EMIT(((self + 0x8000) >> 8) & 0xFF);

		/* ── NMI handler: poll controller 1, tint the backdrop ─────────
		 * Fires each vblank. Strobes $4016, reads the A-button bit, and
		 * rewrites palette entry 0 = $30 (white) while A is held, else $21
		 * (blue). This makes the built-in ROM input-responsive so the e2e
		 * can inject a button and assert the frame reacts — the coverage the
		 * port[].type = CTRL_STANDARD controller wiring needs. */
		int nmi = pc;
		LDA_IMM(0x01); EMIT(0x8D); EMIT(0x16); EMIT(0x40);   /* STA $4016 (strobe on) */
		LDA_IMM(0x00); EMIT(0x8D); EMIT(0x16); EMIT(0x40);   /* STA $4016 (strobe off) */
		EMIT(0xAD); EMIT(0x16); EMIT(0x40);                  /* LDA $4016 (A button) */
		EMIT(0x29); EMIT(0x01);                              /* AND #$01 */
		int beq = pc; EMIT(0xF0); EMIT(0x00);                /* BEQ notpressed (patched) */
		LDA_IMM(0x30);                                       /* A held → white */
		int bne = pc; EMIT(0xD0); EMIT(0x00);                /* BNE writepal (patched) */
		int notpressed = pc;
		prg[beq + 1] = (uint8_t)(notpressed - (beq + 2));
		LDA_IMM(0x21);                                       /* not held → blue */
		int writepal = pc;
		prg[bne + 1] = (uint8_t)(writepal - (bne + 2));
		EMIT(0x48);                                          /* PHA (save colour) */
		LDA_IMM(0x3F); STA_PPU(0x06);
		LDA_IMM(0x00); STA_PPU(0x06);
		EMIT(0x68);                                          /* PLA (restore colour) */
		STA_PPU(0x07);                                       /* → palette $3F00 */
		LDA_IMM(0x00); STA_PPU(0x06); STA_PPU(0x06);         /* reset VRAM addr off palette */
		EMIT(0x40);                                          /* RTI */

		prg[0x7FFA] = (uint8_t)((nmi + 0x8000) & 0xFF);
		prg[0x7FFB] = (uint8_t)(((nmi + 0x8000) >> 8) & 0xFF);
		#undef EMIT
		#undef LDA_IMM
		#undef LDX_IMM
		#undef STA_PPU
		#undef STX_PPU
	}
	return (sizeof(test_rom));
}

int main(int argc, char **argv) {
	const char *rom_path = NULL;

	for (int i = 1; i < argc; i++) {
		if (argv[i][0] != '-') {
			rom_path = argv[i];
		}
	}

	/* ── core globals power-on (mirrors core/main.c) ─────────────── */
	memset(&info, 0x00, sizeof(info));
	for (int n = 0; n < NES_CHIPS_MAX; n++) {
		memset(&nes[n].m.memmap, 0x00, sizeof(nes[n].m.memmap));
		memset(&nes[n].m.vram, 0x00, sizeof(nes[n].m.vram));
		memset(&nes[n].m.ram, 0x00, sizeof(nes[n].m.ram));
		memset(&nes[n].m.nmt, 0x00, sizeof(nes[n].m.nmt));
	}
	memset(&prgrom, 0x00, sizeof(prgrom));
	memset(&chrrom, 0x00, sizeof(chrrom));
	memset(&wram, 0x00, sizeof(wram));
	memset(&miscrom, 0x00, sizeof(miscrom));

	info.number_of_nes = 1;

	if (memmap_init() == EXIT_ERROR) {
		fprintf(stderr, "punes: memmap_init failed\n");
		return (1);
	}

	info.no_rom = TRUE;
	info.doublebuffer = TRUE;
	info.machine[HEADER] = info.machine[DATABASE] = DEFAULT;

	pn_config_defaults();

	/* Wire a standard controller onto both ports. input_init() (run inside
	 * emu_turn_on) only installs the standard-controller read handler when
	 * port[].type == CTRL_STANDARD; otherwise the read is input_rd_disabled and
	 * the game sees no input. puNES's Qt shell sets this from settings — our
	 * frontend must do it explicitly. set_button() then drives
	 * port[0].data.treated[], which the read strobes out on $4016. */
	port[0].type = CTRL_STANDARD;
	port[1].type = CTRL_STANDARD;

	/* point the core at our ROM (file path, or write the test ROM out) */
	if (rom_path) {
		snprintf(info.rom.file, sizeof(info.rom.file), "%s", rom_path);
		printf("punes: loading %s\n", rom_path);
	} else {
		FILE *f = fopen("/tmp/punes-test.nes", "wb");
		if (f) {
			fwrite(test_rom, 1, build_test_rom(), f);
			fclose(f);
			snprintf(info.rom.file, sizeof(info.rom.file), "/tmp/punes-test.nes");
		}
		printf("punes: using built-in test ROM\n");
	}
	info.no_rom = FALSE;

	ppu_init();

	if (emu_turn_on()) {
		fprintf(stderr, "punes: emu_turn_on failed\n");
		return (1);
	}

	/* ── SDL ─────────────────────────────────────────────────────── */
	SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO);
	window = SDL_CreateWindow("puNES", NES_W * SCALE, NES_H * SCALE, 0);
	surface = SDL_GetWindowSurface(window);

	{
		SDL_AudioSpec want;
		memset(&want, 0, sizeof(want));
		want.freq = pn_snd_samplerate();
		want.format = SDL_AUDIO_S16;
		want.channels = pn_snd_channels();
		audio_dev = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &want, 0, 0);
		if (audio_dev) {
			SDL_ResumeAudioStreamDevice(audio_dev);
		}
	}

	__setAnimationFrameFunc(frame_callback);
	return (0);
}
