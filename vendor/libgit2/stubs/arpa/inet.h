/* Stub arpa/inet.h for WASM — provide endianness conversion */
#ifndef STUB_ARPA_INET_H
#define STUB_ARPA_INET_H
#include <stdint.h>
static inline uint32_t htonl(uint32_t hostlong) {
    const uint8_t *b = (const uint8_t *)&hostlong;
    return ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) |
           ((uint32_t)b[2] << 8) | (uint32_t)b[3];
}
static inline uint16_t htons(uint16_t hostshort) {
    const uint8_t *b = (const uint8_t *)&hostshort;
    return ((uint16_t)b[0] << 8) | (uint16_t)b[1];
}
static inline uint32_t ntohl(uint32_t netlong) { return htonl(netlong); }
static inline uint16_t ntohs(uint16_t netshort) { return htons(netshort); }
#endif
