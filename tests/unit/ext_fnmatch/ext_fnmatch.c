/* fnmatch via the optional libc-ext.js (vendored musl fnmatch). */
#include <stdio.h>
#include <fnmatch.h>

int main(void) {
    printf("%d %d\n", fnmatch("*.c", "foo.c", 0), fnmatch("*.c", "foo.h", 0));
    printf("%d %d\n", fnmatch("a?c", "abc", 0), fnmatch("a?c", "ac", 0));
    printf("%d %d\n", fnmatch("[a-z]*", "hello", 0), fnmatch("[a-z]*", "Hello", 0));
    printf("%d %d\n", fnmatch("foo/*", "foo/bar", FNM_PATHNAME),
                      fnmatch("foo/*", "foo/bar/baz", FNM_PATHNAME));
    printf("%d\n", fnmatch("HELLO", "hello", FNM_CASEFOLD));
    return 0;
}
