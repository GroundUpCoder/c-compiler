/* Out-of-line definitions for libgit2 symbols that are missing.
 *
 * The c-compiler does not support inline, so GIT_INLINE_KEYWORD is empty and
 * GIT_INLINE functions become plain static. The corresponding extern declarations
 * in the same headers then create unresolved imports. This file provides the
 * external definitions those declarations require.
 *
 * Also stubs networking transports that are not included in the build. */

#include "iterator.h"
#include "git2/sys/stream.h"
#include "git2/sys/transport.h"

/* Inline fallback: iterator.h  */

/* Provide the external definition for the inline in iterator.h.
 * The header has both a GIT_INLINE (static) definition and an extern declaration;
 * the compiler resolves to the extern which needs this. */
git_index *git_iterator_index(git_iterator *iter)
{
    return iter->index;
}

/* Networking stubs */

int git_socket_stream_new(git_stream **out, const char *host, const char *port)
{
    (void)out; (void)host; (void)port;
    return -1;
}

int git_socket_stream_global_init(void)
{
    return 0;
}

int git_openssl_stream_global_init(void)
{
    return -1;
}

int git_mbedtls_stream_global_init(void)
{
    return -1;
}

int git_transport_ssh_libssh2_global_init(void)
{
    return -1;
}

int git_smart_subtransport_http(git_smart_subtransport **out, git_transport *owner, void *param)
{
    (void)out; (void)owner; (void)param;
    return -1;
}
