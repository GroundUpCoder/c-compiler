// BUG: putenv() copied the caller's string and freed the previous environ
//      entry. POSIX putenv() installs the CALLER's pointer verbatim: later
//      edits to the buffer are visible through getenv(), putenv() of the
//      very pointer environ already holds is a no-op, and no environ entry
//      the libc did not allocate is ever freed. busybox hush's variable
//      store is written against exactly those semantics — it re-exports its
//      environ-imported PWD via putenv(varstr) where varstr IS the environ
//      entry, and frees a replaced exported var's OLD string itself after
//      putenv(new). The copy+free deviation freed hush's live PWD varstr;
//      the next script-file `a=1` landed in the freed block, false-matched
//      as "assignment does not change anything", and `$a` expanded empty
//      (env-layout dependent — ticket #296).
// C11: 7.22.4.6 (getenv); POSIX.1-2017 putenv (XSI): "the string pointed to
//      by string shall become part of the environment".
// EXPECT: edit-after-putenv is visible (2); alias re-putenv is a no-op (3);
//         setenv replaces the entry without freeing or editing the caller's
//         buffer (4); the buffer re-installs (5) and survives unsetenv (6,7).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char buf[32];

int main(void) {
  strcpy(buf, "GUC_PE=bar");
  if (putenv(buf) != 0) { printf("putenv failed\n"); return 1; }
  printf("1 %s\n", getenv("GUC_PE"));
  strcpy(buf, "GUC_PE=baz");                /* edit propagates: POSIX pointer */
  printf("2 %s\n", getenv("GUC_PE"));
  putenv(buf);                              /* environ already holds buf */
  printf("3 %s\n", getenv("GUC_PE"));
  setenv("GUC_PE", "qux", 1);               /* replace; buf stays caller's */
  printf("4 %s %s\n", getenv("GUC_PE"), buf);
  putenv(buf);                              /* re-install caller's buffer */
  printf("5 %s\n", getenv("GUC_PE"));
  unsetenv("GUC_PE");                       /* must not free buf */
  strcpy(buf, "GUC_PE=ok");                 /* buffer still usable */
  printf("6 %d\n", getenv("GUC_PE") == NULL);
  putenv(buf);
  printf("7 %s\n", getenv("GUC_PE"));
  return 0;
}
