#pragma once

#define GB_likely(x)   __builtin_expect((bool)(x), 1)
#define GB_unlikely(x) __builtin_expect((bool)(x), 0)
/* PATCH(c-compiler): compound literal instead of a statement expression.
   Value-identical for SameBoy's `inline_const(uint8_t[], {...})[i]` lookup
   tables; storage is automatic instead of static, which is fine for reads. */
#define GB_inline_const(type, ...) ((const type)__VA_ARGS__)

#if !defined(typeof)
#if defined(__cplusplus) || __STDC_VERSION__ < 202311
#define typeof __typeof__
#endif
#endif

#ifdef GB_INTERNAL

// "Keyword" definitions
#define likely(x)   GB_likely(x)
#define unlikely(x) GB_unlikely(x)
#define inline_const GB_inline_const

/* PATCH(c-compiler): plain ternaries instead of statement expressions.
   Double-evaluates the arguments; every call site in the vendored subset
   passes side-effect-free expressions (audited at v1.0.3). */
#if !defined(MIN)
#define MIN(A, B)    ((A) < (B) ? (A) : (B))
#endif

#if !defined(MAX)
#define MAX(A, B)    ((A) < (B) ? (B) : (A))
#endif

/* PATCH(c-compiler): this compiler has no __builtin_bswap*; provide all
   three as static inline functions (single evaluation, unlike the macro
   this replaces). */
#include <stdint.h>
static inline uint16_t __sameboy_bswap16(uint16_t x)
{
    return (uint16_t)(x >> 8 | x << 8);
}
static inline uint32_t __sameboy_bswap32(uint32_t x)
{
    return x >> 24 | ((x >> 8) & 0xFF00) | ((x << 8) & 0xFF0000) | x << 24;
}
static inline uint64_t __sameboy_bswap64(uint64_t x)
{
    return (uint64_t)__sameboy_bswap32((uint32_t)(x >> 32)) |
           ((uint64_t)__sameboy_bswap32((uint32_t)x) << 32);
}
#define __builtin_bswap16 __sameboy_bswap16
#define __builtin_bswap32 __sameboy_bswap32
#define __builtin_bswap64 __sameboy_bswap64

#define internal __attribute__((visibility("hidden")))
#define noinline __attribute__((noinline))

#if __clang__
#define unrolled _Pragma("unroll")
#define nounroll _Pragma("clang loop unroll(disable)")
#elif __GNUC__ >= 8
#define unrolled _Pragma("GCC unroll 8")
#define nounroll _Pragma("GCC unroll 0")
#else
#define unrolled
#define nounroll
#endif

#define unreachable() __builtin_unreachable();
#define nodefault default: unreachable()

#ifdef GB_BIG_ENDIAN
#define LE16(x) __builtin_bswap16(x)
#define LE32(x) __builtin_bswap32(x)
#define LE64(x) __builtin_bswap64(x)
#define BE16(x) (x)
#define BE32(x) (x)
#define BE64(x) (x)
#else
#define LE16(x) (x)
#define LE32(x) (x)
#define LE64(x) (x)
#define BE16(x) __builtin_bswap16(x)
#define BE32(x) __builtin_bswap32(x)
#define BE64(x) __builtin_bswap64(x)
#endif
#endif

struct GB_gameboy_s;
typedef struct GB_gameboy_s GB_gameboy_t;
