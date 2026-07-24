/* Minimal <arpa/inet.h> for the vendored NetSurf build (gucOS) —
 * address-literal parsing only; see netinet/in.h.  Implementation:
 * shim/inet.c. */
#ifndef GUCOS_NETSURF_ARPA_INET_H
#define GUCOS_NETSURF_ARPA_INET_H

#include <netinet/in.h>

int inet_aton(const char *cp, struct in_addr *inp);
int inet_pton(int af, const char *src, void *dst);

#endif
