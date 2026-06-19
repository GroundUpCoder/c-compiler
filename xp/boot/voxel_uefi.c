/* Voxel landscape for UEFI — integer-based terrain, no libm dependency.
   Uses GOP framebuffer, boots as UEFI PE application. */

/* ── UEFI types (minimal, no headers needed) ──────────────────────── */
typedef unsigned long long EFI_STATUS;
typedef void *EFI_HANDLE;
typedef unsigned short CHAR16;
typedef unsigned long long UINT64;
typedef unsigned int UINT32;
typedef unsigned short UINT16;
typedef unsigned char UINT8;
typedef unsigned long long EFI_PHYSICAL_ADDRESS;

typedef struct { UINT64 Signature; UINT32 Revision; UINT32 HeaderSize;
                 UINT32 CRC32; UINT32 Reserved; } EFI_TABLE_HEADER;

typedef EFI_STATUS (*EFI_TEXT_STRING)(void *This, CHAR16 *String);

typedef struct { void *Reset; EFI_TEXT_STRING OutputString; void *TestString;
                 void *QueryMode; void *SetMode; void *SetAttribute;
                 void *ClearScreen; } SIMPLE_TEXT_OUTPUT;

typedef struct { EFI_TABLE_HEADER Hdr; CHAR16 *FirmwareVendor;
                 UINT32 FirmwareRevision; void *ConsoleInHandle; void *ConIn;
                 void *ConsoleOutHandle; SIMPLE_TEXT_OUTPUT *ConOut;
                 void *StandardErrorHandle; void *StdErr;
                 void *RuntimeServices; void *BootServices; } EFI_SYSTEM_TABLE;

typedef struct { UINT32 RedMask, GreenMask, BlueMask, ReservedMask;
                 UINT32 PixelFormat; UINT32 HorizontalResolution;
                 UINT32 VerticalResolution; UINT32 PixelsPerScanLine;
                 EFI_PHYSICAL_ADDRESS FrameBufferBase; UINT64 FrameBufferSize;
} GOP_MODE_INFO;

typedef struct { UINT32 MaxMode, Mode; void *Info; UINT64 SizeOfInfo;
                 EFI_PHYSICAL_ADDRESS FrameBufferBase; UINT64 FrameBufferSize;
} GOP_MODE_DATA;

typedef EFI_STATUS (*LOCATE_PROTOCOL)(void *guid, void *reg, void **iface);

/* ── Globals ──────────────────────────────────────────────────────── */
static unsigned int *fb;
static int fb_w, fb_h, fb_scanline;
static int fb_rgb; /* 0=BGRx, 1=RGBx */

#define MAP 256
#define MAPMASK (MAP - 1)
static unsigned char heightmap[MAP * MAP];
static unsigned char colormap[MAP * MAP];
static unsigned int ybuffer[2560];  /* wider than any expected screen */

/* ── Integer math helpers ──────────────────────────────────────────── */
static int iabs(int x) { return x < 0 ? -x : x; }

static int imax(int a, int b) { return a > b ? a : b; }
static int imin(int a, int b) { return a < b ? a : b; }

/* Simple integer sine approximation: returns value in [-256, 256]
   Input angle in "units" where 256 units = 2*PI. */
static int isin(int angle) {
  /* 5th-order Taylor-like approximation on [0, 256] mapped to [0, 2pi] */
  /* Normalize to [0, 256) */
  angle = angle & 255;
  /* Map to [0, 128] using symmetry */
  int neg = 0;
  if (angle > 128) { angle = 256 - angle; neg = 1; }
  /* angle is now in [0, 128] mapped to [0, pi] */
  /* x = angle * PI / 128, approximately. We need sin(x) * 256 */
  /* Use approximation: 256 * sin(angle * pi / 128) */
  /* ax = angle * 1.23 (scaled by 256 so pi/128 * 256 ~= 2*pi/256 * 256 = ~6.28/256*256) */
  /* Actually use a simple cubic: 4*x*(128-x)/128 for angle in [0,128] */
  int x = angle;
  int result = (4 * x * (128 - x)) / 128;  /* max 256 at x=64 */
  return neg ? -result : result;
}

static int icos(int angle) { return isin(angle + 64); }

/* 2D noise using integer math. Returns value in [0, 255] */
static int inoise2d(int x, int y, int seed) {
  int v = seed;
  v = v * 1103515245 + x * 137 + y * 271;
  v = (v ^ (v >> 13)) * 1103515245;
  v = v ^ (v >> 13);
  return ((unsigned int)v) & 255;
}

/* Smooth 2D noise via bilinear interpolation */
static int smooth_noise(int x, int y, int scale, int seed) {
  int sx = x / scale, sy = y / scale;
  int fx = x % scale, fy = y % scale;
  int a = inoise2d(sx, sy, seed);
  int b = inoise2d(sx+1, sy, seed);
  int c = inoise2d(sx, sy+1, seed);
  int d = inoise2d(sx+1, sy+1, seed);
  int top = a + ((b - a) * fx) / scale;
  int bot = c + ((d - c) * fx) / scale;
  return top + ((bot - top) * fy) / scale;
}

static void gen_maps(void) {
  int i, j;
  for (i = 0; i < MAP; i++) {
    for (j = 0; j < MAP; j++) {
      int h = 0;
      h += smooth_noise(i, j, 4, 42) * 3;
      h += smooth_noise(i, j, 8, 99) * 2;
      h += smooth_noise(i, j, 16, 137);
      h += smooth_noise(i, j, 32, 201) / 2;
      h = h / 4 + 32; /* shift up so valleys aren't at 0 */
      if (h < 0) h = 0; if (h > 255) h = 255;
      heightmap[i * MAP + j] = (unsigned char)h;

      /* Color by height + extra noise for variety */
      int c = inoise2d(i, j, 77) & 31;
      if (h < 40)
        c = 60 + h;              /* valleys: dark green */
      else if (h < 80)
        c = 90 + h / 2 + (c / 6); /* hills: green */
      else if (h < 140)
        c = 100 + h / 3 + (c / 4); /* mid: mixed green-brown */
      else if (h < 200)
        c = 120 + (c / 3);        /* high: rocky grey-brown */
      else
        c = 180 + (c / 5);        /* peaks: light grey */
      if (c < 0) c = 0; if (c > 255) c = 255;
      colormap[i * MAP + j] = (unsigned char)c;
    }
  }
}

/* ── Framebuffer pixel write ───────────────────────────────────────── */
static void putpixel(int x, int y, unsigned char r, unsigned char g, unsigned char b) {
  if (x < 0 || x >= fb_w || y < 0 || y >= fb_h) return;
  unsigned int color;
  if (fb_rgb)
    color = ((unsigned int)r) | ((unsigned int)g << 8) | ((unsigned int)b << 16);
  else
    color = ((unsigned int)b) | ((unsigned int)g << 8) | ((unsigned int)r << 16);
  fb[y * fb_scanline + x] = color;
}

/* ── Render one frame ──────────────────────────────────────────────── */
static void render_frame(int cam_x, int cam_y, int cam_angle, int cam_height) {
  int col, z;

  for (col = 0; col < fb_w; col++) {
    int col_off = col - fb_w/2;
    int ray_angle = cam_angle + col_off / 8;
    int rca = icos(ray_angle);
    int rsa = isin(ray_angle);

    int dx = (rca * 2) / 3;
    int dy = (rsa * 2) / 3;
    int rx = cam_x * 256;
    int ry = cam_y * 256;
    int dist = 0;

    /* Track highest terrain point for this column */
    int highest = fb_h;

    for (z = 0; z < 400; z++) {
      rx += dx;
      ry += dy;
      dist += 1;

      int mx = (rx >> 8) & MAPMASK;
      int my = (ry >> 8) & MAPMASK;
      if (mx < 0) mx += MAP; if (my < 0) my += MAP;

      int h = (int)heightmap[my * MAP + mx];
      int c  = (int)colormap[my * MAP + mx];

      int dh = h - cam_height;
      int h_on_screen = fb_h/2 + (dh * 48) / imax(dist, 1);
      if (h_on_screen < 0) h_on_screen = 0;
      if (h_on_screen > fb_h) h_on_screen = fb_h;

      /* Only process if this terrain is closer than previous */
      if (h_on_screen < highest) {
        int shade = dist / 8;
        if (shade > 128) shade = 128;

        /* Draw terrain from h_on_screen to highest */
        int yy;
        for (yy = h_on_screen; yy < highest && yy < fb_h; yy++) {
          int tr = c - shade;
          int tg = c - shade/2;
          int tb = (c/2) - shade/2;
          if (tr < 0) tr = 0; if (tg < 0) tg = 0; if (tb < 0) tb = 0;
          putpixel(col, yy, (unsigned char)tr, (unsigned char)tg, (unsigned char)tb);
        }
        highest = h_on_screen;
      }
    }

    /* Draw sky from top of screen down to highest terrain point */
    {
      int yy;
      for (yy = 0; yy < highest && yy < fb_h; yy++) {
        int sr = 60 + yy * 30 / fb_h;
        int sg = 100 + yy * 50 / fb_h;
        int sb = 170 + yy * 85 / fb_h;
        if (sr > 255) sr = 255; if (sg > 255) sg = 255; if (sb > 255) sb = 255;
        putpixel(col, yy, (unsigned char)sr, (unsigned char)sg, (unsigned char)sb);
      }
    }
  }
}

/* ── Entry point ───────────────────────────────────────────────────── */
#define EFI_SUCCESS 0

static unsigned char gop_guid[16] = {
  0xde,0xa9,0x42,0x90,0xdc,0x23,0x38,0x4a,
  0x96,0xfb,0x7a,0xde,0xd0,0x80,0x51,0x6a
};

EFI_STATUS _start(EFI_HANDLE ImageHandle, EFI_SYSTEM_TABLE *ST) {
  EFI_STATUS status;
  void *g;
  LOCATE_PROTOCOL lp;
  CHAR16 msg[] = {'V','O','X','E','L',' ','U','E','F','I','\r','\n',0};
  ST->ConOut->OutputString(ST->ConOut, msg);

  /* Get BootServices->LocateProtocol */
  {
    char *bs = (char *)ST->BootServices;
    lp = *(LOCATE_PROTOCOL *)(bs + 320);
  }
  status = lp(gop_guid, (void *)0, (void **)&g);
  if (status != 0 || g == (void *)0) {
    CHAR16 err[] = {'G','O','P',' ','f','a','i','l','e','d','\r','\n',0};
    ST->ConOut->OutputString(ST->ConOut, err);
    for (;;) {}
  }

  /* Access GOP struct fields by raw offset */
  {
    char *mode = *(char **)((char *)g + 24);
    char *info_ptr = *(char **)(mode + 8);
    fb = (unsigned int *)(*(unsigned long long *)(mode + 24));
    unsigned int *inf = (unsigned int *)info_ptr;
    fb_w = inf[1];
    fb_h = inf[2];
    fb_rgb = (inf[3] == 0);
    fb_scanline = inf[8];
  }

  /* Generate heightmap */
  gen_maps();

  /* Animation loop — fly through terrain */
  {
    int cam_x = 80, cam_y = 100;
    int cam_angle = 64;  /* looking right */
    int cam_height = 45;
    int frame;
    for (frame = 0; frame < 300; frame++) {
      render_frame(cam_x, cam_y, cam_angle, cam_height);
      cam_x += (icos(cam_angle) * 3) / 64;
      cam_y += (isin(cam_angle) * 3) / 64;
      /* Slowly turn and pan */
      cam_angle = (cam_angle + 1) & 255;
      /* Vary height slightly to see different perspectives */
      if ((frame & 31) == 0) cam_height = 45 + ((frame >> 3) & 15);
    }
  }

  /* Hang */
  for (;;) {}
  return EFI_SUCCESS;
}
