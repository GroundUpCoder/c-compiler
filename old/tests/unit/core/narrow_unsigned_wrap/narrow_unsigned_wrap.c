// Tests that narrow unsigned types (unsigned char, unsigned short) wrap
// correctly after increment, decrement, and compound assignment.
// In C, arithmetic on these types is performed at int width, but the
// result must be truncated back to the narrow type when stored.
#include <stdio.h>

int main() {
  // ---- unsigned char decrement underflow ----
  unsigned char u8 = 0;
  u8--;
  printf("%d\n", u8);            // 255
  printf("%d\n", u8 == 255);     // 1

  // ---- unsigned char increment overflow ----
  unsigned char u8b = 255;
  u8b++;
  printf("%d\n", u8b);           // 0
  printf("%d\n", u8b == 0);      // 1

  // ---- unsigned char pre-decrement ----
  unsigned char u8c = 0;
  unsigned char r1 = --u8c;
  printf("%d\n", u8c);           // 255
  printf("%d\n", r1);            // 255

  // ---- unsigned char pre-increment ----
  unsigned char u8d = 255;
  unsigned char r2 = ++u8d;
  printf("%d\n", u8d);           // 0
  printf("%d\n", r2);            // 0

  // ---- unsigned char post-decrement ----
  unsigned char u8e = 0;
  unsigned char r3 = u8e--;
  printf("%d\n", r3);            // 0 (old value)
  printf("%d\n", u8e);           // 255

  // ---- unsigned char post-increment ----
  unsigned char u8f = 255;
  unsigned char r4 = u8f++;
  printf("%d\n", r4);            // 255 (old value)
  printf("%d\n", u8f);           // 0

  // ---- unsigned char compound assignment ----
  unsigned char u8g = 5;
  u8g -= 10;
  printf("%d\n", u8g);           // 251
  unsigned char u8h = 250;
  u8h += 10;
  printf("%d\n", u8h);           // 4

  // ---- unsigned short decrement underflow ----
  unsigned short u16 = 0;
  u16--;
  printf("%d\n", u16);           // 65535
  printf("%d\n", u16 == 65535);  // 1

  // ---- unsigned short increment overflow ----
  unsigned short u16b = 65535;
  u16b++;
  printf("%d\n", u16b);          // 0
  printf("%d\n", u16b == 0);     // 1

  // ---- unsigned short compound assignment ----
  unsigned short u16c = 5;
  u16c -= 10;
  printf("%d\n", u16c);          // 65531

  // ---- loop pattern (the actual peanut_gb crash pattern) ----
  unsigned char i = 3;
  int count = 0;
  for (; i != 0xFF; i--) {
    count++;
  }
  printf("%d\n", count);         // 4 (3, 2, 1, 0 then wraps to 255 = 0xFF)

  // ---- multiplication wrap ----
  unsigned char u8m = 200;
  u8m *= 2;
  printf("%d\n", u8m);           // 144 (400 & 0xFF)

  return 0;
}
