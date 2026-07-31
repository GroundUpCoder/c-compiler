// BUG: __environ_take_ownership registered its deep copies of the INHERITED
//      environ strings in the libc ownership registry, making them freeable:
//      unsetenv() of an inherited entry and a same-name putenv() replacement
//      both freed the copy. busybox hush's environ import loop aliases
//      exactly those strings as cur_var->varstr with max_len > 0 — hush's
//      marker for "startup env space: edit in place, NEVER free", true on
//      musl/glibc where an execve'd environment is never freed. Freeing one
//      while hush holds the alias is a use-after-free: `VAR=VAL cmd` on an
//      inherited exported var restored a dangling pointer, `export -n VAR`
//      read freed memory, and `export -n VAR=VAL` wrote into the freed block
//      (ticket #312). Inherited environ strings must be immortal; only
//      setenv-allocated entries belong to the registry.
// C11: 7.22.4.6 (getenv); POSIX.1-2017 environ, putenv (XSI), unsetenv.
// EXPECT: after the libc takes ownership of an inherited environment,
//         unsetenv of an inherited entry (2), a same-name putenv
//         replacement (3,4), and an in-place edit after unsetenv — hush's
//         export -n VAR=VAL shape — (5) all leave the pre-existing aliases
//         readable and correct, even after allocation churn that reuses
//         same-size freed blocks.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern char **environ;

/* The alias a startup-env importer (hush's loop) would hold. */
static char *find_entry(const char *prefix) {
  for (char **e = environ; *e; e++)
    if (strncmp(*e, prefix, strlen(prefix)) == 0) return *e;
  return 0;
}

/* Low-churn programs reuse a freed block on the very next same-size malloc
   (the allocator dynamic behind #296/#312) — scribble over that size class
   so a freed alias cannot read back its old bytes by luck. */
static void churn(size_t len) {
  char *p[4];
  for (int i = 0; i < 4; i++) {
    p[i] = malloc(len);
    if (p[i]) { memset(p[i], 'X', len - 1); p[i][len - 1] = '\0'; }
  }
  for (int i = 0; i < 4; i++) free(p[i]);
}

int main(void) {
  static char a[] = "GUC_IA=alpha";
  static char b[] = "GUC_IB=beta";
  static char c[] = "GUC_IC=gamma";
  static char *boot[] = { a, b, c, 0 };
  environ = boot;                 /* the "inherited" environment */

  unsetenv("GUC_NOSUCH");         /* first mutation: libc takes ownership */

  char *ia = find_entry("GUC_IA=");
  char *ib = find_entry("GUC_IB=");
  char *ic = find_entry("GUC_IC=");
  printf("1 %d\n", ia != 0 && ib != 0 && ic != 0);

  unsetenv("GUC_IA");             /* must NOT free the inherited string */
  churn(sizeof "GUC_IA=alpha");
  printf("2 %d\n", strcmp(ia, "GUC_IA=alpha") == 0);

  static char nb[] = "GUC_IB=new";
  putenv(nb);                     /* replacement must NOT free the old */
  churn(sizeof "GUC_IB=beta");
  printf("3 %d\n", strcmp(ib, "GUC_IB=beta") == 0);
  printf("4 %s\n", getenv("GUC_IB"));

  unsetenv("GUC_IC");             /* the export -n VAR=VAL shape: unsetenv, */
  strcpy(ic, "GUC_IC=delta");     /* then edit the startup space in place */
  churn(sizeof "GUC_IC=gamma");
  printf("5 %d\n", strcmp(ic, "GUC_IC=delta") == 0);
  return 0;
}
