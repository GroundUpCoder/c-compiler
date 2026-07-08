// BUG: top-level parameter qualifiers participated in function type
// compatibility — `void f(char *, const char, const char *const)` did not
// convert to `void (*)(char *, char, const char *)`, so busybox stat.c's
// print_it(format, file, print_stat, ...) was rejected. Found porting
// coreutils batch 2 (todos/0034).
// C11: 6.7.6.3p15 — in the determination of type compatibility (and of a
// composite type), each parameter declared with qualified type is taken
// as having the unqualified version of its declared type.
// EXPECT: matches clang: qualifier-mismatched params are compatible; calls
// through the pointer work in both directions; so do redeclarations.
#include <stdio.h>

static void show(char *p, const char c, const char *const s) {
    printf("%s %c %s\n", p, c, s);
}

/* redeclaration whose params differ only in top-level qualifiers */
void show2(char *p, char c);
void show2(char *const p, const char c) { printf("%s %c\n", p, c); }

static void call(void (*fn)(char *, char, const char *)) {
    char buf[] = "via";
    fn(buf, 'q', "ptr");
}

int main(void) {
    call(show);
    void (*g)(char *, char) = show2;
    char b[] = "re";
    g(b, 'd');
    return 0;
}
