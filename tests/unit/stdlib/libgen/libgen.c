#include <stdio.h>
#include <string.h>
#include <libgen.h>

/* basename()/dirname() may modify their argument, so give each its own copy. */
static void show(const char *in) {
    char b1[256], b2[256];
    strcpy(b1, in);
    strcpy(b2, in);
    printf("[%s] base=%s dir=%s\n", in, basename(b1), dirname(b2));
}

int main(void) {
    show("/usr/lib");
    show("/usr/");
    show("usr");
    show("/");
    show("..");
    show(".");
    show("");
    show("/foo/bar/baz.txt");
    show("foo/bar/");
    return 0;
}
