#include <stdio.h>
#include <string.h>

/* Test that \x escapes in string literals produce raw bytes,
 * not UTF-8 encoded codepoints. E.g., \x93 should be 1 byte (0x93),
 * not 2 bytes (0xC2 0x93). */

int main(void) {
    const char *s = "\x19\x93\r\n\x1a\n";
    printf("len=%d\n", (int)strlen(s));
    for (int i = 0; s[i]; i++) {
        printf("s[%d]=0x%02x\n", i, (unsigned char)s[i]);
    }

    const char *hi = "\x80\xff\xfe\xab\xcd";
    printf("hi_len=%d\n", (int)strlen(hi));
    for (int i = 0; hi[i]; i++) {
        printf("hi[%d]=0x%02x\n", i, (unsigned char)hi[i]);
    }
    return 0;
}
