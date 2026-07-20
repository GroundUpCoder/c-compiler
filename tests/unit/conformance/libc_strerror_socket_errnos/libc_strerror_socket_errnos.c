// BUG: strerror() only named errnos <= ENOTEMPTY (39), so every socket-family
//      errno (<errno.h> ENOTSOCK 88 .. EINPROGRESS 115) printed "Unknown error"
//      -- a refused connect() reported "Unknown error" instead of the real string.
// C11: 7.24.6.2 -- strerror maps every valid errno to a string; the socket errnos
//      are defined by <errno.h> here (todos/0008), so they must map too.
// EXPECT: the glibc wording for each errno (this libc is glibc-modeled; the
//         existing strerror strings already use glibc wording). todos/0243.
#include <stdio.h>
#include <string.h>
#include <errno.h>

int main(void) {
  printf("%d %s\n", ENOTSOCK, strerror(ENOTSOCK));
  printf("%d %s\n", EDESTADDRREQ, strerror(EDESTADDRREQ));
  printf("%d %s\n", EPROTOTYPE, strerror(EPROTOTYPE));
  printf("%d %s\n", EPROTONOSUPPORT, strerror(EPROTONOSUPPORT));
  printf("%d %s\n", EOPNOTSUPP, strerror(EOPNOTSUPP));
  printf("%d %s\n", ENOTSUP, strerror(ENOTSUP)); /* == EOPNOTSUPP */
  printf("%d %s\n", EAFNOSUPPORT, strerror(EAFNOSUPPORT));
  printf("%d %s\n", EADDRINUSE, strerror(EADDRINUSE));
  printf("%d %s\n", EADDRNOTAVAIL, strerror(EADDRNOTAVAIL));
  printf("%d %s\n", ECONNABORTED, strerror(ECONNABORTED));
  printf("%d %s\n", ECONNRESET, strerror(ECONNRESET));
  printf("%d %s\n", ENOBUFS, strerror(ENOBUFS));
  printf("%d %s\n", EISCONN, strerror(EISCONN));
  printf("%d %s\n", ENOTCONN, strerror(ENOTCONN));
  printf("%d %s\n", ETIMEDOUT, strerror(ETIMEDOUT));
  printf("%d %s\n", ECONNREFUSED, strerror(ECONNREFUSED));
  printf("%d %s\n", EHOSTUNREACH, strerror(EHOSTUNREACH));
  printf("%d %s\n", EALREADY, strerror(EALREADY));
  printf("%d %s\n", EINPROGRESS, strerror(EINPROGRESS));
  /* Non-socket errnos that were also unnamed before todos/0243. */
  printf("%d %s\n", ENOLCK, strerror(ENOLCK));
  printf("%d %s\n", EOVERFLOW, strerror(EOVERFLOW));
  return 0;
}
