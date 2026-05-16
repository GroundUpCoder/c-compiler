// Multiple zero-length arrays in one struct — a GCC extension.
// All [0] members have sizeof 0 and address at the end of the prior
// non-zero member, so they all alias the same trailing memory.
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

struct multi {
    int header;
    uint8_t  bytes[0];
    uint32_t words[0];
};

int main(void) {
    printf("sizeof=%d\n", (int)sizeof(struct multi));

    struct multi *m = malloc(sizeof(struct multi) + 16);
    m->header = 0xCAFE;

    // Write a uint32_t through `words`, read individual bytes through `bytes`.
    m->words[0] = 0x44332211;
    printf("header=%x\n", m->header);
    printf("bytes via words: %x %x %x %x\n",
        m->bytes[0], m->bytes[1], m->bytes[2], m->bytes[3]);
    printf("alias addrs: %d\n", (void*)m->bytes == (void*)m->words);

    free(m);
    return 0;
}
