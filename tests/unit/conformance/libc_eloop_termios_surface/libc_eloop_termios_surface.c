// BUG: <errno.h> had no ELOOP even though the filesystem RAISES it -- BlockFS's
//      path walk caps at SYMLOOP_MAX=40 hops and sets errno 40 (host.js). Any
//      program that spells the name failed to compile, and strerror(40) printed
//      "Unknown error". CPython's errno.py does `from errno import ELOOP`, which
//      took pathlib/zipfile/zipapp/compileall down with it. Same commit added the
//      <termios.h> line-control surface (tcdrain/tcflush/tcflow/tcsendbreak, the
//      TC*FLUSH selectors and TC{OOFF,OON,IOFF,ION}, and the B* rate ladder) that
//      CPython's termios module needs to build.
// C11: POSIX.1-2017 <errno.h> ELOOP; <termios.h> 11.2 line control.
// EXPECT: ELOOP is 40 -- the number the kernel actually raises, not a fresh one --
//         with the glibc wording, and the termios names exist with this libc's
//         literal-baud encoding (B9600 == 9600, the BSD convention the original
//         B9600/B115200 pair chose). todos/0340.
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <termios.h>

int main(void) {
  printf("%d %s\n", ELOOP, strerror(ELOOP));

  /* Queue selectors and flow actions (Linux numbering). */
  printf("%d %d %d\n", TCIFLUSH, TCOFLUSH, TCIOFLUSH);
  printf("%d %d %d %d\n", TCOOFF, TCOON, TCIOFF, TCION);

  /* The rate ladder is the literal baud number here, not Linux's small enum. */
  printf("%d %d %d %d %d\n", B0, B50, B9600, B115200, B4000000);

  /* The four line-control calls exist and reject a non-terminal fd rather
     than succeeding vacuously; tcflow/tcflush validate their argument first. */
  struct termios t;
  int nottty = tcgetattr(-1, &t);
  printf("tcgetattr(-1)=%d\n", nottty);
  printf("tcdrain(-1)=%d\n", tcdrain(-1));
  printf("tcsendbreak(-1,0)=%d\n", tcsendbreak(-1, 0));
  errno = 0;
  printf("tcflow(-1,999)=%d errno=%d\n", tcflow(-1, 999), errno == EINVAL);
  errno = 0;
  printf("tcflush(-1,999)=%d errno=%d\n", tcflush(-1, 999), errno == EINVAL);
  return 0;
}
