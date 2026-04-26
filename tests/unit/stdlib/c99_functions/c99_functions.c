#include <stdio.h>
#include <stdlib.h>
#include <inttypes.h>
#include <errno.h>

int main(void) {
    char *end;

    // --- atoi / atol / atoll ---
    printf("atoi(\"42\"): %d\n", atoi("42"));
    printf("atoi(\"-7\"): %d\n", atoi("-7"));
    printf("atol(\"100\"): %ld\n", atol("100"));
    printf("atoll(\"123456789012345\"): %lld\n", atoll("123456789012345"));
    printf("atoll(\"-99\"): %lld\n", atoll("-99"));

    // --- strtol ---
    printf("strtol(\"0xFF\", 0): %ld\n", strtol("0xFF", &end, 0));
    // Exact LONG_MIN — no ERANGE
    errno = 0;
    printf("strtol(\"-2147483648\", 10): %ld, errno=%d\n", strtol("-2147483648", &end, 10), errno);
    errno = 0;
    long v_sl = strtol("3000000000", &end, 10);
    printf("strtol overflow: %ld, errno=%d\n", v_sl, errno);
    errno = 0;
    v_sl = strtol("-3000000000", &end, 10);
    printf("strtol underflow: %ld, errno=%d\n", v_sl, errno);

    // --- strtoul ---
    printf("strtoul(\"4294967295\", 10): %lu\n", strtoul("4294967295", &end, 10));
    printf("strtoul(\"0777\", 0): %lu\n", strtoul("0777", &end, 0));
    // C99: unsigned negation — no ERANGE (result is representable)
    errno = 0;
    printf("strtoul(\"-1\", 10): %lu, errno=%d\n", strtoul("-1", &end, 10), errno);
    errno = 0;
    unsigned long v_ul = strtoul("9999999999", &end, 10);
    printf("strtoul overflow: %lu, errno=%d\n", v_ul, errno);

    // --- strtoll ---
    printf("strtoll(\"0x1A\", 0): %lld\n", strtoll("0x1A", &end, 0));
    printf("strtoll(\"-100\", 10): %lld\n", strtoll("-100", &end, 10));
    printf("strtoll(\"7FFFFFFFFFFFFFFF\", 16): %lld\n", strtoll("7FFFFFFFFFFFFFFF", &end, 16));
    errno = 0;
    long long v_sll = strtoll("9999999999999999999", &end, 10);
    printf("strtoll overflow: %lld, errno=%d\n", v_sll, errno);
    errno = 0;
    v_sll = strtoll("-9999999999999999999", &end, 10);
    printf("strtoll underflow: %lld, errno=%d\n", v_sll, errno);

    // --- strtoull ---
    printf("strtoull(\"18446744073709551615\", 10): %llu\n", strtoull("18446744073709551615", &end, 10));
    printf("strtoull(\"FF\", 16): %llu\n", strtoull("FF", &end, 16));
    // C99: unsigned negation — no ERANGE (result is representable)
    errno = 0;
    printf("strtoull(\"-1\", 10): %llu, errno=%d\n", strtoull("-1", &end, 10), errno);
    errno = 0;
    unsigned long long v_ull = strtoull("99999999999999999999", &end, 10);
    printf("strtoull overflow: %llu, errno=%d\n", v_ull, errno);

    // endptr handling
    strtoll("  123abc", &end, 10);
    printf("endptr: '%s'\n", end);
    strtoll("  xyz", &end, 10);
    printf("no digits endptr: '%s'\n", end);

    // --- strtof / strtold ---
    printf("strtof(\"3.14\"): %.2f\n", (double)strtof("3.14", &end));
    printf("strtold(\"2.718\"): %.3f\n", (double)strtold("2.718", &end));

    // --- llabs ---
    printf("llabs(-42): %lld\n", llabs(-42));
    printf("llabs(100): %lld\n", llabs(100));

    // --- lldiv ---
    lldiv_t d = lldiv(100LL, 7LL);
    printf("lldiv(100,7): quot=%lld rem=%lld\n", d.quot, d.rem);
    d = lldiv(-100LL, 3LL);
    printf("lldiv(-100,3): quot=%lld rem=%lld\n", d.quot, d.rem);

    // --- imaxabs ---
    printf("imaxabs(-999): %lld\n", (long long)imaxabs(-999));

    // --- imaxdiv ---
    imaxdiv_t id = imaxdiv(200, 11);
    printf("imaxdiv(200,11): quot=%lld rem=%lld\n", (long long)id.quot, (long long)id.rem);

    // --- strtoimax / strtoumax ---
    printf("strtoimax(\"-1234567890123\", 10): %lld\n", (long long)strtoimax("-1234567890123", &end, 10));
    printf("strtoumax(\"FFFFFFFF\", 16): %llu\n", (unsigned long long)strtoumax("FFFFFFFF", &end, 16));

    return 0;
}
