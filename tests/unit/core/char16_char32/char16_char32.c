#include <uchar.h>
#include <stdio.h>

int main(void) {
    // === char16_t and char32_t types ===
    printf("sizeof(char16_t)=%d\n", (int)sizeof(char16_t));
    printf("sizeof(char32_t)=%d\n", (int)sizeof(char32_t));

    // === Prefixed char literals ===
    // u'x' has type char16_t (unsigned short)
    char16_t c16 = u'A';
    printf("u'A'=%d\n", (int)c16);

    // U'x' has type char32_t (unsigned int)
    char32_t c32 = U'A';
    printf("U'A'=%d\n", (int)c32);

    // L'x' has type wchar_t (int)
    int wc = L'Z';
    printf("L'Z'=%d\n", (int)wc);

    // Unicode codepoints in prefixed char literals
    char16_t c16u = u'\u00e9';  // e-acute
    printf("u'e-acute'=%d\n", (int)c16u);  // 233

    char32_t c32u = U'\U0001F600';  // grinning face emoji
    printf("U'emoji'=%d\n", (int)c32u);  // 128512

    // === Wide string literals (u"...") ===
    const char16_t *s16 = u"Hi";
    // Little-endian: 'H'=0x48, 'i'=0x69
    printf("u\"Hi\"[0]=%d\n", (int)s16[0]);  // 72 = 'H'
    printf("u\"Hi\"[1]=%d\n", (int)s16[1]);  // 105 = 'i'
    printf("u\"Hi\"[2]=%d\n", (int)s16[2]);  // 0 = null terminator

    // === Wide string literals (U"...") ===
    const char32_t *s32 = U"AB";
    printf("U\"AB\"[0]=%d\n", (int)s32[0]);  // 65 = 'A'
    printf("U\"AB\"[1]=%d\n", (int)s32[1]);  // 66 = 'B'
    printf("U\"AB\"[2]=%d\n", (int)s32[2]);  // 0 = null terminator

    // === L"..." string literals ===
    const unsigned int *wstr = L"OK";
    printf("L\"OK\"[0]=%d\n", (int)wstr[0]);  // 79 = 'O'
    printf("L\"OK\"[1]=%d\n", (int)wstr[1]);  // 75 = 'K'
    printf("L\"OK\"[2]=%d\n", (int)wstr[2]);  // 0 = null terminator

    // === u8"..." string literals (UTF-8, same as regular) ===
    const char *s8 = u8"hi";
    printf("u8[0]=%d\n", (int)(unsigned char)s8[0]);  // 104 = 'h'
    printf("u8[1]=%d\n", (int)(unsigned char)s8[1]);  // 105 = 'i'
    printf("u8[2]=%d\n", (int)(unsigned char)s8[2]);  // 0

    // === Array initialization from wide string literal ===
    char16_t arr16[] = u"XY";
    printf("arr16 size=%d\n", (int)(sizeof(arr16) / sizeof(char16_t)));  // 3
    printf("arr16[0]=%d\n", (int)arr16[0]);  // 88 = 'X'
    printf("arr16[1]=%d\n", (int)arr16[1]);  // 89 = 'Y'
    printf("arr16[2]=%d\n", (int)arr16[2]);  // 0

    char32_t arr32[] = U"PQ";
    printf("arr32 size=%d\n", (int)(sizeof(arr32) / sizeof(char32_t)));  // 3
    printf("arr32[0]=%d\n", (int)arr32[0]);  // 80 = 'P'
    printf("arr32[1]=%d\n", (int)arr32[1]);  // 81 = 'Q'
    printf("arr32[2]=%d\n", (int)arr32[2]);  // 0

    // === String concatenation with prefix ===
    const char16_t *cat16 = u"AB" u"CD";
    printf("cat16[0]=%d\n", (int)cat16[0]);  // 65
    printf("cat16[1]=%d\n", (int)cat16[1]);  // 66
    printf("cat16[2]=%d\n", (int)cat16[2]);  // 67
    printf("cat16[3]=%d\n", (int)cat16[3]);  // 68
    printf("cat16[4]=%d\n", (int)cat16[4]);  // 0

    // Mixed concatenation: plain + u"..." -> u"..."
    const char16_t *mixed = "AB" u"CD";
    printf("mixed[0]=%d\n", (int)mixed[0]);  // 65
    printf("mixed[3]=%d\n", (int)mixed[3]);  // 68
    printf("mixed[4]=%d\n", (int)mixed[4]);  // 0

    return 0;
}
