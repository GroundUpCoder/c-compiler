#ifndef JQ_SHIM_PTHREAD_H
#define JQ_SHIM_PTHREAD_H
/*
 * Minimal single-threaded <pthread.h> shim for the gucOS wasm build of jq.
 *
 * The gucOS process model is single-threaded (no fork, no threads — see
 * todos/OS.md), so the only pthread surface jq actually exercises collapses
 * trivially:
 *   - thread-specific data (jv.c's decNumber context, jv_dtoa_tsd.c's dtoa
 *     context) becomes plain per-process globals, and
 *   - pthread_once() becomes a one-shot boolean.
 * jq's real threading (jq_test.c's regression threads) is behind HAVE_PTHREAD,
 * which we leave undefined, so none of pthread_create/join/exit is needed.
 *
 * Each key is created and used within a single translation unit in jq, so the
 * per-TU static key table below is coherent for every real caller.
 */
#include <stddef.h>

#define __JQ_TLS_MAX 64
static void *__jq_tls_val[__JQ_TLS_MAX];
static void (*__jq_tls_dtor[__JQ_TLS_MAX])(void *);
static int __jq_tls_n = 0;

typedef int pthread_key_t;

static inline int pthread_key_create(pthread_key_t *key, void (*dtor)(void *)) {
  if (__jq_tls_n >= __JQ_TLS_MAX) return -1;
  *key = __jq_tls_n++;
  __jq_tls_dtor[*key] = dtor;
  __jq_tls_val[*key] = NULL;
  return 0;
}
static inline int pthread_key_delete(pthread_key_t key) {
  (void)key;
  return 0;
}
static inline int pthread_setspecific(pthread_key_t key, const void *val) {
  if (key < 0 || key >= __JQ_TLS_MAX) return -1;
  __jq_tls_val[key] = (void *)val;
  return 0;
}
static inline void *pthread_getspecific(pthread_key_t key) {
  if (key < 0 || key >= __JQ_TLS_MAX) return NULL;
  return __jq_tls_val[key];
}

typedef int pthread_once_t;
#define PTHREAD_ONCE_INIT 0
static inline int pthread_once(pthread_once_t *once, void (*init)(void)) {
  if (!*once) { *once = 1; init(); }
  return 0;
}

/* No-op mutexes: nothing to serialize against in a single thread. */
typedef int pthread_mutex_t;
#define PTHREAD_MUTEX_INITIALIZER 0
static inline int pthread_mutex_init(pthread_mutex_t *m, const void *a) { (void)m; (void)a; return 0; }
static inline int pthread_mutex_lock(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_mutex_unlock(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_mutex_destroy(pthread_mutex_t *m) { (void)m; return 0; }

#endif /* JQ_SHIM_PTHREAD_H */
