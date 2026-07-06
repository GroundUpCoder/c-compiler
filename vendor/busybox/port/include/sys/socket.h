/* stub for the wasm port: no sockets — just enough for libbb.h's
 * compile-time asserts and prototypes to parse. Every actual socket call
 * would come from libbb's networking helpers, which the hush build never
 * references. */
#pragma once
#include <sys/types.h>

#define SOCK_STREAM    1
#define SOCK_DGRAM     2
#define SOCK_RAW       3
#define SOCK_RDM       4
#define SOCK_SEQPACKET 5

#define AF_UNSPEC 0
#define AF_UNIX   1
#define AF_INET   2
#define AF_INET6  10
#define PF_UNSPEC AF_UNSPEC
#define PF_INET   AF_INET

typedef unsigned socklen_t;
typedef unsigned short sa_family_t;

struct sockaddr {
    sa_family_t sa_family;
    char sa_data[14];
};

/* netinet/in.h essentials (libbb.h's len_and_sockaddr needs the type) */
typedef unsigned short in_port_t;
typedef unsigned in_addr_t;
struct in_addr { in_addr_t s_addr; };
struct sockaddr_in {
    sa_family_t sin_family;
    in_port_t sin_port;
    struct in_addr sin_addr;
    char sin_zero[8];
};
