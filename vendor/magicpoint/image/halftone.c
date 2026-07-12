/* dither.c:
 *
 * routine for dithering a color image to monochrome based on color
 * intensity.  this is loosely based on an algorithm which barry shein
 * (bzs@std.com) used in his "xf" program.
 *
 * jim frost 07.10.89
 *
 * Copyright 1989, 1990 Jim Frost.
 * See included file "copyright.h" for complete copyright information.
 */

#include "copyright.h"
#include "image.h"

/* RGB intensity tables.  red is (val * 0.30), green is (val * 0.59), blue
 * is (val * .11), where val is intensity >> 8.  these are used by the
 * colorIntensity() macro in images.h.
 */

unsigned short RedIntensity[256]= {
      0,    76,   153,   230,   307,   384,   460,   537,
    614,   691,   768,   844,   921,   998,  1075,  1152,
   1228,  1305,  1382,  1459,  1536,  1612,  1689,  1766,
   1843,  1920,  1996,  2073,  2150,  2227,  2304,  2380,
   2457,  2534,  2611,  2688,  2764,  2841,  2918,  2995,
   3072,  3148,  3225,  3302,  3379,  3456,  3532,  3609,
   3686,  3763,  3840,  3916,  3993,  4070,  4147,  4224,
   4300,  4377,  4454,  4531,  4608,  4684,  4761,  4838,
   4915,  4992,  5068,  5145,  5222,  5299,  5376,  5452,
   5529,  5606,  5683,  5760,  5836,  5913,  5990,  6067,
   6144,  6220,  6297,  6374,  6451,  6528,  6604,  6681,
   6758,  6835,  6912,  6988,  7065,  7142,  7219,  7296,
   7372,  7449,  7526,  7603,  7680,  7756,  7833,  7910,
   7987,  8064,  8140,  8217,  8294,  8371,  8448,  8524,
   8601,  8678,  8755,  8832,  8908,  8985,  9062,  9139,
   9216,  9292,  9369,  9446,  9523,  9600,  9676,  9753,
   9830,  9907,  9984, 10060, 10137, 10214, 10291, 10368,
  10444, 10521, 10598, 10675, 10752, 10828, 10905, 10982,
  11059, 11136, 11212, 11289, 11366, 11443, 11520, 11596,
  11673, 11750, 11827, 11904, 11980, 12057, 12134, 12211,
  12288, 12364, 12441, 12518, 12595, 12672, 12748, 12825,
  12902, 12979, 13056, 13132, 13209, 13286, 13363, 13440,
  13516, 13593, 13670, 13747, 13824, 13900, 13977, 14054,
  14131, 14208, 14284, 14361, 14438, 14515, 14592, 14668,
  14745, 14822, 14899, 14976, 15052, 15129, 15206, 15283,
  15360, 15436, 15513, 15590, 15667, 15744, 15820, 15897,
  15974, 16051, 16128, 16204, 16281, 16358, 16435, 16512,
  16588, 16665, 16742, 16819, 16896, 16972, 17049, 17126,
  17203, 17280, 17356, 17433, 17510, 17587, 17664, 17740,
  17817, 17894, 17971, 18048, 18124, 18201, 18278, 18355,
  18432, 18508, 18585, 18662, 18739, 18816, 18892, 18969,
  19046, 19123, 19200, 19276, 19353, 19430, 19507, 19584
};

unsigned short GreenIntensity[256]= {
     0,  151,  302,  453,  604,  755,  906, 1057,
  1208, 1359, 1510, 1661, 1812, 1963, 2114, 2265,
  2416, 2567, 2718, 2869, 3020, 3171, 3322, 3473,
  3624, 3776, 3927, 4078, 4229, 4380, 4531, 4682,
  4833, 4984, 5135, 5286, 5437, 5588, 5739, 5890,
  6041, 6192, 6343, 6494, 6645, 6796, 6947, 7098,
  7249, 7400, 7552, 7703, 7854, 8005, 8156, 8307,
  8458, 8609, 8760, 8911, 9062, 9213, 9364, 9515,
  9666, 9817, 9968,10119,10270,10421,10572,10723,
 10874,11025,11176,11328,11479,11630,11781,11932,
 12083,12234,12385,12536,12687,12838,12989,13140,
 13291,13442,13593,13744,13895,14046,14197,14348,
 14499,14650,14801,14952,15104,15255,15406,15557,
 15708,15859,16010,16161,16312,16463,16614,16765,
 16916,17067,17218,17369,17520,17671,17822,17973,
 18124,18275,18426,18577,18728,18880,19031,19182,
 19333,19484,19635,19786,19937,20088,20239,20390,
 20541,20692,20843,20994,21145,21296,21447,21598,
 21749,21900,22051,22202,22353,22504,22656,22807,
 22958,23109,23260,23411,23562,23713,23864,24015,
 24166,24317,24468,24619,24770,24921,25072,25223,
 25374,25525,25676,25827,25978,26129,26280,26432,
 26583,26734,26885,27036,27187,27338,27489,27640,
 27791,27942,28093,28244,28395,28546,28697,28848,
 28999,29150,29301,29452,29603,29754,29905,30056,
 30208,30359,30510,30661,30812,30963,31114,31265,
 31416,31567,31718,31869,32020,32171,32322,32473,
 32624,32775,32926,33077,33228,33379,33530,33681,
 33832,33984,34135,34286,34437,34588,34739,34890,
 35041,35192,35343,35494,35645,35796,35947,36098,
 36249,36400,36551,36702,36853,37004,37155,37306,
 37457,37608,37760,37911,38062,38213,38364,38515
};

unsigned short BlueIntensity[256]= {
     0,   28,   56,   84,  112,  140,  168,  197,
   225,  253,  281,  309,  337,  366,  394,  422,
   450,  478,  506,  535,  563,  591,  619,  647,
   675,  704,  732,  760,  788,  816,  844,  872,
   901,  929,  957,  985, 1013, 1041, 1070, 1098,
  1126, 1154, 1182, 1210, 1239, 1267, 1295, 1323,
  1351, 1379, 1408, 1436, 1464, 1492, 1520, 1548,
  1576, 1605, 1633, 1661, 1689, 1717, 1745, 1774,
  1802, 1830, 1858, 1886, 1914, 1943, 1971, 1999,
  2027, 2055, 2083, 2112, 2140, 2168, 2196, 2224,
  2252, 2280, 2309, 2337, 2365, 2393, 2421, 2449,
  2478, 2506, 2534, 2562, 2590, 2618, 2647, 2675,
  2703, 2731, 2759, 2787, 2816, 2844, 2872, 2900,
  2928, 2956, 2984, 3013, 3041, 3069, 3097, 3125,
  3153, 3182, 3210, 3238, 3266, 3294, 3322, 3351,
  3379, 3407, 3435, 3463, 3491, 3520, 3548, 3576,
  3604, 3632, 3660, 3688, 3717, 3745, 3773, 3801,
  3829, 3857, 3886, 3914, 3942, 3970, 3998, 4026,
  4055, 4083, 4111, 4139, 4167, 4195, 4224, 4252,
  4280, 4308, 4336, 4364, 4392, 4421, 4449, 4477,
  4505, 4533, 4561, 4590, 4618, 4646, 4674, 4702,
  4730, 4759, 4787, 4815, 4843, 4871, 4899, 4928,
  4956, 4984, 5012, 5040, 5068, 5096, 5125, 5153,
  5181, 5209, 5237, 5265, 5294, 5322, 5350, 5378,
  5406, 5434, 5463, 5491, 5519, 5547, 5575, 5603,
  5632, 5660, 5688, 5716, 5744, 5772, 5800, 5829,
  5857, 5885, 5913, 5941, 5969, 5998, 6026, 6054,
  6082, 6110, 6138, 6167, 6195, 6223, 6251, 6279,
  6307, 6336, 6364, 6392, 6420, 6448, 6476, 6504,
  6533, 6561, 6589, 6617, 6645, 6673, 6702, 6730,
  6758, 6786, 6814, 6842, 6871, 6899, 6927, 6955,
  6983, 7011, 7040, 7068, 7096, 7124, 7152, 7180
};

/* 4x4 arrays used for dithering, arranged by nybble
 */

#define GRAYS    17 /* ((4 * 4) + 1) patterns for a good dither */
#define GRAYSTEP ((unsigned long)(65536 / GRAYS))

static byte DitherBits[GRAYS][4] = {
  { 0xf, 0xf, 0xf, 0xf },
  { 0xe, 0xf, 0xf, 0xf },
  { 0xe, 0xf, 0xb, 0xf },
  { 0xa, 0xf, 0xb, 0xf },
  { 0xa, 0xf, 0xa, 0xf },
  { 0xa, 0xd, 0xa, 0xf },
  { 0xa, 0xd, 0xa, 0x7 },
  { 0xa, 0x5, 0xa, 0x7 },
  { 0xa, 0x5, 0xa, 0x5 },
  { 0x8, 0x5, 0xa, 0x5 },
  { 0x8, 0x5, 0x2, 0x5 },
  { 0x0, 0x5, 0x2, 0x5 },
  { 0x0, 0x5, 0x0, 0x5 },
  { 0x0, 0x4, 0x0, 0x5 },
  { 0x0, 0x4, 0x0, 0x1 },
  { 0x0, 0x0, 0x0, 0x1 },
  { 0x0, 0x0, 0x0, 0x0 }
};

/* simple dithering algorithm, really optimized for the 4x4 array
 */

Image *halftone(cimage, verbose)
     Image        *cimage;
     unsigned int  verbose;
{ Image         *image;
  unsigned char *sp, *dp, *dp2; /* data pointers */
  unsigned int   dindex;        /* index into dither array */
  unsigned int   spl;           /* source pixel length in bytes */
  unsigned int   dll;           /* destination line length in bytes */
  Pixel          color;         /* pixel color */
  unsigned int  *index;         /* index into dither array for a given pixel */
  unsigned int   a, x, y;       /* random counters */

  goodImage(cimage, "dither");
  if (BITMAPP(cimage))
    return(NULL);

  /* set up
   */

  if (verbose) {
    fprintf(stderr, "  Halftoning image...");
    fflush(stderr);
  }
  image= newBitImage(cimage->width * 4, cimage->height * 4);
  if (cimage->title) {
    image->title= (char *)lmalloc(strlen(cimage->title) + 13);
    sprintf(image->title, "%s (halftoned)", cimage->title);
  }
  spl= cimage->pixlen;
  dll= (image->width / 8) + (image->width % 8 ? 1 : 0);

  /* if the number of possible pixels isn't very large, build an array
   * which we index by the pixel value to find the dither array index
   * by color brightness.  we do this in advance so we don't have to do
   * it for each pixel.  things will break if a pixel value is greater
   * than (1 << depth), which is bogus anyway.  this calculation is done
   * on a per-pixel basis if the colormap is too big.
   */

  if (RGBP(cimage) && (cimage->depth <= 16)) {
    index= (unsigned int *)lmalloc(sizeof(unsigned int) * cimage->rgb.used);
    for (x= 0; x < cimage->rgb.used; x++) {
      *(index + x)=
	((unsigned long)colorIntensity(*(cimage->rgb.red + x),
				       *(cimage->rgb.green + x),
				       *(cimage->rgb.blue + x))) / GRAYSTEP;
      if (*(index + x) >= GRAYS) /* rounding errors can do this */
	*(index + x)= GRAYS - 1;
    }
  }
  else
    index= NULL;

  /* dither each pixel
   */

  sp= cimage->data;
  dp= image->data;
  for (y= 0; y < cimage->height; y++) {
    for (x= 0; x < cimage->width; x++) {
      dp2= dp + (x >> 1);
      color= memToVal(sp, spl);
      if (RGBP(cimage)) {
	if (index)
	  dindex= *(index + color);
	else {
	  dindex= 
	    ((unsigned long)colorIntensity(cimage->rgb.red[color],
					   cimage->rgb.green[color],
					   cimage->rgb.blue[color])) / GRAYSTEP;
	}
      }
      else {
	dindex=
	  ((unsigned long)colorIntensity((TRUE_RED(color) << 8),
					 (TRUE_GREEN(color) << 8),
					 (TRUE_BLUE(color) << 8))) / GRAYSTEP;
      }
      if (dindex >= GRAYS) /* rounding errors can do this */
	dindex= GRAYS - 1;

      /* loop for the four Y bits in the dither pattern, putting all
       * four X bits in at once.  if you think this would be hard to
       * change to be an NxN dithering array, you're right, since we're
       * banking on the fact that we need only shift the mask based on
       * whether x is odd or not.  an 8x8 array wouldn't even need that,
       * but blowing an image up by 64x is probably not a feature.
       */

      if (x & 1)
	for (a= 0; a < 4; a++, dp2 += dll)
	  *dp2 |= DitherBits[dindex][a];
      else
	for (a= 0; a < 4; a++, dp2 += dll)
	  *dp2 |= (DitherBits[dindex][a] << 4);
      sp += spl;
    }
    dp += (dll << 2); /* (dll * 4) but I like shifts */
  }
  if (verbose)
    fprintf(stderr, "done\n");
  return(image);
}
