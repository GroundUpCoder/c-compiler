/* POSIX regex via the optional libc-ext.js (vendored TRE). Exercises compile,
   capture groups, POSIX character classes, REG_NOMATCH, and regerror text. */
#include <stdio.h>
#include <regex.h>

int main(void) {
    regex_t re;
    regmatch_t m[2];

    printf("compile=%d\n", regcomp(&re, "^a([0-9]+)z$", REG_EXTENDED));
    printf("match=%d grp=[%d,%d]\n",
           regexec(&re, "a123z", 2, m, 0), (int)m[1].rm_so, (int)m[1].rm_eo);
    printf("nomatch=%d (NOMATCH=%d)\n", regexec(&re, "a12y", 0, 0, 0), REG_NOMATCH);
    regfree(&re);

    regex_t cls;
    regcomp(&cls, "[[:digit:]]+", REG_EXTENDED);
    printf("class_hit=%d class_miss=%d\n",
           regexec(&cls, "abc42", 0, 0, 0), regexec(&cls, "abc", 0, 0, 0));
    regfree(&cls);

    regex_t ci;
    regcomp(&ci, "hello", REG_EXTENDED | REG_ICASE);
    printf("icase=%d\n", regexec(&ci, "say HELLO now", 0, 0, 0));
    regfree(&ci);

    char eb[64];
    regex_t bad;
    int e = regcomp(&bad, "a(", REG_EXTENDED);
    regerror(e, &bad, eb, sizeof eb);
    printf("err=%d msg=%s\n", e, eb);
    return 0;
}
