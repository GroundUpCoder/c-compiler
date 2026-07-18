// BUG: snprintf/sprintf %s (and the whole printf family) corrupted bytes
//      0x80-0x9F: the host formatter decoded C strings with a "latin1"
//      TextDecoder, which per the WHATWG encoding standard is actually
//      windows-1252 - 0x80 became U+20AC, 0x94 U+201D, etc. - and the
//      byte writer then truncated those code points with charCodeAt&0xFF
//      (0x80 -> 0xAC, 0x94 -> 0x1D). Any UTF-8 text with continuation
//      bytes in that range (em dash e2 80 94, curly quotes...) was
//      mangled by one snprintf pass. Found via gucOS package summaries
//      rendering tofu (ticket #81).
// C11: 7.21.6.5 - snprintf writes the argument string's BYTES; no
//      character-set transformation applies.
// EXPECT: every byte 0x01..0xFF round-trips %s identically.
#include <stdio.h>
#include <string.h>

int main(void) {
    char src[256], dst[300];
    for (int i = 1; i <= 0xFF; i++) src[i - 1] = (char)i;
    src[255] = 0;
    snprintf(dst, sizeof dst, "%s", src);
    if (strlen(dst) != 255) { printf("LEN %d\n", (int)strlen(dst)); return 1; }
    int bad = 0;
    for (int i = 0; i < 255; i++)
        if (dst[i] != src[i]) {
            printf("MISMATCH at %02x: got %02x\n",
                   (unsigned char)src[i], (unsigned char)dst[i]);
            bad = 1;
        }
    // the motivating case: an em dash survives a %s round trip
    char em[32];
    snprintf(em, sizeof em, "a %s b", "\xe2\x80\x94");
    for (const char *p = em; *p; p++) printf("%02x ", (unsigned char)*p);
    printf("\n");
    puts(bad ? "FAIL" : "OK");
    return bad;
}
