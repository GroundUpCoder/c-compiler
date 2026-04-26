#include <stdio.h>

struct Pixel {
  unsigned int r : 5;
  unsigned int g : 6;
  unsigned int b : 5;
};

int main() {
  /* Verify struct size — 16 bits = fits in one int = 4 bytes */
  printf("sizeof_Pixel=%d\n", (int)sizeof(struct Pixel));

  struct Pixel pixels[4];
  unsigned int *raw = (unsigned int *)pixels;

  /* Zero-init via raw pointer */
  int i;
  for (i = 0; i < 4; i++) raw[i] = 0;

  /* Set each pixel to different values */
  pixels[0].r = 31; pixels[0].g = 63; pixels[0].b = 31;  /* all max */
  pixels[1].r = 1;  pixels[1].g = 2;  pixels[1].b = 3;
  pixels[2].r = 0;  pixels[2].g = 0;  pixels[2].b = 0;   /* all zero */
  pixels[3].r = 16; pixels[3].g = 32; pixels[3].b = 16;   /* mid values */

  /* Read back and print */
  for (i = 0; i < 4; i++) {
    printf("pixel[%d]: r=%u g=%u b=%u\n", i, pixels[i].r, pixels[i].g, pixels[i].b);
  }

  /* Type-pun to verify layout:
     r = bits 0-4, g = bits 5-10, b = bits 11-15 */
  /* pixel[0]: r=31(0x1F) g=63(0x7E0) b=31(0xF800) = 0xFFFF */
  printf("raw[0]=0x%x\n", raw[0]);

  /* pixel[1]: r=1 g=2<<5=0x40 b=3<<11=0x1800 = 0x1841 */
  printf("raw[1]=0x%x\n", raw[1]);

  /* Modify via raw and read back through struct */
  raw[2] = 0xFFFF;  /* all bits in 16-bit range set */
  printf("pixel[2]: r=%u g=%u b=%u\n", pixels[2].r, pixels[2].g, pixels[2].b);

  /* Verify stride: &pixels[1] - &pixels[0] should be sizeof(Pixel) */
  long diff = (long)((unsigned char *)&pixels[1] - (unsigned char *)&pixels[0]);
  printf("stride=%ld\n", diff);

  /* Pointer arithmetic with -> on array elements */
  struct Pixel *pp = &pixels[3];
  pp->r = 10;
  pp->g = 20;
  pp->b = 5;
  printf("arrow: r=%u g=%u b=%u\n", pp->r, pp->g, pp->b);

  return 0;
}
