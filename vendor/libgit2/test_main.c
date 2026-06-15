/* Reproduction: git_index_open crashes due to stack corruption in parse_index.

   The c-compiler miscompiles parse_index() in a way that corrupts the
   caller's stack-local git_str buffer.ptr field. After parse_index
   returns, git_str_dispose passes the corrupted pointer to free(),
   which detects an out-of-bounds address.

   The bug is in the compiler's stack frame layout for parse_index
   when embedded in the full libgit2 build context. It corrupts
   buffer.ptr from a valid heap pointer to a garbage value (0x5). */

#include <stdio.h>
#include <git2.h>

int main(void) {
    git_libgit2_init();

    git_index *idx = NULL;
    int e = git_index_open(&idx, "/tmp/minimal.idx");
    printf("git_index_open -> %d\n", e);
    if (e == 0) git_index_free(idx);

    git_libgit2_shutdown();
    printf("done (should not reach here - crash expected above)\n");
    return 0;
}
