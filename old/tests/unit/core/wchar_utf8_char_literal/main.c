// C11 §6.4.4.4p9: A wide character literal L'x' where x is a multibyte
// character should have the value of the corresponding codepoint.
// Bug: the compiler uses unescape() (byte-at-a-time) for char literals
// instead of unescapeCodepoint() (UTF-8 aware), so L'é' gives 0xC3 (195)
// instead of the correct codepoint 0xE9 (233).
#include <stdio.h>

int main(void) {
    // é = U+00E9, encoded as UTF-8: 0xC3 0xA9
    // L'é' should decode to codepoint 233, not byte 195
    int wc = L'é';
    printf("%d\n", wc);

    // ñ = U+00F1, encoded as UTF-8: 0xC3 0xB1
    int wc2 = L'ñ';
    printf("%d\n", wc2);

    // ü = U+00FC, encoded as UTF-8: 0xC3 0xBC
    int wc3 = L'ü';
    printf("%d\n", wc3);

    // CJK character 中 = U+4E2D, encoded as UTF-8: 0xE4 0xB8 0xAD
    int wc4 = L'中';
    printf("%d\n", wc4);

    return 0;
}
