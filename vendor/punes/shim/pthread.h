/* c-compiler puNES shim: single-threaded no-op pthread. We drive frames
   ourselves; the threaded core files (emu_thread/gfx_thread/snd threads) are
   not compiled, so mutex ops are pure no-ops. */
#ifndef PUNES_SHIM_PTHREAD_H_
#define PUNES_SHIM_PTHREAD_H_
typedef int pthread_t;
typedef int pthread_mutex_t;
typedef int pthread_attr_t;
typedef int pthread_mutexattr_t;
#define PTHREAD_MUTEX_INITIALIZER 0
static inline int pthread_create(pthread_t *t, const pthread_attr_t *a, void *(*f)(void *), void *p) { (void)t;(void)a;(void)f;(void)p; return 1; }
static inline int pthread_join(pthread_t t, void **r) { (void)t;(void)r; return 0; }
static inline int pthread_mutex_init(pthread_mutex_t *m, const pthread_mutexattr_t *a) { (void)m;(void)a; return 0; }
static inline int pthread_mutex_lock(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_mutex_unlock(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_mutex_destroy(pthread_mutex_t *m) { (void)m; return 0; }
#endif
