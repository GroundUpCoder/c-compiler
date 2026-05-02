#include <stdio.h>
#include <guc.h>

void test_jss(void) {
    printf("=== __jss ===\n");
    __externref s = __jss("hello");
    printf("%d\n", s != 0); // 1
    __jslog(s);             // hello
}

void test_wjs_builtins(void) {
    printf("=== wasm:js-string ===\n");
    __externref s = __jss("hello world");
    printf("%d\n", __wjs_length(s));          // 11
    printf("%d\n", __wjs_charCodeAt(s, 0));   // 104 ('h')

    __externref a = __jss("abc");
    __externref b = __jss("abc");
    __externref c = __jss("def");
    printf("%d\n", __wjs_equals(a, b));       // 1
    printf("%d\n", __wjs_equals(a, c));       // 0

    __refextern cat = __wjs_concat(a, c);
    printf("%d\n", __wjs_length(cat));        // 6
    __jslog(cat);                             // abcdef

    __refextern sub = __wjs_substring(s, 6, 11);
    __jslog(sub);                             // world

    __refextern ch = __wjs_fromCharCode(65);
    __jslog(ch);                              // A

    printf("%d\n", __wjs_compare(a, c));      // -1 (abc < def)
    printf("%d\n", __wjs_compare(c, a));      // 1  (def > abc)
    printf("%d\n", __wjs_compare(a, b));      // 0  (abc == abc)

    __refextern emoji = __wjs_fromCodePoint(128640);
    printf("%d\n", __wjs_length(emoji));      // 2 (surrogate pair)

    printf("%d\n", __wjs_codePointAt(s, 0));  // 104 ('h')

    printf("%d\n", __wjs_test(s));            // 1 (is a string)
    __externref notstr = __jsglobal();
    printf("%d\n", __wjs_test(notstr));       // 0 (not a string)

    __refextern casted = __wjs_cast(s);
    printf("%d\n", __wjs_length(casted));     // 11
}

void test_jsstr_read(void) {
    printf("=== __jsstr_read ===\n");

    // Basic read — fits with room for \0
    __externref s = __jss("hello");
    char buf[32];
    int written;
    int ok = __jsstr_read(s, buf, sizeof(buf), &written);
    printf("%d\n", ok);       // 1
    printf("%d\n", written);  // 5
    printf("%s\n", buf);      // hello

    // Truncation — buffer too small
    char small[3];
    ok = __jsstr_read(s, small, sizeof(small), &written);
    printf("%d\n", ok);       // 0
    printf("%d\n", written);  // 3

    // UTF-8 multibyte
    __externref utf8 = __wjs_fromCodePoint(0x00E9); // é = 2 bytes in UTF-8
    printf("%d\n", __jsstr_utf8len(utf8));           // 2
    char ubuf[8];
    ok = __jsstr_read(utf8, ubuf, sizeof(ubuf), &written);
    printf("%d\n", ok);       // 1
    printf("%d\n", written);  // 2

    // Exact fit — no room for \0
    char exact[5];
    ok = __jsstr_read(s, exact, 5, &written);
    printf("%d\n", ok);       // 1
    printf("%d\n", written);  // 5

    // UTF-8 length
    __externref ascii = __jss("abc");
    printf("%d\n", __jsstr_utf8len(ascii)); // 3
    __externref hw = __jss("hello world");
    printf("%d\n", __jsstr_utf8len(hw));    // 11
}

int main(void) {
    test_jss();
    test_wjs_builtins();
    test_jsstr_read();
    return 0;
}
