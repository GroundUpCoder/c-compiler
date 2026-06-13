/* Comanche-style voxel landscape, bare-metal x86, VGA Mode 13h.

   Set palette to 3-3-2 RGB (8R × 8G × 4B = 256 entries).
   Generate heightmap + colormap from a sin-cos noise.
   Each frame:  spiral-camera, per-column front-to-back ray walk, y-buffer.

   No libc, no libm — fmath.c provides sin/cos/sqrt, etc. */

#include "fmath.h"

/* CRITICAL: TCC links functions in source order — the boot loader jumps
   to offset 0 of kernel.bin so the FIRST function defined here must be the
   entry point.  Without this stub, the loader runs whatever happens to
   compile first (which is whatever your editor saved most recently in the
   bottom of the file — recipe for hours of head-scratching). */
void _start(void);
void __entry(void) { _start(); }

#define W   320
#define H   200
#define MAP 512
#define MAPMASK (MAP - 1)

static volatile unsigned char *const FB = (unsigned char *)0xA0000;

/* Big buffers live at FIXED high-memory addresses, NOT in .bss.
   The kernel links at 0x10000; with these as .bss arrays (512K maps +
   64K backbuf) the .bss ran 0x122BC..0xA21BC — i.e. the last ~8.2 KB of
   backbuf sat INSIDE the VGA window at 0xA0000. Every render wrote the
   bottom ~25.5 backbuf rows straight onto screen rows 0..25 (the "roll" /
   gray-band artifact). Placing them above 2 MiB (flat segments, A20 on,
   32 MiB RAM, stack at 3 MiB grows down) keeps .bss tiny and far from VGA. */
static unsigned char *const heightmap = (unsigned char *)0x200000; /* 256 KiB */
static unsigned char *const colormap  = (unsigned char *)0x240000; /* 256 KiB */
static int           *const ybuf      = (int *)          0x280000; /* 1280 B  */
/* Back buffer: render here, then atomically blit to FB at end of frame.
   Without this the screenshot pipeline catches mid-render — sky drawn,
   terrain columns not yet painted in. */
static unsigned char *const backbuf   = (unsigned char *)0x281000; /* 64000 B, ends 0x290A00 */

/* ---- Port I/O ---- */
static inline void outb(unsigned short port, unsigned char val) {
    __asm__ volatile ("outb %%al, %%dx" : : "a"(val), "d"(port));
}

/* ---- VGA palette (3-3-2 RGB) ---- */
static void set_palette(void) {
    /* Mode 13h palette ports: 0x3C8 = write index, 0x3C9 = R/G/B (6-bit each). */
    outb(0x3C8, 0);
    for (int i = 0; i < 256; i++) {
        int r3 = (i >> 5) & 7;
        int g3 = (i >> 2) & 7;
        int b2 = (i >> 0) & 3;
        /* Scale 3-bit (0..7) → 6-bit (0..63); 2-bit (0..3) → 6-bit. */
        outb(0x3C9, (unsigned char)(r3 * 9));
        outb(0x3C9, (unsigned char)(g3 * 9));
        outb(0x3C9, (unsigned char)(b2 * 21));
    }
}

static unsigned char pack332(int r, int g, int b) {
    if (r < 0) r = 0; if (r > 255) r = 255;
    if (g < 0) g = 0; if (g > 255) g = 255;
    if (b < 0) b = 0; if (b > 255) b = 255;
    return (unsigned char)((((r >> 5) & 7) << 5) | (((g >> 5) & 7) << 2) | ((b >> 6) & 3));
}

/* ---- Terrain generation ---- */
static float fnoise(float x, float y) {
    float v = 0.0f;
    v += 1.000f * fm_sinf(x * 0.013f) * fm_cosf(y * 0.011f);
    v += 0.500f * fm_sinf(x * 0.029f) * fm_cosf(y * 0.031f + 0.5f);
    v += 0.250f * fm_sinf(x * 0.061f + 1.0f) * fm_cosf(y * 0.071f);
    v += 0.125f * fm_sinf(x * 0.131f) * fm_cosf(y * 0.121f + 0.3f);
    return v;
}

static void gen_terrain(void) {
    for (int y = 0; y < MAP; y++) {
        for (int x = 0; x < MAP; x++) {
            float h = fnoise((float)x, (float)y);
            int height = (int)((h + 2.0f) * 60.0f);
            if (height < 0) height = 0;
            if (height > 255) height = 255;
            heightmap[y * MAP + x] = (unsigned char)height;

            int r, g, b;
            if (height <  50)      { r =  20; g =  60; b = 140; }
            else if (height <  70) { r =  40; g =  90; b = 170; }
            else if (height <  85) { r = 200; g = 180; b = 120; }
            else if (height < 160) { r =  50; g = 100 + (height -  85) / 2; b =  30; }
            else if (height < 210) { r = 110 + (height - 160); g = 90 + (height - 160) / 2; b = 70; }
            else                   { r = 240; g = 245; b = 250; }
            colormap[y * MAP + x] = pack332(r, g, b);
        }
    }
}

/* ---- Render ---- */
static void render(float px, float py, float phc, float phi, float pitch_tan) {
    /* Sky: gradient (palette indices that map to a sky-like color). */
    for (int y = 0; y < H; y++) {
        unsigned char sky = pack332(80 + y / 2, 120 + y / 3, 200 - y / 4);
        for (int x = 0; x < W; x++) backbuf[y * W + x] = sky;
    }
    for (int i = 0; i < W; i++) ybuf[i] = H;

    float sin_phi = fm_sinf(phi), cos_phi = fm_cosf(phi);
    const float scale_height = 200.0f;
    const int   horizon_y    = H / 2;

    float z = 1.0f;
    float dz = 1.0f;
    while (z < 800.0f) {
        float plx = (cos_phi - sin_phi) * z + px;
        float ply = (sin_phi + cos_phi) * z + py;
        float prx = (cos_phi + sin_phi) * z + px;
        float pry = (sin_phi - cos_phi) * z + py;
        float dx = (prx - plx) / (float)W;
        float dy = (pry - ply) / (float)W;

        for (int i = 0; i < W; i++) {
            int sx = (int)plx & MAPMASK;
            int sy = (int)ply & MAPMASK;
            unsigned char hs = heightmap[sy * MAP + sx];
            unsigned char cs = colormap [sy * MAP + sx];

            float tan_a = (phc - (float)hs) / z;
            float denom = 1.0f + tan_a * pitch_tan;
            int yScr = (int)((float)horizon_y + scale_height * (tan_a - pitch_tan) / denom);
            if (yScr < 0) yScr = 0;

            if (yScr < ybuf[i]) {
                int yEnd = ybuf[i];
                if (yEnd > H) yEnd = H;
                for (int y = yScr; y < yEnd; y++) backbuf[y * W + i] = cs;
                ybuf[i] = yScr;
            }
            plx += dx;
            ply += dy;
        }
        z += dz;
        if (z > 40.0f) dz *= 1.005f;
    }
    /* Atomic blit back→front so a screenshot never catches a half-drawn frame. */
    for (int i = 0; i < W * H; i++) FB[i] = backbuf[i];
}

void _start(void) {
    /* Init x87 FPU. */
    __asm__ volatile ("fninit");

    set_palette();
    gen_terrain();

    int frame = 0;
    for (;;) {
        float t = (float)frame * (1.0f / 30.0f);
        float theta = t * 0.9f;
        float r = 130.0f + t * 40.0f;
        float h_cam = 250.0f + t * 35.0f;
        const float cx = 256.0f, cy = 256.0f;
        const float target_h = 80.0f;

        float cam_x = cx + r * fm_cosf(theta);
        float cam_y = cy + r * fm_sinf(theta);
        /* atan2 inlined — for this case we know phi = theta + pi (looking toward center).
           Equivalent to phi = atan2(cy - cam_y, cx - cam_x). */
        float phi = theta + 3.14159265f;
        float pitch_tan = (h_cam - target_h) / r;

        render(cam_x, cam_y, h_cam, phi, pitch_tan);
        frame++;
    }
}
