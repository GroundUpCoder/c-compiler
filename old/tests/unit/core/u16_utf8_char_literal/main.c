// Same UTF-8 decoding bug as L'x', but for u'x'
// u'é' should give codepoint 233 (0xE9), not byte 195 (0xC3)
#include <uchar.h>
#include <stdio.h>

int main(void) {
    char16_t c1 = u'é';  // U+00E9 -> should be 233
    printf("%u\n", (unsigned)c1);

    char16_t c2 = u'ñ';  // U+00F1 -> should be 241
    printf("%u\n", (unsigned)c2);

    // Compare: escape sequence should work correctly
    char16_t c3 = u'\u00e9';  // Same as é
    printf("%u\n", (unsigned)c3);

    // They should be equal
    printf("eq=%d\n", c1 == c3);

    return 0;
}
