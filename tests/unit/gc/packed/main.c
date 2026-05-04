#include <stdio.h>

__struct Pixel {
  unsigned char r;
  unsigned char g;
  unsigned char b;
  unsigned char a;
};

__struct WithShorts {
  short s;
  unsigned short u;
};

__struct WithSignedChar { signed char v; };

int main(void) {
  // Packed unsigned char fields
  __struct Pixel *p = __new(__struct Pixel *, 200, 100, 50, 255);
  printf("%d %d %d %d\n", p->r, p->g, p->b, p->a);

  // Modify
  p->r = 1;
  p->g = 254;
  printf("%d %d %d %d\n", p->r, p->g, p->b, p->a);

  // Short / ushort
  __struct WithShorts *h = __new(__struct WithShorts *, -1000, 50000);
  printf("%d %d\n", h->s, h->u);

  // Signed char wraps
  __struct WithSignedChar *s = __new(__struct WithSignedChar *, -42);
  printf("%d\n", s->v);

  // Packed array of bytes
  __array(unsigned char) buf = __new(__array(unsigned char), 4);
  for (int i = 0; i < 4; i++) buf[i] = (i + 1) * 50;
  for (int i = 0; i < 4; i++) printf("%d ", buf[i]);
  printf("\n");

  // Packed signed char array — uses array.get_s
  __array(signed char) sb = __new_array(signed char, -1, -2, -3, 100);
  for (int i = 0; i < __array_len(sb); i++) printf("%d ", sb[i]);
  printf("\n");

  // Mixed sizes in one struct
  __struct Mix { unsigned char tag; int value; short flags; };
  __struct Mix *m = __new(__struct Mix *, 7, 42000, -100);
  printf("%d %d %d\n", m->tag, m->value, m->flags);

  return 0;
}
