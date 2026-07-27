/* M0 PROBE SHIM — NOT a real <stdatomic.h>.
 *
 * compiler.js defines __STDC_NO_ATOMICS__ (a conforming choice — C11 atomics
 * are an optional feature) and provides neither the _Atomic qualifier nor the
 * GCC __atomic_* builtins.  CPython's Include/cpython/pyatomic.h therefore
 * falls straight through to
 *     #error "no available pyatomic implementation for this platform/compiler"
 *
 * gucOS processes are single-threaded (one wasm instance per Web Worker, no
 * shared linear memory between processes) and CPython's own WASI tier-2 config
 * is single-threaded with pthread STUBS, so a plain-load / plain-store
 * lowering is semantically sufficient: there is no second thread that could
 * observe a torn or reordered access.  This shim encodes exactly that.
 *
 * It exists so the probe can measure what is BEHIND this wall.  It is scaffold,
 * not a proposal — the real fix belongs in compiler.js.  See the report.
 */
#ifndef _CCPROBE_STDATOMIC_H
#define _CCPROBE_STDATOMIC_H

/* Only the functional form _Atomic(T) appears in pyatomic_std.h. */
#define _Atomic(T) T

typedef enum {
    memory_order_relaxed = 0,
    memory_order_consume = 1,
    memory_order_acquire = 2,
    memory_order_release = 3,
    memory_order_acq_rel = 4,
    memory_order_seq_cst = 5
} memory_order;

/* Read-modify-write must yield the OLD value.  compiler.js has no statement
 * expressions ({ ... }), so there is no way to introduce a temporary inside an
 * expression -- instead stash the old value in a file-static scratch slot and
 * read it back out through a __typeof__-derived pointer.  Safe here precisely
 * because the target is single-threaded and no call intervenes between the
 * stash and the read-back. */
static union { long long __i; void *__p; double __d; } __ccp_atomic_scratch;

#define __CCP_OLD(p)  (*(__typeof__(*(p)) *)&__ccp_atomic_scratch)

#define ATOMIC_VAR_INIT(v) (v)
#define atomic_init(p, v)  (*(p) = (v))

#define atomic_load(p)                  (*(p))
#define atomic_load_explicit(p, mo)     (*(p))
#define atomic_store(p, v)              ((void)(*(p) = (v)))
#define atomic_store_explicit(p, v, mo) ((void)(*(p) = (v)))

#define atomic_thread_fence(mo)  ((void)0)
#define atomic_signal_fence(mo)  ((void)0)

#define atomic_exchange(p, v) \
    (__CCP_OLD(p) = *(p), *(p) = (v), __CCP_OLD(p))
#define atomic_exchange_explicit(p, v, mo) atomic_exchange(p, v)

#define __CCP_RMW(p, op, v) \
    (__CCP_OLD(p) = *(p), \
     *(p) = (__typeof__(*(p)))(*(p) op (v)), \
     __CCP_OLD(p))

#define atomic_fetch_add(p, v)               __CCP_RMW(p, +, v)
#define atomic_fetch_add_explicit(p, v, mo)  __CCP_RMW(p, +, v)
#define atomic_fetch_sub(p, v)               __CCP_RMW(p, -, v)
#define atomic_fetch_sub_explicit(p, v, mo)  __CCP_RMW(p, -, v)
#define atomic_fetch_and(p, v)               __CCP_RMW(p, &, v)
#define atomic_fetch_and_explicit(p, v, mo)  __CCP_RMW(p, &, v)
#define atomic_fetch_or(p, v)                __CCP_RMW(p, |, v)
#define atomic_fetch_or_explicit(p, v, mo)   __CCP_RMW(p, |, v)
#define atomic_fetch_xor(p, v)               __CCP_RMW(p, ^, v)
#define atomic_fetch_xor_explicit(p, v, mo)  __CCP_RMW(p, ^, v)

/* Returns bool; on failure writes the observed value back through `e`. */
#define atomic_compare_exchange_strong(p, e, d) \
    (*(p) == *(e) ? ((*(p) = (d)), 1) : ((*(e) = *(p)), 0))
#define atomic_compare_exchange_strong_explicit(p, e, d, s, f) \
    atomic_compare_exchange_strong(p, e, d)
#define atomic_compare_exchange_weak(p, e, d) \
    atomic_compare_exchange_strong(p, e, d)
#define atomic_compare_exchange_weak_explicit(p, e, d, s, f) \
    atomic_compare_exchange_strong(p, e, d)

#endif /* _CCPROBE_STDATOMIC_H */
