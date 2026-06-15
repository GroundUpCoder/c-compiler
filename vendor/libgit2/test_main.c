/* Smoke test: git_index_open() on a minimal index file.

   This used to crash with "free: double free detected": SHA1 hashing
   overflowed an under-sized git_hash_ctx and corrupted the caller's
   git_str buffer.ptr, which git_str_dispose then free()'d. Root cause was a
   compiler bug (a struct/union member of incomplete type was silently sized
   as 0) plus a libgit2 misconfig (GIT_SHA1_COLLISIONDETECT defined instead of
   the GIT_SHA1_BUILTIN the code checks, leaving git_hash_sha1_ctx incomplete
   in hash.c). Both are fixed; this now prints "git_index_open -> 0" and the
   "done" line below. See README.md. */

#include <stdio.h>
#include <git2.h>

int main(void) {
    git_libgit2_init();

    git_index *idx = NULL;
    int e = git_index_open(&idx, "/tmp/minimal.idx");
    printf("git_index_open -> %d\n", e);
    if (e == 0) git_index_free(idx);

    git_libgit2_shutdown();
    printf("done\n");
    return 0;
}
