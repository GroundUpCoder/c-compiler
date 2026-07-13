// BUG: an array of char* with EXACTLY ONE string-literal initializer —
// `const char *r[] = {"command"};` — was compiled by the `char s[] = "str"`
// byte-copy rule: the string's BYTES landed in the pointer slot instead of
// the literal's address (r[0] == 0x6d6d6f63 "comm"). Multi-element arrays
// were fine (the special case can't pattern-match), as were bare pointers.
// Hit auto locals (sized and unsized), static locals, file-scope statics,
// and compound literals alike. Found by /bin/code's build_tools()
// (todos/0174): cJSON walked the "required" name list through such an array
// and SEGV'd/hung on the garbage pointer.
// C11: 6.7.9p14 says a string literal initializes an array of CHARACTER
// type; p11/p13 make {"x"} for a char*[1] a one-element pointer init (the
// literal decays). The byte-copy shortcut applies only to character-type
// (and matching-width wchar/char16) element arrays.
// EXPECT: matches clang: every variant prints the string through the
// pointer and round-trips it through a const char** parameter.
#include <stdio.h>
#include <string.h>

static const char *file_static[] = {"file-static"};
static const char *file_static2[] = {"fs-a", "fs-b"};

static int through(const char **req, int nreq) {
    int total = 0;
    for (int i = 0; i < nreq; i++) total += (int)strlen(req[i]);
    return total;
}

int main(void) {
    const char *auto_unsized[] = {"auto-unsized"};
    const char *auto_sized[1] = {"auto-sized"};
    char *nonconst[] = {"nonconst"};
    static const char *local_static[] = {"local-static"};
    const char *two[] = {"two-a", "two-b"};

    printf("auto_unsized: %s\n", auto_unsized[0]);
    printf("auto_sized: %s\n", auto_sized[0]);
    printf("nonconst: %s\n", nonconst[0]);
    printf("local_static: %s\n", local_static[0]);
    printf("file_static: %s\n", file_static[0]);
    printf("two: %s %s\n", two[0], two[1]);
    printf("file_static2: %s %s\n", file_static2[0], file_static2[1]);
    printf("sizeof: %d %d\n", (int)(sizeof auto_unsized / sizeof auto_unsized[0]),
           (int)(sizeof two / sizeof two[0]));

    /* the shape that found it: pass through a const char** parameter */
    { const char *r[] = {"command"}; printf("through1: %d\n", through(r, 1)); }
    { const char *r[] = {"path", "content"}; printf("through2: %d\n", through(r, 2)); }

    /* the char-array byte-copy rule must keep working */
    char s1[] = "bytes";
    char s2[8] = {"braced"};
    printf("chararr: %s %s %d %d\n", s1, s2, (int)sizeof s1, (int)sizeof s2);

    /* compound literals, both flavors */
    printf("cl_char: %s\n", (char[]){"cl-bytes"});
    const char **clp = (const char *[]){"cl-ptr"};
    printf("cl_ptr: %s\n", clp[0]);
    return 0;
}
