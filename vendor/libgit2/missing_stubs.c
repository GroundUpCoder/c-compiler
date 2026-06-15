/* Stubs for libgit2 on c-compiler (WASM).

   Provides out-of-line definitions for GIT_INLINE functions whose extern
   fallbacks create unresolved imports, plus networking transport stubs.

   The c-compiler matches symbols by full type signature, so we use
   forward-declared structs to get matching pointer types without pulling
   in git2.h (which the c-compiler can't parse). */

#include <stdbool.h>

/* libgit2's file-I/O helpers (lock_file, write_file_stream, cp_by_fd, ...) put
   a 64 KB GIT_BUFSIZE_FILEIO buffer on the stack. The default WASM shadow stack
   is one 64 KB page, so entering any of them underflows the stack pointer and
   traps. Force at least a 1 MB shadow stack for every libgit2 build. This TU is
   compiled into all libgit2 executable targets, and the linker takes the max
   __minstack across TUs, so anchoring it here covers the whole library. */
__minstack(1048576);

/* Forward-declare the structs we need for correct pointer types.
   These match the typedefs in git2.h — the c-compiler resolves
   `struct git_stream **` to the same type as `git_stream **`. */
struct git_stream;
struct git_transport;
struct git_smart_subtransport;
struct git_index;
struct git_iterator;

/* === Missing globals === */
bool git_http__expect_continue = false;
int git_socket_stream__connect_timeout = 10;
int git_socket_stream__timeout = 10;

/* === Inline fallback: iterator.h === */
struct git_index *git_iterator_index(struct git_iterator *iter)
{
    /* struct git_iterator { ... git_index *index; ... }
       We can't include iterator.h (c-compiler issues), so we return NULL.
       This stub is for the extern declaration — call sites that can inline
       will use the static definition in the header instead. */
    return (struct git_index *)0;
}

/* === Networking stubs === */

int git_mbedtls_stream_global_init(void) { return -1; }
int git_openssl_stream_global_init(void) { return -1; }
int git_socket_stream_global_init(void) { return 0; }

int git_socket_stream_new(struct git_stream **out, const char *host, const char *port)
{
    (void)out; (void)host; (void)port;
    return -1;
}

int git_transport_ssh_libssh2_global_init(void) { return -1; }

int git_smart_subtransport_http(
    struct git_smart_subtransport **out,
    struct git_transport *owner,
    void *param)
{
    (void)out; (void)owner; (void)param;
    return -1;
}
