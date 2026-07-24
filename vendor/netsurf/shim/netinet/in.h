/* Minimal <netinet/in.h> for the vendored NetSurf build (gucOS).
 *
 * gucOS has no network stack; NetSurf's file-only build still compiles
 * utils/inet.c and urldb's IP-literal handling, which want the POSIX inet
 * types (config.h HAVE_POSIX_INET_HEADERS).  This provides exactly the
 * types those paths use — address PARSING, not sockets.
 */
#ifndef GUCOS_NETSURF_NETINET_IN_H
#define GUCOS_NETSURF_NETINET_IN_H

#include <stdint.h>

typedef uint32_t in_addr_t;
typedef uint16_t in_port_t;

struct in_addr {
	in_addr_t s_addr;          /* network byte order */
};

struct in6_addr {
	uint8_t s6_addr[16];
};

#ifndef AF_INET
#define AF_INET 2
#endif
#ifndef AF_INET6
#define AF_INET6 10
#endif

#endif
