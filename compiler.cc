#include <bit>
#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <chrono>
#include <ctime>
#include <deque>
#include <filesystem>
#include <format>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <span>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

using std::nullptr_t;

// ====================
// Standard library
// ====================

std::map<std::string_view, std::string_view> standardLibraryHeaderFiles = {
    {"stdint.h", R"(
#pragma once

// Exact-width integer types
typedef signed char int8_t;
typedef unsigned char uint8_t;
typedef short int16_t;
typedef unsigned short uint16_t;
typedef int int32_t;
typedef unsigned int uint32_t;
typedef long long int64_t;
typedef unsigned long long uint64_t;

// Minimum-width integer types (use exact-width types)
typedef int8_t int_least8_t;
typedef uint8_t uint_least8_t;
typedef int16_t int_least16_t;
typedef uint16_t uint_least16_t;
typedef int32_t int_least32_t;
typedef uint32_t uint_least32_t;
typedef int64_t int_least64_t;
typedef uint64_t uint_least64_t;

// Fastest minimum-width integer types
// For wasm32, 32-bit operations are native
typedef int8_t int_fast8_t;
typedef uint8_t uint_fast8_t;
typedef int32_t int_fast16_t;
typedef uint32_t uint_fast16_t;
typedef int32_t int_fast32_t;
typedef uint32_t uint_fast32_t;
typedef int64_t int_fast64_t;
typedef uint64_t uint_fast64_t;

// Integer types capable of holding object pointers
typedef long intptr_t;
typedef unsigned long uintptr_t;

// Greatest-width integer types
typedef int64_t intmax_t;
typedef uint64_t uintmax_t;

// Limits of exact-width integer types
#define INT8_MIN (-128)
#define INT8_MAX 127
#define UINT8_MAX 255
#define INT16_MIN (-32768)
#define INT16_MAX 32767
#define UINT16_MAX 65535
#define INT32_MIN (-2147483647 - 1)
#define INT32_MAX 2147483647
#define UINT32_MAX 4294967295U
#define INT64_MIN (-9223372036854775807LL - 1LL)
#define INT64_MAX 9223372036854775807LL
#define UINT64_MAX 18446744073709551615ULL

// Limits of minimum-width integer types
#define INT_LEAST8_MIN INT8_MIN
#define INT_LEAST8_MAX INT8_MAX
#define UINT_LEAST8_MAX UINT8_MAX
#define INT_LEAST16_MIN INT16_MIN
#define INT_LEAST16_MAX INT16_MAX
#define UINT_LEAST16_MAX UINT16_MAX
#define INT_LEAST32_MIN INT32_MIN
#define INT_LEAST32_MAX INT32_MAX
#define UINT_LEAST32_MAX UINT32_MAX
#define INT_LEAST64_MIN INT64_MIN
#define INT_LEAST64_MAX INT64_MAX
#define UINT_LEAST64_MAX UINT64_MAX

// Limits of fastest minimum-width integer types
#define INT_FAST8_MIN INT8_MIN
#define INT_FAST8_MAX INT8_MAX
#define UINT_FAST8_MAX UINT8_MAX
#define INT_FAST16_MIN INT32_MIN
#define INT_FAST16_MAX INT32_MAX
#define UINT_FAST16_MAX UINT32_MAX
#define INT_FAST32_MIN INT32_MIN
#define INT_FAST32_MAX INT32_MAX
#define UINT_FAST32_MAX UINT32_MAX
#define INT_FAST64_MIN INT64_MIN
#define INT_FAST64_MAX INT64_MAX
#define UINT_FAST64_MAX UINT64_MAX

// Limits of integer types capable of holding object pointers
#define INTPTR_MIN INT32_MIN
#define INTPTR_MAX INT32_MAX
#define UINTPTR_MAX UINT32_MAX

// Limits of greatest-width integer types
#define INTMAX_MIN INT64_MIN
#define INTMAX_MAX INT64_MAX
#define UINTMAX_MAX UINT64_MAX

// Limits of other integer types
#define PTRDIFF_MIN INT32_MIN
#define PTRDIFF_MAX INT32_MAX
#define SIZE_MAX UINT32_MAX

// Macros for integer constant expressions
#define INT8_C(x) (x)
#define INT16_C(x) (x)
#define INT32_C(x) (x)
#define INT64_C(x) (x ## LL)
#define UINT8_C(x) (x)
#define UINT16_C(x) (x)
#define UINT32_C(x) (x ## U)
#define UINT64_C(x) (x ## ULL)
#define INTMAX_C(x) INT64_C(x)
#define UINTMAX_C(x) UINT64_C(x)
  )"},

    {"inttypes.h", R"(
#pragma once
#include <stdint.h>

// Format macros for fprintf (wasm32: int=32, long=32, long long=64)
#define PRId8  "d"
#define PRId16 "d"
#define PRId32 "d"
#define PRId64 "lld"
#define PRIi8  "i"
#define PRIi16 "i"
#define PRIi32 "i"
#define PRIi64 "lli"
#define PRIu8  "u"
#define PRIu16 "u"
#define PRIu32 "u"
#define PRIu64 "llu"
#define PRIo8  "o"
#define PRIo16 "o"
#define PRIo32 "o"
#define PRIo64 "llo"
#define PRIx8  "x"
#define PRIx16 "x"
#define PRIx32 "x"
#define PRIx64 "llx"
#define PRIX8  "X"
#define PRIX16 "X"
#define PRIX32 "X"
#define PRIX64 "llX"

#define PRIdLEAST8  PRId8
#define PRIdLEAST16 PRId16
#define PRIdLEAST32 PRId32
#define PRIdLEAST64 PRId64
#define PRIiLEAST8  PRIi8
#define PRIiLEAST16 PRIi16
#define PRIiLEAST32 PRIi32
#define PRIiLEAST64 PRIi64
#define PRIuLEAST8  PRIu8
#define PRIuLEAST16 PRIu16
#define PRIuLEAST32 PRIu32
#define PRIuLEAST64 PRIu64
#define PRIoLEAST8  PRIo8
#define PRIoLEAST16 PRIo16
#define PRIoLEAST32 PRIo32
#define PRIoLEAST64 PRIo64
#define PRIxLEAST8  PRIx8
#define PRIxLEAST16 PRIx16
#define PRIxLEAST32 PRIx32
#define PRIxLEAST64 PRIx64
#define PRIXLEAST8  PRIX8
#define PRIXLEAST16 PRIX16
#define PRIXLEAST32 PRIX32
#define PRIXLEAST64 PRIX64

#define PRIdFAST8  PRId8
#define PRIdFAST16 PRId32
#define PRIdFAST32 PRId32
#define PRIdFAST64 PRId64
#define PRIiFAST8  PRIi8
#define PRIiFAST16 PRIi32
#define PRIiFAST32 PRIi32
#define PRIiFAST64 PRIi64
#define PRIuFAST8  PRIu8
#define PRIuFAST16 PRIu32
#define PRIuFAST32 PRIu32
#define PRIuFAST64 PRIu64
#define PRIoFAST8  PRIo8
#define PRIoFAST16 PRIo32
#define PRIoFAST32 PRIo32
#define PRIoFAST64 PRIo64
#define PRIxFAST8  PRIx8
#define PRIxFAST16 PRIx32
#define PRIxFAST32 PRIx32
#define PRIxFAST64 PRIx64
#define PRIXFAST8  PRIX8
#define PRIXFAST16 PRIX32
#define PRIXFAST32 PRIX32
#define PRIXFAST64 PRIX64

#define PRIdPTR "d"
#define PRIiPTR "i"
#define PRIuPTR "u"
#define PRIoPTR "o"
#define PRIxPTR "x"
#define PRIXPTR "X"

#define PRIdMAX PRId64
#define PRIiMAX PRIi64
#define PRIuMAX PRIu64
#define PRIoMAX PRIo64
#define PRIxMAX PRIx64
#define PRIXMAX PRIX64

// Format macros for fscanf
#define SCNd8  "hhd"
#define SCNd16 "hd"
#define SCNd32 "d"
#define SCNd64 "lld"
#define SCNi8  "hhi"
#define SCNi16 "hi"
#define SCNi32 "i"
#define SCNi64 "lli"
#define SCNu8  "hhu"
#define SCNu16 "hu"
#define SCNu32 "u"
#define SCNu64 "llu"
#define SCNo8  "hho"
#define SCNo16 "ho"
#define SCNo32 "o"
#define SCNo64 "llo"
#define SCNx8  "hhx"
#define SCNx16 "hx"
#define SCNx32 "x"
#define SCNx64 "llx"

#define SCNdLEAST8  SCNd8
#define SCNdLEAST16 SCNd16
#define SCNdLEAST32 SCNd32
#define SCNdLEAST64 SCNd64
#define SCNiLEAST8  SCNi8
#define SCNiLEAST16 SCNi16
#define SCNiLEAST32 SCNi32
#define SCNiLEAST64 SCNi64
#define SCNuLEAST8  SCNu8
#define SCNuLEAST16 SCNu16
#define SCNuLEAST32 SCNu32
#define SCNuLEAST64 SCNu64
#define SCNoLEAST8  SCNo8
#define SCNoLEAST16 SCNo16
#define SCNoLEAST32 SCNo32
#define SCNoLEAST64 SCNo64
#define SCNxLEAST8  SCNx8
#define SCNxLEAST16 SCNx16
#define SCNxLEAST32 SCNx32
#define SCNxLEAST64 SCNx64

#define SCNdFAST8  SCNd8
#define SCNdFAST16 SCNd32
#define SCNdFAST32 SCNd32
#define SCNdFAST64 SCNd64
#define SCNiFAST8  SCNi8
#define SCNiFAST16 SCNi32
#define SCNiFAST32 SCNi32
#define SCNiFAST64 SCNi64
#define SCNuFAST8  SCNu8
#define SCNuFAST16 SCNu32
#define SCNuFAST32 SCNu32
#define SCNuFAST64 SCNu64
#define SCNoFAST8  SCNo8
#define SCNoFAST16 SCNo32
#define SCNoFAST32 SCNo32
#define SCNoFAST64 SCNo64
#define SCNxFAST8  SCNx8
#define SCNxFAST16 SCNx32
#define SCNxFAST32 SCNx32
#define SCNxFAST64 SCNx64

#define SCNdPTR "d"
#define SCNiPTR "i"
#define SCNuPTR "u"
#define SCNoPTR "o"
#define SCNxPTR "x"

#define SCNdMAX SCNd64
#define SCNiMAX SCNi64
#define SCNuMAX SCNu64
#define SCNoMAX SCNo64
#define SCNxMAX SCNx64

// Functions
typedef struct { intmax_t quot; intmax_t rem; } imaxdiv_t;

intmax_t imaxabs(intmax_t n);
imaxdiv_t imaxdiv(intmax_t numer, intmax_t denom);
intmax_t strtoimax(const char *nptr, char **endptr, int base);
uintmax_t strtoumax(const char *nptr, char **endptr, int base);
  )"},

    {"float.h", R"(
#pragma once
#define FLT_RADIX 2
#define FLT_ROUNDS 1
#define FLT_EVAL_METHOD 0
#define DECIMAL_DIG 21
#define FLT_DIG 6
#define FLT_MANT_DIG 24
#define FLT_MIN_EXP (-125)
#define FLT_MAX_EXP 128
#define FLT_MIN_10_EXP (-37)
#define FLT_MAX_10_EXP 38
#define FLT_MIN 1.17549435e-38F
#define FLT_MAX 3.40282347e+38F
#define FLT_EPSILON 1.19209290e-7F
#define FLT_TRUE_MIN 1.40129846e-45F
#define DBL_DIG 15
#define DBL_MANT_DIG 53
#define DBL_MIN_EXP (-1021)
#define DBL_MAX_EXP 1024
#define DBL_MIN_10_EXP (-307)
#define DBL_MAX_10_EXP 308
#define DBL_MIN 2.2250738585072014e-308
#define DBL_MAX 1.7976931348623157e+308
#define DBL_EPSILON 2.2204460492503131e-16
#define DBL_TRUE_MIN 4.9406564584124654e-324
#define LDBL_DIG DBL_DIG
#define LDBL_MANT_DIG DBL_MANT_DIG
#define LDBL_MIN_EXP DBL_MIN_EXP
#define LDBL_MAX_EXP DBL_MAX_EXP
#define LDBL_MIN_10_EXP DBL_MIN_10_EXP
#define LDBL_MAX_10_EXP DBL_MAX_10_EXP
#define LDBL_MIN DBL_MIN
#define LDBL_MAX DBL_MAX
#define LDBL_EPSILON DBL_EPSILON
#define LDBL_TRUE_MIN DBL_TRUE_MIN
  )"},

    {"limits.h", R"(
#pragma once
#define CHAR_BIT 8
#define SCHAR_MIN (-128)
#define SCHAR_MAX 127
#define UCHAR_MAX 255
#define CHAR_MIN SCHAR_MIN
#define CHAR_MAX SCHAR_MAX
#define MB_LEN_MAX 4
#define SHRT_MIN (-32768)
#define SHRT_MAX 32767
#define USHRT_MAX 65535
#define INT_MIN (-2147483647 - 1)
#define INT_MAX 2147483647
#define UINT_MAX 4294967295U
#define LONG_MIN (-2147483647L - 1L)
#define LONG_MAX 2147483647L
#define ULONG_MAX 4294967295UL
#define LLONG_MIN (-9223372036854775807LL - 1LL)
#define LLONG_MAX 9223372036854775807LL
#define ULLONG_MAX 18446744073709551615ULL
  )"},

    {"stdarg.h", R"(
#pragma once
typedef int *__va_elem;
typedef __va_elem va_list[1];
#define va_start(ap, param) __builtin_va_start(ap[0], param)
#define va_arg(ap, type) __builtin_va_arg(ap[0], type)
#define va_end(ap) __builtin_va_end(ap[0])
#define va_copy(dest, src) __builtin_va_copy(dest[0], src[0])
  )"},

    {"stddef.h", R"(
#pragma once
typedef unsigned long size_t; // Use long for all pointer-sized types
typedef long ptrdiff_t;
typedef int wchar_t;
typedef long double max_align_t;
#define NULL ((void *)0)
#define offsetof(type, member) ((size_t)&((type *)0)->member)
  )"},

    {"uchar.h", R"(
#pragma once
#include <stdint.h>
typedef uint_least16_t char16_t;
typedef uint_least32_t char32_t;
#define __STDC_UTF_16__ 1
#define __STDC_UTF_32__ 1
  )"},

    {"__atexit.h", R"(
#pragma once
__require_source("__atexit.c");
int atexit(void (*func)(void));
void __run_atexits(void);
  )"},

    {"__malloc.h", R"(
#pragma once
#include <stddef.h>
__require_source("__malloc.c");

#define __builtin_clz(x) __wasm(int, (x), op 0x67)
#define __builtin_ctz(x) __wasm(int, (x), op 0x68)
#define __builtin_clzll(x) ((int)__wasm(long long, (x), op 0x79))
#define __builtin_ctzll(x) ((int)__wasm(long long, (x), op 0x7a))

void *malloc(size_t size);
void free(void *ptr);
void *calloc(size_t count, size_t size);
void *realloc(void *ptr, size_t new_size);
void *aligned_alloc(size_t alignment, size_t size);

struct __heap_info {
  long heap_start;
  long heap_end;
  long total_bytes;
  long free_blocks;
  long free_bytes;
  long largest_free;
};
void __inspect_heap(struct __heap_info *info);
  )"},

    {"stdlib.h", R"(
#pragma once
__require_source("__stdlib.c");
#include <stddef.h>
#include <__atexit.h>
#include <__malloc.h>

#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
#define RAND_MAX 32767

int abs(int n);
long labs(long n);

typedef struct { int quot; int rem; } div_t;
typedef struct { long quot; long rem; } ldiv_t;
typedef struct { long long quot; long long rem; } lldiv_t;
div_t div(int numer, int denom);
ldiv_t ldiv(long numer, long denom);
lldiv_t lldiv(long long numer, long long denom);

int atoi(const char *nptr);
long atol(const char *nptr);
long long atoll(const char *nptr);
long strtol(const char *nptr, char **endptr, int base);
unsigned long strtoul(const char *nptr, char **endptr, int base);
long long strtoll(const char *nptr, char **endptr, int base);
unsigned long long strtoull(const char *nptr, char **endptr, int base);
double strtod(const char *nptr, char **endptr);
float strtof(const char *nptr, char **endptr);
long double strtold(const char *nptr, char **endptr);
double atof(const char *nptr);
long long llabs(long long n);
int rand(void);
void srand(unsigned int seed);
void *bsearch(const void *key, const void *base, size_t nmemb,
              size_t size, int (*compar)(const void *, const void *));
void qsort(void *base, size_t nmemb, size_t size,
           int (*compar)(const void *, const void *));
void exit(int status);
void abort(void);

char *getenv(const char *name);
int setenv(const char *name, const char *value, int overwrite);
int unsetenv(const char *name);
int system(const char *command);

#define MB_CUR_MAX 1
int mblen(const char *s, size_t n);
int mbtowc(wchar_t *pwc, const char *s, size_t n);
int wctomb(char *s, wchar_t wc);
size_t mbstowcs(wchar_t *dest, const char *src, size_t n);
size_t wcstombs(char *dest, const wchar_t *src, size_t n);
  )"},

    {"stdio.h", R"(
#pragma once
__require_source("__stdio.c");
#include <stddef.h>
#include <stdarg.h>
#define NULL ((void *)0)
#define EOF (-1)

#define _IOFBF 0
#define _IOLBF 1
#define _IONBF 2
#define BUFSIZ 1024
#define FOPEN_MAX 64
#define FILENAME_MAX 4096
#define L_tmpnam 20
#define TMP_MAX 10000

#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2

#define __F_READ  1
#define __F_WRITE 2
#define __F_APPEND 4
#define __F_EOF   8
#define __F_ERR   16

typedef struct FILE {
  int fd;
  int flags;
  int buf_mode;
  char *buf;
  int buf_size;
  int buf_pos;
  int buf_len;
  int ungetc_char;
} FILE;

typedef long fpos_t;

extern FILE __stdin_file;
extern FILE __stdout_file;
extern FILE __stderr_file;

#define stdin  (&__stdin_file)
#define stdout (&__stdout_file)
#define stderr (&__stderr_file)

int sprintf(char *buf, const char *fmt, ...);
int snprintf(char *buf, size_t size, const char *fmt, ...);
__import int vsnprintf(char *buf, size_t size, const char *fmt, va_list ap);

int printf(const char *fmt, ...);
int vprintf(const char *fmt, va_list ap);
int fprintf(FILE *stream, const char *fmt, ...);
int vfprintf(FILE *stream, const char *fmt, va_list ap);
int vsprintf(char *buf, const char *fmt, va_list ap);
int putchar(int c);
int puts(const char *s);
FILE *fopen(const char *path, const char *mode);
int fclose(FILE *stream);
size_t fread(void *ptr, size_t size, size_t nmemb, FILE *stream);
size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream);
int fflush(FILE *stream);
int fputs(const char *s, FILE *stream);
int fputc(int c, FILE *stream);
int fgetc(FILE *stream);
char *fgets(char *s, int n, FILE *stream);
int ungetc(int c, FILE *stream);

int fseek(FILE *stream, long offset, int whence);
long ftell(FILE *stream);
void rewind(FILE *stream);
int fgetpos(FILE *stream, fpos_t *pos);
int fsetpos(FILE *stream, const fpos_t *pos);

int feof(FILE *stream);
int ferror(FILE *stream);
void clearerr(FILE *stream);
int setvbuf(FILE *stream, char *buf, int mode, size_t size);
void setbuf(FILE *stream, char *buf);
void perror(const char *s);
char *gets(char *s);

__import int __vsscanf_impl(const char *str, int str_len, const char *fmt,
                            int *consumed, va_list ap);
int vsscanf(const char *s, const char *fmt, va_list ap);
int sscanf(const char *s, const char *fmt, ...);
int vfscanf(FILE *stream, const char *fmt, va_list ap);
int fscanf(FILE *stream, const char *fmt, ...);
int vscanf(const char *fmt, va_list ap);
int scanf(const char *fmt, ...);

__import int remove(const char *path);
__import int rename(const char *oldpath, const char *newpath);

FILE *freopen(const char *path, const char *mode, FILE *stream);
FILE *tmpfile(void);
char *tmpnam(char *s);
FILE *popen(const char *command, const char *type);
int pclose(FILE *stream);

#define getc(stream)     fgetc(stream)
#define getchar()        fgetc(stdin)
#define putc(c, stream)  fputc(c, stream)
  )"},

    {"string.h", R"(
#pragma once
__require_source("__string.c");
#include <stddef.h>
#define NULL ((void *)0)
void *memcpy(void *dest, const void *src, size_t n);
void *memmove(void *dest, const void *src, size_t n);
void *memset(void *s, int c, size_t n);
int memcmp(const void *s1, const void *s2, size_t n);
size_t strlen(const char *s);
char *strcpy(char *dest, const char *src);
char *strncpy(char *dest, const char *src, size_t n);
int strcmp(const char *s1, const char *s2);
int strncmp(const char *s1, const char *s2, size_t n);
char *strcat(char *dest, const char *src);
char *strchr(const char *s, int c);
char *strrchr(const char *s, int c);
char *strstr(const char *haystack, const char *needle);
void *memchr(const void *s, int c, size_t n);
char *strncat(char *dest, const char *src, size_t n);
size_t strspn(const char *s, const char *accept);
size_t strcspn(const char *s, const char *reject);
char *strpbrk(const char *s, const char *accept);
char *strtok(char *str, const char *delim);
int strcoll(const char *s1, const char *s2);
size_t strxfrm(char *dest, const char *src, size_t n);
char *strerror(int errnum);
char *strdup(const char *s);
  )"},

    {"assert.h", R"(
__require_source("__assert.c");
void __assert_fail(const char *expr, const char *file, int line);
#ifdef NDEBUG
#define assert(expr) ((void)0)
#else
#define assert(expr) ((expr) ? (void)0 : __assert_fail(#expr, __FILE__, __LINE__))
#endif
#define static_assert _Static_assert
  )"},

    {"math.h", R"(
#pragma once
__require_source("__math.c");

#define INFINITY (1.0f / 0.0f)
#define NAN (0.0f / 0.0f)
#define HUGE_VAL ((double)INFINITY)
#define HUGE_VALF INFINITY
#define HUGE_VALL ((long double)INFINITY)

#define M_E        2.71828182845904523536
#define M_LOG2E    1.44269504088896340736
#define M_LOG10E   0.43429448190325182765
#define M_LN2      0.69314718055994530942
#define M_LN10     2.30258509299404568402
#define M_PI       3.14159265358979323846
#define M_PI_2     1.57079632679489661923
#define M_PI_4     0.78539816339744830962
#define M_1_PI     0.31830988618379067154
#define M_2_PI     0.63661977236758134308
#define M_2_SQRTPI 1.12837916709551257390
#define M_SQRT2    1.41421356237309504880
#define M_SQRT1_2  0.70710678118654752440

double fabs(double x);
double ceil(double x);
double floor(double x);
double trunc(double x);
double nearbyint(double x);
double rint(double x);
double sqrt(double x);

float fabsf(float x);
float ceilf(float x);
float floorf(float x);
float truncf(float x);
float nearbyintf(float x);
float rintf(float x);
float sqrtf(float x);

double fmin(double x, double y);
double fmax(double x, double y);
double copysign(double x, double y);

float fminf(float x, float y);
float fmaxf(float x, float y);
float copysignf(float x, float y);

// Host-imported math functions
__import double sin(double x);
__import double cos(double x);
__import double tan(double x);
__import double asin(double x);
__import double acos(double x);
__import double atan(double x);
__import double atan2(double y, double x);
__import double sinh(double x);
__import double cosh(double x);
__import double tanh(double x);
__import double asinh(double x);
__import double acosh(double x);
__import double atanh(double x);
__import double exp(double x);
__import double expm1(double x);
__import double log(double x);
__import double log2(double x);
__import double log10(double x);
__import double log1p(double x);
__import double pow(double x, double y);
__import double cbrt(double x);
__import double hypot(double x, double y);
__import double fmod(double x, double y);

float sinf(float x);
float cosf(float x);
float tanf(float x);
float asinf(float x);
float acosf(float x);
float atanf(float x);
float atan2f(float y, float x);
float sinhf(float x);
float coshf(float x);
float tanhf(float x);
float asinhf(float x);
float acoshf(float x);
float atanhf(float x);
float expf(float x);
float expm1f(float x);
float logf(float x);
float log2f(float x);
float log10f(float x);
float log1pf(float x);
float powf(float x, float y);
float cbrtf(float x);
float hypotf(float x, float y);
float fmodf(float x, float y);

double round(double x);
float roundf(float x);
double fdim(double x, double y);
float fdimf(float x, float y);
long lround(double x);
long lrint(double x);
long lroundf(float x);
long lrintf(float x);
double nextafter(double x, double y);
float nextafterf(float x, float y);
double frexp(double x, int *exp);
double ldexp(double x, int n);
float ldexpf(float x, int n);
int ilogb(double x);
double logb(double x);
double modf(double x, double *iptr);
float modff(float x, float *iptr);
  )"},

    // setjmp/longjmp: lowered to WASM exceptions by a per-TU AST pass.
    // setjmp(buf) is recognized in 'if' conditions and transformed to try/catch.
    // longjmp(buf, val) is transformed to throw.
    // See lowerSetjmpLongjmp().
    {"setjmp.h", R"(
#pragma once
__require_source("__setjmp.c");
typedef int jmp_buf[1];
__exception __LongJump(int, int);
extern int __setjmp_id_counter;
__import int setjmp(jmp_buf env);
__import void longjmp(jmp_buf env, int val);
  )"},

    {"signal.h", R"(
#error "signal.h is not supported"
  )"},

    {"errno.h", R"(
#pragma once
__require_source("__errno.c");
extern int errno;
#define EPERM   1
#define ENOENT  2
#define ESRCH   3
#define EINTR   4
#define EIO     5
#define ENXIO   6
#define E2BIG   7
#define ENOEXEC 8
#define EBADF   9
#define ECHILD  10
#define EAGAIN  11
#define ENOMEM  12
#define EACCES  13
#define EFAULT  14
#define EBUSY   16
#define EEXIST  17
#define EXDEV   18
#define ENODEV  19
#define ENOTDIR 20
#define EISDIR  21
#define EINVAL  22
#define ENFILE  23
#define EMFILE  24
#define ENOTTY  25
#define EFBIG   27
#define ENOSPC  28
#define ESPIPE  29
#define EROFS   30
#define EPIPE   32
#define EDOM    33
#define ERANGE  34
#define ENAMETOOLONG 36
#define ENOSYS  38
#define ENOTEMPTY 39
#define EWOULDBLOCK EAGAIN
  )"},

    {"fcntl.h", R"(
#pragma once
#include <unistd.h>
#define O_RDONLY  0
#define O_WRONLY  1
#define O_RDWR    2
#define O_CREAT   0x40
#define O_EXCL    0x80
#define O_TRUNC   0x200
#define O_APPEND  0x400
__import int __open_impl(const char *path, int flags, int mode);
int open(const char *path, int flags, ...);
  )"},

    {"unistd.h", R"(
#pragma once
typedef long ssize_t;
typedef long off_t;
#define STDIN_FILENO  0
#define STDOUT_FILENO 1
#define STDERR_FILENO 2
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
#define F_OK 0
#define R_OK 4
#define W_OK 2
#define X_OK 1
__import int close(int fd);
__import long read(int fd, void *buf, long count);
__import long write(int fd, const void *buf, long count);
__import long lseek(int fd, long offset, int whence);
__import char *getcwd(char *buf, long size);
__import int chdir(const char *path);
__import int access(const char *path, int mode);
__import int rmdir(const char *path);
__import int unlink(const char *path);
__import int pipe(int pipefd[2]);
__import int dup(int oldfd);
__import int dup2(int oldfd, int newfd);
__import int getpid(void);
__import int isatty(int fd);
  )"},

    {"locale.h", R"(
#pragma once
__require_source("__locale.c");
#include <stddef.h>
#define NULL ((void *)0)

#define LC_ALL      0
#define LC_COLLATE  1
#define LC_CTYPE    2
#define LC_MONETARY 3
#define LC_NUMERIC  4
#define LC_TIME     5

struct lconv {
  char *decimal_point;
  char *thousands_sep;
  char *grouping;
  char *int_curr_symbol;
  char *currency_symbol;
  char *mon_decimal_point;
  char *mon_thousands_sep;
  char *mon_grouping;
  char *positive_sign;
  char *negative_sign;
  char int_frac_digits;
  char frac_digits;
  char p_cs_precedes;
  char p_sep_by_space;
  char n_cs_precedes;
  char n_sep_by_space;
  char p_sign_posn;
  char n_sign_posn;
};

char *setlocale(int category, const char *locale);
struct lconv *localeconv(void);
  )"},

    {"ctype.h", R"(
#pragma once
__require_source("__ctype.c");
int isalnum(int c);
int isalpha(int c);
int isblank(int c);
int iscntrl(int c);
int isdigit(int c);
int isgraph(int c);
int islower(int c);
int isprint(int c);
int ispunct(int c);
int isspace(int c);
int isupper(int c);
int isxdigit(int c);
int tolower(int c);
int toupper(int c);
  )"},

    {"wctype.h", R"(
#pragma once
__require_source("__wchar.c");
typedef unsigned int wint_t;
typedef int wctrans_t;
typedef int wctype_t;
#define WEOF ((wint_t)-1)
int iswalnum(wint_t c);
int iswalpha(wint_t c);
int iswblank(wint_t c);
int iswcntrl(wint_t c);
int iswdigit(wint_t c);
int iswgraph(wint_t c);
int iswlower(wint_t c);
int iswprint(wint_t c);
int iswpunct(wint_t c);
int iswspace(wint_t c);
int iswupper(wint_t c);
int iswxdigit(wint_t c);
wint_t towlower(wint_t c);
wint_t towupper(wint_t c);
  )"},

    {"wchar.h", R"(
#pragma once
#include <stddef.h>
#include <wctype.h>
__require_source("__wchar.c");
typedef struct { int __state; } mbstate_t;
size_t wcslen(const wchar_t *s);
wchar_t *wcscpy(wchar_t *dest, const wchar_t *src);
wchar_t *wcsncpy(wchar_t *dest, const wchar_t *src, size_t n);
int wcscmp(const wchar_t *s1, const wchar_t *s2);
int wcsncmp(const wchar_t *s1, const wchar_t *s2, size_t n);
wchar_t *wcscat(wchar_t *dest, const wchar_t *src);
wchar_t *wcsncat(wchar_t *dest, const wchar_t *src, size_t n);
wchar_t *wcschr(const wchar_t *s, wchar_t c);
wchar_t *wcsrchr(const wchar_t *s, wchar_t c);
wchar_t *wcsstr(const wchar_t *haystack, const wchar_t *needle);
size_t wcsspn(const wchar_t *s, const wchar_t *accept);
size_t wcscspn(const wchar_t *s, const wchar_t *reject);
wchar_t *wcspbrk(const wchar_t *s, const wchar_t *accept);
wchar_t *wcstok(wchar_t *str, const wchar_t *delim, wchar_t **saveptr);
int wcscoll(const wchar_t *s1, const wchar_t *s2);
size_t wcsxfrm(wchar_t *dest, const wchar_t *src, size_t n);
wchar_t *wmemcpy(wchar_t *dest, const wchar_t *src, size_t n);
wchar_t *wmemmove(wchar_t *dest, const wchar_t *src, size_t n);
wchar_t *wmemset(wchar_t *dest, wchar_t c, size_t n);
int wmemcmp(const wchar_t *s1, const wchar_t *s2, size_t n);
wchar_t *wmemchr(const wchar_t *s, wchar_t c, size_t n);
wint_t btowc(int c);
int wctob(wint_t c);
int mbsinit(const mbstate_t *ps);
size_t wcrtomb(char *s, wchar_t wc, mbstate_t *ps);
size_t mbrtowc(wchar_t *pwc, const char *s, size_t n, mbstate_t *ps);
  )"},

    {"alloca.h", R"(
#pragma once
void *alloca(long size);
  )"},

    {"time.h", R"(
#pragma once
__require_source("__time.c");
#include <stddef.h>

typedef long time_t;
typedef long clock_t;

struct tm {
  int tm_sec;
  int tm_min;
  int tm_hour;
  int tm_mday;
  int tm_mon;
  int tm_year;
  int tm_wday;
  int tm_yday;
  int tm_isdst;
  long tm_gmtoff;
};

struct timespec {
  long tv_sec;
  long tv_nsec;
};

typedef int clockid_t;
#define CLOCKS_PER_SEC 1000
#define CLOCK_REALTIME 0
#define CLOCK_MONOTONIC 1

time_t time(time_t *t);
clock_t clock(void);
double difftime(time_t t1, time_t t0);
struct tm *gmtime(const time_t *timep);
struct tm *localtime(const time_t *timep);
struct tm *localtime_r(const time_t *timep, struct tm *result);
time_t mktime(struct tm *tm);
char *asctime(const struct tm *tm);
char *ctime(const time_t *timep);
size_t strftime(char *s, size_t max, const char *fmt, const struct tm *tm);
int clock_gettime(clockid_t clk_id, struct timespec *tp);
  )"},
    {"SDL.h", R"(
#pragma once
__require_source("__SDL.c");

typedef unsigned int Uint32;
typedef unsigned short Uint16;
typedef unsigned char Uint8;
typedef int Sint32;

typedef struct SDL_Surface {
    int w, h;
    int pitch;
    void *pixels;
} SDL_Surface;

typedef struct SDL_Window SDL_Window;

typedef struct SDL_Rect {
    int x, y, w, h;
} SDL_Rect;

typedef struct SDL_Keysym {
    int scancode;
    int sym;
    Uint16 mod;
    Uint32 unused;
} SDL_Keysym;

typedef struct SDL_KeyboardEvent {
    Uint32 type;
    Uint32 timestamp;
    Uint32 windowID;
    Uint8 state;
    Uint8 repeat;
    Uint8 padding2;
    Uint8 padding3;
    SDL_Keysym keysym;
} SDL_KeyboardEvent;

typedef union SDL_Event {
    Uint32 type;
    SDL_KeyboardEvent key;
    Uint8 padding[56];
} SDL_Event;

#define SDL_INIT_VIDEO 0x00000020
#define SDL_INIT_AUDIO 0x00000010
#define SDL_WINDOWPOS_CENTERED 0x2FFF0000
#define SDL_PIXELFORMAT_RGBA32 376840196
#define SDL_WINDOW_SHOWN 0x00000004
#define SDL_WINDOWPOS_UNDEFINED 0x1FFF0000
#define SDL_PIXELFORMAT_RGB888 370546692
#define SDL_QUIT 0x100
#define SDL_KEYDOWN 0x300
#define SDL_KEYUP 0x301
#define SDL_PRESSED 1
#define SDL_RELEASED 0

#define SDLK_BACKSPACE 8
#define SDLK_TAB 9
#define SDLK_RETURN 13
#define SDLK_ESCAPE 27
#define SDLK_SPACE 32
#define SDLK_PLUS 43
#define SDLK_MINUS 45
#define SDLK_EQUALS 61
#define SDLK_DELETE 127
#define SDLK_CAPSLOCK 1073741881
#define SDLK_F1 1073741882
#define SDLK_F2 1073741883
#define SDLK_F3 1073741884
#define SDLK_F4 1073741885
#define SDLK_F5 1073741886
#define SDLK_F6 1073741887
#define SDLK_F7 1073741888
#define SDLK_F8 1073741889
#define SDLK_F9 1073741890
#define SDLK_F10 1073741891
#define SDLK_F11 1073741892
#define SDLK_F12 1073741893
#define SDLK_PRINTSCREEN 1073741894
#define SDLK_SCROLLLOCK 1073741895
#define SDLK_PAUSE 1073741896
#define SDLK_INSERT 1073741897
#define SDLK_HOME 1073741898
#define SDLK_PAGEUP 1073741899
#define SDLK_END 1073741901
#define SDLK_PAGEDOWN 1073741902
#define SDLK_RIGHT 1073741903
#define SDLK_LEFT 1073741904
#define SDLK_DOWN 1073741905
#define SDLK_UP 1073741906
#define SDLK_NUMLOCKCLEAR 1073741907
#define SDLK_LCTRL 1073742048
#define SDLK_LSHIFT 1073742049
#define SDLK_LALT 1073742050
#define SDLK_RCTRL 1073742052
#define SDLK_RSHIFT 1073742053
#define SDLK_RALT 1073742054

/* Audio format constants */
#define AUDIO_S8 0x8008
#define AUDIO_S16 0x8010
#define AUDIO_S32 0x8020
#define AUDIO_F32 0x8120

typedef Uint32 SDL_AudioDeviceID;

typedef struct SDL_AudioSpec {
    int freq;
    int format;
    Uint8 channels;
} SDL_AudioSpec;

int SDL_Init(Uint32 flags);
SDL_Window *SDL_CreateWindow(const char *title, int x, int y, int w, int h, Uint32 flags);
Uint32 SDL_GetWindowID(SDL_Window *window);
SDL_Surface *SDL_GetWindowSurface(SDL_Window *window);
int SDL_UpdateWindowSurface(SDL_Window *window);
int SDL_PollEvent(SDL_Event *event);
void SDL_DestroyWindow(SDL_Window *window);
void SDL_Quit(void);
void SDL_Delay(Uint32 ms);
Uint32 SDL_GetTicks(void);
void SDL_SetWindowTitle(SDL_Window *window, const char *title);
void __setAnimationFrameFunc(void (*callback)(void));

SDL_AudioDeviceID SDL_OpenAudioDevice(const char *device, int iscapture,
                                      const SDL_AudioSpec *desired,
                                      SDL_AudioSpec *obtained, int allowed_changes);
int SDL_QueueAudio(SDL_AudioDeviceID dev, const void *data, Uint32 len);
Uint32 SDL_GetQueuedAudioSize(SDL_AudioDeviceID dev);
void SDL_ClearQueuedAudio(SDL_AudioDeviceID dev);
void SDL_PauseAudioDevice(SDL_AudioDeviceID dev, int pause_on);
void SDL_CloseAudioDevice(SDL_AudioDeviceID dev);
  )"},

    {"emscripten.h", R"(
#pragma once
__require_source("__emscripten.c");
#define EMSCRIPTEN_KEEPALIVE
void emscripten_set_main_loop(void (*func)(void), int fps, int simulate_infinite_loop);
void emscripten_async_call(void (*func)(void *), void *arg, int millis);
float emscripten_random(void);
  )"},

    // POSIX/BSD compatibility headers

    {"strings.h", R"(
#pragma once
__require_source("__strings.c");
#include <stddef.h>
int strcasecmp(const char *s1, const char *s2);
int strncasecmp(const char *s1, const char *s2, size_t n);
int ffs(int x);
int ffsl(long x);
int ffsll(long long x);
int fls(int x);
int flsl(long x);
int flsll(long long x);
  )"},

    {"stdbool.h", R"(
#pragma once
#define bool _Bool
#define true 1
#define false 0
#define __bool_true_false_are_defined 1
  )"},

    {"stdnoreturn.h", R"(
#pragma once
#define noreturn _Noreturn
  )"},

    {"threads.h", R"(
#pragma once
#define thread_local _Thread_local
  )"},

    {"stdalign.h", R"(
#pragma once
#define alignof _Alignof
#define alignas _Alignas
#define __alignof_is_defined 1
#define __alignas_is_defined 1
  )"},

    {"iso646.h", R"(
#pragma once
#define and    &&
#define and_eq &=
#define bitand &
#define bitor  |
#define compl  ~
#define not    !
#define not_eq !=
#define or     ||
#define or_eq  |=
#define xor    ^
#define xor_eq ^=
  )"},

    {"fenv.h", R"(
#pragma once
#define FE_DIVBYZERO  1
#define FE_INEXACT    2
#define FE_INVALID    4
#define FE_OVERFLOW   8
#define FE_UNDERFLOW  16
#define FE_ALL_EXCEPT (FE_DIVBYZERO|FE_INEXACT|FE_INVALID|FE_OVERFLOW|FE_UNDERFLOW)
#define FE_TONEAREST  0
#define FE_DOWNWARD   1
#define FE_UPWARD     2
#define FE_TOWARDZERO 3
#define FE_DFL_ENV    ((const fenv_t *)0)
typedef unsigned int fexcept_t;
typedef unsigned int fenv_t;
static inline int feclearexcept(int e) { (void)e; return 0; }
static inline int fegetexceptflag(fexcept_t *f, int e) { (void)f; (void)e; return 0; }
static inline int feraiseexcept(int e) { (void)e; return 0; }
static inline int fesetexceptflag(const fexcept_t *f, int e) { (void)f; (void)e; return 0; }
static inline int fetestexcept(int e) { (void)e; return 0; }
static inline int fegetround(void) { return FE_TONEAREST; }
static inline int fesetround(int r) { (void)r; return 0; }
static inline int fegetenv(fenv_t *e) { (void)e; return 0; }
static inline int feholdexcept(fenv_t *e) { (void)e; return 0; }
static inline int fesetenv(const fenv_t *e) { (void)e; return 0; }
static inline int feupdateenv(const fenv_t *e) { (void)e; return 0; }
  )"},

    {"tgmath.h", R"(
#pragma once
#include <math.h>

/* Type-generic macros for <math.h> functions (C11 7.25) */
/* Each macro dispatches to the float variant for float arguments, */
/* and the double variant otherwise.                               */

/* Unary float/double */
#define fabs(x)      _Generic((x), float: fabsf,      default: fabs)(x)
#define ceil(x)      _Generic((x), float: ceilf,      default: ceil)(x)
#define floor(x)     _Generic((x), float: floorf,     default: floor)(x)
#define trunc(x)     _Generic((x), float: truncf,     default: trunc)(x)
#define nearbyint(x) _Generic((x), float: nearbyintf, default: nearbyint)(x)
#define rint(x)      _Generic((x), float: rintf,      default: rint)(x)
#define sqrt(x)      _Generic((x), float: sqrtf,      default: sqrt)(x)
#define sin(x)       _Generic((x), float: sinf,       default: sin)(x)
#define cos(x)       _Generic((x), float: cosf,       default: cos)(x)
#define tan(x)       _Generic((x), float: tanf,       default: tan)(x)
#define asin(x)      _Generic((x), float: asinf,      default: asin)(x)
#define acos(x)      _Generic((x), float: acosf,      default: acos)(x)
#define atan(x)      _Generic((x), float: atanf,      default: atan)(x)
#define sinh(x)      _Generic((x), float: sinhf,      default: sinh)(x)
#define cosh(x)      _Generic((x), float: coshf,      default: cosh)(x)
#define tanh(x)      _Generic((x), float: tanhf,      default: tanh)(x)
#define asinh(x)     _Generic((x), float: asinhf,     default: asinh)(x)
#define acosh(x)     _Generic((x), float: acoshf,     default: acosh)(x)
#define atanh(x)     _Generic((x), float: atanhf,     default: atanh)(x)
#define exp(x)       _Generic((x), float: expf,       default: exp)(x)
#define expm1(x)     _Generic((x), float: expm1f,     default: expm1)(x)
#define log(x)       _Generic((x), float: logf,       default: log)(x)
#define log2(x)      _Generic((x), float: log2f,      default: log2)(x)
#define log10(x)     _Generic((x), float: log10f,     default: log10)(x)
#define log1p(x)     _Generic((x), float: log1pf,     default: log1p)(x)
#define cbrt(x)      _Generic((x), float: cbrtf,      default: cbrt)(x)
#define round(x)     _Generic((x), float: roundf,     default: round)(x)

/* Binary float/double — dispatch on (x)+(y) so mixed float/double promotes */
#define fdim(x, y)      _Generic((x)+(y), float: fdimf,      default: fdim)(x, y)
#define fmin(x, y)      _Generic((x)+(y), float: fminf,      default: fmin)(x, y)
#define fmax(x, y)      _Generic((x)+(y), float: fmaxf,      default: fmax)(x, y)
#define copysign(x, y)  _Generic((x)+(y), float: copysignf,  default: copysign)(x, y)
#define fmod(x, y)      _Generic((x)+(y), float: fmodf,      default: fmod)(x, y)
#define pow(x, y)       _Generic((x)+(y), float: powf,       default: pow)(x, y)
#define atan2(y, x)     _Generic((y)+(x), float: atan2f,     default: atan2)(y, x)
#define hypot(x, y)     _Generic((x)+(y), float: hypotf,     default: hypot)(x, y)
#define nextafter(x, y) _Generic((x)+(y), float: nextafterf, default: nextafter)(x, y)

/* ldexp: second arg is always int, dispatch on first arg only */
#define ldexp(x, n)     _Generic((x), float: ldexpf,    default: ldexp)(x, n)
  )"},

    {"sys/types.h", R"(
#pragma once
typedef long ssize_t;
typedef long off_t;
typedef unsigned long size_t;
typedef int mode_t;
  )"},

    {"sys/stat.h", R"(
#pragma once
#include <sys/types.h>

#define S_IRWXU 0700
#define S_IRUSR 0400
#define S_IWUSR 0200
#define S_IXUSR 0100
#define S_IRWXG 0070
#define S_IRGRP 0040
#define S_IWGRP 0020
#define S_IXGRP 0010
#define S_IRWXO 0007
#define S_IROTH 0004
#define S_IWOTH 0002
#define S_IXOTH 0001

#define S_IFMT   0170000
#define S_IFDIR  0040000
#define S_IFREG  0100000
#define S_IFLNK  0120000
#define S_ISDIR(m)  (((m) & S_IFMT) == S_IFDIR)
#define S_ISREG(m)  (((m) & S_IFMT) == S_IFREG)
#define S_ISLNK(m)  (((m) & S_IFMT) == S_IFLNK)

struct stat {
  unsigned long st_dev;
  unsigned long st_ino;
  unsigned long st_mode;
  unsigned long st_nlink;
  unsigned long st_size;
  long          st_atime;
  long          st_mtime;
  long          st_ctime;
};

__import int mkdir(const char *path, int mode);
__import int stat(const char *path, struct stat *buf);
__import int lstat(const char *path, struct stat *buf);
__import int fstat(int fd, struct stat *buf);
  )"},

    {"sys/time.h", R"(
#pragma once
#include <time.h>
struct timeval {
  long tv_sec;
  long tv_usec;
};
__import int __gettimeofday(long *sec, long *usec);
static inline int gettimeofday(struct timeval *tv, void *tz) {
  (void)tz;
  if (tv) {
    __gettimeofday(&tv->tv_sec, &tv->tv_usec);
  }
  return 0;
}
  )"},

    {"sys/file.h", R"(
#pragma once
  )"},

    {"sys/select.h", R"(
#pragma once
  )"},

    {"byteswap.h", R"(
#pragma once
static inline unsigned short bswap_16(unsigned short x) {
  return (x >> 8) | (x << 8);
}
static inline unsigned int bswap_32(unsigned int x) {
  return (x >> 24) | ((x >> 8) & 0xFF00) | ((x << 8) & 0xFF0000) | (x << 24);
}
static inline unsigned long long bswap_64(unsigned long long x) {
  return ((x >> 56) & 0xFF) | ((x >> 40) & 0xFF00) |
         ((x >> 24) & 0xFF0000) | ((x >> 8) & 0xFF000000ULL) |
         ((x << 8) & 0xFF00000000ULL) | ((x << 24) & 0xFF0000000000ULL) |
         ((x << 40) & 0xFF000000000000ULL) | ((x << 56) & 0xFF00000000000000ULL);
}
  )"},

    {"dirent.h", R"(
#pragma once
#include <sys/types.h>
#include <stdlib.h>
__require_source("__dirent.c");

#define DT_UNKNOWN 0
#define DT_DIR     4
#define DT_REG     8
#define DT_LNK    10

/* NOTE: d_ino is always 0 (Node.js directory APIs don't expose inodes).
   Use stat() to get st_ino if needed. */
struct dirent {
  long           d_ino;
  int            d_type;
  char           d_name[256];
};

struct __DIR;
typedef struct __DIR DIR;

DIR *opendir(const char *name);
int closedir(DIR *dirp);
struct dirent *readdir(DIR *dirp);
  )"},
};

std::map<std::string_view, std::string_view> standardLibrarySourceFiles = {
    {"__atexit.c", R"(
static void (*__atexit_funcs[32])(void);
static int __atexit_count = 0;

int atexit(void (*func)(void)) {
  if (__atexit_count >= 32) return -1;
  __atexit_funcs[__atexit_count++] = func;
  return 0;
}

void __run_atexits(void) {
  while (__atexit_count > 0)
    __atexit_funcs[--__atexit_count]();
}
__export __run_atexits = __run_atexits;
  )"},

    {"__malloc.c", R"MALLOC(
#include <__malloc.h>
#include <stdio.h>

// TLSF (Two-Level Segregated Fit) allocator
//
// Block layout (8-byte header):
//   +0: size_and_flags (long) - bits[31:3]=block size/8, bit0=FREE, bit1=PREV_FREE
//   +4: prev_phys (long) - address of previous physical block
// Free blocks additionally store at payload:
//   +8: next_free (long)
//   +12: prev_free (long)

#define FREE_BIT      1
#define PREV_FREE_BIT 2
#define FLAG_BITS     3

#define BLOCK_OVERHEAD  8
#define MIN_BLOCK_SIZE  16
#define BLOCK_ALIGN     8

#define SL_LOG2   4
#define SEARCH_ROUND(size) ((size) + (1 << (31 - __builtin_clz((int)(size)) - SL_LOG2)) - 1)
#define SL_COUNT  (1 << SL_LOG2)
#define FL_SHIFT  4
#define FL_MAX    30
#define FL_COUNT  (FL_MAX - FL_SHIFT + 1)

static long fl_bitmap;
static long sl_bitmap[FL_COUNT];
static long free_heads[FL_COUNT * SL_COUNT];
static long pool_start;
static long pool_end;
static long last_block;
static int  initialized;

static long block_size(long block) {
  return *(long *)block & ~FLAG_BITS;
}

static int block_is_free(long block) {
  return *(long *)block & FREE_BIT;
}

static int block_prev_is_free(long block) {
  return *(long *)block & PREV_FREE_BIT;
}

static long block_prev_phys(long block) {
  return *(long *)(block + 4);
}

static long block_next_phys(long block) {
  return block + block_size(block);
}

static long block_payload(long block) {
  return block + BLOCK_OVERHEAD;
}

static long payload_to_block(long payload) {
  return payload - BLOCK_OVERHEAD;
}

static long block_get_next_free(long block) {
  return *(long *)(block + 8);
}

static void block_set_next_free(long block, long nf) {
  *(long *)(block + 8) = nf;
}

static long block_get_prev_free(long block) {
  return *(long *)(block + 12);
}

static void block_set_prev_free(long block, long pf) {
  *(long *)(block + 12) = pf;
}

// mapping_insert: floor mapping for insertion
static void mapping_insert(long size, int *fl, int *sl) {
  if (size < (1 << (FL_SHIFT + 1))) {
    *fl = 0;
    *sl = (int)((size - MIN_BLOCK_SIZE) >> 3);
  } else {
    int t = 31 - __builtin_clz((int)size);
    *sl = (int)((size >> (t - SL_LOG2)) & (SL_COUNT - 1));
    *fl = t - FL_SHIFT;
  }
}

// mapping_search: ceiling mapping for search (rounds up)
static void mapping_search(long size, int *fl, int *sl) {
  long rounded = SEARCH_ROUND(size);
  mapping_insert(rounded, fl, sl);
}

static void insert_free_block(long block) {
  int fl, sl;
  long sz = block_size(block);
  mapping_insert(sz, &fl, &sl);

  long head = free_heads[fl * SL_COUNT + sl];
  block_set_next_free(block, head);
  block_set_prev_free(block, 0);
  if (head) block_set_prev_free(head, block);
  free_heads[fl * SL_COUNT + sl] = block;

  fl_bitmap = fl_bitmap | (1 << fl);
  sl_bitmap[fl] = sl_bitmap[fl] | (1 << sl);
}

static void remove_free_block(long block) {
  int fl, sl;
  long sz = block_size(block);
  mapping_insert(sz, &fl, &sl);

  long nf = block_get_next_free(block);
  long pf = block_get_prev_free(block);
  if (nf && block_get_prev_free(nf) != block) {
    puts("Corrupted heap: free list broken (next->prev != cur)");
    __wasm(void, (), op 0x00);
  }
  if (pf && block_get_next_free(pf) != block) {
    puts("Corrupted heap: free list broken (prev->next != cur)");
    __wasm(void, (), op 0x00);
  }
  if (nf) block_set_prev_free(nf, pf);
  if (pf) block_set_next_free(pf, nf);
  else {
    free_heads[fl * SL_COUNT + sl] = nf;
    if (!nf) {
      sl_bitmap[fl] = sl_bitmap[fl] & ~(1 << sl);
      if (!sl_bitmap[fl])
        fl_bitmap = fl_bitmap & ~(1 << fl);
    }
  }
}

static long find_suitable_block(int *fl, int *sl) {
  // Search current SL bitmap from sl upward
  long sl_map = sl_bitmap[*fl] & (~0L << *sl);
  if (!sl_map) {
    // Search FL bitmap from fl+1 upward
    long fl_map = fl_bitmap & (~0L << (*fl + 1));
    if (!fl_map) return 0;
    *fl = __builtin_ctz((int)fl_map);
    sl_map = sl_bitmap[*fl];
  }
  *sl = __builtin_ctz((int)sl_map);
  return free_heads[*fl * SL_COUNT + *sl];
}

static long merge_prev(long block) {
  if (block_prev_is_free(block)) {
    long prev = block_prev_phys(block);
    remove_free_block(prev);
    long new_size = block_size(prev) + block_size(block);
    *(long *)prev = (*(long *)prev & FLAG_BITS) | new_size;
    // Update prev_phys of next physical block
    long next = block_next_phys(prev);
    if (next < pool_end)
      *(long *)(next + 4) = prev;
    if (block == last_block)
      last_block = prev;
    block = prev;
  }
  return block;
}

static long merge_next(long block) {
  long next = block_next_phys(block);
  if (next < pool_end && block_is_free(next)) {
    remove_free_block(next);
    long new_size = block_size(block) + block_size(next);
    *(long *)block = (*(long *)block & FLAG_BITS) | new_size;
    // Update prev_phys of block after next
    long after = block_next_phys(block);
    if (after < pool_end)
      *(long *)(after + 4) = block;
    if (next == last_block)
      last_block = block;
  }
  return block;
}

static void split_block(long block, long needed) {
  long remainder_size = block_size(block) - needed;
  if (remainder_size >= MIN_BLOCK_SIZE) {
    // Resize current block
    *(long *)block = (*(long *)block & FLAG_BITS) | needed;
    // Create remainder block
    long rem = block + needed;
    *(long *)rem = remainder_size | FREE_BIT;
    *(long *)(rem + 4) = block;
    // Update next block's prev_phys
    long next = rem + remainder_size;
    if (next < pool_end)
      *(long *)(next + 4) = rem;
    if (block == last_block)
      last_block = rem;
    insert_free_block(rem);
    // Set PREV_FREE on successor
    next = block_next_phys(block);
    if (next < pool_end)
      *(long *)next = *(long *)next | PREV_FREE_BIT;
  }
}

static void block_mark_used(long block) {
  *(long *)block = *(long *)block & ~FREE_BIT;
  // Clear PREV_FREE on next physical block
  long next = block_next_phys(block);
  if (next < pool_end)
    *(long *)next = *(long *)next & ~PREV_FREE_BIT;
}

static void block_mark_free(long block) {
  *(long *)block = *(long *)block | FREE_BIT;
  // Set PREV_FREE on next physical block
  long next = block_next_phys(block);
  if (next < pool_end)
    *(long *)next = *(long *)next | PREV_FREE_BIT;
}

static void init_pool(void) {
  pool_start = __builtin(heap_base);
  // Align pool_start to BLOCK_ALIGN
  pool_start = (pool_start + BLOCK_ALIGN - 1) & ~(BLOCK_ALIGN - 1);
  pool_end = pool_start;
  last_block = 0;
  fl_bitmap = 0;
  int i = 0;
  while (i < FL_COUNT) { sl_bitmap[i] = 0; i = i + 1; }
  i = 0;
  while (i < FL_COUNT * SL_COUNT) { free_heads[i] = 0; i = i + 1; }
  initialized = 1;
}

static int grow_pool(long needed) {
  // needed includes BLOCK_OVERHEAD
  long new_end = pool_end + needed;
  // Align to page boundary for wasm memory.grow
  long pages = (new_end + 65535) / 65536;
  if (pages > __builtin(memory_size)) {
    long grow = pages - __builtin(memory_size);
    if (__builtin(memory_grow, grow) == (size_t)-1)
      return 0;
  }
  // Create a new block at pool_end
  long block = pool_end;
  long block_sz = new_end - pool_end;
  // Round up so mapping_search can find this block
  block_sz = SEARCH_ROUND(block_sz);
  // Round up to alignment
  block_sz = (block_sz + BLOCK_ALIGN - 1) & ~(BLOCK_ALIGN - 1);
  new_end = pool_end + block_sz;
  // Re-check pages after rounding
  pages = (new_end + 65535) / 65536;
  if (pages > __builtin(memory_size)) {
    long grow = pages - __builtin(memory_size);
    if (__builtin(memory_grow, grow) == (size_t)-1)
      return 0;
  }

  *(long *)block = block_sz | FREE_BIT;
  *(long *)(block + 4) = last_block;
  pool_end = new_end;

  // If last block is free, merge
  if (last_block && block_is_free(last_block)) {
    // Set prev_free bit so merge_prev works
    *(long *)block = *(long *)block | PREV_FREE_BIT;
    last_block = block;
    block = merge_prev(block);
  } else {
    last_block = block;
  }

  insert_free_block(block);
  return 1;
}

static long adjust_request(long size) {
  // Add overhead and ensure minimum size
  long adjusted = size + BLOCK_OVERHEAD;
  if (adjusted < MIN_BLOCK_SIZE) adjusted = MIN_BLOCK_SIZE;
  // Align up
  adjusted = (adjusted + BLOCK_ALIGN - 1) & ~(BLOCK_ALIGN - 1);
  return adjusted;
}

void *malloc(size_t size) {
  if (size == 0) return (void *)0;
  if (size > 0x40000000L) return (void *)0;

  if (!initialized) init_pool();

  long adjusted = adjust_request((long)size);

  int fl, sl;
  mapping_search(adjusted, &fl, &sl);
  if (fl >= FL_COUNT) {
    // Too large even for search
    if (!grow_pool(adjusted)) return (void *)0;
    mapping_search(adjusted, &fl, &sl);
  }

  long block = find_suitable_block(&fl, &sl);
  if (!block) {
    if (!grow_pool(adjusted)) return (void *)0;
    mapping_search(adjusted, &fl, &sl);
    block = find_suitable_block(&fl, &sl);
    if (!block) return (void *)0;
  }

  remove_free_block(block);
  split_block(block, adjusted);
  block_mark_used(block);

  return (void *)block_payload(block);
}

void free(void *ptr) {
  if (!ptr) return;

  long block = payload_to_block((long)ptr);

  // Bounds check
  if (block < pool_start || block >= pool_end) {
    puts("free: double free detected");
    __wasm(void, (), op 0x00);
  }
  // Double-free detection: block must not already be free
  if (block_is_free(block)) {
    puts("free: double free detected");
    __wasm(void, (), op 0x00);
  }

  block_mark_free(block);
  block = merge_prev(block);
  block = merge_next(block);
  insert_free_block(block);
}

void *calloc(size_t count, size_t size) {
  if (size != 0 && count > 0x40000000L / size) return (void *)0;
  size_t total = count * size;
  void *p = malloc(total);
  if (p) __builtin(memory_fill, p, 0, total);
  return p;
}

void *realloc(void *ptr, size_t new_size) {
  if (!ptr) return malloc(new_size);
  if (new_size == 0) { free(ptr); return (void *)0; }

  long block = payload_to_block((long)ptr);
  long old_payload = block_size(block) - BLOCK_OVERHEAD;

  // If new size fits in current block, keep it
  if (new_size <= (size_t)old_payload) return ptr;

  // Allocate new, copy, free old
  void *new_ptr = malloc(new_size);
  if (!new_ptr) return (void *)0;
  __builtin(memory_copy, new_ptr, ptr, old_payload);
  free(ptr);
  return new_ptr;
}

void *aligned_alloc(size_t alignment, size_t size) {
  // C11 7.22.3.1: alignment must be a supported alignment, size a multiple of alignment
  if (alignment == 0 || (alignment & (alignment - 1)) != 0) return (void *)0;
  if (size % alignment != 0) return (void *)0;
  // TLSF malloc returns 8-byte aligned memory (BLOCK_ALIGN == 8).
  // Alignments up to 8 are satisfied directly. Larger extended alignments are
  // not supported (the compiler rejects _Alignas > max_align_t == 8).
  if (alignment > 8) return (void *)0;
  return malloc(size);
}

void __inspect_heap(struct __heap_info *info) {
  if (!initialized) init_pool();
  info->heap_start = pool_start;
  info->heap_end = pool_end;
  info->total_bytes = pool_end - pool_start;
  long fb = 0;
  long fby = 0;
  long lf = 0;
  int f = 0;
  while (f < FL_COUNT) {
    int s = 0;
    while (s < SL_COUNT) {
      long b = free_heads[f * SL_COUNT + s];
      while (b) {
        long sz = block_size(b) - BLOCK_OVERHEAD;
        fb = fb + 1;
        fby = fby + sz;
        if (sz > lf) lf = sz;
        b = block_get_next_free(b);
      }
      s = s + 1;
    }
    f = f + 1;
  }
  info->free_blocks = fb;
  info->free_bytes = fby;
  info->largest_free = lf;
}
  )MALLOC"},

    {"__stdlib.c", R"STDLIB(
#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
#include <inttypes.h>
#include <__atexit.h>
__import double __strtod_impl(const char *nptr, char **endptr, const char *bound);

int abs(int n) { return n < 0 ? -n : n; }
long labs(long n) { return n < 0 ? -n : n; }

int atoi(const char *nptr) { return (int)strtol(nptr, (char **)0, 10); }
long atol(const char *nptr) { return strtol(nptr, (char **)0, 10); }

static int __digit_value(char c, int base) {
  int v;
  if (c >= '0' && c <= '9') v = c - '0';
  else if (c >= 'a' && c <= 'z') v = c - 'a' + 10;
  else if (c >= 'A' && c <= 'Z') v = c - 'A' + 10;
  else return -1;
  if (v >= base) return -1;
  return v;
}

// Core integer parser: accumulates magnitude as unsigned long long.
// Returns the parsed magnitude. Sets *neg, *any, *overflow, and *endp.
static unsigned long long __strtou_core(
    const char *nptr, const char **endp, int base,
    int *neg, int *any, int *overflow) {
  const char *s = nptr;
  while (*s == ' ' || *s == '\t' || *s == '\n' ||
         *s == '\r' || *s == '\f' || *s == '\v')
    s++;
  *neg = 0;
  if (*s == '-') { *neg = 1; s++; }
  else if (*s == '+') { s++; }
  if ((base == 0 || base == 16) && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
    base = 16; s += 2;
  } else if (base == 0 && s[0] == '0') {
    base = 8; s++;
  } else if (base == 0) {
    base = 10;
  }
  unsigned long long result = 0;
  *any = 0;
  *overflow = 0;
  while (1) {
    int d = __digit_value(*s, base);
    if (d < 0) break;
    *any = 1;
    if (result > (18446744073709551615ULL - (unsigned)d) / (unsigned)base) *overflow = 1;
    if (!*overflow) result = result * base + d;
    s++;
  }
  *endp = s;
  return result;
}

unsigned long long strtoull(const char *nptr, char **endptr, int base) {
  const char *end;
  int neg, any, overflow;
  unsigned long long val = __strtou_core(nptr, &end, base, &neg, &any, &overflow);
  if (overflow) { errno = ERANGE; val = 18446744073709551615ULL; }
  else if (neg) { val = -val; }
  if (endptr) *endptr = (char *)(any ? end : nptr);
  return val;
}

long long strtoll(const char *nptr, char **endptr, int base) {
  const char *end;
  int neg, any, overflow;
  unsigned long long val = __strtou_core(nptr, &end, base, &neg, &any, &overflow);
  if (overflow || (!neg && val > 9223372036854775807ULL) ||
      (neg && val > 9223372036854775808ULL)) {
    errno = ERANGE;
    if (endptr) *endptr = (char *)(any ? end : nptr);
    return neg ? (-9223372036854775807LL - 1LL) : 9223372036854775807LL;
  }
  if (endptr) *endptr = (char *)(any ? end : nptr);
  return neg ? -(long long)val : (long long)val;
}

unsigned long strtoul(const char *nptr, char **endptr, int base) {
  const char *end;
  int neg, any, overflow;
  unsigned long long val = __strtou_core(nptr, &end, base, &neg, &any, &overflow);
  if (overflow || val > 4294967295ULL) { errno = ERANGE; val = 4294967295ULL; neg = 0; }
  if (endptr) *endptr = (char *)(any ? end : nptr);
  return neg ? -(unsigned long)val : (unsigned long)val;
}

long strtol(const char *nptr, char **endptr, int base) {
  const char *end;
  int neg, any, overflow;
  unsigned long long val = __strtou_core(nptr, &end, base, &neg, &any, &overflow);
  if (overflow || (!neg && val > 2147483647ULL) ||
      (neg && val > 2147483648ULL)) {
    errno = ERANGE;
    if (endptr) *endptr = (char *)(any ? end : nptr);
    return neg ? (-2147483647L - 1L) : 2147483647L;
  }
  if (endptr) *endptr = (char *)(any ? end : nptr);
  return neg ? -(long)val : (long)val;
}

double strtod(const char *nptr, char **endptr) {
  const char *s = nptr;
  while (*s == ' ' || *s == '\t' || *s == '\n' ||
         *s == '\r' || *s == '\f' || *s == '\v')
    s++;
  const char *bound = s;
  if (*bound == '+' || *bound == '-') bound++;
  while (*bound >= '0' && *bound <= '9') bound++;
  if (*bound == '.') { bound++; while (*bound >= '0' && *bound <= '9') bound++; }
  if (*bound == 'e' || *bound == 'E') {
    const char *e = bound + 1;
    if (*e == '+' || *e == '-') e++;
    if (*e >= '0' && *e <= '9') {
      bound = e;
      while (*bound >= '0' && *bound <= '9') bound++;
    }
  }
  return __strtod_impl(nptr, endptr, bound);
}

float strtof(const char *nptr, char **endptr) {
  return (float)strtod(nptr, endptr);
}

long double strtold(const char *nptr, char **endptr) {
  return (long double)strtod(nptr, endptr);
}

double atof(const char *nptr) {
  return strtod(nptr, (char **)0);
}

long long atoll(const char *nptr) {
  return strtoll(nptr, (char **)0, 10);
}

long long llabs(long long n) { return n < 0 ? -n : n; }

intmax_t imaxabs(intmax_t n) { return n < 0 ? -n : n; }

imaxdiv_t imaxdiv(intmax_t numer, intmax_t denom) {
  imaxdiv_t r;
  r.quot = numer / denom;
  r.rem = numer % denom;
  return r;
}

intmax_t strtoimax(const char *nptr, char **endptr, int base) {
  return (intmax_t)strtoll(nptr, endptr, base);
}

uintmax_t strtoumax(const char *nptr, char **endptr, int base) {
  return (uintmax_t)strtoull(nptr, endptr, base);
}

static unsigned long __rand_next = 1;
int rand(void) {
  __rand_next = __rand_next * 1103515245 + 12345;
  return (__rand_next / 65536) % 32768;
}
void srand(unsigned int seed) { __rand_next = seed; }

void *bsearch(const void *key, const void *base, size_t nmemb,
              size_t size, int (*compar)(const void *, const void *)) {
  size_t lo = 0;
  size_t hi = nmemb;
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    const void *p = (const char *)base + mid * size;
    int cmp = compar(key, p);
    if (cmp < 0) hi = mid;
    else if (cmp > 0) lo = mid + 1;
    else return (void *)p;
  }
  return (void *)0;
}

static void __swap(char *a, char *b, size_t size) {
  size_t i = 0;
  while (i < size) {
    char t = a[i];
    a[i] = b[i];
    b[i] = t;
    i++;
  }
}

static void __siftdown(char *base, size_t nmemb, size_t size, size_t i,
                        int (*compar)(const void *, const void *)) {
  while (1) {
    size_t left = 2 * i + 1;
    size_t right = 2 * i + 2;
    size_t largest = i;
    if (left < nmemb &&
        compar(base + left * size, base + largest * size) > 0)
      largest = left;
    if (right < nmemb &&
        compar(base + right * size, base + largest * size) > 0)
      largest = right;
    if (largest == i) break;
    __swap(base + i * size, base + largest * size, size);
    i = largest;
  }
}

void qsort(void *base, size_t nmemb, size_t size,
           int (*compar)(const void *, const void *)) {
  if (nmemb < 2) return;
  char *b = (char *)base;
  // Build max-heap
  size_t i = nmemb / 2;
  while (i > 0) {
    i--;
    __siftdown(b, nmemb, size, i, compar);
  }
  // Extract elements
  size_t end = nmemb;
  while (end > 1) {
    end--;
    __swap(b, b + end * size, size);
    __siftdown(b, end, size, 0, compar);
  }
}

__import void __exit(int status);

void exit(int status) {
  fflush(0);
  __run_atexits();
  __exit(status);
}
__export exit = exit;


void abort(void) {
  __builtin_abort();
}

div_t div(int numer, int denom) {
  div_t r;
  r.quot = numer / denom;
  r.rem = numer % denom;
  return r;
}

ldiv_t ldiv(long numer, long denom) {
  ldiv_t r;
  r.quot = numer / denom;
  r.rem = numer % denom;
  return r;
}

lldiv_t lldiv(long long numer, long long denom) {
  lldiv_t r;
  r.quot = numer / denom;
  r.rem = numer % denom;
  return r;
}

__import int __getenv(const char *name, char *buf, int buf_size);
__import int __setenv(const char *name, const char *value, int overwrite);
__import int __unsetenv(const char *name);

static char __getenv_buf[4096];

char *getenv(const char *name) {
  int len = __getenv(name, __getenv_buf, sizeof(__getenv_buf));
  if (len < 0) return 0;
  return __getenv_buf;
}

int setenv(const char *name, const char *value, int overwrite) {
  return __setenv(name, value, overwrite);
}

int unsetenv(const char *name) {
  return __unsetenv(name);
}

int system(const char *command) {
  if (!command) return 0;  /* no command processor available */
  return -1;
}

int mblen(const char *s, size_t n) {
  if (!s) return 0;
  if (n == 0 || *s == '\0') return 0;
  return 1;
}

int mbtowc(wchar_t *pwc, const char *s, size_t n) {
  if (!s) return 0;
  if (n == 0) return -1;
  if (*s == '\0') {
    if (pwc) *pwc = 0;
    return 0;
  }
  if (pwc) *pwc = (unsigned char)*s;
  return 1;
}

int wctomb(char *s, wchar_t wc) {
  if (!s) return 0;
  if (wc < 0 || wc > 255) return -1;
  *s = (char)wc;
  return 1;
}

size_t mbstowcs(wchar_t *dest, const char *src, size_t n) {
  size_t i;
  for (i = 0; i < n; i++) {
    if (dest) dest[i] = (unsigned char)src[i];
    if (src[i] == '\0') return i;
  }
  return i;
}

size_t wcstombs(char *dest, const wchar_t *src, size_t n) {
  size_t i;
  for (i = 0; i < n; i++) {
    if (src[i] < 0 || src[i] > 255) return (size_t)-1;
    if (dest) dest[i] = (char)src[i];
    if (src[i] == '\0') return i;
  }
  return i;
}
  )STDLIB"},

    {"__string.c", R"(
#include <stddef.h>
#include <stdlib.h>
#include <errno.h>

void *memcpy(void *dest, const void *src, size_t n) {
  __builtin(memory_copy, dest, src, n);
  return dest;
}

void *memmove(void *dest, const void *src, size_t n) {
  // wasm memory.copy handles overlapping regions correctly
  __builtin(memory_copy, dest, src, n);
  return dest;
}

void *memset(void *s, int c, size_t n) {
  __builtin(memory_fill, s, c, n);
  return s;
}

int memcmp(const void *s1, const void *s2, size_t n) {
  const unsigned char *a = (const unsigned char *)s1;
  const unsigned char *b = (const unsigned char *)s2;
  for (size_t i = 0; i < n; i++) {
    if (a[i] != b[i]) return a[i] - b[i];
  }
  return 0;
}

size_t strlen(const char *s) {
  size_t len = 0;
  while (s[len]) len++;
  return len;
}

char *strcpy(char *dest, const char *src) {
  size_t i = 0;
  while (src[i]) { dest[i] = src[i]; i++; }
  dest[i] = 0;
  return dest;
}

char *strncpy(char *dest, const char *src, size_t n) {
  size_t i = 0;
  while (i < n && src[i]) { dest[i] = src[i]; i++; }
  while (i < n) { dest[i] = 0; i++; }
  return dest;
}

int strcmp(const char *s1, const char *s2) {
  while (*s1 && *s1 == *s2) { s1++; s2++; }
  return (unsigned char)*s1 - (unsigned char)*s2;
}

int strncmp(const char *s1, const char *s2, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (s1[i] != s2[i] || !s1[i]) return (unsigned char)s1[i] - (unsigned char)s2[i];
  }
  return 0;
}

char *strcat(char *dest, const char *src) {
  char *p = dest;
  while (*p) p++;
  while (*src) { *p = *src; p++; src++; }
  *p = 0;
  return dest;
}

char *strchr(const char *s, int c) {
  while (*s) {
    if (*s == (char)c) return (char *)s;
    s++;
  }
  if (c == 0) return (char *)s;
  return (char *)0;
}

char *strrchr(const char *s, int c) {
  const char *last = (const char *)0;
  while (*s) {
    if (*s == (char)c) last = s;
    s++;
  }
  if (c == 0) return (char *)s;
  return (char *)last;
}

char *strstr(const char *haystack, const char *needle) {
  if (!*needle) return (char *)haystack;
  while (*haystack) {
    const char *h = haystack;
    const char *n = needle;
    while (*h && *n && *h == *n) { h++; n++; }
    if (!*n) return (char *)haystack;
    haystack++;
  }
  return (char *)0;
}

void *memchr(const void *s, int c, size_t n) {
  const unsigned char *p = (const unsigned char *)s;
  for (size_t i = 0; i < n; i++) {
    if (p[i] == (unsigned char)c) return (void *)(p + i);
  }
  return (void *)0;
}

char *strncat(char *dest, const char *src, size_t n) {
  char *p = dest;
  while (*p) p++;
  while (n-- && *src) { *p++ = *src++; }
  *p = 0;
  return dest;
}

size_t strspn(const char *s, const char *accept) {
  size_t count = 0;
  while (*s) {
    const char *a = accept;
    int found = 0;
    while (*a) { if (*s == *a) { found = 1; break; } a++; }
    if (!found) break;
    s++;
    count++;
  }
  return count;
}

size_t strcspn(const char *s, const char *reject) {
  size_t count = 0;
  while (*s) {
    const char *r = reject;
    while (*r) { if (*s == *r) return count; r++; }
    s++;
    count++;
  }
  return count;
}

char *strpbrk(const char *s, const char *accept) {
  while (*s) {
    const char *a = accept;
    while (*a) { if (*s == *a) return (char *)s; a++; }
    s++;
  }
  return (char *)0;
}

char *strtok(char *str, const char *delim) {
  static char *next;
  if (str) next = str;
  if (!next) return (char *)0;
  next += strspn(next, delim);
  if (!*next) { next = (char *)0; return (char *)0; }
  char *tok = next;
  next += strcspn(next, delim);
  if (*next) { *next = 0; next++; }
  else { next = (char *)0; }
  return tok;
}

int strcoll(const char *s1, const char *s2) {
  return strcmp(s1, s2);
}

size_t strxfrm(char *dest, const char *src, size_t n) {
  size_t len = strlen(src);
  if (n > 0) {
    size_t copy = len < n ? len : n - 1;
    size_t i;
    for (i = 0; i < copy; i++) dest[i] = src[i];
    dest[i] = 0;
  }
  return len;
}

char *strerror(int errnum) {
  switch (errnum) {
  case 0:          return "Success";
  case EPERM:      return "Operation not permitted";
  case ENOENT:     return "No such file or directory";
  case ESRCH:      return "No such process";
  case EINTR:      return "Interrupted system call";
  case EIO:        return "Input/output error";
  case ENXIO:      return "No such device or address";
  case E2BIG:      return "Argument list too long";
  case ENOEXEC:    return "Exec format error";
  case EBADF:      return "Bad file descriptor";
  case ECHILD:     return "No child processes";
  case EAGAIN:     return "Resource temporarily unavailable";
  case ENOMEM:     return "Cannot allocate memory";
  case EACCES:     return "Permission denied";
  case EFAULT:     return "Bad address";
  case EBUSY:      return "Device or resource busy";
  case EEXIST:     return "File exists";
  case EXDEV:      return "Invalid cross-device link";
  case ENODEV:     return "No such device";
  case ENOTDIR:    return "Not a directory";
  case EISDIR:     return "Is a directory";
  case EINVAL:     return "Invalid argument";
  case ENFILE:     return "Too many open files in system";
  case EMFILE:     return "Too many open files";
  case ENOTTY:     return "Inappropriate ioctl for device";
  case EFBIG:      return "File too large";
  case ENOSPC:     return "No space left on device";
  case ESPIPE:     return "Illegal seek";
  case EROFS:      return "Read-only file system";
  case EPIPE:      return "Broken pipe";
  case EDOM:       return "Numerical argument out of domain";
  case ERANGE:     return "Numerical result out of range";
  case ENAMETOOLONG: return "File name too long";
  case ENOSYS:     return "Function not implemented";
  case ENOTEMPTY:  return "Directory not empty";
  default:         return "Unknown error";
  }
}

char *strdup(const char *s) {
  size_t len = strlen(s) + 1;
  char *d = malloc(len);
  if (d) memcpy(d, s, len);
  return d;
}
  )"},

    {"__assert.c", R"(
#include <stdio.h>

void __assert_fail(const char *expr, const char *file, int line) {
  printf("Assertion failed: %s, file %s, line %d\n", expr, file, line);
  __wasm(void, (), op 0);
}
  )"},

    {"__stdio.c", R"(
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

static char __stdin_buf[BUFSIZ];
static char __stdout_buf[BUFSIZ];

FILE __stdin_file  = {0, __F_READ,  _IOLBF, __stdin_buf,  BUFSIZ, 0, 0, EOF};
FILE __stdout_file = {1, __F_WRITE, _IOLBF, __stdout_buf, BUFSIZ, 0, 0, EOF};
FILE __stderr_file = {2, __F_WRITE, _IONBF, 0, 0, 0, 0, EOF};

static FILE *__open_files[64];
static int __num_open_files;

static int __flush_buf(FILE *stream) {
  int pos = 0;
  while (pos < stream->buf_pos) {
    long w = write(stream->fd, stream->buf + pos, stream->buf_pos - pos);
    if (w <= 0) {
      /* Preserve unwritten data at front of buffer */
      int remaining = stream->buf_pos - pos;
      memmove(stream->buf, stream->buf + pos, remaining);
      stream->buf_pos = remaining;
      stream->flags |= __F_ERR;
      return -1;
    }
    pos += w;
  }
  stream->buf_pos = 0;
  return 0;
}

int fflush(FILE *stream) {
  if (!stream) {
    fflush(stdout);
    fflush(stderr);
    for (int i = 0; i < __num_open_files; i++) {
      if (__open_files[i]) fflush(__open_files[i]);
    }
    return 0;
  }
  if ((stream->flags & __F_WRITE) && stream->buf_pos > 0) {
    return __flush_buf(stream);
  }
  return 0;
}

size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream) {
  if (!(stream->flags & __F_WRITE)) {
    write(2, "fwrite: stream is not writable\n", 31);
    __wasm(void, (), op 0);
  }
  size_t total = size * nmemb;
  const char *src = (const char *)ptr;

  if (stream->buf_mode == _IONBF || !stream->buf) {
    long w = write(stream->fd, src, total);
    if (w < 0) { stream->flags |= __F_ERR; return 0; }
    return w / size;
  }

  if (stream->buf_mode == _IOLBF) {
    for (size_t i = 0; i < total; i++) {
      stream->buf[stream->buf_pos++] = src[i];
      if (src[i] == '\n' || stream->buf_pos >= stream->buf_size) {
        if (__flush_buf(stream) < 0) return i / size;
      }
    }
    return nmemb;
  }

  /* _IOFBF */
  for (size_t i = 0; i < total; i++) {
    stream->buf[stream->buf_pos++] = src[i];
    if (stream->buf_pos >= stream->buf_size) {
      if (__flush_buf(stream) < 0) return i / size;
    }
  }
  return nmemb;
}

size_t fread(void *ptr, size_t size, size_t nmemb, FILE *stream) {
  if (!(stream->flags & __F_READ)) {
    write(2, "fread: stream is not readable\n", 30);
    __wasm(void, (), op 0);
  }
  size_t total = size * nmemb;
  char *dst = (char *)ptr;
  size_t got = 0;
  if (stream->ungetc_char != EOF && got < total) {
    dst[got++] = (unsigned char)stream->ungetc_char;
    stream->ungetc_char = EOF;
  }
  while (got < total) {
    if (stream->buf_pos < stream->buf_len) {
      size_t avail = stream->buf_len - stream->buf_pos;
      size_t want = total - got;
      size_t n = avail < want ? avail : want;
      memcpy(dst + got, stream->buf + stream->buf_pos, n);
      stream->buf_pos += n;
      got += n;
    } else {
      /* C11 7.21.3p3: flush all line-buffered output streams when input
         is requested on an unbuffered or line-buffered stream */
      if (stream->buf_mode != _IOFBF) fflush(0);
      if (!stream->buf || stream->buf_size == 0) {
        long r = read(stream->fd, dst + got, total - got);
        if (r <= 0) {
          if (r == 0) stream->flags |= __F_EOF;
          else stream->flags |= __F_ERR;
          break;
        }
        got += r;
      } else {
        long r = read(stream->fd, stream->buf, stream->buf_size);
        if (r <= 0) {
          if (r == 0) stream->flags |= __F_EOF;
          else stream->flags |= __F_ERR;
          break;
        }
        stream->buf_len = r;
        stream->buf_pos = 0;
      }
    }
  }
  return got / size;
}

int fgetc(FILE *stream) {
  unsigned char c;
  size_t n = fread(&c, 1, 1, stream);
  if (n == 0) return EOF;
  return c;
}

int ungetc(int c, FILE *stream) {
  if (c == EOF) return EOF;
  stream->ungetc_char = (unsigned char)c;
  stream->flags &= ~__F_EOF;
  return (unsigned char)c;
}

char *fgets(char *s, int n, FILE *stream) {
  if (n <= 0) return 0;
  int i = 0;
  while (i < n - 1) {
    int c = fgetc(stream);
    if (c == EOF) break;
    s[i++] = c;
    if (c == '\n') break;
  }
  if (i == 0) return 0;
  s[i] = '\0';
  return s;
}

int fputc(int c, FILE *stream) {
  unsigned char ch = c;
  size_t n = fwrite(&ch, 1, 1, stream);
  if (n == 0) return EOF;
  return ch;
}

int fputs(const char *s, FILE *stream) {
  size_t len = strlen(s);
  size_t n = fwrite(s, 1, len, stream);
  if (n < len) return EOF;
  return 0;
}

int vfprintf(FILE *stream, const char *fmt, va_list ap) {
  va_list ap2;
  va_copy(ap2, ap);
  int len = vsnprintf(0, 0, fmt, ap);
  char stackbuf[256];
  char *buf = stackbuf;
  if (len + 1 > 256) {
    buf = (char *)malloc(len + 1);
  }
  vsnprintf(buf, len + 1, fmt, ap2);
  va_end(ap2);
  fwrite(buf, 1, len, stream);
  if (buf != stackbuf) free(buf);
  return len;
}

int fprintf(FILE *stream, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vfprintf(stream, fmt, ap);
  va_end(ap);
  return r;
}

int vprintf(const char *fmt, va_list ap) {
  return vfprintf(stdout, fmt, ap);
}

int printf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vfprintf(stdout, fmt, ap);
  va_end(ap);
  return r;
}

int putchar(int c) {
  return fputc(c, stdout);
}

int puts(const char *s) {
  fputs(s, stdout);
  fputc('\n', stdout);
  return 0;
}

FILE *fopen(const char *path, const char *mode) {
  int flags = 0;
  int fflags = 0;
  if (mode[0] == 'r') {
    if (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+')) {
      flags = O_RDWR;
      fflags = __F_READ | __F_WRITE;
    } else {
      flags = O_RDONLY;
      fflags = __F_READ;
    }
  } else if (mode[0] == 'w') {
    if (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+')) {
      flags = O_RDWR | O_CREAT | O_TRUNC;
      fflags = __F_READ | __F_WRITE;
    } else {
      flags = O_WRONLY | O_CREAT | O_TRUNC;
      fflags = __F_WRITE;
    }
  } else if (mode[0] == 'a') {
    if (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+')) {
      flags = O_RDWR | O_CREAT | O_APPEND;
      fflags = __F_READ | __F_WRITE | __F_APPEND;
    } else {
      flags = O_WRONLY | O_CREAT | O_APPEND;
      fflags = __F_WRITE | __F_APPEND;
    }
  } else {
    return 0;
  }
  int fd = open(path, flags, 0666);
  if (fd < 0) return 0;

  FILE *f = (FILE *)malloc(sizeof(FILE));
  char *buf = (char *)malloc(BUFSIZ);
  f->fd = fd;
  f->flags = fflags;
  f->buf_mode = _IOFBF;
  f->buf = buf;
  f->buf_size = BUFSIZ;
  f->buf_pos = 0;
  f->buf_len = 0;
  f->ungetc_char = EOF;

  if (__num_open_files < 64) {
    __open_files[__num_open_files++] = f;
  }
  return f;
}

int fclose(FILE *stream) {
  fflush(stream);
  int r = close(stream->fd);
  if (stream->buf) free(stream->buf);
  for (int i = 0; i < __num_open_files; i++) {
    if (__open_files[i] == stream) {
      __open_files[i] = __open_files[--__num_open_files];
      break;
    }
  }
  free(stream);
  return r;
}

int fseek(FILE *stream, long offset, int whence) {
  fflush(stream);
  stream->buf_pos = 0;
  stream->buf_len = 0;
  stream->ungetc_char = EOF;
  long r = lseek(stream->fd, offset, whence);
  if (r < 0) return -1;
  stream->flags &= ~__F_EOF;
  return 0;
}

long ftell(FILE *stream) {
  long pos = lseek(stream->fd, 0, SEEK_CUR);
  if (pos < 0) return -1;
  if (stream->flags & __F_READ) {
    pos -= (stream->buf_len - stream->buf_pos);
    if (stream->ungetc_char != EOF) pos--;
  }
  if (stream->flags & __F_WRITE) {
    pos += stream->buf_pos;
  }
  return pos;
}

void rewind(FILE *stream) {
  fseek(stream, 0, SEEK_SET);
  stream->flags &= ~__F_ERR;
}

int fgetpos(FILE *stream, fpos_t *pos) {
  long p = ftell(stream);
  if (p < 0) return -1;
  *pos = p;
  return 0;
}

int fsetpos(FILE *stream, const fpos_t *pos) {
  return fseek(stream, *pos, SEEK_SET);
}

int feof(FILE *stream) {
  return (stream->flags & __F_EOF) != 0;
}

int ferror(FILE *stream) {
  return (stream->flags & __F_ERR) != 0;
}

void clearerr(FILE *stream) {
  stream->flags &= ~(__F_EOF | __F_ERR);
}

int setvbuf(FILE *stream, char *buf, int mode, size_t size) {
  fflush(stream);
  stream->buf_mode = mode;
  if (buf) {
    stream->buf = buf;
    stream->buf_size = size;
  }
  stream->buf_pos = 0;
  stream->buf_len = 0;
  return 0;
}

int vsscanf(const char *s, const char *fmt, va_list ap) {
  int consumed;
  int len = strlen(s);
  return __vsscanf_impl(s, len, fmt, &consumed, ap);
}

int sscanf(const char *s, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vsscanf(s, fmt, ap);
  va_end(ap);
  return r;
}

int vfscanf(FILE *stream, const char *fmt, va_list ap) {
  if (!(stream->flags & __F_READ)) {
    write(2, "vfscanf: stream is not readable\n", 32);
    __wasm(void, (), op 0);
  }

  /* Handle ungetc char: push it back into the buffer */
  if (stream->ungetc_char != EOF) {
    if (stream->buf_pos > 0) {
      stream->buf_pos--;
      stream->buf[stream->buf_pos] = (char)stream->ungetc_char;
    } else if (stream->buf_len < stream->buf_size) {
      memmove(stream->buf + 1, stream->buf, stream->buf_len);
      stream->buf[0] = (char)stream->ungetc_char;
      stream->buf_len++;
    } else {
      write(2, "vfscanf: buffer full with ungetc pending\n", 41);
      __wasm(void, (), op 0);
    }
    stream->ungetc_char = EOF;
  }

  /* If buffer empty, try to fill it */
  if (stream->buf_pos >= stream->buf_len) {
    long r = read(stream->fd, stream->buf, stream->buf_size);
    if (r <= 0) {
      if (r == 0) stream->flags |= __F_EOF;
      else stream->flags |= __F_ERR;
      return -1;
    }
    stream->buf_pos = 0;
    stream->buf_len = r;
  }

  /* Shift data to buffer start for accumulation */
  if (stream->buf_pos > 0) {
    memmove(stream->buf, stream->buf + stream->buf_pos, stream->buf_len - stream->buf_pos);
    stream->buf_len -= stream->buf_pos;
    stream->buf_pos = 0;
  }

  /* Loop: try parsing, refill if consumed everything */
  for (;;) {
    va_list ap2;
    va_copy(ap2, ap);
    int consumed;
    int result = __vsscanf_impl(stream->buf, stream->buf_len, fmt, &consumed, ap2);
    va_end(ap2);

    if (consumed < stream->buf_len || (stream->flags & __F_EOF)) {
      /* Done: didn't consume everything, or no more data */
      stream->buf_pos = consumed;
      return result;
    }

    /* Consumed everything — need more data */
    if (stream->buf_len >= stream->buf_size) {
      /* Buffer full, field exceeds buffer size */
      write(2, "vfscanf: field exceeds buffer size\n", 35);
      __wasm(void, (), op 0);
    }

    long got = read(stream->fd, stream->buf + stream->buf_len,
                    stream->buf_size - stream->buf_len);
    if (got <= 0) {
      if (got == 0) stream->flags |= __F_EOF;
      else stream->flags |= __F_ERR;
      stream->buf_pos = consumed;
      return result;
    }
    stream->buf_len += got;
    /* Loop back and retry with more data */
  }
}

int fscanf(FILE *stream, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vfscanf(stream, fmt, ap);
  va_end(ap);
  return r;
}

int vscanf(const char *fmt, va_list ap) {
  return vfscanf(stdin, fmt, ap);
}

int scanf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vscanf(fmt, ap);
  va_end(ap);
  return r;
}

void setbuf(FILE *stream, char *buf) {
  setvbuf(stream, buf, buf ? _IOFBF : _IONBF, BUFSIZ);
}

void perror(const char *s) {
  if (s && *s)
    fprintf(stderr, "%s: %s\n", s, strerror(errno));
  else
    fprintf(stderr, "%s\n", strerror(errno));
}

// Intentionally aborts — vsprintf has no bounds checking and is unsafe.
// Do NOT replace with a working implementation. Use vsnprintf instead.
int vsprintf(char *buf, const char *fmt, va_list ap) {
  fprintf(stderr, "vsprintf() is unsafe and not supported; use vsnprintf() instead\n");
  abort();
  return 0;
}

int sprintf(char *buf, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vsnprintf(buf, 0x7fffffff, fmt, ap);
  va_end(ap);
  return r;
}

int snprintf(char *buf, size_t size, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vsnprintf(buf, size, fmt, ap);
  va_end(ap);
  return r;
}

// Variadic wrapper around __open_impl (non-variadic host import).
// POSIX open() is variadic: mode is only used with O_CREAT.
int open(const char *path, int flags, ...) {
  int mode = 0;
  if (flags & 0x40) { // O_CREAT
    va_list ap;
    va_start(ap, flags);
    mode = va_arg(ap, int);
    va_end(ap);
  }
  return __open_impl(path, flags, mode);
}

// Intentionally aborts — gets has no bounds checking and is unsafe.
// Do NOT replace with a working implementation. Use fgets instead.
char *gets(char *s) {
  fprintf(stderr, "gets() is unsafe and not supported; use fgets() instead\n");
  abort();
  return 0;
}

static void __stdio_cleanup(void) {
  fflush(0);
}
// Register stdio cleanup as an atexit handler.
// This uses a GCC-style constructor attribute to run at startup.
// For now, we use a dummy function pointer to trigger registration.
static int __stdio_cleanup_registered = atexit(__stdio_cleanup);

FILE *freopen(const char *path, const char *mode, FILE *stream) {
  if (!stream) return 0;
  fflush(stream);
  close(stream->fd);
  if (!path) return 0;
  int flags = 0;
  int fflags = 0;
  if (mode[0] == 'r') {
    if (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+')) {
      flags = O_RDWR; fflags = __F_READ | __F_WRITE;
    } else {
      flags = O_RDONLY; fflags = __F_READ;
    }
  } else if (mode[0] == 'w') {
    if (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+')) {
      flags = O_RDWR | O_CREAT | O_TRUNC; fflags = __F_READ | __F_WRITE;
    } else {
      flags = O_WRONLY | O_CREAT | O_TRUNC; fflags = __F_WRITE;
    }
  } else if (mode[0] == 'a') {
    if (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+')) {
      flags = O_RDWR | O_CREAT | O_APPEND; fflags = __F_READ | __F_WRITE | __F_APPEND;
    } else {
      flags = O_WRONLY | O_CREAT | O_APPEND; fflags = __F_WRITE | __F_APPEND;
    }
  } else {
    return 0;
  }
  int fd = open(path, flags, 0666);
  if (fd < 0) return 0;
  stream->fd = fd;
  stream->flags = fflags;
  stream->buf_pos = 0;
  stream->buf_len = 0;
  stream->ungetc_char = EOF;
  return stream;
}

FILE *tmpfile(void) { return 0; }
char *tmpnam(char *s) { (void)s; return 0; }
FILE *popen(const char *command, const char *type) {
  (void)command; (void)type; return 0;
}
int pclose(FILE *stream) { (void)stream; return -1; }
  )"},

    {"__math.c", R"(
#include <math.h>

// Unary f64 (double)
double fabs(double x) { return __wasm(double, (x), op 0x99); }
double ceil(double x) { return __wasm(double, (x), op 0x9B); }
double floor(double x) { return __wasm(double, (x), op 0x9C); }
double trunc(double x) { return __wasm(double, (x), op 0x9D); }
double nearbyint(double x) { return __wasm(double, (x), op 0x9E); }
double rint(double x) { return __wasm(double, (x), op 0x9E); }
double sqrt(double x) { return __wasm(double, (x), op 0x9F); }

// Unary f32 (float)
float fabsf(float x) { return __wasm(float, (x), op 0x8B); }
float ceilf(float x) { return __wasm(float, (x), op 0x8D); }
float floorf(float x) { return __wasm(float, (x), op 0x8E); }
float truncf(float x) { return __wasm(float, (x), op 0x8F); }
float nearbyintf(float x) { return __wasm(float, (x), op 0x90); }
float rintf(float x) { return __wasm(float, (x), op 0x90); }
float sqrtf(float x) { return __wasm(float, (x), op 0x91); }

// Binary f64 (double)
double fmin(double x, double y) { return __wasm(double, (x, y), op 0xA4); }
double fmax(double x, double y) { return __wasm(double, (x, y), op 0xA5); }
double copysign(double x, double y) { return __wasm(double, (x, y), op 0xA6); }

// Binary f32 (float)
float fminf(float x, float y) { return __wasm(float, (x, y), op 0x96); }
float fmaxf(float x, float y) { return __wasm(float, (x, y), op 0x97); }
float copysignf(float x, float y) { return __wasm(float, (x, y), op 0x98); }

// Float wrappers for host-imported functions
float sinf(float x) { return (float)sin((double)x); }
float cosf(float x) { return (float)cos((double)x); }
float tanf(float x) { return (float)tan((double)x); }
float asinf(float x) { return (float)asin((double)x); }
float acosf(float x) { return (float)acos((double)x); }
float atanf(float x) { return (float)atan((double)x); }
float atan2f(float y, float x) { return (float)atan2((double)y, (double)x); }
float sinhf(float x) { return (float)sinh((double)x); }
float coshf(float x) { return (float)cosh((double)x); }
float tanhf(float x) { return (float)tanh((double)x); }
float asinhf(float x) { return (float)asinh((double)x); }
float acoshf(float x) { return (float)acosh((double)x); }
float atanhf(float x) { return (float)atanh((double)x); }
float expf(float x) { return (float)exp((double)x); }
float expm1f(float x) { return (float)expm1((double)x); }
float logf(float x) { return (float)log((double)x); }
float log2f(float x) { return (float)log2((double)x); }
float log10f(float x) { return (float)log10((double)x); }
float log1pf(float x) { return (float)log1p((double)x); }
float powf(float x, float y) { return (float)pow((double)x, (double)y); }
float cbrtf(float x) { return (float)cbrt((double)x); }
float hypotf(float x, float y) { return (float)hypot((double)x, (double)y); }
float fmodf(float x, float y) { return (float)fmod((double)x, (double)y); }

// round: ties away from zero
double round(double x) {
  double t = trunc(x);
  if (fabs(x - t) >= 0.5) return t + copysign(1.0, x);
  return t;
}
float roundf(float x) {
  float t = truncf(x);
  if (fabsf(x - t) >= 0.5f) return t + copysignf(1.0f, x);
  return t;
}

double fdim(double x, double y) { return x > y ? x - y : 0.0; }
float fdimf(float x, float y) { return x > y ? x - y : 0.0f; }

long lround(double x) { return (long)round(x); }
long lrint(double x) { return (long)rint(x); }
long lroundf(float x) { return (long)roundf(x); }
long lrintf(float x) { return (long)rintf(x); }

// nextafter: return next representable value from x toward y
// IEEE 754 doubles have the property that consecutive values have
// consecutive bit patterns (within the same sign), so +-1 on the
// reinterpreted integer gives the adjacent double.
double nextafter(double x, double y) {
  if (x != x || y != y) return x + y;
  if (x == y) return y;
  long long bits = __wasm(long long, (x), op 0xBD);
  if (x == 0.0) {
    bits = 1LL;
    double tiny = __wasm(double, (bits), op 0xBF);
    return copysign(tiny, y);
  }
  if ((x < y) == (x > 0.0)) bits++;
  else bits--;
  return __wasm(double, (bits), op 0xBF);
}
float nextafterf(float x, float y) {
  if (x != x || y != y) return x + y;
  if (x == y) return y;
  int bits = __wasm(int, (x), op 0xBC);
  if (x == 0.0f) {
    bits = 1;
    float tiny = __wasm(float, (bits), op 0xBE);
    return copysignf(tiny, y);
  }
  if ((x < y) == (x > 0.0f)) bits++;
  else bits--;
  return __wasm(float, (bits), op 0xBE);
}

// frexp: split x into normalized fraction [0.5, 1) and exponent
double frexp(double x, int *exp) {
  long long bits = __wasm(long long, (x), op 0xBD);
  long long emask = (long long)0x7FF << 52;
  int e = (int)((bits >> 52) & 0x7FF);
  if (e == 0) {
    if (x == 0.0) { *exp = 0; return x; }
    // Subnormal: multiply by 2^52 to normalize
    x = x * 4503599627370496.0;
    bits = __wasm(long long, (x), op 0xBD);
    e = (int)((bits >> 52) & 0x7FF);
    e = e - 52;
  } else if (e == 0x7FF) {
    *exp = 0;
    return x;
  }
  *exp = e - 1022;
  bits = (bits & ~emask) | ((long long)0x3FE << 52);
  return __wasm(double, (bits), op 0xBF);
}

// ldexp: multiply x by 2^n
// Uses repeated scaling to handle the full range of n without
// overflowing intermediate exponent calculations.
// Special cases (zero, inf, NaN) are handled naturally by multiplication.
double ldexp(double x, int n) {
  if (n > 1023) {
    x *= 8.98846567431158e307;  // 2^1023
    n -= 1023;
    if (n > 1023) {
      x *= 8.98846567431158e307;
      n -= 1023;
      if (n > 1023) n = 1023;
    }
  } else if (n < -1022) {
    x *= 2.2250738585072014e-308;  // 2^-1022
    n += 1022;
    if (n < -1022) {
      x *= 2.2250738585072014e-308;
      n += 1022;
      if (n < -1022) n = -1022;
    }
  }
  long long scale_bits = (long long)(n + 1023) << 52;
  double scale = __wasm(double, (scale_bits), op 0xBF);
  return x * scale;
}

float ldexpf(float x, int n) { return (float)ldexp((double)x, n); }

// ilogb: extract unbiased exponent as int
int ilogb(double x) {
  long long bits = __wasm(long long, (x), op 0xBD);
  int e = (int)((bits >> 52) & 0x7FF);
  if (e == 0) {
    if (x == 0.0) return -2147483647 - 1;
    x = fabs(x) * 4503599627370496.0;
    bits = __wasm(long long, (x), op 0xBD);
    e = (int)((bits >> 52) & 0x7FF);
    return e - 1023 - 52;
  }
  if (e == 0x7FF) return 2147483647;
  return e - 1023;
}

// logb: extract exponent as double
double logb(double x) {
  long long bits = __wasm(long long, (x), op 0xBD);
  int e = (int)((bits >> 52) & 0x7FF);
  if (e == 0) {
    if (x == 0.0) return -1.0 / 0.0;
    x = fabs(x) * 4503599627370496.0;
    bits = __wasm(long long, (x), op 0xBD);
    e = (int)((bits >> 52) & 0x7FF);
    return (double)(e - 1023 - 52);
  }
  if (e == 0x7FF) return x * x;
  return (double)(e - 1023);
}

double modf(double x, double *iptr) {
  *iptr = trunc(x);
  return x - *iptr;
}
float modff(float x, float *iptr) {
  *iptr = truncf(x);
  return x - *iptr;
}
  )"},

    {"__locale.c", R"(
#include <locale.h>
#include <string.h>

static struct lconv __c_lconv = {
  ".",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  127,
  127,
  127,
  127,
  127,
  127,
  127,
  127,
};

char *setlocale(int category, const char *locale) {
  if (locale == 0) return "C";
  if (locale[0] == '\0' || strcmp(locale, "C") == 0 || strcmp(locale, "POSIX") == 0)
    return "C";
  return 0;
}

struct lconv *localeconv(void) {
  return &__c_lconv;
}
  )"},

    {"__errno.c", R"(
int errno;
void __errno_set(int e) { errno = e; }
__export __errno_set = __errno_set;
  )"},

    {"__ctype.c", R"(
int isdigit(int c) { return c >= '0' && c <= '9'; }
int islower(int c) { return c >= 'a' && c <= 'z'; }
int isupper(int c) { return c >= 'A' && c <= 'Z'; }
int isalpha(int c) { return islower(c) || isupper(c); }
int isalnum(int c) { return isalpha(c) || isdigit(c); }
int isblank(int c) { return c == ' ' || c == '\t'; }
int iscntrl(int c) { return (c >= 0 && c < 32) || c == 127; }
int isprint(int c) { return c >= 32 && c <= 126; }
int isgraph(int c) { return c > 32 && c <= 126; }
int isspace(int c) {
  return c == ' ' || c == '\t' || c == '\n' ||
       c == '\r' || c == '\f' || c == '\v';
}
int ispunct(int c) { return isgraph(c) && !isalnum(c); }
int isxdigit(int c) {
  return isdigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
int tolower(int c) { return isupper(c) ? c + ('a' - 'A') : c; }
int toupper(int c) { return islower(c) ? c + ('A' - 'a') : c; }
  )"},

    {"__wchar.c", R"(
#include <stddef.h>

/* --- wctype functions (ASCII baseline) --- */
int iswalpha(unsigned int c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }
int iswupper(unsigned int c) { return c >= 'A' && c <= 'Z'; }
int iswlower(unsigned int c) { return c >= 'a' && c <= 'z'; }
int iswdigit(unsigned int c) { return c >= '0' && c <= '9'; }
int iswalnum(unsigned int c) { return iswalpha(c) || iswdigit(c); }
int iswblank(unsigned int c) { return c == ' ' || c == '\t'; }
int iswspace(unsigned int c) {
  return c == ' ' || c == '\t' || c == '\n' ||
         c == '\r' || c == '\f' || c == '\v';
}
int iswcntrl(unsigned int c) { return (c < 32) || c == 127; }
int iswprint(unsigned int c) { return c >= 32 && c <= 126; }
int iswgraph(unsigned int c) { return c > 32 && c <= 126; }
int iswpunct(unsigned int c) { return iswgraph(c) && !iswalnum(c); }
int iswxdigit(unsigned int c) {
  return iswdigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
unsigned int towlower(unsigned int c) { return iswupper(c) ? c + ('a' - 'A') : c; }
unsigned int towupper(unsigned int c) { return iswlower(c) ? c + ('A' - 'a') : c; }

/* --- wchar string functions --- */
size_t wcslen(const wchar_t *s) {
  size_t len = 0;
  while (s[len]) len++;
  return len;
}
wchar_t *wcscpy(wchar_t *dest, const wchar_t *src) {
  size_t i = 0;
  while (src[i]) { dest[i] = src[i]; i++; }
  dest[i] = 0;
  return dest;
}
wchar_t *wcsncpy(wchar_t *dest, const wchar_t *src, size_t n) {
  size_t i = 0;
  while (i < n && src[i]) { dest[i] = src[i]; i++; }
  while (i < n) { dest[i] = 0; i++; }
  return dest;
}
int wcscmp(const wchar_t *s1, const wchar_t *s2) {
  while (*s1 && *s1 == *s2) { s1++; s2++; }
  return *s1 - *s2;
}
int wcsncmp(const wchar_t *s1, const wchar_t *s2, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (s1[i] != s2[i] || !s1[i]) return s1[i] - s2[i];
  }
  return 0;
}
wchar_t *wcscat(wchar_t *dest, const wchar_t *src) {
  wchar_t *p = dest;
  while (*p) p++;
  while (*src) { *p = *src; p++; src++; }
  *p = 0;
  return dest;
}
wchar_t *wcsncat(wchar_t *dest, const wchar_t *src, size_t n) {
  wchar_t *p = dest;
  while (*p) p++;
  while (n-- && *src) { *p++ = *src++; }
  *p = 0;
  return dest;
}
wchar_t *wcschr(const wchar_t *s, wchar_t c) {
  while (*s) {
    if (*s == c) return (wchar_t *)s;
    s++;
  }
  if (c == 0) return (wchar_t *)s;
  return (wchar_t *)0;
}
wchar_t *wcsrchr(const wchar_t *s, wchar_t c) {
  const wchar_t *last = (const wchar_t *)0;
  while (*s) {
    if (*s == c) last = s;
    s++;
  }
  if (c == 0) return (wchar_t *)s;
  return (wchar_t *)last;
}
wchar_t *wcsstr(const wchar_t *haystack, const wchar_t *needle) {
  if (!*needle) return (wchar_t *)haystack;
  while (*haystack) {
    const wchar_t *h = haystack;
    const wchar_t *n = needle;
    while (*h && *n && *h == *n) { h++; n++; }
    if (!*n) return (wchar_t *)haystack;
    haystack++;
  }
  return (wchar_t *)0;
}
size_t wcsspn(const wchar_t *s, const wchar_t *accept) {
  size_t count = 0;
  while (*s) {
    const wchar_t *a = accept;
    int found = 0;
    while (*a) { if (*s == *a) { found = 1; break; } a++; }
    if (!found) break;
    s++; count++;
  }
  return count;
}
size_t wcscspn(const wchar_t *s, const wchar_t *reject) {
  size_t count = 0;
  while (*s) {
    const wchar_t *r = reject;
    while (*r) { if (*s == *r) return count; r++; }
    s++; count++;
  }
  return count;
}
wchar_t *wcspbrk(const wchar_t *s, const wchar_t *accept) {
  while (*s) {
    const wchar_t *a = accept;
    while (*a) { if (*s == *a) return (wchar_t *)s; a++; }
    s++;
  }
  return (wchar_t *)0;
}
wchar_t *wcstok(wchar_t *str, const wchar_t *delim, wchar_t **saveptr) {
  if (str) *saveptr = str;
  if (!*saveptr) return (wchar_t *)0;
  *saveptr += wcsspn(*saveptr, delim);
  if (!**saveptr) { *saveptr = (wchar_t *)0; return (wchar_t *)0; }
  wchar_t *tok = *saveptr;
  *saveptr += wcscspn(*saveptr, delim);
  if (**saveptr) { **saveptr = 0; (*saveptr)++; }
  else { *saveptr = (wchar_t *)0; }
  return tok;
}
int wcscoll(const wchar_t *s1, const wchar_t *s2) { return wcscmp(s1, s2); }
size_t wcsxfrm(wchar_t *dest, const wchar_t *src, size_t n) {
  size_t len = wcslen(src);
  if (n > 0) {
    size_t copy = len < n ? len : n - 1;
    for (size_t i = 0; i < copy; i++) dest[i] = src[i];
    dest[copy] = 0;
  }
  return len;
}

/* --- wmem functions --- */
wchar_t *wmemcpy(wchar_t *dest, const wchar_t *src, size_t n) {
  for (size_t i = 0; i < n; i++) dest[i] = src[i];
  return dest;
}
wchar_t *wmemmove(wchar_t *dest, const wchar_t *src, size_t n) {
  if (dest < src) { for (size_t i = 0; i < n; i++) dest[i] = src[i]; }
  else { for (size_t i = n; i > 0; i--) dest[i-1] = src[i-1]; }
  return dest;
}
wchar_t *wmemset(wchar_t *dest, wchar_t c, size_t n) {
  for (size_t i = 0; i < n; i++) dest[i] = c;
  return dest;
}
int wmemcmp(const wchar_t *s1, const wchar_t *s2, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (s1[i] != s2[i]) return s1[i] - s2[i];
  }
  return 0;
}
wchar_t *wmemchr(const wchar_t *s, wchar_t c, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (s[i] == c) return (wchar_t *)(s + i);
  }
  return (wchar_t *)0;
}

/* --- multibyte/wide conversions (UTF-8) --- */
#include <wchar.h>
unsigned int btowc(int c) { return (c >= 0 && c <= 0x7F) ? (unsigned int)c : (unsigned int)-1; }
int wctob(unsigned int c) { return (c <= 0x7F) ? (int)c : -1; }
int mbsinit(const mbstate_t *ps) { (void)ps; return 1; }

size_t wcrtomb(char *s, wchar_t wc, mbstate_t *ps) {
  (void)ps;
  unsigned int c = (unsigned int)wc;
  if (!s) return 1;
  if (c < 0x80) { s[0] = (char)c; return 1; }
  if (c < 0x800) { s[0] = (char)(0xC0 | (c >> 6)); s[1] = (char)(0x80 | (c & 0x3F)); return 2; }
  if (c < 0x10000) { s[0] = (char)(0xE0 | (c >> 12)); s[1] = (char)(0x80 | ((c >> 6) & 0x3F)); s[2] = (char)(0x80 | (c & 0x3F)); return 3; }
  if (c < 0x110000) { s[0] = (char)(0xF0 | (c >> 18)); s[1] = (char)(0x80 | ((c >> 12) & 0x3F)); s[2] = (char)(0x80 | ((c >> 6) & 0x3F)); s[3] = (char)(0x80 | (c & 0x3F)); return 4; }
  return (size_t)-1;
}

size_t mbrtowc(wchar_t *pwc, const char *s, size_t n, mbstate_t *ps) {
  (void)ps;
  if (!s) return 0;
  if (n == 0) return (size_t)-2;
  unsigned char b0 = (unsigned char)s[0];
  if (b0 < 0x80) {
    if (pwc) *pwc = b0;
    return b0 ? 1 : 0;
  }
  unsigned int cp; size_t len;
  if ((b0 & 0xE0) == 0xC0)      { cp = b0 & 0x1F; len = 2; }
  else if ((b0 & 0xF0) == 0xE0) { cp = b0 & 0x0F; len = 3; }
  else if ((b0 & 0xF8) == 0xF0) { cp = b0 & 0x07; len = 4; }
  else return (size_t)-1;
  if (len > n) return (size_t)-2;
  for (size_t i = 1; i < len; i++) {
    unsigned char bi = (unsigned char)s[i];
    if ((bi & 0xC0) != 0x80) return (size_t)-1;
    cp = (cp << 6) | (bi & 0x3F);
  }
  if (pwc) *pwc = (wchar_t)cp;
  return cp ? len : 0;
}
  )"},

    {"__alloca.c", R"(
void *alloca(long size) {
  return __builtin(alloca, size);
}
  )"},

    {"__time.c", R"(
#include <time.h>
#include <stdio.h>

__import long __time_now(void);
__import long __clock(void);
__import long __timezone_offset(long t);

time_t time(time_t *t) {
  time_t now = __time_now();
  if (t) *t = now;
  return now;
}

clock_t clock(void) {
  return __clock();
}

double difftime(time_t t1, time_t t0) {
  return (double)(t1 - t0);
}

static int __is_leap(int y) {
  return (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
}

static int __days_in_month(int m, int leap) {
  static int mdays[] = {31,28,31,30,31,30,31,31,30,31,30,31};
  if (m == 1 && leap) return 29;
  return mdays[m];
}

static int __days_in_year(int y) {
  return __is_leap(y) ? 366 : 365;
}

static struct tm __gmtime_buf;

static void __secs_to_tm(long t, struct tm *res) {
  long days = t / 86400;
  long rem = t % 86400;
  if (rem < 0) { rem += 86400; days--; }

  res->tm_hour = (int)(rem / 3600);
  rem %= 3600;
  res->tm_min = (int)(rem / 60);
  res->tm_sec = (int)(rem % 60);

  /* Jan 1, 1970 was a Thursday (wday=4) */
  int wday = (int)((days + 4) % 7);
  if (wday < 0) wday += 7;
  res->tm_wday = wday;

  int y = 1970;
  if (days >= 0) {
    while (days >= __days_in_year(y)) {
      days -= __days_in_year(y);
      y++;
    }
  } else {
    while (days < 0) {
      y--;
      days += __days_in_year(y);
    }
  }
  res->tm_year = y - 1900;
  res->tm_yday = (int)days;

  int leap = __is_leap(y);
  int m = 0;
  while (m < 11 && days >= __days_in_month(m, leap)) {
    days -= __days_in_month(m, leap);
    m++;
  }
  res->tm_mon = m;
  res->tm_mday = (int)days + 1;
}

struct tm *gmtime(const time_t *timep) {
  __secs_to_tm(*timep, &__gmtime_buf);
  __gmtime_buf.tm_isdst = 0;
  return &__gmtime_buf;
}

static struct tm __localtime_buf;

struct tm *localtime(const time_t *timep) {
  long offset = __timezone_offset(*timep);
  long local = *timep + offset;
  __secs_to_tm(local, &__localtime_buf);
  __localtime_buf.tm_isdst = -1;
  __localtime_buf.tm_gmtoff = offset;
  return &__localtime_buf;
}

struct tm *localtime_r(const time_t *timep, struct tm *result) {
  long offset = __timezone_offset(*timep);
  long local = *timep + offset;
  __secs_to_tm(local, result);
  result->tm_isdst = -1;
  result->tm_gmtoff = offset;
  return result;
}

time_t mktime(struct tm *tp) {
  /* Normalize mon */
  int m = tp->tm_mon;
  int y = tp->tm_year + 1900;
  while (m < 0)  { m += 12; y--; }
  while (m >= 12) { m -= 12; y++; }
  tp->tm_mon = m;
  tp->tm_year = y - 1900;

  /* Days from epoch to start of year */
  long days = 0;
  if (y >= 1970) {
    for (int i = 1970; i < y; i++) days += __days_in_year(i);
  } else {
    for (int i = y; i < 1970; i++) days -= __days_in_year(i);
  }

  /* Days in months */
  int leap = __is_leap(y);
  for (int i = 0; i < m; i++) days += __days_in_month(i, leap);
  days += tp->tm_mday - 1;

  long secs = days * 86400L + tp->tm_hour * 3600L + tp->tm_min * 60L + tp->tm_sec;

  /* Adjust for local timezone */
  long offset = __timezone_offset(secs);
  secs -= offset;

  /* Fill in derived fields by converting back */
  struct tm *tmp = localtime(&secs);
  *tp = *tmp;

  return secs;
}

static char __asctime_buf[32];

static const char *__wday_abbr[] = {
  "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"
};
static const char *__mon_abbr[] = {
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
};

char *asctime(const struct tm *tp) {
  sprintf(__asctime_buf, "%s %s %2d %02d:%02d:%02d %d\n",
      __wday_abbr[tp->tm_wday], __mon_abbr[tp->tm_mon],
      tp->tm_mday, tp->tm_hour, tp->tm_min, tp->tm_sec,
      tp->tm_year + 1900);
  return __asctime_buf;
}

char *ctime(const time_t *timep) {
  return asctime(localtime(timep));
}

static void __ap_str(char *s, size_t max, size_t *pos, const char *src) {
  while (*src && *pos + 1 < max) {
    s[*pos] = *src;
    (*pos)++;
    src++;
  }
}

static void __ap_int(char *s, size_t max, size_t *pos, int val, int width) {
  char buf[16];
  int len = 0;
  int neg = 0;
  int v = val;
  if (v < 0) { neg = 1; v = -v; }
  if (v == 0) { buf[len++] = '0'; }
  else { while (v > 0) { buf[len++] = '0' + v % 10; v /= 10; } }
  /* pad with zeros */
  int total = len + neg;
  while (total < width) { __ap_str(s, max, pos, "0"); total++; }
  if (neg) __ap_str(s, max, pos, "-");
  int i;
  for (i = len - 1; i >= 0; i--) {
    char c[2];
    c[0] = buf[i];
    c[1] = 0;
    __ap_str(s, max, pos, c);
  }
}

static const char *__wday_full[] = {
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday"
};
static const char *__mon_full[] = {
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
};

size_t strftime(char *s, size_t max, const char *fmt, const struct tm *tp) {
  if (max == 0) return 0;
  size_t pos = 0;

  while (*fmt && pos + 1 < max) {
    if (*fmt != '%') {
      s[pos++] = *fmt++;
      continue;
    }
    fmt++; /* skip % */
    switch (*fmt) {
    case 'Y': __ap_int(s, max, &pos, tp->tm_year + 1900, 4); break;
    case 'm': __ap_int(s, max, &pos, tp->tm_mon + 1, 2); break;
    case 'd': __ap_int(s, max, &pos, tp->tm_mday, 2); break;
    case 'H': __ap_int(s, max, &pos, tp->tm_hour, 2); break;
    case 'M': __ap_int(s, max, &pos, tp->tm_min, 2); break;
    case 'S': __ap_int(s, max, &pos, tp->tm_sec, 2); break;
    case 'a': __ap_str(s, max, &pos, __wday_abbr[tp->tm_wday]); break;
    case 'A': __ap_str(s, max, &pos, __wday_full[tp->tm_wday]); break;
    case 'b': __ap_str(s, max, &pos, __mon_abbr[tp->tm_mon]); break;
    case 'B': __ap_str(s, max, &pos, __mon_full[tp->tm_mon]); break;
    case 'c':
      __ap_str(s, max, &pos, __wday_abbr[tp->tm_wday]);
      __ap_str(s, max, &pos, " ");
      __ap_str(s, max, &pos, __mon_abbr[tp->tm_mon]);
      __ap_str(s, max, &pos, " ");
      __ap_int(s, max, &pos, tp->tm_mday, 2);
      __ap_str(s, max, &pos, " ");
      __ap_int(s, max, &pos, tp->tm_hour, 2);
      __ap_str(s, max, &pos, ":");
      __ap_int(s, max, &pos, tp->tm_min, 2);
      __ap_str(s, max, &pos, ":");
      __ap_int(s, max, &pos, tp->tm_sec, 2);
      __ap_str(s, max, &pos, " ");
      __ap_int(s, max, &pos, tp->tm_year + 1900, 4);
      break;
    case 'I': {
      int h12 = tp->tm_hour % 12;
      __ap_int(s, max, &pos, h12 == 0 ? 12 : h12, 2);
      break;
    }
    case 'p': __ap_str(s, max, &pos, tp->tm_hour < 12 ? "AM" : "PM"); break;
    case 'j': __ap_int(s, max, &pos, tp->tm_yday + 1, 3); break;
    case 'w': __ap_int(s, max, &pos, tp->tm_wday, 1); break;
    case 'u': __ap_int(s, max, &pos, tp->tm_wday == 0 ? 7 : tp->tm_wday, 1); break;
    case 'y': __ap_int(s, max, &pos, (tp->tm_year + 1900) % 100, 2); break;
    case 'U': __ap_int(s, max, &pos, (tp->tm_yday + 7 - tp->tm_wday) / 7, 2); break;
    case 'W': __ap_int(s, max, &pos, (tp->tm_yday + 7 - (tp->tm_wday ? tp->tm_wday - 1 : 6)) / 7, 2); break;
    case 'x':
      __ap_int(s, max, &pos, tp->tm_mon + 1, 2);
      __ap_str(s, max, &pos, "/");
      __ap_int(s, max, &pos, tp->tm_mday, 2);
      __ap_str(s, max, &pos, "/");
      __ap_int(s, max, &pos, (tp->tm_year + 1900) % 100, 2);
      break;
    case 'X':
      __ap_int(s, max, &pos, tp->tm_hour, 2);
      __ap_str(s, max, &pos, ":");
      __ap_int(s, max, &pos, tp->tm_min, 2);
      __ap_str(s, max, &pos, ":");
      __ap_int(s, max, &pos, tp->tm_sec, 2);
      break;
    case 'Z': break; /* no timezone name available in wasm */
    case '%': s[pos++] = '%'; break;
    case 'n': s[pos++] = '\n'; break;
    case 't': s[pos++] = '\t'; break;
    case '\0': goto done;
    default:
      s[pos++] = '%';
      if (pos + 1 < max) s[pos++] = *fmt;
      break;
    }
    fmt++;
  }
done:
  s[pos] = '\0';
  return pos;
}

__import long __clock_ns_hi(void);
__import long __clock_ns_lo(void);

int clock_gettime(clockid_t clk_id, struct timespec *tp) {
  (void)clk_id;
  long hi = __clock_ns_hi();
  long lo = __clock_ns_lo();
  /* hi = seconds, lo = nanoseconds remainder */
  tp->tv_sec = hi;
  tp->tv_nsec = lo;
  return 0;
}
  )"},

    {"__strings.c", R"(
#include <stddef.h>

static int __tolower(int c) {
  if (c >= 'A' && c <= 'Z') return c + ('a' - 'A');
  return c;
}

int strcasecmp(const char *s1, const char *s2) {
  while (*s1 && *s2) {
    int c1 = __tolower((unsigned char)*s1);
    int c2 = __tolower((unsigned char)*s2);
    if (c1 != c2) return c1 - c2;
    s1++;
    s2++;
  }
  return __tolower((unsigned char)*s1) - __tolower((unsigned char)*s2);
}

int strncasecmp(const char *s1, const char *s2, size_t n) {
  for (size_t i = 0; i < n; i++) {
    int c1 = __tolower((unsigned char)*s1);
    int c2 = __tolower((unsigned char)*s2);
    if (c1 != c2) return c1 - c2;
    if (*s1 == '\0') return 0;
    s1++;
    s2++;
  }
  return 0;
}

int ffs(int x) { return x ? __wasm(int, (x), op 0x68) + 1 : 0; }
int ffsl(long x) { return x ? __wasm(int, (x), op 0x68) + 1 : 0; }
int ffsll(long long x) { return x ? (int)__wasm(long long, (x), op 0x7A) + 1 : 0; }
int fls(int x) { return x ? 32 - __wasm(int, (x), op 0x67) : 0; }
int flsl(long x) { return x ? 32 - __wasm(int, (x), op 0x67) : 0; }
int flsll(long long x) { return x ? 64 - (int)__wasm(long long, (x), op 0x79) : 0; }
  )"},

    {"__SDL.c", R"(
#include <SDL.h>
#include <stdlib.h>
#include <string.h>

/* Opaque to user code (only the forward declaration is in SDL.h).
   'handle' is a 1-based index into the host's sdlWindows array.
   We reuse it as the SDL window ID (SDL_GetWindowID returns it,
   and event windowID fields carry it). This is fine because we
   control the entire stack — the real @kmamal/sdl window ID
   never leaks to C code. */
struct SDL_Window {
    int handle;
    SDL_Surface surface;
};

/* Low-level host imports — all operate on primitive values only.
   The host (host.js) knows nothing about C struct layouts. */
__import int __sdl_init(int flags);
__import void __sdl_quit(void);
__import int __sdl_create_window(const char *title, int x, int y, int w, int h, int flags);
__import void __sdl_destroy_window(int handle);
__import void __sdl_set_window_title(int handle, const char *title);
__import int __sdl_update_window_surface(int handle, const void *pixels, int w, int h, int pitch);
__import void __sdl_delay(int ms);
__import int __sdl_get_ticks(void);
__import void __sdl_set_animation_frame_func(void (*callback)(void));
__import int __sdl_open_audio_device(int freq, int format, int channels);
__import int __sdl_queue_audio(int dev, const void *data, int len);
__import int __sdl_get_queued_audio_size(int dev);
__import void __sdl_clear_queued_audio(int dev);
__import void __sdl_pause_audio_device(int dev, int pause_on);
__import void __sdl_close_audio_device(int dev);

int SDL_Init(Uint32 flags) {
    return __sdl_init((int)flags);
}

SDL_Window *SDL_CreateWindow(const char *title, int x, int y, int w, int h, Uint32 flags) {
    int handle = __sdl_create_window(title, x, y, w, h, (int)flags);
    int pitch = w * 4;
    SDL_Window *win = (SDL_Window *)malloc(sizeof(SDL_Window));
    win->handle = handle;
    win->surface.w = w;
    win->surface.h = h;
    win->surface.pitch = pitch;
    win->surface.pixels = malloc(pitch * h);
    memset(win->surface.pixels, 0, pitch * h);
    return win;
}

Uint32 SDL_GetWindowID(SDL_Window *window) {
    return (Uint32)window->handle;
}

SDL_Surface *SDL_GetWindowSurface(SDL_Window *window) {
    return &window->surface;
}

int SDL_UpdateWindowSurface(SDL_Window *window) {
    SDL_Surface *s = &window->surface;
    return __sdl_update_window_surface(window->handle, s->pixels, s->w, s->h, s->pitch);
}

/* ---- Event queue (freelist-based linked list) ---- */

typedef struct __SDL_EventEntry {
    SDL_Event event;
    struct __SDL_EventEntry *next;
} __SDL_EventEntry;

static __SDL_EventEntry *__sdl_eq_head;
static __SDL_EventEntry *__sdl_eq_tail;
static __SDL_EventEntry *__sdl_eq_free;

static __SDL_EventEntry *__sdl_eq_alloc(void) {
    __SDL_EventEntry *e = __sdl_eq_free;
    if (e) {
        __sdl_eq_free = e->next;
    } else {
        e = (__SDL_EventEntry *)malloc(sizeof(__SDL_EventEntry));
    }
    e->next = 0;
    return e;
}

static void __sdl_eq_push(__SDL_EventEntry *e) {
    if (__sdl_eq_tail) {
        __sdl_eq_tail->next = e;
    } else {
        __sdl_eq_head = e;
    }
    __sdl_eq_tail = e;
}

void __sdl_push_quit_event(int window_id) {
    __SDL_EventEntry *e = __sdl_eq_alloc();
    memset(&e->event, 0, sizeof(SDL_Event));
    e->event.type = SDL_QUIT;
    __sdl_eq_push(e);
}
__export __sdl_push_quit_event = __sdl_push_quit_event;

void __sdl_push_key_event(int window_id, int type, int scancode, int sym) {
    __SDL_EventEntry *e = __sdl_eq_alloc();
    memset(&e->event, 0, sizeof(SDL_Event));
    e->event.type = (Uint32)type;
    e->event.key.windowID = (Uint32)window_id;
    e->event.key.state = (type == SDL_KEYDOWN) ? SDL_PRESSED : SDL_RELEASED;
    e->event.key.keysym.scancode = scancode;
    e->event.key.keysym.sym = sym;
    __sdl_eq_push(e);
}
__export __sdl_push_key_event = __sdl_push_key_event;

int SDL_PollEvent(SDL_Event *event) {
    __SDL_EventEntry *e = __sdl_eq_head;
    if (!e) return 0;
    __sdl_eq_head = e->next;
    if (!__sdl_eq_head) __sdl_eq_tail = 0;
    *event = e->event;
    e->next = __sdl_eq_free;
    __sdl_eq_free = e;
    return 1;
}

/* ---- Audio ---- */

SDL_AudioDeviceID SDL_OpenAudioDevice(const char *device, int iscapture,
                                      const SDL_AudioSpec *desired,
                                      SDL_AudioSpec *obtained, int allowed_changes) {
    int dev = __sdl_open_audio_device(desired->freq, desired->format, (int)desired->channels);
    if (dev <= 0) return 0;
    if (obtained) {
        obtained->freq = desired->freq;
        obtained->format = desired->format;
        obtained->channels = desired->channels;
    }
    return (SDL_AudioDeviceID)dev;
}

int SDL_QueueAudio(SDL_AudioDeviceID dev, const void *data, Uint32 len) {
    return __sdl_queue_audio((int)dev, data, (int)len);
}

Uint32 SDL_GetQueuedAudioSize(SDL_AudioDeviceID dev) {
    return (Uint32)__sdl_get_queued_audio_size((int)dev);
}

void SDL_ClearQueuedAudio(SDL_AudioDeviceID dev) {
    __sdl_clear_queued_audio((int)dev);
}

void SDL_PauseAudioDevice(SDL_AudioDeviceID dev, int pause_on) {
    __sdl_pause_audio_device((int)dev, pause_on);
}

void SDL_CloseAudioDevice(SDL_AudioDeviceID dev) {
    __sdl_close_audio_device((int)dev);
}

void SDL_DestroyWindow(SDL_Window *window) {
    __sdl_destroy_window(window->handle);
    free(window->surface.pixels);
    free(window);
}

void SDL_Quit(void) {
    __sdl_quit();
}

void SDL_Delay(Uint32 ms) {
    __sdl_delay((int)ms);
}

Uint32 SDL_GetTicks(void) {
    return (Uint32)__sdl_get_ticks();
}

void SDL_SetWindowTitle(SDL_Window *window, const char *title) {
    __sdl_set_window_title(window->handle, title);
}

void __setAnimationFrameFunc(void (*callback)(void)) {
    __sdl_set_animation_frame_func(callback);
}
  )"},

    {"__emscripten.c", R"(
#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
__import void __sdl_set_animation_frame_func(void (*callback)(void));
__import void __emscripten_async_call(void (*func)(void *), void *arg, int millis);
__import float __emscripten_random(void);

void emscripten_set_main_loop(void (*func)(void), int fps, int simulate_infinite_loop) {
  if (fps != 0) {
    printf("emscripten_set_main_loop: unsupported fps=%d (only 0 is supported)\n", fps);
    exit(1);
  }
  (void)simulate_infinite_loop;
  __sdl_set_animation_frame_func(func);
}

void emscripten_async_call(void (*func)(void *), void *arg, int millis) {
  __emscripten_async_call(func, arg, millis);
}

float emscripten_random(void) {
  return __emscripten_random();
}
  )"},

    {"__dirent.c", R"(
#include <dirent.h>
#include <stdlib.h>

__import int __opendir(const char *name);
__import int __readdir(int handle, void *dirent_buf);
__import int __closedir(int handle);

struct __DIR {
  int fd;
  struct dirent ent;
};

DIR *opendir(const char *name) {
  int handle = __opendir(name);
  if (handle < 0) return (DIR *)0;
  DIR *dirp = (DIR *)malloc(sizeof(DIR));
  if (!dirp) return (DIR *)0;
  dirp->fd = handle;
  return dirp;
}

int closedir(DIR *dirp) {
  if (!dirp) return -1;
  int ret = __closedir(dirp->fd);
  free(dirp);
  return ret;
}

struct dirent *readdir(DIR *dirp) {
  if (!dirp) return (struct dirent *)0;
  int result = __readdir(dirp->fd, &dirp->ent);
  if (result < 0) return (struct dirent *)0;
  return &dirp->ent;
}
  )"},

    {"__setjmp.c", R"(
int __setjmp_id_counter;
  )"},
};

// ====================
// Utilities
// ====================

using u8 = std::uint8_t;
using u16 = std::uint16_t;
using u32 = std::uint32_t;
using u64 = std::uint64_t;
using i32 = std::int32_t;
using i64 = std::int64_t;
using Buffer = std::vector<u8>;
using Symbol = const std::string *;  // interned string

Symbol intern(std::string_view str) {
  static std::unordered_map<std::string_view, std::unique_ptr<std::string>> pool;

  auto it = pool.find(str);
  if (it != pool.end()) {
    return it->second.get();  // Found existing entry
  }

  // Make a new entry
  auto newString = std::make_unique<std::string>(str);
  Symbol ptr = newString.get();
  auto key = std::string_view(*ptr);
  pool.emplace(key, std::move(newString));

  return ptr;
}

// Not available until C++23, so we have our own version here
template <class Enum>
std::underlying_type_t<Enum> toUnderlying(Enum type) {
  return static_cast<std::underlying_type_t<Enum>>(type);
}

// Just for convenience, to reduce number of static_cast<> calls.
// size_t to u32 is really really common when dealing with wasm vectors.
u32 toU32(std::size_t value) { return static_cast<u32>(value); }

// A simple insertion-order-preserving map backed by a vector.
// Suitable for small maps where linear scan is fine (e.g. function parameters).
template <typename K, typename V>
struct InsertionOrderMap {
  std::vector<std::pair<K, V>> entries;

  void clear() { entries.clear(); }
  bool empty() const { return entries.empty(); }

  V &operator[](K key) {
    for (auto &[k, v] : entries)
      if (k == key) return v;
    entries.push_back({key, V{}});
    return entries.back().second;
  }

  auto find(K key) {
    for (auto it = entries.begin(); it != entries.end(); ++it)
      if (it->first == key) return it;
    return entries.end();
  }

  auto begin() { return entries.begin(); }
  auto end() { return entries.end(); }
};

[[noreturn]] void panicf(const char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  vfprintf(stderr, fmt, args);
  va_end(args);
  fprintf(stderr, "\n");
  exit(1);
}

void append(Buffer &out, const Buffer &data) { out.insert(out.end(), data.begin(), data.end()); }

void lebU(Buffer &out, u64 value) {
  do {
    u8 byte = value & 0x7F;
    value >>= 7;
    if (value != 0) {
      byte |= 0x80;
    }
    out.push_back(byte);
  } while (value != 0);
}

void lebI(Buffer &out, i64 value) {
  int more = 1;
  while (more) {
    u8 byte = value & 0x7F;
    value >>= 7;  // Assumes arithmetic right shift
    if ((value == 0 && (byte & 0x40) == 0) || (value == -1 && (byte & 0x40) != 0)) {
      more = 0;
    } else {
      byte |= 0x80;
    }
    out.push_back(byte);
  }
}

void appendF32(Buffer &out, float value) {
  u32 raw = std::bit_cast<u32>(value);
  for (int i = 0; i < 4; ++i) {  // Assume little-endian platform; no swap needed
    out.push_back(static_cast<u8>((raw >> (i * 8)) & 0xFF));
  }
}

void appendF64(Buffer &out, double value) {
  u64 raw = std::bit_cast<u64>(value);
  for (int i = 0; i < 8; ++i) {  // Assume little-endian platform; no swap needed
    out.push_back(static_cast<u8>((raw >> (i * 8)) & 0xFF));
  }
}

// ====================
// IO
// ====================

std::string readFile(const std::string &filename) {
  FILE *f = fopen(filename.c_str(), "rb");
  if (!f) {
    panicf("failed to open file: %s\n", filename.c_str());
  }
  fseek(f, 0, SEEK_END);
  size_t fileSize = ftell(f);
  fseek(f, 0, SEEK_SET);
  std::string content(fileSize, '\0');
  fread(content.data(), 1, fileSize, f);
  fclose(f);

  // Translation phase 2: splice lines by removing backslash-newline sequences
  // I.e. support line continuation
  // TODO: This will mean that line numbers will be off; I think I'll
  // want to fix it in the future, but the complexity isn't really worth it right now.
  if (content.find("\\\n") != std::string::npos) {
    std::string spliced;
    spliced.reserve(content.size());
    for (size_t i = 0; i < content.size(); i++) {
      if (content[i] == '\\' && i + 1 < content.size() && content[i + 1] == '\n') {
        i++;  // skip both '\' and '\n'
      } else {
        spliced.push_back(content[i]);
      }
    }
    return spliced;
  }

  return content;
}

// ====================
// WASM typedefs, enums and structs
// ====================

struct WasmValue;

using WasmFunctionTypeId = u32;
using WasmFunctionId = u32;
using WasmMemoryId = u32;
using WasmGlobalId = u32;
using WasmExpression = Buffer;

// Import and Export kinds
enum class WasmExternKind : u8 {
  FUNC = 0x00,
  TABLE = 0x01,
  MEMORY = 0x02,
  GLOBAL = 0x03,
};

enum class WasmNumType : u8 {
  I32 = 0x7F,
  I64 = 0x7E,
  F32 = 0x7D,
  F64 = 0x7C,
};

struct WasmType {
  enum Tag : u8 { EMPTY, NUM };
  Tag tag = EMPTY;
  WasmNumType num = WasmNumType::I32;

  constexpr WasmType() : tag(EMPTY) {}
  constexpr WasmType(WasmNumType n) : tag(NUM), num(n) {}

  constexpr bool isEmpty() const { return tag == EMPTY; }
  constexpr bool isNum() const { return tag == NUM; }
  constexpr bool isIntegral() const {
    return isNum() && (num == WasmNumType::I32 || num == WasmNumType::I64);
  }
  constexpr bool isFloating() const {
    return isNum() && (num == WasmNumType::F32 || num == WasmNumType::F64);
  }

  void emit(Buffer &buf) const {
    switch (tag) {
      case EMPTY: buf.push_back(0x40); break;
      case NUM: buf.push_back(static_cast<u8>(num)); break;
    }
  }

  constexpr bool operator==(const WasmType &o) const {
    if (tag != o.tag) return false;
    switch (tag) {
      case EMPTY: return true;
      case NUM: return num == o.num;
    }
    return false;
  }
  constexpr bool operator!=(const WasmType &o) const { return !(*this == o); }
  constexpr auto operator<=>(const WasmType &o) const {
    if (auto cmp = tag <=> o.tag; cmp != 0) return cmp;
    switch (tag) {
      case NUM: return num <=> o.num;
      default: return std::strong_ordering::equal;
    }
  }

  static const WasmType I32;
  static const WasmType I64;
  static const WasmType F32;
  static const WasmType F64;
  static const WasmType Empty;
};
inline constexpr WasmType WasmType::I32{WasmNumType::I32};
inline constexpr WasmType WasmType::I64{WasmNumType::I64};
inline constexpr WasmType WasmType::F32{WasmNumType::F32};
inline constexpr WasmType WasmType::F64{WasmNumType::F64};
inline constexpr WasmType WasmType::Empty{};

// Memory opcodes for use with load/store
enum class MemoryOpcode : u8 {
  // Natural loads
  I32_LOAD = 0x28,
  I64_LOAD = 0x29,
  F32_LOAD = 0x2A,
  F64_LOAD = 0x2B,

  // Narrow loads
  I32_LOAD8_S = 0x2C,
  I32_LOAD8_U = 0x2D,
  I32_LOAD16_S = 0x2E,
  I32_LOAD16_U = 0x2F,
  I64_LOAD8_S = 0x30,
  I64_LOAD8_U = 0x31,
  I64_LOAD16_S = 0x32,
  I64_LOAD16_U = 0x33,
  I64_LOAD32_S = 0x34,
  I64_LOAD32_U = 0x35,

  // Nautral stores
  I32_STORE = 0x36,
  I64_STORE = 0x37,
  F32_STORE = 0x38,
  F64_STORE = 0x39,

  // Narrow stores
  I32_STORE8 = 0x3A,
  I32_STORE16 = 0x3B,
  I64_STORE8 = 0x3C,
  I64_STORE16 = 0x3D,
  I64_STORE32 = 0x3E,
};
using enum MemoryOpcode;

// Arithmetic and relational opcodes
enum class WasmALU : u8 {
  // Relational operations
  OP_EQZ,
  OP_EQ,
  OP_NE,
  OP_LT,  // can be unsigned
  OP_GT,  // can be unsigned
  OP_LE,  // can be unsigned
  OP_GE,  // can be unsigned

  // Unary operations
  OP_CLZ,
  OP_CTZ,
  OP_POPCNT,

  // Binary operations
  OP_ADD,
  OP_SUB,
  OP_MUL,
  OP_DIV,  // can be unsigned for integers
  OP_REM,  // can be unsigned for integers
  OP_AND,
  OP_OR,
  OP_XOR,
  OP_SHL,
  OP_SHR_S,
  OP_SHR_U,
  OP_ROTL,
  OP_ROTR,

  // Floating-point unary operations
  OP_ABS,
  OP_NEG,
  OP_CEIL,
  OP_FLOOR,
  OP_TRUNC,
  OP_NEAREST,
  OP_SQRT,

  // Floating-point binary operations
  OP_MIN,
  OP_MAX,
  OP_COPYSIGN,

  // Conversions and reinterprets
  OP_WRAP_I64,         // [i64] -> [i32]
  OP_TRUNC_F32,        // [f32] -> [i32] or [i64], can be unsigned
  OP_TRUNC_F64,        // [f64] -> [i32] or [i64], can be unsigned
  OP_EXTEND_I32,       // [i32] -> [i64], can be unsigned
  OP_CONVERT_I32,      // [i32] -> [f32] or [f64], can be unsigned
  OP_CONVERT_I64,      // [i64] -> [f32] or [f64], can be unsigned
  OP_DEMOTE_F64,       // [f64] -> [f32]
  OP_PROMOTE_F32,      // [f32] -> [f64]
  OP_REINTERPRET_F32,  // [f32] -> [i32]
  OP_REINTERPRET_F64,  // [f64] -> [i64]
  OP_REINTERPRET_I32,  // [i32] -> [f32]
  OP_REINTERPRET_I64,  // [i64] -> [f64]
};
using enum WasmALU;

// Get relational or arithemtic opcode
// (GET Arithmethic OPeration)
// Intended to cover [0x45, 0xBF]
u8 getaop(WasmType t, WasmALU op, bool sign = true) {
  if (!t.isNum()) panicf("getaop called with non-numeric WasmType");
  switch (t.num) {
    case WasmNumType::I32:
      switch (op) {
        // Relational
        case OP_EQZ: return 0x45;
        case OP_EQ: return 0x46;
        case OP_NE: return 0x47;
        case OP_LT: return sign ? 0x48 : 0x49;
        case OP_GT: return sign ? 0x4A : 0x4B;
        case OP_LE: return sign ? 0x4C : 0x4D;
        case OP_GE: return sign ? 0x4E : 0x4F;
        // Unary
        case OP_CLZ: return 0x67;
        case OP_CTZ: return 0x68;
        case OP_POPCNT: return 0x69;
        // Binary
        case OP_ADD: return 0x6A;
        case OP_SUB: return 0x6B;
        case OP_MUL: return 0x6C;
        case OP_DIV: return sign ? 0x6D : 0x6E;
        case OP_REM: return sign ? 0x6F : 0x70;
        case OP_AND: return 0x71;
        case OP_OR: return 0x72;
        case OP_XOR: return 0x73;
        case OP_SHL: return 0x74;
        case OP_SHR_S: return 0x75;
        case OP_SHR_U: return 0x76;
        case OP_ROTL: return 0x77;
        case OP_ROTR: return 0x78;
        // Conversions (Result is I32)
        case OP_WRAP_I64: return 0xA7;
        case OP_TRUNC_F32: return sign ? 0xA8 : 0xA9;
        case OP_TRUNC_F64: return sign ? 0xAA : 0xAB;
        case OP_REINTERPRET_F32: return 0xBC;
        default: break;
      }
      break;

    case WasmNumType::I64:
      switch (op) {
        // Relational
        case OP_EQZ: return 0x50;
        case OP_EQ: return 0x51;
        case OP_NE: return 0x52;
        case OP_LT: return sign ? 0x53 : 0x54;
        case OP_GT: return sign ? 0x55 : 0x56;
        case OP_LE: return sign ? 0x57 : 0x58;
        case OP_GE: return sign ? 0x59 : 0x5A;
        // Unary
        case OP_CLZ: return 0x79;
        case OP_CTZ: return 0x7A;
        case OP_POPCNT: return 0x7B;
        // Binary
        case OP_ADD: return 0x7C;
        case OP_SUB: return 0x7D;
        case OP_MUL: return 0x7E;
        case OP_DIV: return sign ? 0x7F : 0x80;
        case OP_REM: return sign ? 0x81 : 0x82;
        case OP_AND: return 0x83;
        case OP_OR: return 0x84;
        case OP_XOR: return 0x85;
        case OP_SHL: return 0x86;
        case OP_SHR_S: return 0x87;
        case OP_SHR_U: return 0x88;
        case OP_ROTL: return 0x89;
        case OP_ROTR: return 0x8A;
        // Conversions (Result is I64)
        case OP_EXTEND_I32: return sign ? 0xAC : 0xAD;
        case OP_TRUNC_F32: return sign ? 0xAE : 0xAF;
        case OP_TRUNC_F64: return sign ? 0xB0 : 0xB1;
        case OP_REINTERPRET_F64: return 0xBD;
        default: break;
      }
      break;

    case WasmNumType::F32:
      switch (op) {
        // Relational
        case OP_EQ: return 0x5B;
        case OP_NE: return 0x5C;
        case OP_LT: return 0x5D;
        case OP_GT: return 0x5E;
        case OP_LE: return 0x5F;
        case OP_GE: return 0x60;
        // Unary
        case OP_ABS: return 0x8B;
        case OP_NEG: return 0x8C;
        case OP_CEIL: return 0x8D;
        case OP_FLOOR: return 0x8E;
        case OP_TRUNC: return 0x8F;
        case OP_NEAREST: return 0x90;
        case OP_SQRT: return 0x91;
        // Binary
        case OP_ADD: return 0x92;
        case OP_SUB: return 0x93;
        case OP_MUL: return 0x94;
        case OP_DIV: return 0x95;
        case OP_MIN: return 0x96;
        case OP_MAX: return 0x97;
        case OP_COPYSIGN: return 0x98;
        // Conversions (Result is F32)
        case OP_CONVERT_I32: return sign ? 0xB2 : 0xB3;
        case OP_CONVERT_I64: return sign ? 0xB4 : 0xB5;
        case OP_DEMOTE_F64: return 0xB6;
        case OP_REINTERPRET_I32: return 0xBE;
        default: break;
      }
      break;

    case WasmNumType::F64:
      switch (op) {
        // Relational
        case OP_EQ: return 0x61;
        case OP_NE: return 0x62;
        case OP_LT: return 0x63;
        case OP_GT: return 0x64;
        case OP_LE: return 0x65;
        case OP_GE: return 0x66;
        // Unary
        case OP_ABS: return 0x99;
        case OP_NEG: return 0x9A;
        case OP_CEIL: return 0x9B;
        case OP_FLOOR: return 0x9C;
        case OP_TRUNC: return 0x9D;
        case OP_NEAREST: return 0x9E;
        case OP_SQRT: return 0x9F;
        // Binary
        case OP_ADD: return 0xA0;
        case OP_SUB: return 0xA1;
        case OP_MUL: return 0xA2;
        case OP_DIV: return 0xA3;
        case OP_MIN: return 0xA4;
        case OP_MAX: return 0xA5;
        case OP_COPYSIGN: return 0xA6;
        // Conversions (Result is F64)
        case OP_CONVERT_I32: return sign ? 0xB7 : 0xB8;
        case OP_CONVERT_I64: return sign ? 0xB9 : 0xBA;
        case OP_PROMOTE_F32: return 0xBB;
        case OP_REINTERPRET_I64: return 0xBF;
        default: break;
      }
      break;

    default: break;
  }
  panicf("Invalid type/op combination: type=%d op=%d", toUnderlying(t.num), toUnderlying(op));
  return 0;
}

// Convenience utility for building WASM code
struct WasmCode {
  Buffer &bytes;

  void push(u8 byte) { bytes.push_back(byte); }

  // control flow and function calls (0x00 - 0x11)
  void unreachable() { push(0x00); }
  void nop() { push(0x01); }
  void block(WasmType blockType = {}) {
    push(0x02);  // block
    blockType.emit(bytes);
  }
  void loop(WasmType blockType = {}) {
    push(0x03);  // loop
    blockType.emit(bytes);
  }
  void if_(WasmType blockType) {
    // [cond] -> []
    push(0x04);  // if
    blockType.emit(bytes);
  }
  void else_() { push(0x05); }
  void end() { push(0x0B); }
  void br(u32 labelIdx) {
    // [] -> []
    push(0x0C);  // br
    lebU(bytes, labelIdx);
  }
  void brIf(u32 labelIdx) {
    // [cond] -> []
    push(0x0D);  // br_if
    lebU(bytes, labelIdx);
  }
  void brTable(std::span<const u32> labelIndices, u32 defaultLabelIdx) {
    // [labelIndex] -> [unreachable]
    push(0x0E);  // br_table
    lebU(bytes, toU32(labelIndices.size()));
    for (u32 idx : labelIndices) {
      lebU(bytes, idx);
    }
    lebU(bytes, defaultLabelIdx);
  }
  void ret() { push(0x0F); }  // [results*] -> []
  void call(u32 funcIdx) {
    // [args*] -> [results*]
    push(0x10);  // call
    lebU(bytes, funcIdx);
  }
  void callIndirect(u32 typeIdx) {
    // [tableIdx, args*] -> [results*]
    push(0x11);  // call_indirect
    lebU(bytes, typeIdx);
    push(0x00);  // reserved
  }

  // locals and globals (0x20 - 0x24)
  void localGet(u32 index) {
    push(0x20);  // local.get
    lebU(bytes, index);
  }
  void localSet(u32 index) {
    push(0x21);  // local.set
    lebU(bytes, index);
  }
  void localTee(u32 index) {
    push(0x22);  // local.tee
    lebU(bytes, index);
  }
  void globalGet(u32 index) {
    push(0x23);  // global.get
    lebU(bytes, index);
  }
  void globalSet(u32 index) {
    push(0x24);  // global.set
    lebU(bytes, index);
  }

  // memory operations (0x28 - 0x3E)
  // load  - load bytes from memory into the stack
  //         [address] -> [value]
  // store - store bytes from the stack into memory
  //         [address, value] -> []
  //
  // Also note, align is expressed as the power of two exponent.
  //   align = 0 -> 1 byte alignment
  //   align = 1 -> 2 byte alignment
  //   align = 2 -> 4 byte alignment
  //   align = 3 -> 8 byte alignment
  //
  void mop(MemoryOpcode opcode, u32 offset, u8 align) {
    push(toUnderlying(opcode));
    lebU(bytes, align);
    lebU(bytes, offset);
  }
  void memorySize() {
    push(0x3F);  // memory.size
    push(0x00);  // memory index
  }
  void memoryGrow() {
    push(0x40);  // memory.grow
    push(0x00);  // memory index
  }
  // Bulk memory operations (0xFC prefix)
  // memory.copy: [dest, src, len] -> []
  void memoryCopy() {
    push(0xFC);       // multi-byte prefix
    lebU(bytes, 10);  // 0x0A = memory.copy
    push(0x00);       // dest memory index
    push(0x00);       // src memory index
  }
  // memory.fill: [dest, value, len] -> []
  void memoryFill() {
    push(0xFC);       // multi-byte prefix
    lebU(bytes, 11);  // 0x0B = memory.fill
    push(0x00);       // memory index
  }

  // numeric constants (0x41 - 0x44)
  void i32Const(i32 value) {
    push(0x41);  // i32.const
    lebI(bytes, value);
  }
  void i64Const(i64 value) {
    push(0x42);  // i64.const
    lebI(bytes, value);
  }
  void f32Const(float value) {
    push(0x43);  // f32.const
    appendF32(bytes, value);
  }
  void f64Const(double value) {
    push(0x44);  // f64.const
    appendF64(bytes, value);
  }
  void valueConst(WasmValue value);

  // relational, arithmetic and conversion operations (0x45 - 0xBF)
  // Arithmetic OPeration
  void aop(WasmType t, WasmALU op, bool sign = true) { push(getaop(t, op, sign)); }

  // Exception handling
  void throw_(u32 tagIdx) {
    push(0x08);
    lebU(bytes, tagIdx);
  }
  void tryTable(WasmType blockType, std::span<const std::tuple<u8, u32, u32>> catches) {
    push(0x1F);
    blockType.emit(bytes);
    lebU(bytes, toU32(catches.size()));
    for (const auto &[kind, tagIdx, labelIdx] : catches) {
      push(kind);
      if (kind == 0x00 || kind == 0x01) lebU(bytes, tagIdx);  // catch/catch_ref have tag index
      lebU(bytes, labelIdx);
    }
  }
};

struct WasmValue : public std::variant<i32, i64, float, double> {
  using variant::variant;
  WasmType getType() const {
    static constexpr WasmType typeMap[] = {
        WasmType::I32,
        WasmType::I64,
        WasmType::F32,
        WasmType::F64,
    };
    return typeMap[this->index()];
  }
  bool is(WasmType type) const { return getType() == type; }
  template <typename T>
  T as() const {
    return std::get<T>(*this);
  }
};

void WasmCode::valueConst(WasmValue value) {
  WasmType wt = value.getType();
  if (!wt.isNum()) panicf("valueConst called with non-numeric WasmType");
  switch (wt.num) {
    case WasmNumType::I32: i32Const(value.as<i32>()); break;
    case WasmNumType::I64: i64Const(value.as<i64>()); break;
    case WasmNumType::F32: f32Const(value.as<float>()); break;
    case WasmNumType::F64: f64Const(value.as<double>()); break;
  }
}

struct WasmFunctionType {
  std::vector<WasmType> params;
  std::vector<WasmType> results;
  auto operator<=>(const WasmFunctionType &) const = default;
};

struct WasmFunctionImport {
  std::string moduleName;
  std::string functionName;
  WasmFunctionTypeId typeId;
};

struct WasmLocals {
  WasmType type;
  u32 count;
};

struct WasmFunctionDefinition {
  WasmFunctionTypeId typeId;
  std::vector<WasmLocals> locals = {};
  Buffer body = {};
};

struct WasmMemory {
  u32 minPages;
  u32 maxPages;  // 0 means no maximum
};

struct WasmGlobal {
  WasmType type;
  WasmExpression initialValueExpression;
  bool isMutable;
};

struct WasmExport {
  std::string name;
  WasmExternKind kind;
  u32 index;
};

struct WasmDataSegment {
  u32 memoryIndex;
  WasmExpression offsetExpression;  // expression that computes the offset
  Buffer initData;                  // raw data to initialize
};

struct WasmTag {
  u32 typeIdx;
};

struct ExceptionTag;  // forward declaration; defined after Type

// ====================
// WASM state
// ====================

std::vector<WasmFunctionType> wasmTypeDefs;                    // section 1
std::map<WasmFunctionType, u32> wasmFunctionTypeIndices;      //
std::vector<WasmFunctionImport> wasmFunctionImports;          // section 2
std::vector<WasmFunctionDefinition> wasmFunctionDefinitions;  // section 3 & 10
std::vector<WasmMemory> wasmMemories;                         // section 5
std::vector<WasmGlobal> wasmGlobals;                          // section 6
std::vector<WasmExport> wasmExports;                          // section 7
std::vector<WasmDataSegment> wasmDataSegments;                // section 11
std::vector<WasmTag> wasmTags;                                // section 13
std::map<Symbol, ExceptionTag *> exceptionTags;               // exception tag registry
std::vector<std::pair<std::string, std::string>> wasmCustomSections;  // custom sections (name, content)

// ====================
// WASM state modifiers
// ====================

WasmFunctionTypeId addWasmFunctionTypeId(const WasmFunctionType &type) {
  auto it = wasmFunctionTypeIndices.find(type);
  if (it != wasmFunctionTypeIndices.end()) {
    return it->second;
  }
  WasmFunctionTypeId newId = toU32(wasmTypeDefs.size());
  wasmTypeDefs.push_back(type);
  wasmFunctionTypeIndices[type] = newId;
  return newId;
}


WasmFunctionId addWasmFunctionImport(
    std::string moduleName, std::string functionName, WasmFunctionTypeId typeId) {
  if (wasmFunctionDefinitions.size() > 0) {
    panicf("WASM function imports must be added before function definitions");
  }
  WasmFunctionId newId = toU32(wasmFunctionImports.size());
  wasmFunctionImports.emplace_back(
      WasmFunctionImport{std::move(moduleName), std::move(functionName), typeId});
  return newId;
}

WasmFunctionId addWasmFunctionDefinition(WasmFunctionTypeId typeId) {
  WasmFunctionId newId = toU32(wasmFunctionImports.size() + wasmFunctionDefinitions.size());
  wasmFunctionDefinitions.push_back(WasmFunctionDefinition{typeId});
  return newId;
}

void addWasmFunctionLocals(WasmFunctionId funcId, WasmType type, u32 count) {
  if (funcId < wasmFunctionImports.size() ||
      funcId >= wasmFunctionImports.size() + wasmFunctionDefinitions.size()) {
    panicf("Invalid WASM function ID in addWasmFunctionLocals()");
  }
  WasmFunctionDefinition &funcDef = wasmFunctionDefinitions[funcId - wasmFunctionImports.size()];
  funcDef.locals.push_back(WasmLocals{type, count});
}

WasmMemoryId addWasmMemory(u32 minPages, u32 maxPages = 0) {
  WasmMemoryId newId = toU32(wasmMemories.size());
  wasmMemories.push_back(WasmMemory{minPages, maxPages});
  return newId;
}

WasmGlobalId addWasmGlobal(WasmValue initialValue, bool isMutable) {
  WasmGlobalId newId = toU32(wasmGlobals.size());
  wasmGlobals.push_back(WasmGlobal{initialValue.getType(), {}, isMutable});
  auto &global = wasmGlobals.back();

  // initial value expression (constant)
  WasmCode code{global.initialValueExpression};
  code.valueConst(initialValue);
  code.end();  // end of init expr

  return newId;
}

void patchWasmGlobalValue(WasmGlobalId id, WasmValue newValue) {
  auto &global = wasmGlobals[id];
  global.initialValueExpression.clear();
  WasmCode code{global.initialValueExpression};
  code.valueConst(newValue);
  code.end();
}

void addWasmExport(std::string name, WasmExternKind kind, u32 index) {
  wasmExports.push_back(WasmExport{std::move(name), kind, index});
}

u32 addWasmTag(u32 funcTypeIdx) {
  u32 idx = toU32(wasmTags.size());
  wasmTags.push_back(WasmTag{funcTypeIdx});
  return idx;
}

void addDataSegment(u32 offset, Buffer initData) {
  WasmDataSegment segment;
  segment.memoryIndex = 0;  // only one memory for now

  // offset expression (constant)
  WasmCode code{segment.offsetExpression};
  code.i32Const(static_cast<i32>(offset));
  code.end();  // end of init expr

  segment.initData = std::move(initData);
  wasmDataSegments.push_back(std::move(segment));
}

// ====================
// WASM emitters
// ====================

void emitSection(Buffer &out, u8 id, const Buffer &content) {
  out.push_back(id);
  lebU(out, toU32(content.size()));
  append(out, content);
}

void emitString(Buffer &out, std::string_view str) {
  lebU(out, toU32(str.size()));
  append(out, Buffer(str.begin(), str.end()));
}

void emit(Buffer &out) {
  // WASM magic and version
  append(out, {0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00});

  Buffer buf;

  // Type section (section 1) — function types
  {
    lebU(buf, toU32(wasmTypeDefs.size()));

    for (const auto &func : wasmTypeDefs) {
      buf.push_back(0x60);  // func type tag
      lebU(buf, toU32(func.params.size()));
      for (const WasmType &param : func.params) {
        param.emit(buf);
      }
      lebU(buf, toU32(func.results.size()));
      for (const WasmType &result : func.results) {
        result.emit(buf);
      }
    }

    emitSection(out, 1, buf);
    buf.clear();
  }

  // Import section (section 2)
  {
    // a vector of imports
    lebU(buf, toU32(wasmFunctionImports.size()));

    for (const auto &imp : wasmFunctionImports) {
      // module name
      emitString(buf, imp.moduleName);

      // function name
      emitString(buf, imp.functionName);

      // import kind
      buf.push_back(toUnderlying(WasmExternKind::FUNC));

      // type index
      lebU(buf, imp.typeId);
    }

    emitSection(out, 2, buf);
    buf.clear();
  }

  // Function section (section 3)
  {
    // a vector of function definitions
    lebU(buf, toU32(wasmFunctionDefinitions.size()));
    for (const auto &def : wasmFunctionDefinitions) {
      lebU(buf, def.typeId);
    }
    emitSection(out, 3, buf);
    buf.clear();
  }

  // Table section (section 4)
  {
    u32 totalFuncs = toU32(wasmFunctionImports.size() + wasmFunctionDefinitions.size());
    u32 tableSize = totalFuncs + 1;  // +1 for reserved null entry at index 0
    lebU(buf, 1);                    // number of tables
    buf.push_back(0x70);             // funcref
    buf.push_back(0x00);             // flags: no max
    lebU(buf, tableSize);            // min size
    emitSection(out, 4, buf);
    buf.clear();
  }

  // Memory section (section 5)
  {
    // a vector of memories
    lebU(buf, toU32(wasmMemories.size()));
    for (const auto &mem : wasmMemories) {
      bool hasMaxPages = (mem.maxPages != 0);
      buf.push_back(hasMaxPages ? 0x01 : 0x00);  // flags
      lebU(buf, mem.minPages);
      if (hasMaxPages) {
        lebU(buf, mem.maxPages);
      }
    }
    emitSection(out, 5, buf);
    buf.clear();
  }

  // Tag section (section 13) — exception tags
  // Must appear after Memory section and before Global section
  if (!wasmTags.empty()) {
    lebU(buf, toU32(wasmTags.size()));
    for (const auto &tag : wasmTags) {
      buf.push_back(0x00);  // attribute: exception (0x00)
      lebU(buf, tag.typeIdx);
    }
    emitSection(out, 13, buf);
    buf.clear();
  }

  // Global section (section 6)
  {
    // a vector of globals
    lebU(buf, toU32(wasmGlobals.size()));
    for (const auto &global : wasmGlobals) {
      // value type
      global.type.emit(buf);

      // mutability
      buf.push_back(global.isMutable ? 0x01 : 0x00);

      append(buf, global.initialValueExpression);
    }
    emitSection(out, 6, buf);
    buf.clear();
  }

  // Export section (section 7)
  {
    // a vector of exports
    lebU(buf, toU32(wasmExports.size()));
    for (const auto &exp : wasmExports) {
      // export name
      emitString(buf, exp.name);

      // export kind
      buf.push_back(toUnderlying(exp.kind));

      // index
      lebU(buf, exp.index);
    }
    emitSection(out, 7, buf);
    buf.clear();
  }

  // Element section (section 9) - populate table with all functions
  {
    u32 totalFuncs = toU32(wasmFunctionImports.size() + wasmFunctionDefinitions.size());
    if (totalFuncs > 0) {
      lebU(buf, 1);  // number of element segments
      lebU(buf, 0);  // table index 0
      // offset expression: i32.const 1 (start at index 1, index 0 is null)
      buf.push_back(0x41);  // i32.const
      lebI(buf, 1);
      buf.push_back(0x0B);  // end
      lebU(buf, totalFuncs);
      for (u32 i = 0; i < totalFuncs; i++) {
        lebU(buf, i);  // function index
      }
    } else {
      lebU(buf, 0);  // no element segments
    }
    emitSection(out, 9, buf);
    buf.clear();
  }

  // Code section (section 10)
  {
    // a vector of function bodies
    lebU(buf, toU32(wasmFunctionDefinitions.size()));
    for (const auto &def : wasmFunctionDefinitions) {
      Buffer funcBody;

      // locals declaration
      lebU(funcBody, toU32(def.locals.size()));
      for (const auto &local : def.locals) {
        lebU(funcBody, local.count);
        local.type.emit(funcBody);
      }
      append(funcBody, def.body);  // function body
      WasmCode{funcBody}.end();    // end opcode

      // emit function body with size prefix
      lebU(buf, toU32(funcBody.size()));
      append(buf, funcBody);
    }
    emitSection(out, 10, buf);
    buf.clear();
  }

  // Data section (section 11)
  {
    // a vector of data segments
    lebU(buf, toU32(wasmDataSegments.size()));
    for (const auto &segment : wasmDataSegments) {
      lebU(buf, segment.memoryIndex);
      append(buf, segment.offsetExpression);
      lebU(buf, toU32(segment.initData.size()));
      append(buf, segment.initData);
    }
    emitSection(out, 11, buf);
    buf.clear();
  }

  // Custom sections (section 0)
  for (const auto &[name, content] : wasmCustomSections) {
    Buffer buf;
    emitString(buf, name);
    append(buf, Buffer(content.begin(), content.end()));
    emitSection(out, 0, buf);
  }
}

// ====================
// Lexer
// ====================

enum class TokenKind : u8 {
  EOS,          // end of stream
  NEWLINE,      // preserved for preprocessor, stripped before parsing
  IDENT,        // identifier (keywords are IDENTS during preprocessing)
  PP_NUMBER,    // preprocessor number
  STRING,       // string literal
  CHAR,         // character literal
  PUNCT,        // punctuation ('text' holds which punctuation)
  KEYWORD,      // keyword ('text' holds which keyword)
  INT,          // integer literal (post-preprocessing)
  FLOAT,        // floating-point literal (post-preprocessing)
  PLACEMARKER,  // empty macro argument adjacent to ## (C standard §6.10.3.3)
};

std::string_view getTokenKindName(TokenKind kind) {
  switch (kind) {
    case TokenKind::EOS: return "EOS";
    case TokenKind::NEWLINE: return "NEWLINE";
    case TokenKind::IDENT: return "IDENT";
    case TokenKind::PP_NUMBER: return "PP_NUMBER";
    case TokenKind::STRING: return "STRING";
    case TokenKind::CHAR: return "CHAR";
    case TokenKind::PUNCT: return "PUNCT";
    case TokenKind::KEYWORD: return "KEYWORD";
    case TokenKind::INT: return "INT";
    case TokenKind::FLOAT: return "FLOAT";
    case TokenKind::PLACEMARKER: return "PLACEMARKER";
    default: return "UNKNOWN";
  }
}

enum class Keyword : u8 {
  AUTO,
  BREAK,
  CASE,
  CHAR,
  CONST,
  CONTINUE,
  DEFAULT,
  DO,
  DOUBLE,
  ELSE,
  ENUM,
  EXTERN,
  FLOAT,
  FOR,
  GOTO,
  IF,
  INT,
  LONG,
  REGISTER,
  RETURN,
  SHORT,
  SIGNED,
  SIZEOF,
  STATIC,
  STRUCT,
  SWITCH,
  TYPEDEF,
  UNION,
  UNSIGNED,
  VOID,
  VOLATILE,
  WHILE,

  // C99
  INLINE,
  RESTRICT,

  // C11
  GENERIC,        // _Generic selection expression
  STATIC_ASSERT,  // _Static_assert
  NORETURN,       // _Noreturn function specifier
  ALIGNOF,        // _Alignof
  ALIGNAS,        // _Alignas
  THREAD_LOCAL,   // _Thread_local (no-op: WASM is single-threaded)

  // Extensions
  BOOL,      // C99 '_Bool' type
  X_IMPORT,  // __import (external function provided by wasm host)
  X_BUILTIN_VA_START,
  X_BUILTIN_VA_ARG,
  X_BUILTIN_VA_END,
  X_BUILTIN_VA_COPY,
  X_MEMORY_SIZE,     // Gets the current memory size in pages (64KiB each)
  X_MEMORY_GROW,     // Grows memory by N pages, returns previous size
  X_BUILTIN_UNREACHABLE,  // __builtin_unreachable()
  X_BUILTIN_ABORT,        // __builtin_abort() — same as unreachable
  X_BUILTIN_EXPECT,       // __builtin_expect(x, v) — returns x (hint ignored on WASM)
  X_BUILTIN,         // __builtin(name, args...) unified intrinsic syntax
  X_ATTRIBUTE,       // __attribute__((...)) GCC attribute syntax
  X_REQUIRE_SOURCE,  // __require_source (for including standard library source files)
  X_EXPORT,          // __export (export a function from the WASM module under a custom name)
  X_WASM,            // __wasm (embed raw WebAssembly bytecode)
  X_MINSTACK,        // __minstack (minimum stack size in bytes)
  X_EXCEPTION,       // __exception (WASM exception tag declaration)
  X_TRY,             // __try (WASM try block)
  X_CATCH,           // __catch (WASM catch clause)
  X_THROW,           // __throw (WASM throw instruction)
};

enum class Punct : u8 {
  // Single-character
  LBRACK, RBRACK, LPAREN, RPAREN, LBRACE, RBRACE,
  DOT, AMP, STAR, PLUS, MINUS, TILDE,
  BANG, SLASH, PCT, LT, GT, CARET,
  PIPE, QMARK, COLON, SEMI, EQ, COMMA, HASH,
  // Two-character
  ARROW, PLUSPLUS, MINUSMINUS, LSHIFT, RSHIFT,
  LE, GE, EQEQ, NE, AMPAMP, PIPEPIPE,
  STAR_EQ, SLASH_EQ, PCT_EQ, PLUS_EQ, MINUS_EQ,
  AMP_EQ, CARET_EQ, PIPE_EQ, HASH_HASH,
  // Three-character
  LSHIFT_EQ, RSHIFT_EQ, ELLIPSIS,
};

std::string_view getKeywordName(Keyword kw) {
  switch (kw) {
    case Keyword::AUTO: return "auto";
    case Keyword::BREAK: return "break";
    case Keyword::CASE: return "case";
    case Keyword::CHAR: return "char";
    case Keyword::CONST: return "const";
    case Keyword::CONTINUE: return "continue";
    case Keyword::DEFAULT: return "default";
    case Keyword::DO: return "do";
    case Keyword::DOUBLE: return "double";
    case Keyword::ELSE: return "else";
    case Keyword::ENUM: return "enum";
    case Keyword::EXTERN: return "extern";
    case Keyword::FLOAT: return "float";
    case Keyword::FOR: return "for";
    case Keyword::GOTO: return "goto";
    case Keyword::IF: return "if";
    case Keyword::INT: return "int";
    case Keyword::LONG: return "long";
    case Keyword::REGISTER: return "register";
    case Keyword::RETURN: return "return";
    case Keyword::SHORT: return "short";
    case Keyword::SIGNED: return "signed";
    case Keyword::SIZEOF: return "sizeof";
    case Keyword::STATIC: return "static";
    case Keyword::STRUCT: return "struct";
    case Keyword::SWITCH: return "switch";
    case Keyword::TYPEDEF: return "typedef";
    case Keyword::UNION: return "union";
    case Keyword::UNSIGNED: return "unsigned";
    case Keyword::VOID: return "void";
    case Keyword::VOLATILE: return "volatile";
    case Keyword::WHILE: return "while";
    case Keyword::INLINE: return "inline";
    case Keyword::RESTRICT: return "restrict";
    case Keyword::GENERIC: return "_Generic";
    case Keyword::STATIC_ASSERT: return "_Static_assert";
    case Keyword::NORETURN: return "_Noreturn";
    case Keyword::ALIGNOF: return "_Alignof";
    case Keyword::ALIGNAS: return "_Alignas";
    case Keyword::THREAD_LOCAL: return "_Thread_local";
    case Keyword::BOOL: return "_Bool";
    case Keyword::X_IMPORT: return "__import";
    case Keyword::X_BUILTIN_VA_START: return "__builtin_va_start";
    case Keyword::X_BUILTIN_VA_ARG: return "__builtin_va_arg";
    case Keyword::X_BUILTIN_VA_END: return "__builtin_va_end";
    case Keyword::X_BUILTIN_VA_COPY: return "__builtin_va_copy";
    case Keyword::X_BUILTIN_UNREACHABLE: return "__builtin_unreachable";
    case Keyword::X_BUILTIN_ABORT: return "__builtin_abort";
    case Keyword::X_BUILTIN_EXPECT: return "__builtin_expect";
    case Keyword::X_MEMORY_SIZE: return "__memory_size";
    case Keyword::X_MEMORY_GROW: return "__memory_grow";
    case Keyword::X_BUILTIN: return "__builtin";
    case Keyword::X_ATTRIBUTE: return "__attribute__";
    case Keyword::X_REQUIRE_SOURCE: return "__require_source";
    case Keyword::X_EXPORT: return "__export";
    case Keyword::X_WASM: return "__wasm";
    case Keyword::X_EXCEPTION: return "__exception";
    case Keyword::X_TRY: return "__try";
    case Keyword::X_CATCH: return "__catch";
    case Keyword::X_THROW: return "__throw";
    default: return "UNKNOWN_KEYWORD";
  }
}

enum class StringPrefix : u8 {
  NONE,
  PREFIX_L,   // L"..." or L'.'
  PREFIX_u,   // u"..." or u'.'
  PREFIX_U,   // U"..." or U'.'
  PREFIX_u8,  // u8"..."
};

struct TokenFlags {
  bool atBol : 1 = false;       // at beginning of line
  bool hasSpace : 1 = false;    // has space before token
  bool isUnsigned : 1 = false;  // INT: U suffix
  bool isLong : 1 = false;      // INT: L suffix; FLOAT: L suffix (long double)
  bool isLongLong : 1 = false;  // INT: LL suffix
  bool isFloat : 1 = false;     // FLOAT: f/F suffix
  bool isDecimal : 1 = false;   // INT: decimal (not hex/octal) — affects type promotion
  StringPrefix stringPrefix = StringPrefix::NONE;  // string/char literal prefix
};

struct Token {
  Symbol filename;
  u32 line;
  u32 column;
  TokenKind kind;
  std::string_view text;  // view into source code (source must outlive token)
  union {
    u64 integer;  // The '-' is always a separate token, so integers are always non-negative
    double floating;
    Keyword keyword;
    Punct punct;
  } value;

  TokenFlags flags = {};

  bool atIdent(std::string_view ident) const { return kind == TokenKind::IDENT && text == ident; }
  bool atPunct(Punct p) const { return kind == TokenKind::PUNCT && value.punct == p; }
  bool atKeyword(Keyword kw) const { return kind == TokenKind::KEYWORD && value.keyword == kw; }
};

struct LexError {
  std::string message;
  Symbol filename;
  u32 line;
};

struct LexResult {
  std::vector<Token> tokens;
  std::vector<LexError> errors;
  std::vector<LexError> warnings;
};

LexResult lex(Symbol filename, std::string_view source) {
  const auto s = source;
  const auto n = s.size();
  LexResult result;
  u32 i = 0, line = 1;
  u32 lineStart = 0;  // index of start of current line
  u32 j = 0;  // token start index
  u32 savedLine = 1, savedColumn = 1;
  bool lastTokenWasNewline = true;
  bool bol = true, space = false;

  auto isSpace = [](char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\f' || c == '\v' || c == '\n';
  };
  auto isIdentStart = [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$';
  };
  auto isDigit = [](char c) { return c >= '0' && c <= '9'; };
  auto isIdentPart = [&](char c) { return isIdentStart(c) || isDigit(c); };
  auto isPpNumberPart = [&](char c) { return isIdentPart(c) || c == '.'; };

  auto mark = [&]() {
    j = i;
    savedLine = line;
    savedColumn = i - lineStart + 1;
  };
  auto peek = [&](u32 k = 0) { return i + k < n ? s[i + k] : '\0'; };
  auto at = [&](char c) { return i < n && s[i] == c; };
  auto isPunctChar = [](char c) -> bool {
    switch (c) {
      case '[': case ']': case '(': case ')': case '{': case '}':
      case '.': case '&': case '*': case '+': case '-': case '~':
      case '!': case '/': case '%': case '<': case '>': case '^':
      case '|': case '?': case ':': case ';': case '=': case ',':
      case '#':
        return true;
      default: return false;
    }
  };
  auto advance = [&](u32 count = 1) { i += count; };
  auto advanceLine = [&]() { ++line; lineStart = i; };
  auto addToken = [&](TokenKind kind) {
    auto tokenFlags = TokenFlags{
        .atBol = bol,
        .hasSpace = space,
    };
    auto token = Token{filename, savedLine, savedColumn, kind, s.substr(j, i - j), {}, tokenFlags};
    result.tokens.push_back(token);
    lastTokenWasNewline = (kind == TokenKind::NEWLINE);
    bol = false;
    space = false;
  };
  auto tryPunct = [&]() -> bool {
    Punct p;
    u32 len = 1;
    switch (peek()) {
      case '[': p = Punct::LBRACK; break;
      case ']': p = Punct::RBRACK; break;
      case '(': p = Punct::LPAREN; break;
      case ')': p = Punct::RPAREN; break;
      case '{': p = Punct::LBRACE; break;
      case '}': p = Punct::RBRACE; break;
      case '~': p = Punct::TILDE; break;
      case '?': p = Punct::QMARK; break;
      case ';': p = Punct::SEMI; break;
      case ',': p = Punct::COMMA; break;
      case '.':
        if (peek(1) == '.' && peek(2) == '.') { p = Punct::ELLIPSIS; len = 3; }
        else { p = Punct::DOT; }
        break;
      case '+':
        if (peek(1) == '+') { p = Punct::PLUSPLUS; len = 2; }
        else if (peek(1) == '=') { p = Punct::PLUS_EQ; len = 2; }
        else { p = Punct::PLUS; }
        break;
      case '-':
        if (peek(1) == '>') { p = Punct::ARROW; len = 2; }
        else if (peek(1) == '-') { p = Punct::MINUSMINUS; len = 2; }
        else if (peek(1) == '=') { p = Punct::MINUS_EQ; len = 2; }
        else { p = Punct::MINUS; }
        break;
      case '*':
        if (peek(1) == '=') { p = Punct::STAR_EQ; len = 2; }
        else { p = Punct::STAR; }
        break;
      case '/':
        if (peek(1) == '=') { p = Punct::SLASH_EQ; len = 2; }
        else { p = Punct::SLASH; }
        break;
      case '%':
        if (peek(1) == '=') { p = Punct::PCT_EQ; len = 2; }
        else { p = Punct::PCT; }
        break;
      case '<':
        if (peek(1) == '<') {
          if (peek(2) == '=') { p = Punct::LSHIFT_EQ; len = 3; }
          else { p = Punct::LSHIFT; len = 2; }
        } else if (peek(1) == '=') { p = Punct::LE; len = 2; }
        else { p = Punct::LT; }
        break;
      case '>':
        if (peek(1) == '>') {
          if (peek(2) == '=') { p = Punct::RSHIFT_EQ; len = 3; }
          else { p = Punct::RSHIFT; len = 2; }
        } else if (peek(1) == '=') { p = Punct::GE; len = 2; }
        else { p = Punct::GT; }
        break;
      case '=':
        if (peek(1) == '=') { p = Punct::EQEQ; len = 2; }
        else { p = Punct::EQ; }
        break;
      case '!':
        if (peek(1) == '=') { p = Punct::NE; len = 2; }
        else { p = Punct::BANG; }
        break;
      case '&':
        if (peek(1) == '&') { p = Punct::AMPAMP; len = 2; }
        else if (peek(1) == '=') { p = Punct::AMP_EQ; len = 2; }
        else { p = Punct::AMP; }
        break;
      case '|':
        if (peek(1) == '|') { p = Punct::PIPEPIPE; len = 2; }
        else if (peek(1) == '=') { p = Punct::PIPE_EQ; len = 2; }
        else { p = Punct::PIPE; }
        break;
      case '^':
        if (peek(1) == '=') { p = Punct::CARET_EQ; len = 2; }
        else { p = Punct::CARET; }
        break;
      case ':': p = Punct::COLON; break;
      case '#':
        if (peek(1) == '#') { p = Punct::HASH_HASH; len = 2; }
        else { p = Punct::HASH; }
        break;
      default: return false;
    }
    mark();
    advance(len);
    addToken(TokenKind::PUNCT);
    result.tokens.back().value.punct = p;
    return true;
  };

  while (i < n && result.errors.empty()) {
    // Whitespace and comments
    if (at('\n') && !lastTokenWasNewline) {
      mark();
      addToken(TokenKind::NEWLINE);
      advance();
      advanceLine();
      bol = true;
      space = false;
      continue;
    }
    if (isSpace(s[i])) {
      if (s[i] == '\n') { advance(); advanceLine(); }
      else { advance(); }
      space = true;
      continue;
    }
    if (peek() == '/' && peek(1) == '/') {
      while (i < n && !at('\n')) {
        advance();
      }
      continue;
    }
    if (peek() == '/' && peek(1) == '*') {
      advance(2);
      while (i < n && !(peek() == '*' && peek(1) == '/')) {
        if (s[i] == '\n') { advance(); advanceLine(); }
        else { advance(); }
      }
      if (i < n) {
        advance(2);
      } else {
        result.errors.push_back(LexError{"Unterminated comment", filename, line});
      }
      continue;
    }

    mark();

    // String and character literals (including prefixed: L, u, U, u8)
    {
      StringPrefix prefix = StringPrefix::NONE;
      bool isLiteral = false;
      if (at('"') || at('\'')) {
        isLiteral = true;
      } else if (s[i] == 'L' && (peek(1) == '"' || peek(1) == '\'')) {
        prefix = StringPrefix::PREFIX_L;
        advance();
        isLiteral = true;
      } else if (s[i] == 'U' && (peek(1) == '"' || peek(1) == '\'')) {
        prefix = StringPrefix::PREFIX_U;
        advance();
        isLiteral = true;
      } else if (s[i] == 'u') {
        if (peek(1) == '\'' || peek(1) == '"') {
          prefix = StringPrefix::PREFIX_u;
          advance();
          isLiteral = true;
        } else if (peek(1) == '8' && peek(2) == '"') {
          prefix = StringPrefix::PREFIX_u8;
          advance(2);
          isLiteral = true;
        }
      }
      if (isLiteral) {
        char quoteChar = s[i];
        if (prefix == StringPrefix::PREFIX_u8 && quoteChar == '\'') {
          result.errors.push_back(LexError{"u8 prefix is not valid for character literals", filename, line});
        }
        advance();
        while (i < n && !at(quoteChar)) {
          if (at('\\')) {
            advance(2);
          } else {
            advance();
          }
        }
        if (i < n) {
          advance();  // closing " or '
          auto kind = quoteChar == '"' ? TokenKind::STRING : TokenKind::CHAR;
          addToken(kind);
          result.tokens.back().flags.stringPrefix = prefix;
        } else {
          result.errors.push_back(LexError{"Unterminated string literal", filename, line});
        }
        continue;
      }
    }

    // Identifiers
    if (isIdentStart(s[i])) {
      advance();
      while (isIdentPart(peek())) {
        advance();
      }
      addToken(TokenKind::IDENT);
      continue;
    }

    // Preprocessor numbers
    // PP_NUMBERS are greedy
    //
    //   digit
    //   '.' digit
    //   PP_NUMBER (digit, nondigit or '.')*
    //   PP_NUMBER (e+, e-, E+, E-)
    //
    if (isDigit(s[i]) || (s[i] == '.' && isDigit(peek(1)))) {
      advance();
      while (isPpNumberPart(peek())) {
        char c1 = peek();
        char c2 = peek(1);
        if ((c1 == 'e' || c1 == 'E' || c1 == 'p' || c1 == 'P') && (c2 == '+' || c2 == '-')) {
          advance();
        }
        advance();
      }
      addToken(TokenKind::PP_NUMBER);
      continue;
    }

    // C99 digraphs (§6.4.6): <: :> <% %> %: %:%:
    {
      char d0 = peek(), d1 = peek(1);
      auto addDigraph = [&](u32 len, std::string_view canon, Punct p) {
        advance(len);
        auto tokenFlags = TokenFlags{.atBol = bol, .hasSpace = space};
        auto tok = Token{filename, savedLine, savedColumn, TokenKind::PUNCT, canon, {}, tokenFlags};
        tok.value.punct = p;
        result.tokens.push_back(tok);
        lastTokenWasNewline = false;
        bol = false;
        space = false;
      };
      if (d0 == '%' && d1 == ':') {
        if (peek(2) == '%' && peek(3) == ':') {
          addDigraph(4, "##", Punct::HASH_HASH);
        } else {
          addDigraph(2, "#", Punct::HASH);
        }
        continue;
      }
      if (d0 == '<' && d1 == ':') { addDigraph(2, "[", Punct::LBRACK); continue; }
      if (d0 == '<' && d1 == '%') { addDigraph(2, "{", Punct::LBRACE); continue; }
      if (d0 == ':' && d1 == '>') { addDigraph(2, "]", Punct::RBRACK); continue; }
      if (d0 == '%' && d1 == '>') { addDigraph(2, "}", Punct::RBRACE); continue; }
    }

    // Punctuation
    if (tryPunct()) continue;

    // Unknown character
    std::string msg = "Unexpected character: '";
    while (i < n && !isSpace(s[i]) && !isPunctChar(s[i])) {
      msg += s[i];
      advance();
    }
    msg += "'";
    result.errors.push_back(LexError{msg, filename, line});
  }

  mark();
  addToken(TokenKind::EOS);

  return result;
}

struct WarningFlags {
  bool circularDependency = false;
  bool pointerDecay = false;
};

struct CompilerOptions {
  bool noUndefined = false;  // --no-undefined: disable unused-declaration filtering
  bool gcSections = false;   // --gc-sections: cross-TU dead code elimination
  bool compilerDebugSwitch =
      false;  // --compiler-debug-switch: print switch dispatch strategy to stderr
  bool allowImplicitInt = false;   // --allow-implicit-int: permit C89-style implicit int
  bool allowEmptyParams = false;   // --allow-empty-params: treat f() as compatible with any params
  bool allowKnRDefinitions = false; // --allow-knr-definitions: permit K&R function definitions
  bool allowImplicitFunctionDecl = false; // --allow-implicit-function-decl: permit C89-style implicit function declarations
  bool allowUndefined = false; // --allow-undefined: treat unresolved extern functions as wasm imports
  bool timeReport = false; // --time-report: print per-phase timing to stderr
  std::vector<std::string_view> requireSources; // --require-source: inject __require_source
};

CompilerOptions compilerOptions;
WarningFlags warningFlags;

struct PPRegistry {
  std::map<Symbol, std::optional<std::string>> defines;
  std::vector<std::string> includePaths;
  std::vector<std::unique_ptr<std::string>> sourceBuffers;
  std::set<Symbol> onceGuards;  // for #pragma once
  std::vector<std::pair<std::string, std::string>> customSections;  // #pragma custom_section

  // Read file contents then cache in sourceBuffers to manage lifetime
  std::string_view loadFile(std::string_view path) {
    for (const auto &bufPtr : sourceBuffers) {
      if (bufPtr->data() == path.data()) {
        return *bufPtr;
      }
    }
    auto content = readFile(std::string(path));
    sourceBuffers.push_back(std::make_unique<std::string>(std::move(content)));
    return *sourceBuffers.back();
  }
};

// Forward declaration — defined after preprocess(), needed for char constants in #if
i32 unescape(const char *&curr, const char *end);

LexResult preprocess(
    Symbol filename, std::span<const Token> initialTokens, PPRegistry &ppRegistry) {
  struct Macro {
    bool isFunctionLike = false;
    bool isVariadic = false;
    std::string_view variadicName;  // GNU extension: named variadic param (e.g., "args" in "args...")
    std::vector<std::string_view> params;
    std::vector<Token> replacement;
  };

  struct PPState {
    Symbol currentFile;
    const Token *it;
    const Token *end;
    bool atEnd() const { return it == end || it->kind == TokenKind::EOS; }
    const Token &peek() const { return *it; }
    const Token &consume() { return *it++; }
  };

  struct IfLevel {
    bool active;
    bool anyBranchRan;
  };

  LexResult result;
  std::vector<Token> output;
  std::unordered_map<std::string_view, Macro> macros;
  std::vector<IfLevel> ifStack;
  std::vector<Symbol> includeStack = {filename};

  // --- 1. SEED REGISTRY MACROS ---
  for (auto const &[name, val] : ppRegistry.defines) {
    Macro m;
    if (val.has_value()) {
      auto lexRes = lex(name, *val);
      for (const auto &t : lexRes.tokens) {
        if (t.kind != TokenKind::EOS) m.replacement.push_back(t);
      }
    }
    macros[*name] = std::move(m);
  }

  auto isActive = [&]() {
    return ifStack.empty() || ifStack.back().active;
  };

  // Expand __FILE__, __LINE__, __DATE__, __TIME__ predefined macros in-place
  // Compute __DATE__ and __TIME__ once (frozen at translation start per C standard)
  std::string dateStr, timeStr;
  {
    std::time_t now = std::time(nullptr);
    std::tm *tm = std::localtime(&now);
    static const char *months[] = {
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    };
    // "Mmm dd yyyy" — day is space-padded (e.g. "Feb  6 2026")
    char dateBuf[32];
    std::snprintf(dateBuf, sizeof(dateBuf), "\"%s %2d %d\"",
                  months[tm->tm_mon], tm->tm_mday, tm->tm_year + 1900);
    dateStr = dateBuf;
    // "hh:mm:ss"
    char timeBuf[32];
    std::snprintf(timeBuf, sizeof(timeBuf), "\"%02d:%02d:%02d\"",
                  tm->tm_hour, tm->tm_min, tm->tm_sec);
    timeStr = timeBuf;
  }
  auto tryExpandBuiltinMacro = [&dateStr, &timeStr](Token &tok) -> bool {
    if (tok.atIdent("__LINE__")) {
      tok.kind = TokenKind::PP_NUMBER;
      tok.text = *intern(std::to_string(tok.line));
      return true;
    }
    if (tok.atIdent("__FILE__")) {
      tok.kind = TokenKind::STRING;
      tok.text = *intern("\"" + *tok.filename + "\"");
      return true;
    }
    if (tok.atIdent("__DATE__")) {
      tok.kind = TokenKind::STRING;
      tok.text = *intern(dateStr);
      return true;
    }
    if (tok.atIdent("__TIME__")) {
      tok.kind = TokenKind::STRING;
      tok.text = *intern(timeStr);
      return true;
    }
    return false;
  };

  // --- 2. CENTRALIZED EXPANSION HELPER ---
  // Handles recursive expansion and prevents infinite loops via hideset
  using Hideset = std::set<std::string_view>;
  auto expand = [&](auto &self, std::span<const Token> tokens,
                    Hideset hideset) -> std::vector<Token> {
    std::vector<Token> expanded;
    for (size_t i = 0; i < tokens.size(); ++i) {
      const Token &t = tokens[i];

      // Special handling for the 'defined' operator
      if (t.atIdent("defined")) {
        bool hasParens = false;
        size_t nextIdx = i + 1;

        // Skip to the start of the operand
        if (nextIdx < tokens.size() && tokens[nextIdx].atPunct(Punct::LPAREN)) {
          hasParens = true;
          nextIdx++;
        }

        if (nextIdx < tokens.size() && tokens[nextIdx].kind == TokenKind::IDENT) {
          const Token &operand = tokens[nextIdx];
          bool isDefined = macros.count(operand.text);

          // Create a synthetic token for the result (1 or 0)
          Token resultTok = t;
          resultTok.kind = TokenKind::PP_NUMBER;
          resultTok.text = isDefined ? "1" : "0";
          expanded.push_back(resultTok);

          // Advance past the operand and optional closing paren
          i = nextIdx;
          if (hasParens) {
            if (i + 1 < tokens.size() && tokens[i + 1].atPunct(Punct::RPAREN)) {
              i++;
            } else {
              // Technically a preprocessor error, but for now we skip
            }
          }
          continue;
        }
      }

      // Handle __FILE__ / __LINE__ / __DATE__ / __TIME__ predefined macros
      if (t.atIdent("__LINE__") || t.atIdent("__FILE__") ||
          t.atIdent("__DATE__") || t.atIdent("__TIME__")) {
        Token tok = t;
        tryExpandBuiltinMacro(tok);
        expanded.push_back(tok);
        continue;
      }

      // Normal expansion logic
      if (t.kind == TokenKind::IDENT && macros.count(t.text) && !hideset.count(t.text)) {
        const auto &m = macros[t.text];
        if (!m.isFunctionLike) {
          Hideset nextHideset = hideset;
          nextHideset.insert(t.text);
          std::vector<Token> relocated = m.replacement;
          for (auto &tok : relocated) {
            tok.filename = t.filename;
            tok.line = t.line;
            tok.column = t.column;
          }
          std::vector<Token> replacement = self(self, relocated, nextHideset);
          expanded.insert(expanded.end(), replacement.begin(), replacement.end());
        } else {
          // Function-style macro: need to check for '(' and collect arguments
          // Look ahead for '(' (skipping the macro name token and newlines)
          size_t argStart = i + 1;
          while (argStart < tokens.size() && tokens[argStart].kind == TokenKind::NEWLINE)
            argStart++;
          if (argStart < tokens.size() && tokens[argStart].atPunct(Punct::LPAREN)) {
            // Collect arguments by scanning for matching ')'
            // Skip NEWLINE tokens inside macro arguments (C standard: newlines
            // in macro invocations are whitespace, not line terminators)
            std::vector<std::vector<Token>> args;
            std::vector<Token> currentArg;
            int parenDepth = 1;
            size_t j = argStart + 1;  // Start after '('

            while (j < tokens.size() && parenDepth > 0) {
              const Token &argTok = tokens[j];
              if (argTok.kind == TokenKind::NEWLINE) {
                // Skip newlines inside macro arguments
              } else if (argTok.atPunct(Punct::LPAREN)) {
                parenDepth++;
                currentArg.push_back(argTok);
              } else if (argTok.atPunct(Punct::RPAREN)) {
                parenDepth--;
                if (parenDepth > 0) currentArg.push_back(argTok);
              } else if (argTok.atPunct(Punct::COMMA) && parenDepth == 1) {
                // Argument separator at top level
                args.push_back(std::move(currentArg));
                currentArg.clear();
              } else {
                currentArg.push_back(argTok);
              }
              j++;
            }
            // Push final argument (if any tokens or if we had args)
            if (!currentArg.empty() || !args.empty()) {
              args.push_back(std::move(currentArg));
            }

            // Build parameter-to-argument maps
            // paramMap: expanded args (for normal substitution)
            // rawParamMap: unexpanded args (for # stringification)
            std::unordered_map<std::string_view, std::vector<Token>> paramMap;
            std::unordered_map<std::string_view, std::vector<Token>> rawParamMap;
            for (size_t p = 0; p < m.params.size() && p < args.size(); ++p) {
              rawParamMap[m.params[p]] = args[p];
              paramMap[m.params[p]] = self(self, args[p], hideset);
            }
            if (m.isVariadic) {
              std::vector<Token> vaRaw, vaArgs;
              for (size_t p = m.params.size(); p < args.size(); ++p) {
                if (p > m.params.size()) {
                  Token comma;
                  comma.kind = TokenKind::PUNCT;
                  comma.text = *intern(",");
                  comma.value.punct = Punct::COMMA;
                  vaRaw.push_back(comma);
                  vaArgs.push_back(comma);
                }
                vaRaw.insert(vaRaw.end(), args[p].begin(), args[p].end());
                auto expanded = self(self, args[p], hideset);
                vaArgs.insert(vaArgs.end(), expanded.begin(), expanded.end());
              }
              rawParamMap["__VA_ARGS__"] = vaRaw;
              paramMap["__VA_ARGS__"] = vaArgs;
              // GNU extension: named variadic param also gets all variadic args
              if (!m.variadicName.empty()) {
                rawParamMap[m.variadicName] = std::move(vaRaw);
                paramMap[m.variadicName] = std::move(vaArgs);
              }
            }

            // Helper: check if position ri is adjacent to ## in replacement list
            auto isAdjacentToPaste = [&](size_t ri) -> bool {
              if (ri > 0 && m.replacement[ri - 1].atPunct(Punct::HASH_HASH)) return true;
              if (ri + 1 < m.replacement.size() && m.replacement[ri + 1].atPunct(Punct::HASH_HASH)) return true;
              return false;
            };

            // Substitute parameters in replacement list
            std::vector<Token> substituted;
            for (size_t ri = 0; ri < m.replacement.size(); ++ri) {
              const Token &repTok = m.replacement[ri];

              // Handle # stringification operator
              if (repTok.atPunct(Punct::HASH) && ri + 1 < m.replacement.size() &&
                  m.replacement[ri + 1].kind == TokenKind::IDENT &&
                  rawParamMap.count(m.replacement[ri + 1].text)) {
                ri++;  // skip past the parameter name
                const auto &rawTokens = rawParamMap[m.replacement[ri].text];
                std::string str = "\"";
                for (size_t ai = 0; ai < rawTokens.size(); ++ai) {
                  if (ai > 0 && rawTokens[ai].flags.hasSpace) str += ' ';
                  for (char c : rawTokens[ai].text) {
                    if (c == '"' || c == '\\') str += '\\';
                    str += c;
                  }
                }
                str += '"';
                Token strTok = repTok;
                strTok.kind = TokenKind::STRING;
                strTok.text = *intern(std::move(str));
                substituted.push_back(strTok);
                continue;
              }

              if (repTok.kind == TokenKind::IDENT && paramMap.count(repTok.text)) {
                // Use raw (unexpanded) args when adjacent to ##
                bool adjPaste = isAdjacentToPaste(ri);
                const auto &map = adjPaste ? rawParamMap : paramMap;
                const auto &argTokens = map.at(repTok.text);
                if (argTokens.empty() && adjPaste) {
                  // C standard §6.10.3.3: empty argument with ## produces placemarker
                  Token pm = repTok;
                  pm.kind = TokenKind::PLACEMARKER;
                  pm.text = "";
                  substituted.push_back(pm);
                } else {
                  substituted.insert(substituted.end(), argTokens.begin(), argTokens.end());
                }
              } else {
                substituted.push_back(repTok);
              }
            }

            // Token pasting (##) pass
            for (size_t si = 0; si < substituted.size();) {
              if (substituted[si].atPunct(Punct::HASH_HASH) && si > 0 && si + 1 < substituted.size()) {
                Token &left = substituted[si - 1];
                Token &right = substituted[si + 1];
                if (left.kind == TokenKind::PLACEMARKER && right.kind == TokenKind::PLACEMARKER) {
                  // Both empty: keep one placemarker
                  substituted.erase(substituted.begin() + si, substituted.begin() + si + 2);
                } else if (left.kind == TokenKind::PLACEMARKER) {
                  // Left empty: result is right token
                  substituted[si - 1] = right;
                  substituted.erase(substituted.begin() + si, substituted.begin() + si + 2);
                } else if (right.kind == TokenKind::PLACEMARKER) {
                  // Right empty: result is left token (already in place)
                  substituted.erase(substituted.begin() + si, substituted.begin() + si + 2);
                } else {
                  std::string merged = std::string(left.text) + std::string(right.text);
                  Symbol mergedSym = intern(merged);
                  auto lexed = lex(left.filename, *mergedSym);
                  if (!lexed.tokens.empty() && lexed.tokens[0].kind != TokenKind::EOS) {
                    Token newTok = lexed.tokens[0];
                    newTok.filename = left.filename;
                    newTok.line = left.line;
                    newTok.column = left.column;
                    substituted[si - 1] = newTok;
                    substituted.erase(substituted.begin() + si, substituted.begin() + si + 2);
                  } else {
                    si++;
                  }
                }
              } else {
                si++;
              }
            }

            // Remove surviving placemarker tokens
            substituted.erase(std::remove_if(substituted.begin(), substituted.end(),
                                  [](const Token &t) { return t.kind == TokenKind::PLACEMARKER; }),
                substituted.end());

            // Update replacement token locations to invocation site
            for (auto &tok : substituted) {
              tok.filename = t.filename;
              tok.line = t.line;
              tok.column = t.column;
            }

            // Recursively expand with macro in hideset
            Hideset nextHideset = hideset;
            nextHideset.insert(t.text);
            std::vector<Token> result = self(self, substituted, nextHideset);
            expanded.insert(expanded.end(), result.begin(), result.end());

            // Advance past the macro invocation
            i = j - 1;  // -1 because loop will increment
          } else {
            // Function-like macro not followed by '(' - don't expand
            expanded.push_back(t);
          }
        }
      } else {
        expanded.push_back(t);
      }
    }
    return expanded;
  };

  // --- 3. PRATT-STYLE EXPRESSION EVALUATOR ---
  auto evaluateExpression = [&](std::span<Token> line) -> i64 {
    size_t pos = 0;
    auto peek = [&]() -> const Token * { return (pos < line.size()) ? &line[pos] : nullptr; };
    auto consume = [&]() -> const Token * { return &line[pos++]; };

    auto getPrecedence = [](const Token *t) -> int {
      if (!t || t->kind != TokenKind::PUNCT) return 0;
      if (t->atPunct(Punct::QMARK)) return 1;
      if (t->atPunct(Punct::PIPEPIPE)) return 2;
      if (t->atPunct(Punct::AMPAMP)) return 3;
      if (t->atPunct(Punct::PIPE)) return 4;
      if (t->atPunct(Punct::CARET)) return 5;
      if (t->atPunct(Punct::AMP)) return 6;
      if (t->atPunct(Punct::EQEQ) || t->atPunct(Punct::NE)) return 7;
      if (t->atPunct(Punct::LT) || t->atPunct(Punct::GT) || t->atPunct(Punct::LE) || t->atPunct(Punct::GE)) return 8;
      if (t->atPunct(Punct::LSHIFT) || t->atPunct(Punct::RSHIFT)) return 9;
      if (t->atPunct(Punct::PLUS) || t->atPunct(Punct::MINUS)) return 10;
      if (t->atPunct(Punct::STAR) || t->atPunct(Punct::SLASH) || t->atPunct(Punct::PCT)) return 11;
      return 0;
    };

    std::function<i64(int)> parseBinary = [&](int minPrec) -> i64 {
      const Token *t = consume();
      if (!t) return 0;

      i64 left = 0;
      // Primary / Unary
      if (t->kind == TokenKind::PP_NUMBER) {
        try {
          left = std::stoll(std::string(t->text), nullptr, 0);
        } catch (...) {
          left = 0;
        }
      } else if (t->atPunct(Punct::BANG)) {
        left = !parseBinary(12);
      } else if (t->atPunct(Punct::MINUS)) {
        left = -parseBinary(12);
      } else if (t->atPunct(Punct::PLUS)) {
        left = parseBinary(12);
      } else if (t->atPunct(Punct::TILDE)) {
        left = ~parseBinary(12);
      } else if (t->atPunct(Punct::LPAREN)) {
        left = parseBinary(0);
        if (auto next = peek(); next && next->atPunct(Punct::RPAREN)) consume();
      } else if (t->kind == TokenKind::CHAR) {
        // Character constant in #if — parse value (C99 §6.10.1)
        const char *s = t->text.data();
        if (*s == 'L' || *s == 'U' || *s == 'u') s++;
        s++;  // skip opening '
        const char *e = t->text.data() + t->text.size() - 1;  // before closing '
        left = (s < e) ? static_cast<i64>(unescape(s, e)) : 0;
      } else if (t->kind == TokenKind::IDENT) {
        left = 0;  // Standard: remaining idents after expansion are 0
      }

      while (true) {
        const Token *op = peek();
        int prec = getPrecedence(op);
        if (prec <= minPrec) break;

        consume();  // move past the operator

        if (op->atPunct(Punct::QMARK)) {
          i64 thenVal = parseBinary(0);
          if (auto next = peek(); next && next->atPunct(Punct::COLON)) consume();
          i64 elseVal = parseBinary(prec);
          left = left ? thenVal : elseVal;
          continue;
        }

        i64 right = parseBinary(prec);

        if (op->atPunct(Punct::PIPEPIPE)) left = left || right;
        else if (op->atPunct(Punct::AMPAMP)) left = left && right;
        else if (op->atPunct(Punct::PIPE)) left = left | right;
        else if (op->atPunct(Punct::CARET)) left = left ^ right;
        else if (op->atPunct(Punct::AMP)) left = left & right;
        else if (op->atPunct(Punct::EQEQ)) left = (left == right);
        else if (op->atPunct(Punct::NE)) left = (left != right);
        else if (op->atPunct(Punct::LT)) left = (left < right);
        else if (op->atPunct(Punct::GT)) left = (left > right);
        else if (op->atPunct(Punct::LE)) left = (left <= right);
        else if (op->atPunct(Punct::GE)) left = (left >= right);
        else if (op->atPunct(Punct::LSHIFT)) left = left << right;
        else if (op->atPunct(Punct::RSHIFT)) left = left >> right;
        else if (op->atPunct(Punct::PLUS)) left += right;
        else if (op->atPunct(Punct::MINUS)) left -= right;
        else if (op->atPunct(Punct::STAR)) left *= right;
        else if (op->atPunct(Punct::SLASH)) left = (right != 0) ? left / right : 0;
        else if (op->atPunct(Punct::PCT)) left = (right != 0) ? left % right : 0;
      }
      return left;
    };

    return parseBinary(0);
  };

  // --- 4. INCLUDE RESOLUTION ---
  struct IncludeResult {
    LexResult lexResult;
    Symbol resolvedFile;
  };
  auto resolveAndLex = [&](std::string_view target,
                           Symbol currentFile) -> std::optional<IncludeResult> {
    std::string currentPath = *currentFile;
    size_t lastSlash = currentPath.find_last_of("/\\");
    std::string baseDir =
        (lastSlash != std::string::npos) ? currentPath.substr(0, lastSlash + 1) : "";

    std::vector<std::string> searchPaths = {baseDir + std::string(target)};
    for (const auto &p : ppRegistry.includePaths) {
      std::string path = p;
      if (!path.empty() && path.back() != '/' && path.back() != '\\') path += "/";
      searchPaths.push_back(path + std::string(target));
    }

    for (const auto &fullPath : searchPaths) {
      if (FILE *f = fopen(fullPath.c_str(), "r")) {
        fclose(f);
        auto content = ppRegistry.loadFile(fullPath);
        Symbol resolved = intern(fullPath);
        return IncludeResult{lex(resolved, content), resolved};
      }
    }

    // Fallback to standard library files
    if (auto it = standardLibraryHeaderFiles.find(target); it != standardLibraryHeaderFiles.end()) {
      Symbol resolved = intern(std::string(target));
      return IncludeResult{lex(resolved, it->second), resolved};
    }

    return std::nullopt;
  };

  // Per C standard §6.10.3.4, macro expansion results are rescanned "along
  // with all subsequent preprocessing tokens of the source file." If the
  // result ends with a function-like macro name, collect its arguments from
  // subsequent tokens and re-expand.
  auto rescanTrailingMacros = [&](std::vector<Token> &expanded, PPState &state) {
    while (!expanded.empty() && !state.atEnd() && state.peek().atPunct(Punct::LPAREN)) {
      const Token &last = expanded.back();
      if (last.kind != TokenKind::IDENT || !macros.count(last.text) ||
          !macros[last.text].isFunctionLike)
        break;
      std::vector<Token> combined(expanded.begin(), expanded.end());
      combined.push_back(state.consume());  // '('
      int depth = 1;
      while (!state.atEnd() && depth > 0) {
        if (state.peek().atPunct(Punct::LPAREN)) depth++;
        else if (state.peek().atPunct(Punct::RPAREN)) depth--;
        combined.push_back(state.consume());
      }
      expanded = expand(expand, combined, {});
    }
  };

  // --- 5. CORE PROCESSING ---
  auto processTokens = [&](auto &self, PPState &state) -> void {
    i32 lineOffset = 0;
    Symbol fileOverride = nullptr;
    auto emitToken = [&](Token tok) {
      if (lineOffset || fileOverride) {
        tok.line = static_cast<u32>(static_cast<i32>(tok.line) + lineOffset);
        if (fileOverride) tok.filename = fileOverride;
      }
      output.push_back(tok);
    };
    while (!state.atEnd()) {
      const Token &t = state.peek();

      if (t.atPunct(Punct::HASH) && t.flags.atBol) {
        state.consume();
        if (state.atEnd() || state.peek().kind == TokenKind::NEWLINE) continue;

        Token dir = state.consume();

        if (dir.atIdent("ifdef") || dir.atIdent("ifndef") || dir.atIdent("if")) {
          bool condition = false;
          if (dir.atIdent("ifdef") || dir.atIdent("ifndef")) {
            if (!state.atEnd() && state.peek().kind == TokenKind::IDENT) {
              Token name = state.consume();
              condition = macros.count(name.text);
              if (dir.atIdent("ifndef")) condition = !condition;
            }
          } else {  // #if
            std::vector<Token> lineTokens;
            while (!state.atEnd() && state.peek().kind != TokenKind::NEWLINE) {
              lineTokens.push_back(state.consume());
            }
            std::vector<Token> expanded = expand(expand, lineTokens, {});
            condition = evaluateExpression(expanded) != 0;
          }

          bool parentActive = isActive();
          ifStack.push_back({parentActive && condition, condition});
        } else if (dir.atIdent("elif")) {
          if (ifStack.empty()) {
            result.errors.push_back({"#elif without #if", state.currentFile, dir.line});
          } else {
            std::vector<Token> lineTokens;
            while (!state.atEnd() && state.peek().kind != TokenKind::NEWLINE) {
              lineTokens.push_back(state.consume());
            }
            std::vector<Token> expanded = expand(expand, lineTokens, {});
            bool condition = evaluateExpression(expanded) != 0;

            IfLevel &top = ifStack.back();
            bool parentActive = (ifStack.size() > 1) ? ifStack[ifStack.size() - 2].active : true;
            top.active = parentActive && !top.anyBranchRan && condition;
            if (top.active) top.anyBranchRan = true;
          }
        } else if (dir.atIdent("else")) {
          if (ifStack.empty()) {
            result.errors.push_back({"#else without #if", state.currentFile, dir.line});
          } else {
            IfLevel &top = ifStack.back();
            bool parentActive = (ifStack.size() > 1) ? ifStack[ifStack.size() - 2].active : true;
            top.active = parentActive && !top.anyBranchRan;
            top.anyBranchRan = true;
          }
        } else if (dir.atIdent("endif")) {
          if (ifStack.empty()) {
            result.errors.push_back({"#endif without #if", state.currentFile, dir.line});
          } else {
            ifStack.pop_back();
          }
        } else if (isActive()) {
          if (dir.atIdent("define")) {
            if (!state.atEnd() && state.peek().kind == TokenKind::IDENT) {
              Token nameTok = state.consume();
              Macro m;
              if (!state.atEnd() && state.peek().atPunct(Punct::LPAREN) && !state.peek().flags.hasSpace) {
                m.isFunctionLike = true;
                state.consume();  // '('
                while (!state.atEnd() && !state.peek().atPunct(Punct::RPAREN)) {
                  if (state.peek().atPunct(Punct::ELLIPSIS)) {
                    m.isVariadic = true;
                    state.consume();
                    break;
                  }
                  if (state.peek().kind == TokenKind::IDENT) {
                    auto name = state.consume().text;
                    // GNU extension: "name..." is a named variadic param
                    if (!state.atEnd() && state.peek().atPunct(Punct::ELLIPSIS)) {
                      m.isVariadic = true;
                      m.variadicName = name;
                      state.consume();  // consume "..."
                      break;
                    }
                    m.params.push_back(name);
                  }
                  if (!state.atEnd() && state.peek().atPunct(Punct::COMMA)) state.consume();
                }
                if (!state.atEnd()) state.consume();  // ')'
              }
              while (!state.atEnd() && state.peek().kind != TokenKind::NEWLINE)
                m.replacement.push_back(state.consume());
              macros[nameTok.text] = std::move(m);
            }
          } else if (dir.atIdent("undef")) {
            if (!state.atEnd() && state.peek().kind == TokenKind::IDENT) {
              Token name = state.consume();
              macros.erase(name.text);
            }
          } else if (dir.atIdent("include")) {
            if (!state.atEnd()) {
              // Collect all tokens on the #include line
              std::vector<Token> lineTokens;
              while (!state.atEnd() && state.peek().kind != TokenKind::NEWLINE) {
                lineTokens.push_back(state.consume());
              }
              // If the first token isn't a string or '<', try macro expansion
              // (computed include, e.g. #include MYHEADER)
              if (!lineTokens.empty() && lineTokens[0].kind != TokenKind::STRING &&
                  !lineTokens[0].atPunct(Punct::LT)) {
                lineTokens = expand(expand, lineTokens, {});
              }
              std::string rawPathStorage;
              std::string_view rawPath;
              if (lineTokens.empty()) {
                result.errors.push_back({"Empty #include directive", state.currentFile, dir.line});
                continue;
              } else if (lineTokens[0].kind == TokenKind::STRING) {
                std::string_view sv = lineTokens[0].text;
                rawPath = sv.substr(1, sv.size() - 2);
              } else if (lineTokens[0].atPunct(Punct::LT)) {
                // Reconstruct angle-bracket path from expanded tokens
                for (size_t ti = 1; ti < lineTokens.size(); ++ti) {
                  if (lineTokens[ti].atPunct(Punct::GT)) break;
                  rawPathStorage += std::string(lineTokens[ti].text);
                }
                rawPath = rawPathStorage;
              } else {
                result.errors.push_back(
                    {"Expected string or <...> in #include", state.currentFile, dir.line});
                continue;
              }
              auto includeRes = resolveAndLex(rawPath, state.currentFile);
              if (!includeRes) {
                result.errors.push_back({"Could not find include file: " + std::string(rawPath),
                    state.currentFile, dir.line});
              } else if (ppRegistry.onceGuards.count(includeRes->resolvedFile)) {
                // #pragma once: skip file entirely
              } else {
                bool circular = false;
                for (auto s : includeStack)
                  if (s == includeRes->resolvedFile) circular = true;

                if (circular) {
                  if (warningFlags.circularDependency) {
                    result.warnings.push_back(
                        {"Circular include detected", state.currentFile, dir.line});
                  }
                } else {
                  includeStack.push_back(includeRes->resolvedFile);
                  PPState nextState{includeRes->resolvedFile, includeRes->lexResult.tokens.data(),
                      includeRes->lexResult.tokens.data() + includeRes->lexResult.tokens.size()};
                  self(self, nextState);
                  includeStack.pop_back();
                }
              }
            }
          } else if (dir.atIdent("warning") || dir.atIdent("error")) {
            std::string msg = "";
            while (!state.atEnd() && state.peek().kind != TokenKind::NEWLINE) {
              if (!msg.empty()) msg += " ";
              msg += state.consume().text;
            }
            if (dir.atIdent("error")) {
              result.errors.push_back({msg, state.currentFile, dir.line});
            } else {
              fprintf(stderr, "Warning in %s at line %u: %s\n",
                  state.currentFile->c_str(), dir.line, msg.c_str());
            }
          } else if (dir.atIdent("line")) {
            // C99 #line directive: #line N or #line N "filename"
            if (!state.atEnd() && state.peek().kind == TokenKind::PP_NUMBER) {
              Token numTok = state.consume();
              i32 newLine =
                  static_cast<i32>(std::strtol(std::string(numTok.text).c_str(), nullptr, 10));
              // Next source line should be newLine, so offset = newLine - (current line + 1)
              lineOffset = newLine - static_cast<i32>(dir.line) - 1;
              if (!state.atEnd() && state.peek().kind == TokenKind::STRING) {
                std::string_view sv = state.consume().text;
                if (sv.size() >= 2 && sv.front() == '"' && sv.back() == '"') {
                  fileOverride = intern(std::string(sv.substr(1, sv.size() - 2)));
                }
              }
            }
          } else if (dir.atIdent("pragma")) {
            if (!state.atEnd() && state.peek().atIdent("once")) {
              state.consume();  // consume 'once'
              ppRegistry.onceGuards.insert(state.currentFile);
            } else if (!state.atEnd() && state.peek().atIdent("debug")) {
              state.consume();  // consume 'debug'

              std::string finalMessage = "";
              while (!state.atEnd() && state.peek().kind != TokenKind::NEWLINE) {
                // Look for the #( sequence
                if (state.peek().atPunct(Punct::HASH)) {
                  const Token &hash = state.consume();
                  if (!state.atEnd() && state.peek().atPunct(Punct::LPAREN)) {
                    state.consume();  // consume '('

                    // 1. Collect tokens until matching ')'
                    std::vector<Token> exprTokens;
                    int depth = 1;
                    while (!state.atEnd() && depth > 0) {
                      if (state.peek().kind == TokenKind::NEWLINE) break;
                      if (state.peek().atPunct(Punct::LPAREN)) depth++;
                      if (state.peek().atPunct(Punct::RPAREN)) depth--;

                      if (depth > 0) exprTokens.push_back(state.consume());
                      else state.consume();  // consume the closing ')'
                    }

                    // 2. Expand and Evaluate
                    std::vector<Token> expanded = expand(expand, exprTokens, {});
                    i64 resultVal = evaluateExpression(expanded);
                    finalMessage += std::to_string(resultVal);
                    continue;
                  } else {
                    finalMessage += hash.text;
                    continue;
                  }
                }

                // Append literal token text
                finalMessage += state.consume().text;
                finalMessage += " ";
              }

              fprintf(stderr, "PRAGMA DEBUG [%s:%u]: %s\n", state.currentFile->c_str(), dir.line,
                  finalMessage.c_str());
            } else if (!state.atEnd() && state.peek().atIdent("message")) {
              // ... existing pragma message logic ...
            } else if (!state.atEnd() && state.peek().atIdent("custom_section")) {
              state.consume();  // consume 'custom_section'
              if (!state.atEnd() && state.peek().atPunct(Punct::LPAREN)) {
                state.consume();  // consume '('
                if (!state.atEnd() && state.peek().kind == TokenKind::STRING) {
                  std::string_view nameSv = state.consume().text;
                  // Strip quotes
                  if (nameSv.size() >= 2 && nameSv.front() == '"' && nameSv.back() == '"') {
                    nameSv = nameSv.substr(1, nameSv.size() - 2);
                  }
                  std::string sectionName = "com.mtots.c." + std::string(nameSv);
                  if (!state.atEnd() && state.peek().atPunct(Punct::COMMA)) {
                    state.consume();  // consume ','
                    if (!state.atEnd() && state.peek().kind == TokenKind::STRING) {
                      std::string_view contentSv = state.consume().text;
                      if (contentSv.size() >= 2 && contentSv.front() == '"' && contentSv.back() == '"') {
                        contentSv = contentSv.substr(1, contentSv.size() - 2);
                      }
                      ppRegistry.customSections.push_back({sectionName, std::string(contentSv)});
                    }
                  }
                  // consume closing ')'
                  if (!state.atEnd() && state.peek().atPunct(Punct::RPAREN)) state.consume();
                }
              }
            }
          }
        }

        // Skip until the end of the line to finish processing the directive
        while (!state.atEnd() && state.peek().kind != TokenKind::NEWLINE) state.consume();
        if (!state.atEnd()) state.consume();  // consume NEWLINE
        continue;
      }

      if (isActive()) {
        // Handle __FILE__ / __LINE__ / __DATE__ / __TIME__ predefined macros
        if (t.atIdent("__LINE__") || t.atIdent("__FILE__") ||
            t.atIdent("__DATE__") || t.atIdent("__TIME__")) {
          Token tok = state.consume();
          // Apply #line adjustments before expanding so __LINE__/__FILE__ reflect them
          if (lineOffset) tok.line = static_cast<u32>(static_cast<i32>(tok.line) + lineOffset);
          if (fileOverride) tok.filename = fileOverride;
          tryExpandBuiltinMacro(tok);
          output.push_back(tok);
          continue;
        }
        // C99 _Pragma operator: _Pragma("once") is equivalent to #pragma once
        if (t.atIdent("_Pragma") && !state.atEnd()) {
          state.consume();  // consume '_Pragma'
          if (state.peek().atPunct(Punct::LPAREN)) {
            state.consume();  // consume '('
            if (!state.atEnd() && state.peek().kind == TokenKind::STRING) {
              std::string content(state.consume().text);
              // Destring: remove surrounding quotes and unescape
              if (content.size() >= 2 && content.front() == '"' && content.back() == '"') {
                content = content.substr(1, content.size() - 2);
              }
              if (!state.atEnd() && state.peek().atPunct(Punct::RPAREN)) {
                state.consume();  // consume ')'
              }
              // Process the pragma content
              if (content == "once") {
                ppRegistry.onceGuards.insert(state.currentFile);
              }
              // Other pragmas silently ignored (matches #pragma behavior)
            }
          }
          continue;
        }
        if (t.kind == TokenKind::IDENT && macros.count(t.text)) {
          const auto &m = macros[t.text];
          if (m.isFunctionLike) {
            // Collect macro name + arguments for function-like macro
            std::vector<Token> invocation;
            invocation.push_back(state.consume());  // macro name

            // Check for '(' - if not present, don't expand
            if (!state.atEnd() && state.peek().atPunct(Punct::LPAREN)) {
              invocation.push_back(state.consume());  // '('
              int parenDepth = 1;
              while (!state.atEnd() && parenDepth > 0) {
                const Token &argTok = state.peek();
                if (argTok.atPunct(Punct::LPAREN)) parenDepth++;
                else if (argTok.atPunct(Punct::RPAREN)) parenDepth--;
                invocation.push_back(state.consume());
              }
              // Now expand with all tokens
              std::vector<Token> expanded = expand(expand, invocation, {});
              rescanTrailingMacros(expanded, state);
              for (const auto &et : expanded) emitToken(et);
            } else {
              // Function-like macro not followed by '(' - output as-is
              emitToken(invocation[0]);
            }
          } else {
            // Object-like macro: consume BEFORE rescan so state points past
            // the macro name (e.g. to '(' if the expansion yields a
            // function-like macro name that needs trailing arguments).
            state.consume();
            std::vector<Token> expanded = expand(expand, {&t, 1}, {});
            rescanTrailingMacros(expanded, state);
            for (const auto &et : expanded) emitToken(et);
          }
        } else if (t.kind != TokenKind::NEWLINE) {
          emitToken(state.consume());
        } else {
          state.consume();
        }
      } else {
        state.consume();
      }
    }
  };

  PPState initialState{filename, initialTokens.data(), initialTokens.data() + initialTokens.size()};
  processTokens(processTokens, initialState);

  result.tokens = std::move(output);
  return result;
}

i32 unescape(const char *&curr, const char *end) {
  auto isxdigit = [](char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  };
  auto hexVal = [](char c) -> u32 {
    if (c >= '0' && c <= '9') return static_cast<i32>(c - '0');
    if (c >= 'a' && c <= 'f') return static_cast<i32>(10 + (c - 'a'));
    if (c >= 'A' && c <= 'F') return static_cast<i32>(10 + (c - 'A'));
    return 0;
  };

  if (curr >= end) return 0;

  if (*curr == '\\') {
    curr++;  // skip backslash
    if (curr >= end) return 0;

    switch (*curr) {
      case 'n': curr++; return '\n';
      case 't': curr++; return '\t';
      case 'r': curr++; return '\r';
      case 'b': curr++; return '\b';
      case 'f': curr++; return '\f';
      case 'v': curr++; return '\v';
      case 'a': curr++; return '\a';
      case '\\': curr++; return '\\';
      case '\'': curr++; return '\'';
      case '\"': curr++; return '\"';
      case 'x': {  // Hex: \xHH...
        // The greedy nature is per C11 standard
        curr++;
        u32 val = 0;
        while (curr < end && isxdigit(*curr)) {
          val = (val << 4) | hexVal(*curr++);
        }
        return static_cast<i32>(val);
      }
      case 'u':    // \uXXXX
      case 'U': {  // \UXXXXXXXX
        int len = (*curr == 'u') ? 4 : 8;
        curr++;
        u32 val = 0;
        for (int i = 0; i < len && curr < end && isxdigit(*curr); ++i) {
          val = (val << 4) | hexVal(*curr++);
        }
        return static_cast<i32>(val);
      }
      default:
        // Octal: \0, \012, \377, etc.
        if (*curr >= '0' && *curr <= '7') {
          u32 val = static_cast<u32>(*curr++ - '0');
          for (int i = 0; i < 2 && curr < end && *curr >= '0' && *curr <= '7'; ++i) {
            val = (val << 3) | static_cast<u32>(*curr++ - '0');
          }
          return static_cast<i32>(val);
        }
        return *curr++;  // Fallback for unknown escapes
    }
  }

  // Raw byte (handles UTF-8 source one byte at a time)
  return static_cast<unsigned char>(*curr++);
}

// Decode one UTF-8 codepoint from a byte sequence, advancing the pointer.
i32 decodeUtf8(const char *&curr, const char *end) {
  u8 b0 = static_cast<u8>(*curr++);
  if (b0 < 0x80) return b0;
  if ((b0 & 0xE0) == 0xC0 && curr < end) {
    u8 b1 = static_cast<u8>(*curr++);
    return ((b0 & 0x1F) << 6) | (b1 & 0x3F);
  }
  if ((b0 & 0xF0) == 0xE0 && curr + 1 < end) {
    u8 b1 = static_cast<u8>(*curr++);
    u8 b2 = static_cast<u8>(*curr++);
    return ((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F);
  }
  if ((b0 & 0xF8) == 0xF0 && curr + 2 < end) {
    u8 b1 = static_cast<u8>(*curr++);
    u8 b2 = static_cast<u8>(*curr++);
    u8 b3 = static_cast<u8>(*curr++);
    return ((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F);
  }
  return b0;  // Fallback for malformed sequences
}

// Encode a Unicode codepoint as UTF-8, appending to output.
void encodeUtf8(i32 cp, Buffer &out) {
  u32 u = static_cast<u32>(cp);
  if (u <= 0x7F) {
    out.push_back(static_cast<u8>(u));
  } else if (u <= 0x7FF) {
    out.push_back(static_cast<u8>(0xC0 | (u >> 6)));
    out.push_back(static_cast<u8>(0x80 | (u & 0x3F)));
  } else if (u <= 0xFFFF) {
    out.push_back(static_cast<u8>(0xE0 | (u >> 12)));
    out.push_back(static_cast<u8>(0x80 | ((u >> 6) & 0x3F)));
    out.push_back(static_cast<u8>(0x80 | (u & 0x3F)));
  } else {
    out.push_back(static_cast<u8>(0xF0 | (u >> 18)));
    out.push_back(static_cast<u8>(0x80 | ((u >> 12) & 0x3F)));
    out.push_back(static_cast<u8>(0x80 | ((u >> 6) & 0x3F)));
    out.push_back(static_cast<u8>(0x80 | (u & 0x3F)));
  }
}

// Encode a Unicode codepoint as UTF-16LE, appending to output.
void encodeUtf16LE(i32 cp, Buffer &out) {
  if (cp <= 0xFFFF) {
    u16 u = static_cast<u16>(cp);
    out.push_back(static_cast<u8>(u & 0xFF));
    out.push_back(static_cast<u8>((u >> 8) & 0xFF));
  } else {
    // Surrogate pair
    u32 adj = static_cast<u32>(cp) - 0x10000;
    u16 hi = static_cast<u16>(0xD800 + (adj >> 10));
    u16 lo = static_cast<u16>(0xDC00 + (adj & 0x3FF));
    out.push_back(static_cast<u8>(hi & 0xFF));
    out.push_back(static_cast<u8>((hi >> 8) & 0xFF));
    out.push_back(static_cast<u8>(lo & 0xFF));
    out.push_back(static_cast<u8>((lo >> 8) & 0xFF));
  }
}

// Encode a Unicode codepoint as UTF-32LE, appending to output.
void encodeUtf32LE(i32 cp, Buffer &out) {
  u32 u = static_cast<u32>(cp);
  out.push_back(static_cast<u8>(u & 0xFF));
  out.push_back(static_cast<u8>((u >> 8) & 0xFF));
  out.push_back(static_cast<u8>((u >> 16) & 0xFF));
  out.push_back(static_cast<u8>((u >> 24) & 0xFF));
}

// Unescape one character/codepoint from a string literal.
// For escape sequences (\n, \uXXXX, etc.), delegates to unescape().
// For raw source bytes, decodes a full UTF-8 codepoint.
// Use this when you need codepoints (wide strings), not raw bytes.
i32 unescapeCodepoint(const char *&ptr, const char *end) {
  if (*ptr == '\\') return unescape(ptr, end);
  return decodeUtf8(ptr, end);
}

// Helper to provide a fast lookup for keywords
const std::unordered_map<std::string_view, Keyword> &getKeywordMap() {
  static const std::unordered_map<std::string_view, Keyword> map = {{"auto", Keyword::AUTO},
      {"break", Keyword::BREAK}, {"case", Keyword::CASE}, {"char", Keyword::CHAR},
      {"const", Keyword::CONST}, {"continue", Keyword::CONTINUE}, {"default", Keyword::DEFAULT},
      {"do", Keyword::DO}, {"double", Keyword::DOUBLE}, {"else", Keyword::ELSE},
      {"enum", Keyword::ENUM}, {"extern", Keyword::EXTERN}, {"float", Keyword::FLOAT},
      {"for", Keyword::FOR}, {"goto", Keyword::GOTO}, {"if", Keyword::IF}, {"int", Keyword::INT},
      {"long", Keyword::LONG}, {"register", Keyword::REGISTER}, {"return", Keyword::RETURN},
      {"short", Keyword::SHORT}, {"signed", Keyword::SIGNED}, {"sizeof", Keyword::SIZEOF},
      {"static", Keyword::STATIC}, {"struct", Keyword::STRUCT}, {"switch", Keyword::SWITCH},
      {"typedef", Keyword::TYPEDEF}, {"union", Keyword::UNION}, {"unsigned", Keyword::UNSIGNED},
      {"void", Keyword::VOID}, {"volatile", Keyword::VOLATILE}, {"while", Keyword::WHILE},
      {"inline", Keyword::INLINE}, {"restrict", Keyword::RESTRICT}, {"_Generic", Keyword::GENERIC},
      {"_Static_assert", Keyword::STATIC_ASSERT}, {"_Noreturn", Keyword::NORETURN},
      {"_Alignof", Keyword::ALIGNOF}, {"_Alignas", Keyword::ALIGNAS},
      {"_Thread_local", Keyword::THREAD_LOCAL},
      {"_Bool", Keyword::BOOL}, {"__import", Keyword::X_IMPORT},
      {"__builtin_va_start", Keyword::X_BUILTIN_VA_START},
      {"__builtin_va_arg", Keyword::X_BUILTIN_VA_ARG},
      {"__builtin_va_end", Keyword::X_BUILTIN_VA_END},
      {"__builtin_va_copy", Keyword::X_BUILTIN_VA_COPY},
      {"__builtin_unreachable", Keyword::X_BUILTIN_UNREACHABLE},
      {"__builtin_abort", Keyword::X_BUILTIN_ABORT},
      {"__builtin_expect", Keyword::X_BUILTIN_EXPECT},
      {"__memory_size", Keyword::X_MEMORY_SIZE},
      {"__memory_grow", Keyword::X_MEMORY_GROW}, {"__builtin", Keyword::X_BUILTIN},
      {"__require_source", Keyword::X_REQUIRE_SOURCE}, {"__export", Keyword::X_EXPORT},
      {"__wasm", Keyword::X_WASM},
      {"__exception", Keyword::X_EXCEPTION}, {"__try", Keyword::X_TRY},
      {"__catch", Keyword::X_CATCH}, {"__throw", Keyword::X_THROW},
      {"__minstack", Keyword::X_MINSTACK},
      {"__attribute__", Keyword::X_ATTRIBUTE},
      {"__attribute", Keyword::X_ATTRIBUTE}};
  return map;
}

LexResult tokenize(Symbol filename, std::string_view source, PPRegistry &ppRegistry) {
  auto lexResult = lex(filename, source);
  if (!lexResult.errors.empty()) {
    return lexResult;
  }

  // 1. Run the Preprocessor
  lexResult = preprocess(filename, lexResult.tokens, ppRegistry);

  const auto &keywordMap = getKeywordMap();

  // 2. Final Post-Processing Pass
  std::erase_if(lexResult.tokens, [](const Token &t) { return t.kind == TokenKind::NEWLINE; });
  for (auto &t : lexResult.tokens) {
    // (A) IDENT -> KEYWORD
    if (t.kind == TokenKind::IDENT) {
      auto it = keywordMap.find(t.text);
      if (it != keywordMap.end()) {
        t.kind = TokenKind::KEYWORD;
        t.value.keyword = it->second;
      }
    }
    // (B) PP_NUMBER -> INT or FLOAT
    else if (t.kind == TokenKind::PP_NUMBER) {
      // Check if hex first (0x or 0X prefix)
      bool isHex = t.text.size() >= 2 && t.text[0] == '0' && (t.text[1] == 'x' || t.text[1] == 'X');
      // Hex floats use 'p'/'P' for exponent; decimal floats use 'e'/'E'
      bool isHexFloat = isHex && t.text.find_first_of("pP") != std::string_view::npos;
      bool isDouble = t.text.find('.') != std::string_view::npos || isHexFloat ||
          (!isHex && t.text.find_first_of("eE") != std::string_view::npos);
      bool isLongLong = false;
      bool isLong = false;
      bool isFloat = false;
      bool isUnsigned = false;
      // Parse suffixes from the end, but be careful with hex numbers
      // since hex digits (a-f, A-F) can look like suffixes.
      // For hex floats (which have p/P), 'f'/'F' after the exponent is a suffix, not a hex digit.
      for (u32 i = t.text.size() - 1; i > 0; --i) {
        char c = t.text[i];
        if (c == 'u' || c == 'U') {
          isUnsigned = true;
        } else if (c == 'l' || c == 'L') {
          if (isLong || isLongLong) {
            isLongLong = true;
            isLong = false;
          } else {
            isLong = true;
          }
        } else if ((c == 'f' || c == 'F') && (!isHex || isHexFloat)) {
          isFloat = true;
        } else {
          break;
        }
      }

      t.flags.isUnsigned = isUnsigned;
      t.flags.isLong = isLong;
      t.flags.isLongLong = isLongLong;
      t.flags.isFloat = isFloat;
      t.flags.isDecimal = !isHex && !(t.text.size() >= 2 && t.text[0] == '0' &&
                            t.text[1] >= '0' && t.text[1] <= '7');

      if (isFloat || isDouble) {
        t.kind = TokenKind::FLOAT;
        std::string s(t.text);
        char *end = nullptr;
        t.value.floating = std::strtod(s.c_str(), &end);
        if (end == s.c_str()) {
          lexResult.errors.push_back({"Invalid numeric literal: " + s, t.filename, t.line});
        }
      } else {
        t.kind = TokenKind::INT;
        try {
          // stoull handles 0x (hex), 0 (octal), and decimal automatically
          t.value.integer = std::stoull(std::string(t.text), nullptr, 0);
        } catch (...) {
          lexResult.errors.push_back(
              {"Invalid numeric literal: " + std::string(t.text), t.filename, t.line});
        }
      }
    }
    // (C) Resolve CHAR -> INT (per C standard)
    // All char literals (including prefixed L'x', u'x', U'x') become INT.
    // The stringPrefix flag is preserved so the parser can assign the correct type.
    else if (t.kind == TokenKind::CHAR) {
      // Skip the prefix and opening quote to find the character content
      const char *start = t.text.data();
      if (*start == 'L' || *start == 'U') start++;
      else if (*start == 'u') start++;
      start++;  // Skip opening '
      const char *end = t.text.data() + t.text.size() - 1;  // Skip trailing '

      bool isWideChar = (t.flags.stringPrefix == StringPrefix::PREFIX_L ||
                         t.flags.stringPrefix == StringPrefix::PREFIX_u ||
                         t.flags.stringPrefix == StringPrefix::PREFIX_U);
      i32 codepoint = isWideChar ? unescapeCodepoint(start, end) : unescape(start, end);
      t.kind = TokenKind::INT;
      t.value.integer = static_cast<u64>(codepoint);
    }
  }

  return lexResult;
}

// ====================
// AST
// ====================

struct SrcLoc {
  Symbol filename;
  u32 line;
  u32 column;
};

enum class StorageClass {
  NONE,
  AUTO,
  REGISTER,
  STATIC,
  EXTERN,
  TYPEDEF,
  IMPORT,  // __import (external function provided by host environment)
};

enum class AllocClass {
  REGISTER,  // WASM local/global
  MEMORY,    // Linear memory (stack for locals, static for globals)
};

std::string_view strStorageClass(StorageClass sc) {
  switch (sc) {
    case StorageClass::NONE: return "none";
    case StorageClass::AUTO: return "auto";
    case StorageClass::REGISTER: return "register";
    case StorageClass::STATIC: return "static";
    case StorageClass::EXTERN: return "extern";
    case StorageClass::TYPEDEF: return "typedef";
    case StorageClass::IMPORT: return "import";
    default: return "unknown";
  }
}

// Forward declarations for constant evaluation
struct ConstValue;
class ConstEval;

// Result type for constant expression evaluation
struct ConstValue {
  enum Kind { NONE, INT, FLOAT, ADDRESS } kind = NONE;
  union {
    i64 intVal;
    double floatVal;
    u32 addrVal;  // Static memory address or function table index
  };

  ConstValue() : kind(NONE), intVal(0) {}

  static ConstValue fromInt(i64 v) {
    ConstValue cv;
    cv.kind = INT;
    cv.intVal = v;
    return cv;
  }

  static ConstValue fromFloat(double v) {
    ConstValue cv;
    cv.kind = FLOAT;
    cv.floatVal = v;
    return cv;
  }

  static ConstValue fromAddress(u32 addr) {
    ConstValue cv;
    cv.kind = ADDRESS;
    cv.addrVal = addr;
    return cv;
  }

  std::optional<i64> asInt() const {
    if (kind == INT) return intVal;
    if (kind == FLOAT) return static_cast<i64>(floatVal);
    if (kind == ADDRESS) return static_cast<i64>(addrVal);
    return std::nullopt;
  }

  std::optional<double> asFloat() const {
    if (kind == FLOAT) return floatVal;
    if (kind == INT) return static_cast<double>(intVal);
    return std::nullopt;
  }

  std::optional<u32> asAddress() const {
    if (kind == ADDRESS) return addrVal;
    if (kind == INT && intVal >= 0) return static_cast<u32>(intVal);
    return std::nullopt;
  }

  bool isValid() const { return kind != NONE; }
};

// Binary operators
enum class Bop {
  // Arithmetic
  ADD,  // +
  SUB,  // -
  MUL,  // *
  DIV,  // /
  MOD,  // %

  // Comparison
  EQ,  // ==
  NE,  // !=
  LT,  // <
  GT,  // >
  LE,  // <=
  GE,  // >=

  // Logical
  LAND,  // &&
  LOR,   // ||

  // Bitwise
  BAND,  // &
  BOR,   // |
  BXOR,  // ^
  SHL,   // <<
  SHR,   // >>

  // Assignment
  ASSIGN,       // =
  ADD_ASSIGN,   // +=
  SUB_ASSIGN,   // -=
  MUL_ASSIGN,   // *=
  DIV_ASSIGN,   // /=
  MOD_ASSIGN,   // %=
  BAND_ASSIGN,  // &=
  BOR_ASSIGN,   // |=
  BXOR_ASSIGN,  // ^=
  SHL_ASSIGN,   // <<=
  SHR_ASSIGN    // >>=
};

enum class Uop {
  OP_POS,       // +x (unary plus, integer promotion)
  OP_NEG,       // -x (negation)
  OP_LNOT,      // !x (logical not)
  OP_BNOT,      // ~x (bitwise not)
  OP_DEREF,     // *x (dereference)
  OP_ADDR,      // &x (address-of)
  OP_PRE_INC,   // ++x
  OP_PRE_DEC,   // --x
  OP_POST_INC,  // x++
  OP_POST_DEC   // x--
};

std::string_view strBop(Bop op) {
  switch (op) {
    case Bop::ADD: return "+";
    case Bop::SUB: return "-";
    case Bop::MUL: return "*";
    case Bop::DIV: return "/";
    case Bop::MOD: return "%";
    case Bop::EQ: return "==";
    case Bop::NE: return "!=";
    case Bop::LT: return "<";
    case Bop::GT: return ">";
    case Bop::LE: return "<=";
    case Bop::GE: return ">=";
    case Bop::LAND: return "&&";
    case Bop::LOR: return "||";
    case Bop::BAND: return "&";
    case Bop::BOR: return "|";
    case Bop::BXOR: return "^";
    case Bop::SHL: return "<<";
    case Bop::SHR: return ">>";
    case Bop::ASSIGN: return "=";
    case Bop::ADD_ASSIGN: return "+=";
    case Bop::SUB_ASSIGN: return "-=";
    case Bop::MUL_ASSIGN: return "*=";
    case Bop::DIV_ASSIGN: return "/=";
    case Bop::MOD_ASSIGN: return "%=";
    case Bop::BAND_ASSIGN: return "&=";
    case Bop::BOR_ASSIGN: return "|=";
    case Bop::BXOR_ASSIGN: return "^=";
    case Bop::SHL_ASSIGN: return "<<=";
    case Bop::SHR_ASSIGN: return ">>=";
    default: return "?";
  }
}

std::string_view strUop(Uop op) {
  switch (op) {
    case Uop::OP_POS: return "+";
    case Uop::OP_NEG: return "-";
    case Uop::OP_LNOT: return "!";
    case Uop::OP_BNOT: return "~";
    case Uop::OP_DEREF: return "*";
    case Uop::OP_ADDR: return "&";
    case Uop::OP_PRE_INC: return "++pre";
    case Uop::OP_PRE_DEC: return "--pre";
    case Uop::OP_POST_INC: return "post++";
    case Uop::OP_POST_DEC: return "post--";
    default: return "?";
  }
}

enum class TypeKind : u8 {
  // UNKNOWN is for types that could not be determined at parse time
  // While for normal C code this should never happen, in the future
  // we may add some extensions that require semantic passes to resolve types.
  UNKNOWN,

  VOID,
  BOOL,
  CHAR,
  SCHAR,
  UCHAR,
  SHORT,
  USHORT,
  INT,
  UINT,
  LONG,
  ULONG,
  LLONG,
  ULLONG,
  FLOAT,
  DOUBLE,
  LDOUBLE,
  POINTER,
  ARRAY,
  FUNCTION,
  TAG,       // struct/union/enum
};

std::string_view strTypeKind(TypeKind kind) {
  switch (kind) {
    case TypeKind::UNKNOWN: return "unknown";
    case TypeKind::VOID: return "void";
    case TypeKind::BOOL: return "_Bool";
    case TypeKind::CHAR: return "char";
    case TypeKind::SCHAR: return "signed char";
    case TypeKind::UCHAR: return "unsigned char";
    case TypeKind::SHORT: return "short";
    case TypeKind::USHORT: return "unsigned short";
    case TypeKind::INT: return "int";
    case TypeKind::UINT: return "unsigned int";
    case TypeKind::LONG: return "long";
    case TypeKind::ULONG: return "unsigned long";
    case TypeKind::LLONG: return "long long";
    case TypeKind::ULLONG: return "unsigned long long";
    case TypeKind::FLOAT: return "float";
    case TypeKind::DOUBLE: return "double";
    case TypeKind::LDOUBLE: return "long double";
    case TypeKind::POINTER: return "pointer";
    case TypeKind::ARRAY: return "array";
    case TypeKind::FUNCTION: return "function";
    case TypeKind::TAG: return "tag";
    default: return "unknown-value";
  }
}

enum class TagKind {
  STRUCT,
  UNION,
  ENUM,
};

std::string_view strTagKind(TagKind kind) {
  switch (kind) {
    case TagKind::STRUCT: return "struct";
    case TagKind::UNION: return "union";
    case TagKind::ENUM: return "enum";
    default: return "unknown";
  }
}

// There are 4 fundamental sorts of things in the AST,
// Type, Decl, Expr, and Stmt.
//
// Type:
//   It's really rare for us to need a type that we don't want to persist.
//   So we essentially 'leak' all Types we create - the information about them
//   is stored stored in Type::Info - and the 'Type' class is just
//   purely a pointer to that info. We cache all types, so that we can
//   compare them for equality by pointer comparison. However, if you want
//   to compare types stripping away qualifiers, that will still need
//   a deep comparison.
//
// Decl:
//   Declarations represent named entities in the program - variables,
//   functions, struct/union/enum tags, typedef names, etc.
//   Because so many places need to point to a Decl, the underlying Decl data
//   (e.g. DVar, DFunc, DTag) must have stable addresses.
//   To keep things simple, we use heap allocation and allow Decls to 'leak'.
//
//   This simplifies the scenarios where things of uncertain
//   lifetimes need to point to Decls (e.g. Types need to point to tag Decls).
//
//   However, the Decl struct itself is just a tagged pointer to one of those
//   heap-allocated structs, so Decl instances can (and should) be passed
//   around by value.
//
// Stmt and Expr:
//   Originally I planned for Stmt and Expr to use more traditional C++ style
//   memory management with unique_ptr and RAII. However, in practice
//   it was simpler to just let them leak as well, similar to Decls.
//
//   In the current design, Expr and Stmt are tagged pointers just like Decl.
//
class Type;
struct Expr;
struct Stmt;

enum class DeclKind {
  VAR,
  FUNC,
  TAG,  // struct/union/enum tag
  ENUM_CONST,
};

std::string_view strDeclKind(DeclKind kind) {
  switch (kind) {
    case DeclKind::VAR: return "variable";
    case DeclKind::FUNC: return "function";
    case DeclKind::TAG: return "tag";
    case DeclKind::ENUM_CONST: return "enum-constant";
    default: return "unknown";
  }
}

struct DVar;
struct DFunc;
struct DTag;
struct DEnumConst;

struct Decl {
  Decl() noexcept = default;
  Decl(nullptr_t) noexcept : kind(DeclKind::VAR), as{.var = nullptr} {}
  Decl(DVar *v) noexcept : kind(DeclKind::VAR), as{.var = v} {}
  Decl(DFunc *f) noexcept : kind(DeclKind::FUNC), as{.func = f} {}
  Decl(DTag *tg) noexcept : kind(DeclKind::TAG), as{.tag = tg} {}
  Decl(DEnumConst *ec) noexcept : kind(DeclKind::ENUM_CONST), as{.enumConst = ec} {}
  DeclKind kind;
  union {
    DVar *var;
    DFunc *func;
    DTag *tag;
    DEnumConst *enumConst;
  } as;
  std::string toString(u32 indent = 0) const;
  const void *getRawPtr() const { return std::bit_cast<const void *>(as); }
  void *getRawPtr() { return std::bit_cast<void *>(as); }
  uintptr_t getRawId() const { return std::bit_cast<uintptr_t>(as); }
  uintptr_t getRawIdOfDefinition() const;
  bool operator==(nullptr_t) const { return getRawPtr() == nullptr; }
  operator bool() const { return !(*this == nullptr); }
  SrcLoc getLoc() const;
  auto operator<=>(const Decl &other) const { return getRawId() <=> other.getRawId(); }
};

enum class IntrinsicKind : u8 {
  VA_START,
  VA_ARG,
  VA_END,
  VA_COPY,
  MEMORY_SIZE,
  MEMORY_GROW,
  MEMORY_COPY,
  MEMORY_FILL,
  HEAP_BASE,
  ALLOCA,
  UNREACHABLE,
};

std::string_view strIntrinsicKind(IntrinsicKind kind) {
  switch (kind) {
    case IntrinsicKind::VA_START: return "va_start";
    case IntrinsicKind::VA_ARG: return "va_arg";
    case IntrinsicKind::VA_END: return "va_end";
    case IntrinsicKind::VA_COPY: return "va_copy";
    case IntrinsicKind::MEMORY_SIZE: return "memory_size";
    case IntrinsicKind::MEMORY_GROW: return "memory_grow";
    case IntrinsicKind::MEMORY_COPY: return "memory_copy";
    case IntrinsicKind::MEMORY_FILL: return "memory_fill";
    case IntrinsicKind::HEAP_BASE: return "heap_base";
    case IntrinsicKind::ALLOCA: return "alloca";
    case IntrinsicKind::UNREACHABLE: return "unreachable";
    default: return "?";
  }
}

enum class ExprKind : u8 {
  INT,
  FLOAT,
  STRING,
  IDENT,
  BINARY,
  UNARY,
  TERNARY,
  CALL,
  SUBSCRIPT,
  MEMBER,
  ARROW,
  CAST,
  SIZEOF_EXPR,
  SIZEOF_TYPE,
  ALIGNOF_EXPR,
  ALIGNOF_TYPE,
  COMMA,
  INIT_LIST,
  INTRINSIC,
  WASM,
  COMPOUND_LITERAL,
  IMPLICIT_CAST,
} kind;

std::string_view strExprKind(ExprKind kind) {
  switch (kind) {
    case ExprKind::INT: return "integer-literal";
    case ExprKind::FLOAT: return "float-literal";
    case ExprKind::STRING: return "string-literal";
    case ExprKind::IDENT: return "identifier";
    case ExprKind::BINARY: return "binary-expression";
    case ExprKind::UNARY: return "unary-expression";
    case ExprKind::TERNARY: return "ternary-expression";
    case ExprKind::CALL: return "function-call";
    case ExprKind::SUBSCRIPT: return "array-subscript";
    case ExprKind::MEMBER: return "member-access";
    case ExprKind::ARROW: return "arrow-access";
    case ExprKind::CAST: return "type-cast";
    case ExprKind::SIZEOF_EXPR: return "sizeof-expression";
    case ExprKind::SIZEOF_TYPE: return "sizeof-type";
    case ExprKind::ALIGNOF_EXPR: return "alignof-expression";
    case ExprKind::ALIGNOF_TYPE: return "alignof-type";
    case ExprKind::COMMA: return "comma-expression";
    case ExprKind::INIT_LIST: return "initializer-list";
    case ExprKind::INTRINSIC: return "intrinsic";
    case ExprKind::WASM: return "wasm-expression";
    case ExprKind::COMPOUND_LITERAL: return "compound-literal";
    case ExprKind::IMPLICIT_CAST: return "implicit-cast";
    default: return "unknown";
  }
}

struct EInt;
struct EFloat;
struct EString;
struct EIdent;
struct EBinary;
struct EUnary;
struct ETernary;
struct ECall;
struct ESubscript;
struct EMember;
struct EArrow;
struct ECast;
struct ESizeOfExpr;
struct ESizeOfType;
struct EAlignOfExpr;
struct EAlignOfType;
struct EComma;
struct EInitList;
struct EIntrinsic;
struct EWasm;
struct ECompoundLiteral;
struct EImplicitCast;

struct Expr {
  Expr() noexcept = default;
  Expr(nullptr_t) noexcept : kind(ExprKind::INT), as{.intLit = nullptr} {}
  Expr(EInt *i) noexcept : kind(ExprKind::INT), as{.intLit = i} {}
  Expr(EFloat *f) noexcept : kind(ExprKind::FLOAT), as{.floatLit = f} {}
  Expr(EString *s) noexcept : kind(ExprKind::STRING), as{.stringLit = s} {}
  Expr(EIdent *id) noexcept : kind(ExprKind::IDENT), as{.ident = id} {}
  Expr(EBinary *b) noexcept : kind(ExprKind::BINARY), as{.binary = b} {}
  Expr(EUnary *u) noexcept : kind(ExprKind::UNARY), as{.unary = u} {}
  Expr(ETernary *t) noexcept : kind(ExprKind::TERNARY), as{.ternary = t} {}
  Expr(ECall *c) noexcept : kind(ExprKind::CALL), as{.call = c} {}
  Expr(ESubscript *s) noexcept : kind(ExprKind::SUBSCRIPT), as{.subscript = s} {}
  Expr(EMember *m) noexcept : kind(ExprKind::MEMBER), as{.member = m} {}
  Expr(EArrow *a) noexcept : kind(ExprKind::ARROW), as{.arrow = a} {}
  Expr(ECast *c) noexcept : kind(ExprKind::CAST), as{.cast = c} {}
  Expr(ESizeOfExpr *se) noexcept : kind(ExprKind::SIZEOF_EXPR), as{.sizeofExpr = se} {}
  Expr(ESizeOfType *st) noexcept : kind(ExprKind::SIZEOF_TYPE), as{.sizeofType = st} {}
  Expr(EAlignOfExpr *ae) noexcept : kind(ExprKind::ALIGNOF_EXPR), as{.alignofExpr = ae} {}
  Expr(EAlignOfType *at) noexcept : kind(ExprKind::ALIGNOF_TYPE), as{.alignofType = at} {}
  Expr(EComma *c) noexcept : kind(ExprKind::COMMA), as{.comma = c} {}
  Expr(EInitList *il) noexcept : kind(ExprKind::INIT_LIST), as{.initList = il} {}
  Expr(EIntrinsic *i) noexcept : kind(ExprKind::INTRINSIC), as{.intrinsic = i} {}
  Expr(EWasm *w) noexcept : kind(ExprKind::WASM), as{.wasm = w} {}
  Expr(ECompoundLiteral *cl) noexcept
      : kind(ExprKind::COMPOUND_LITERAL), as{.compoundLiteral = cl} {}
  Expr(EImplicitCast *ic) noexcept
      : kind(ExprKind::IMPLICIT_CAST), as{.implicitCast = ic} {}
  ExprKind kind;
  union {
    EInt *intLit;
    EFloat *floatLit;
    EString *stringLit;
    EIdent *ident;
    EBinary *binary;
    EUnary *unary;
    ETernary *ternary;
    ECall *call;
    ESubscript *subscript;
    EMember *member;
    EArrow *arrow;
    ECast *cast;
    ESizeOfExpr *sizeofExpr;
    ESizeOfType *sizeofType;
    EAlignOfExpr *alignofExpr;
    EAlignOfType *alignofType;
    EComma *comma;
    EInitList *initList;
    EIntrinsic *intrinsic;
    EWasm *wasm;
    ECompoundLiteral *compoundLiteral;
    EImplicitCast *implicitCast;
  } as;

  std::string toString(u32 indent = 0) const;
  bool operator==(nullptr_t) const { return std::bit_cast<void *>(as) == nullptr; }
  operator bool() const { return !(*this == nullptr); }
  Type getType() const;
  SrcLoc getLoc() const;
};

enum class StmtKind : u8 {
  EXPR,
  DECL,
  COMPOUND,
  IF,
  WHILE,
  DO_WHILE,
  FOR,
  BREAK,
  CONTINUE,
  RETURN,
  SWITCH,
  GOTO,
  LABEL,
  EMPTY,
  TRY_CATCH,
  THROW,
};

std::string_view strStmtKind(StmtKind kind) {
  switch (kind) {
    case StmtKind::EXPR: return "expression-statement";
    case StmtKind::DECL: return "declaration-statement";
    case StmtKind::COMPOUND: return "compound-statement";
    case StmtKind::IF: return "if-statement";
    case StmtKind::WHILE: return "while-statement";
    case StmtKind::DO_WHILE: return "do-while-statement";
    case StmtKind::FOR: return "for-statement";
    case StmtKind::BREAK: return "break-statement";
    case StmtKind::CONTINUE: return "continue-statement";
    case StmtKind::RETURN: return "return-statement";
    case StmtKind::SWITCH: return "switch-statement";
    case StmtKind::GOTO: return "goto-statement";
    case StmtKind::LABEL: return "label-statement";
    case StmtKind::EMPTY: return "empty-statement";
    case StmtKind::TRY_CATCH: return "try-catch-statement";
    case StmtKind::THROW: return "throw-statement";
    default: return "unknown";
  }
}

struct SExpr;
struct SDecl;
struct SCompound;
struct SIf;
struct SWhile;
struct SDoWhile;
struct SFor;
struct SBreak;
struct SContinue;
struct SReturn;
struct SSwitch;
struct SGoto;
struct SLabel;
struct STryCatch;
struct SThrow;

struct Stmt {
  Stmt() noexcept = default;
  Stmt(nullptr_t) noexcept : kind(StmtKind::EXPR), as{.exprStmt = nullptr} {}
  Stmt(SExpr *e) noexcept : kind(StmtKind::EXPR), as{.exprStmt = e} {}
  Stmt(SDecl *d) noexcept : kind(StmtKind::DECL), as{.declStmt = d} {}
  Stmt(SCompound *c) noexcept : kind(StmtKind::COMPOUND), as{.compound = c} {}
  Stmt(SIf *i) noexcept : kind(StmtKind::IF), as{.ifStmt = i} {}
  Stmt(SWhile *w) noexcept : kind(StmtKind::WHILE), as{.whileStmt = w} {}
  Stmt(SDoWhile *dw) noexcept : kind(StmtKind::DO_WHILE), as{.doWhileStmt = dw} {}
  Stmt(SFor *f) noexcept : kind(StmtKind::FOR), as{.forStmt = f} {}
  Stmt(SBreak *b) noexcept : kind(StmtKind::BREAK), as{.breakStmt = b} {}
  Stmt(SContinue *c) noexcept : kind(StmtKind::CONTINUE), as{.continueStmt = c} {}
  Stmt(SReturn *r) noexcept : kind(StmtKind::RETURN), as{.returnStmt = r} {}
  Stmt(SSwitch *s) noexcept : kind(StmtKind::SWITCH), as{.switchStmt = s} {}
  Stmt(SGoto *g) noexcept : kind(StmtKind::GOTO), as{.gotoStmt = g} {}
  Stmt(SLabel *l) noexcept : kind(StmtKind::LABEL), as{.labelStmt = l} {}
  Stmt(STryCatch *tc) noexcept : kind(StmtKind::TRY_CATCH), as{.tryCatch = tc} {}
  Stmt(SThrow *t) noexcept : kind(StmtKind::THROW), as{.throwStmt = t} {}
  static Stmt empty() noexcept {
    Stmt s;
    s.kind = StmtKind::EMPTY;
    s.as.exprStmt = nullptr;
    return s;
  }
  StmtKind kind;
  union {
    SExpr *exprStmt;
    SDecl *declStmt;
    SCompound *compound;
    SIf *ifStmt;
    SWhile *whileStmt;
    SDoWhile *doWhileStmt;
    SFor *forStmt;
    SBreak *breakStmt;
    SContinue *continueStmt;
    SReturn *returnStmt;
    SSwitch *switchStmt;
    SGoto *gotoStmt;
    SLabel *labelStmt;
    STryCatch *tryCatch;
    SThrow *throwStmt;
  } as;

  std::string toString(u32 indent = 0) const;
  bool operator==(nullptr_t) const { return std::bit_cast<void *>(as) == nullptr; }
  operator bool() const { return !(*this == nullptr); }
  SrcLoc getLoc() const;
};

class Type {
  struct Info;

  // Caches for derived types
  struct PerInfoCache {
    Info *toPointerType = nullptr;
    Info *flipConstType = nullptr;     // toggle const qualifier
    Info *flipVolatileType = nullptr;  // toggle volatile qualifier
  };

  // Designed so that every Type can be tested for exact equality by comparing
  // the 'info' pointer.
  struct Info {
    TypeKind kind;
    i32 size = 0;             // in bytes; 0 for incomplete types
    i32 align = 0;            // in bytes; 0 for unknown alignment
    bool isComplete = false;  // for tag types, will be false until defined
    bool isConst = false;
    bool isVolatile = false;

    // Additional data for specific kinds
    union {
      struct {
        Info *baseType;
      } pointer;
      struct {
        Info *returnType;
        std::vector<Type> *paramTypes;  // let the memory leak for simplicity
        bool isVarArg;
        bool hasUnspecifiedParams;  // f() vs f(void): true means unspecified
      } func;
      struct {
        Info *baseType;
        i32 size;  // number of elements (0 for incomplete array)
      } array;
      struct {
        Symbol name;
        TagKind kind;
        Decl tagDecl;
      } tag;  // struct, union, enum
    } data = {};

    // Caches for derived types
    PerInfoCache cache = {};
  };

  static Info UNKNOWN_INFO;
  static Info VOID_INFO;
  static Info BOOL_INFO;
  static Info CHAR_INFO;
  static Info SCHAR_INFO;
  static Info UCHAR_INFO;
  static Info SHORT_INFO;
  static Info USHORT_INFO;
  static Info INT_INFO;
  static Info UINT_INFO;
  static Info LONG_INFO;
  static Info ULONG_INFO;
  static Info LLONG_INFO;
  static Info ULLONG_INFO;
  static Info FLOAT_INFO;
  static Info DOUBLE_INFO;
  static Info LDOUBLE_INFO;

  // While most caches are stored directly in the base Info structs,
  // array types and function types require more parameters, so we
  // use external maps for those.

  // [baseType, size] -> array type info
  static std::map<std::pair<Info *, size_t>, Info *> ARRAY_TYPE_CACHE;

  // [returnType, paramTypes..., isVarArg, hasUnspecifiedParams] -> function type info
  static std::map<std::tuple<Info *, std::vector<Info *>, bool, bool>, Info *> FUNCTION_TYPE_CACHE;

  // This must be the ONLY field on Type instances
  Info *info;

  Type(Info *info) : info(info) {}

 public:
  // --- Primitive Getters ---
  static Type getUnknown() { return Type(&UNKNOWN_INFO); }
  static Type getVoid() { return Type(&VOID_INFO); }
  static Type getBool() { return Type(&BOOL_INFO); }
  static Type getChar() { return Type(&CHAR_INFO); }
  static Type getSChar() { return Type(&SCHAR_INFO); }
  static Type getUChar() { return Type(&UCHAR_INFO); }
  static Type getShort() { return Type(&SHORT_INFO); }
  static Type getUShort() { return Type(&USHORT_INFO); }
  static Type getInt() { return Type(&INT_INFO); }
  static Type getUInt() { return Type(&UINT_INFO); }
  static Type getLong() { return Type(&LONG_INFO); }
  static Type getULong() { return Type(&ULONG_INFO); }
  static Type getLLong() { return Type(&LLONG_INFO); }
  static Type getULLong() { return Type(&ULLONG_INFO); }
  static Type getFloat() { return Type(&FLOAT_INFO); }
  static Type getDouble() { return Type(&DOUBLE_INFO); }
  static Type getLDouble() { return Type(&LDOUBLE_INFO); }

  static Type getIntegerTypeFromTokenFlags(const TokenFlags &flags) {
    if (flags.isLongLong) {
      return flags.isUnsigned ? getULLong() : getLLong();
    } else if (flags.isLong) {
      return flags.isUnsigned ? getULong() : getLong();
    } else {
      return flags.isUnsigned ? getUInt() : getInt();
    }
  }

  // --- Factory Methods ---
  static Type function(Type returnType, std::span<const Type> paramTypes, bool isVarArg = false,
                       bool hasUnspecifiedParams = false) {
    std::vector<Info *> paramInfos;
    for (const auto &pt : paramTypes) {
      paramInfos.push_back(pt.info);
    }
    auto key = std::make_tuple(returnType.info, paramInfos, isVarArg, hasUnspecifiedParams);
    auto it = FUNCTION_TYPE_CACHE.find(key);
    if (it != FUNCTION_TYPE_CACHE.end()) {
      return Type(it->second);
    }

    // We leak the paramInfos vector for simplicity, since we assume
    // the Type system lives for the lifetime of the program.
    auto leakedParamTypes = new std::vector<Type>(paramTypes.begin(), paramTypes.end());

    Info *funcInfo = new Info();
    funcInfo->kind = TypeKind::FUNCTION;
    funcInfo->size = 0;
    funcInfo->align = 0;
    funcInfo->isComplete = true;
    funcInfo->data.func.returnType = returnType.info;
    funcInfo->data.func.paramTypes = leakedParamTypes;
    funcInfo->data.func.isVarArg = isVarArg;
    funcInfo->data.func.hasUnspecifiedParams = hasUnspecifiedParams;

    FUNCTION_TYPE_CACHE[key] = funcInfo;
    return Type(funcInfo);
  }

  static Type arrayOf(Type baseType, i32 size) {
    auto key = std::make_pair(baseType.info, static_cast<size_t>(size));
    auto it = ARRAY_TYPE_CACHE.find(key);
    if (it != ARRAY_TYPE_CACHE.end()) {
      return Type(it->second);
    }

    Info *arrInfo = new Info();
    arrInfo->kind = TypeKind::ARRAY;
    arrInfo->size = baseType.getSize() * size;
    arrInfo->align = baseType.getAlign();
    arrInfo->isComplete = baseType.isComplete();
    arrInfo->data.array.baseType = baseType.info;
    arrInfo->data.array.size = size;

    ARRAY_TYPE_CACHE[key] = arrInfo;
    return Type(arrInfo);
  }

  static Type newTag(TagKind tagKind, Symbol name) {
    Info *tagInfo = new Info();
    tagInfo->kind = TypeKind::TAG;
    tagInfo->size = 0;
    tagInfo->align = 0;
    tagInfo->isComplete = false;
    tagInfo->data.tag.name = name;
    tagInfo->data.tag.kind = tagKind;
    tagInfo->data.tag.tagDecl = Decl{};
    return Type(tagInfo);
  }

  Type() : info(&UNKNOWN_INFO) {}
  auto operator<=>(const Type &other) const = default;

  // --- Queries ---
  TypeKind getKind() const { return info->kind; }
  bool isKind(TypeKind kind) const { return info->kind == kind; }
  bool isVoid() const { return info->kind == TypeKind::VOID; }
  bool isPointer() const { return info->kind == TypeKind::POINTER; }
  bool isArray() const { return info->kind == TypeKind::ARRAY; }
  bool isFunction() const { return info->kind == TypeKind::FUNCTION; }
  bool isTag() const { return info->kind == TypeKind::TAG; }

  bool isInteger() const {
    switch (info->kind) {
      case TypeKind::BOOL:
      case TypeKind::CHAR:
      case TypeKind::SCHAR:
      case TypeKind::UCHAR:
      case TypeKind::SHORT:
      case TypeKind::USHORT:
      case TypeKind::INT:
      case TypeKind::UINT:
      case TypeKind::LONG:
      case TypeKind::ULONG:
      case TypeKind::LLONG:
      case TypeKind::ULLONG: return true;
      default: return false;
    }
  }
  bool isFloatingPoint() const {
    switch (info->kind) {
      case TypeKind::FLOAT:
      case TypeKind::DOUBLE:
      case TypeKind::LDOUBLE: return true;
      default: return false;
    }
  }
  bool isArithmetic() const { return isInteger() || isFloatingPoint(); }
  bool isScalar() const { return isArithmetic() || isPointer(); }
  bool isEnum() const { return isTag() && info->data.tag.kind == TagKind::ENUM; }
  bool isAggregate() const { return isArray() || (isTag() && !isEnum()); }

  bool isConst() const { return info->isConst; }
  bool isVolatile() const { return info->isVolatile; }
  bool isComplete() const { return info->isComplete; }
  i32 getSize() const { return info->size; }
  i32 getAlign() const { return info->align; }

  // --- Derivation and Decay ---
  Type getPointee() const {
    if (isPointer()) return Type(info->data.pointer.baseType);
    return getVoid();
  }

  Type getArrayBase() const {
    if (isArray()) return Type(info->data.array.baseType);
    return getVoid();
  }

  i32 getArraySize() const {
    if (isArray()) return info->data.array.size;
    return 0;
  }

  Type pointer() const {
    if (info->cache.toPointerType) {
      return Type(info->cache.toPointerType);
    }
    Info *ptrInfo = new Info();
    ptrInfo->kind = TypeKind::POINTER;
    ptrInfo->size = 4;  // Wasm32
    ptrInfo->align = 4;
    ptrInfo->isComplete = true;
    ptrInfo->data.pointer.baseType = info;
    info->cache.toPointerType = ptrInfo;
    return Type(ptrInfo);
  }

  Type decay() const {
    if (isArray()) return getArrayBase().pointer();
    if (isFunction()) return this->pointer();
    return *this;
  }

  Type toggleConst() const {
    if (info->cache.flipConstType) {
      return Type(info->cache.flipConstType);
    }
    Info *flippedInfo = new Info(*info);
    flippedInfo->cache = PerInfoCache();  // reset cache
    flippedInfo->isConst = !info->isConst;

    // Link them so calling toggleConst() again returns the original
    info->cache.flipConstType = flippedInfo;
    flippedInfo->cache.flipConstType = info;

    return Type(flippedInfo);
  }

  Type addConst() const { return info->isConst ? *this : toggleConst(); }

  Type removeConst() const { return info->isConst ? toggleConst() : *this; }

  Type toggleVolatile() const {
    if (info->cache.flipVolatileType) {
      return Type(info->cache.flipVolatileType);
    }
    Info *flippedInfo = new Info(*info);
    flippedInfo->cache = PerInfoCache();  // reset cache
    flippedInfo->isVolatile = !info->isVolatile;

    // Link them so calling toggleVolatile() again returns the original
    info->cache.flipVolatileType = flippedInfo;
    flippedInfo->cache.flipVolatileType = info;

    return Type(flippedInfo);
  }

  Type addVolatile() const { return info->isVolatile ? *this : toggleVolatile(); }

  Type removeVolatile() const { return info->isVolatile ? toggleVolatile() : *this; }

  Type removeQualifiers() const { return removeConst().removeVolatile(); }

  // --- Function Type Queries ---
  Type getReturnType() const {
    if (isFunction()) return Type(info->data.func.returnType);
    return getVoid();
  }

  std::span<Type> getParamTypes() const {
    if (isFunction()) return std::span<Type>{*info->data.func.paramTypes};
    return {};
  }

  bool isVarArg() const {
    if (isFunction()) return info->data.func.isVarArg;
    return false;
  }

  bool hasUnspecifiedParams() const {
    if (isFunction()) return info->data.func.hasUnspecifiedParams;
    return false;
  }

  // --- Tag Type Queries ---

  Symbol getTagName() const {
    if (isTag()) return info->data.tag.name;
    return Symbol{};
  }

  Decl getTagDecl() const {
    if (isTag()) return info->data.tag.tagDecl;
    panicf("Type::getTagDecl() called on non-tag type %s", toString().c_str());
    return Decl{};
  }

  void setTagDecl(Decl decl);

 private:
  // Compute and cache the size and alignment for a tag type (struct/union/enum).
  // Called when the tag definition is complete.
  // Defined after DTag is fully defined.
  void computeTagSizeAndAlign();

 public:
  // Check if this type is compatible with another type for declaration merging.
  // Handles: exact match, incomplete vs complete arrays, and cross-TU tag types
  // matched by kind+name.
  //
  // Intentionally lax in two cases where strict checking would reject valid
  // real-world C code (no major C compiler checks cross-TU type compatibility):
  //  1. Anonymous tags: `typedef struct { ... } Foo;` gets different __anon_N
  //     names in each TU, so we treat any two anonymous tags of the same kind
  //     as compatible.
  //  2. Empty parameter lists (--allow-empty-params): C's `void f()` means
  //     "unspecified parameters", not "zero parameters". We don't distinguish
  //     f() from f(void) internally, so with this flag we treat any function
  //     with 0 params as compatible with any param list.
  bool isCompatibleWith(Type other) const {
    if (*this == other) return true;
    if (info->kind != other.info->kind) return false;
    if (isConst() != other.isConst() || isVolatile() != other.isVolatile()) return false;
    switch (info->kind) {
      case TypeKind::ARRAY: {
        if (!getArrayBase().isCompatibleWith(other.getArrayBase())) return false;
        // Allow incomplete (size 0) to match complete (size > 0)
        return getArraySize() == 0 || other.getArraySize() == 0 ||
            getArraySize() == other.getArraySize();
      }
      case TypeKind::POINTER: return getPointee().isCompatibleWith(other.getPointee());
      case TypeKind::TAG:
        if (info->data.tag.kind != other.info->data.tag.kind) return false;
        if (info->data.tag.name == other.info->data.tag.name) return true;
        // (lax case 1) Anonymous tags get different __anon_N names across TUs.
        return info->data.tag.name->starts_with("__anon_") &&
            other.info->data.tag.name->starts_with("__anon_");
      case TypeKind::FUNCTION: {
        if (!getReturnType().isCompatibleWith(other.getReturnType())) return false;
        auto params = getParamTypes();
        auto otherParams = other.getParamTypes();
        // (lax case 2) f() has unspecified params, compatible with any signature.
        if (hasUnspecifiedParams() || other.hasUnspecifiedParams())
          return true;
        if (isVarArg() != other.isVarArg()) return false;
        if (params.size() != otherParams.size()) return false;
        for (size_t i = 0; i < params.size(); ++i) {
          if (!params[i].isCompatibleWith(otherParams[i])) return false;
        }
        return true;
      }
      default: return false;  // primitives would have matched with == above
    }
  }

  // --- debugging ---
  std::string toString() const {
    // The string representation isn't a faithful reproduction of
    // C syntax; instead it's a simplified grammar that's more
    // 'normalized' for easier reading.
    std::string out;
    if (isConst()) {
      out += "const ";
    }
    if (isVolatile()) {
      out += "volatile ";
    }
    if (info->kind == TypeKind::POINTER) {
      out += "*" + Type{info->data.pointer.baseType}.toString();
    } else if (info->kind == TypeKind::ARRAY) {
      out += "[" + std::to_string(info->data.array.size) + "]" +
          Type{info->data.array.baseType}.toString();
    } else if (info->kind == TypeKind::TAG) {
      out += strTagKind(info->data.tag.kind);
      out += " ";
      out += *info->data.tag.name;
    } else if (info->kind == TypeKind::FUNCTION) {
      out += "(";
      bool first = true;
      for (auto pt : getParamTypes()) {
        if (!first) {
          out += ", ";
        }
        out += pt.toString();
        first = false;
      }
      if (info->data.func.isVarArg) {
        if (!first) {
          out += ", ";
        }
        out += "...";
      }
      out += ")" + Type{info->data.func.returnType}.toString();
    } else {
      out += strTypeKind(info->kind);
    }
    return out;
  }
};

// --- Static Initializers using Wasm32 Sizes ---
Type::Info Type::UNKNOWN_INFO = {TypeKind::UNKNOWN};
Type::Info Type::VOID_INFO = {TypeKind::VOID};
Type::Info Type::BOOL_INFO = {
    .kind = TypeKind::BOOL,
    .size = 1,
    .align = 1,
    .isComplete = true,
};
Type::Info Type::CHAR_INFO = {
    .kind = TypeKind::CHAR,
    .size = 1,
    .align = 1,
    .isComplete = true,
};
Type::Info Type::SCHAR_INFO = {
    .kind = TypeKind::SCHAR,
    .size = 1,
    .align = 1,
    .isComplete = true,
};
Type::Info Type::UCHAR_INFO = {
    .kind = TypeKind::UCHAR,
    .size = 1,
    .align = 1,
    .isComplete = true,
};
Type::Info Type::SHORT_INFO = {
    .kind = TypeKind::SHORT,
    .size = 2,
    .align = 2,
    .isComplete = true,
};
Type::Info Type::USHORT_INFO = {
    .kind = TypeKind::USHORT,
    .size = 2,
    .align = 2,
    .isComplete = true,
};
Type::Info Type::INT_INFO = {
    .kind = TypeKind::INT,
    .size = 4,
    .align = 4,
    .isComplete = true,
};
Type::Info Type::UINT_INFO = {
    .kind = TypeKind::UINT,
    .size = 4,
    .align = 4,
    .isComplete = true,
};
Type::Info Type::LONG_INFO = {
    .kind = TypeKind::LONG,
    .size = 4,
    .align = 4,
    .isComplete = true,
};
Type::Info Type::ULONG_INFO = {
    .kind = TypeKind::ULONG,
    .size = 4,
    .align = 4,
    .isComplete = true,
};
Type::Info Type::LLONG_INFO = {
    .kind = TypeKind::LLONG,
    .size = 8,
    .align = 8,
    .isComplete = true,
};
Type::Info Type::ULLONG_INFO = {
    .kind = TypeKind::ULLONG,
    .size = 8,
    .align = 8,
    .isComplete = true,
};
Type::Info Type::FLOAT_INFO = {
    .kind = TypeKind::FLOAT,
    .size = 4,
    .align = 4,
    .isComplete = true,
};
Type::Info Type::DOUBLE_INFO = {
    .kind = TypeKind::DOUBLE,
    .size = 8,
    .align = 8,
    .isComplete = true,
};
Type::Info Type::LDOUBLE_INFO = {
    .kind = TypeKind::LDOUBLE,
    .size = 8,
    .align = 8,
    .isComplete = true,
};

std::map<std::pair<Type::Info *, size_t>, Type::Info *> Type::ARRAY_TYPE_CACHE;
std::map<std::tuple<Type::Info *, std::vector<Type::Info *>, bool, bool>, Type::Info *>
    Type::FUNCTION_TYPE_CACHE;

const Type TUNKNOWN = Type::getUnknown();
const Type TVOID = Type::getVoid();
const Type TBOOL = Type::getBool();
const Type TCHAR = Type::getChar();
const Type TSCHAR = Type::getSChar();
const Type TUCHAR = Type::getUChar();
const Type TSHORT = Type::getShort();
const Type TUSHORT = Type::getUShort();
const Type TINT = Type::getInt();
const Type TUINT = Type::getUInt();
const Type TLONG = Type::getLong();
const Type TULONG = Type::getULong();
const Type TLLONG = Type::getLLong();
const Type TULLONG = Type::getULLong();
const Type TFLOAT = Type::getFloat();
const Type TDOUBLE = Type::getDouble();
const Type TLDOUBLE = Type::getLDouble();

struct EInt {
  SrcLoc loc;
  Type type;  // type of the integer literal, based on suffixes
  u64 value;
};

struct EFloat {
  SrcLoc loc;
  Type type;  // type of the float literal, based on suffixes
  double value;
};

struct EString {
  SrcLoc loc;
  Type type;
  Buffer value;
};

struct EIdent {
  SrcLoc loc;
  Type type;
  Symbol name;

  // Filled in during the parse.
  // This is possible because C requires at least a declaration
  // before use, and even without definitions, declarations create
  // Decls that identifiers can point to.
  Decl decl;  // which declaration this identifier refers to
};

struct EBinary {
  SrcLoc loc;
  Type type;
  Bop op;
  Expr left;
  Expr right;
};

struct EUnary {
  SrcLoc loc;
  Type type;
  Uop op;
  Expr operand;
};

struct ETernary {
  SrcLoc loc;
  Type type;
  Expr condition;
  Expr thenExpr;
  Expr elseExpr;
};

struct ECall {
  SrcLoc loc;
  Type type;
  Expr callee;
  std::vector<Expr> arguments;

  // Filled in during parse.
  // Not always set - filled in if callee is a direct function call
  DFunc *funcDecl = nullptr;
};

struct ESubscript {
  SrcLoc loc;
  Type type;
  Expr array;
  Expr index;
};

struct EMember {
  SrcLoc loc;
  Type type;
  Expr base;
  Symbol memberName;

  // Filled in during parse.
  // Possible because in C, you cannot access a member of an
  // incomplete struct/union type.
  DVar *memberDecl = nullptr;
};

struct EArrow {
  SrcLoc loc;
  Type type;
  Expr base;
  Symbol memberName;

  // Filled in during parse.
  // Possible because in C, you cannot access a member of an
  // incomplete struct/union type.
  DVar *memberDecl = nullptr;
};

struct ECast {
  SrcLoc loc;
  Type type;
  Type targetType;
  Expr expr;
};

struct ESizeOfExpr {
  SrcLoc loc;
  Type type;
  Expr expr;
};

struct ESizeOfType {
  SrcLoc loc;
  Type type;
  Type operandType;
};

struct EAlignOfExpr {
  SrcLoc loc;
  Type type;
  Expr expr;
};

struct EAlignOfType {
  SrcLoc loc;
  Type type;
  Type operandType;
};

struct EComma {
  SrcLoc loc;
  Type type;
  std::vector<Expr> expressions;
};

struct DesigStep {
  enum Kind : u8 { FIELD, INDEX };
  Kind kind;
  Symbol fieldName = nullptr;  // for FIELD
  Expr indexExpr = nullptr;    // for INDEX (evaluated during semantic phase)
};

struct InitDesignator {
  std::vector<DesigStep> steps;  // empty = positional (no designator)
};

struct EInitList {
  SrcLoc loc;
  Type type;
  std::vector<Expr> elements;
  std::vector<InitDesignator> designators;  // parallel to elements; empty = all positional
  i32 unionMemberIndex = 0;                 // which union member to init (for codegen)
};

struct EIntrinsic {
  SrcLoc loc;
  Type type;  // return type (void for most, argType for VA_ARG)
  IntrinsicKind kind;
  std::vector<Expr>
      args;      // VA_START: [ap, last_param], VA_ARG: [ap], VA_END: [ap], VA_COPY: [dest, src]
  Type argType;  // Only used for VA_ARG - the type to read
};

struct EWasm {
  SrcLoc loc;
  Type type;               // The C type specified by the user
  std::vector<Expr> args;  // Arguments to emit before bytecode
  Buffer bytes;            // Raw wasm bytecode
};

struct ECompoundLiteral {
  SrcLoc loc;
  Type type;            // The declared type (may be updated for unsized arrays)
  EInitList *initList;  // The normalized initializer list
};

struct EImplicitCast {
  SrcLoc loc;
  Type type;    // target type (= Expr::getType() result)
  Expr expr;    // inner expression
};

struct SExpr {
  SrcLoc loc;
  Expr expr;
};

struct SDecl {
  SrcLoc loc;
  std::vector<Decl> declarations;
};

struct SCompound {
  SrcLoc loc;
  std::vector<Stmt> statements;
  std::vector<SLabel *> labels;  // labels directly contained in this compound
};

struct SIf {
  SrcLoc loc;
  Expr condition;
  Stmt thenBranch;
  Stmt elseBranch;  // nullptr if no else
};

struct SWhile {
  SrcLoc loc;
  Expr condition;
  Stmt body;
};

struct SDoWhile {
  SrcLoc loc;
  Stmt body;
  Expr condition;
};

struct SFor {
  SrcLoc loc;
  Stmt init;       // nullptr if no init
  Expr condition;  // nullptr if no condition
  Expr increment;  // nullptr if no increment
  Stmt body;
};

struct SBreak {
  SrcLoc loc;
};

struct SContinue {
  SrcLoc loc;
};

struct SReturn {
  SrcLoc loc;
  Expr expr;  // nullptr for 'return;'
};

struct SwitchCase {
  i64 value;       // Case value (for case), unused for default
  bool isDefault;  // true if this is 'default:'
  u32 stmtIndex;   // Index into SSwitch::statements where this case starts
};

struct SSwitch {
  SrcLoc loc;
  Expr expr;                      // Switch expression
  std::vector<SwitchCase> cases;  // All case/default labels
  SCompound *body;                // Switch body (compound statement)
};

struct SLabel;

struct SGoto {
  SrcLoc loc;
  std::string label;
  SLabel *target = nullptr;  // resolved during parsing
};

enum class LabelKind : u8 {
  FORWARD,  // goto must appear before the label (forward jump)
  LOOP,     // goto must appear after the label (backward jump)
  BOTH,     // label has both forward and backward gotos
};

struct SLabel {
  SrcLoc loc;
  std::string name;
  SCompound *enclosingBlock = nullptr;  // set during parsing
  LabelKind labelKind = LabelKind::FORWARD;
  bool hasGotos = false;  // true if any goto targets this label
};

struct ExceptionTag {
  SrcLoc loc;
  Symbol name;
  std::vector<Type> paramTypes;        // 0 or more params
  ExceptionTag *definition = nullptr;  // canonical tag (self for first decl)
};

struct CatchClause {
  SrcLoc loc;
  ExceptionTag *tag;                // nullptr for catch_all
  std::vector<Symbol> bindings;     // binding names (empty for catch_all)
  std::vector<DVar *> bindingVars;  // DVar* for each binding (empty for catch_all)
  Stmt body;
};

struct STryCatch {
  SrcLoc loc;
  Stmt tryBody;
  std::vector<CatchClause> catches;
};

struct SThrow {
  SrcLoc loc;
  ExceptionTag *tag;
  std::vector<Expr> args;
};

struct DVar {
  SrcLoc loc;
  Symbol name;
  Type type;
  StorageClass storageClass;
  AllocClass allocClass =
      AllocClass::REGISTER;  // REGISTER for WASM locals/globals, MEMORY for linear memory
  Expr initExpr = nullptr;

  // points to the definition
  // Definitions will point to themselves (this is done in the linker phase)
  DVar *definition = nullptr;

  // Bit-field support
  i32 bitWidth = -1;   // -1 means not a bit-field
  i32 bitOffset = 0;   // bit offset within storage unit
  i32 byteOffset = 0;  // byte offset within struct (cached during layout)

  i32 requestedAlignment = 0;  // _Alignas override (0 = none)

  bool isBitField() const { return bitWidth >= 0; }
};

struct ParsedAttributes {
  bool packed = false;
  i32 aligned = 0;  // 0 = no alignment request
  std::set<Symbol> flags;  // no-arg attributes: noinline, noipa, noreturn, unused, etc.
};

struct DeclSpecifiers {
  Type type;
  StorageClass storageClass = StorageClass::NONE;
  bool isInline = false;
  i32 requestedAlignment = 0;  // _Alignas override (0 = none)
};

struct DFunc {
  SrcLoc loc;
  Symbol name;
  Type type;  // full function type
  std::vector<Decl> parameters;
  StorageClass storageClass;
  bool isInline = false;
  Stmt body = nullptr;
  std::vector<DVar *> staticLocals = {};
  std::vector<DVar *> externLocals = {};
  std::vector<DFunc *> externLocalFuncs = {};
  std::set<Decl> usedSymbols = {};  // symbols referenced in this function's body

  std::vector<ECompoundLiteral *> compoundLiterals = {};  // compound literals in this function body

  // For filling in during the parse.
  // If this DFunc is a definition, it will point to itself.
  // Otherwise, it will point to the definition if one exists.
  DFunc *definition = nullptr;
};

// struct/union/enum
struct DTag {
  SrcLoc loc;
  TagKind tagKind;
  Symbol name;
  bool isComplete = false;
  bool isPacked = false;  // __attribute__((packed)) — align all members to 1
  std::vector<Decl> members;  // enums will only contain ENUM_CONST decls
};

struct DEnumConst {
  SrcLoc loc;
  Symbol name;
  i64 value;
};

// Truncate a constant integer value to fit the given C type's width.
// Matches the semantics of C integer conversions (C99 §6.3.1.3).
static i64 truncateConstInt(i64 v, Type type) {
  type = type.removeQualifiers();
  if (type == TCHAR || type == TSCHAR) return static_cast<i64>(static_cast<int8_t>(v));
  if (type == TUCHAR) return static_cast<i64>(static_cast<u8>(v));
  if (type == TSHORT) return static_cast<i64>(static_cast<int16_t>(v));
  if (type == TUSHORT) return static_cast<i64>(static_cast<u16>(v));
  if (type == TINT || type == TLONG) return static_cast<i64>(static_cast<i32>(v));
  if (type == TUINT || type == TULONG) return static_cast<i64>(static_cast<u32>(v));
  if (type == TBOOL) return v != 0 ? 1 : 0;
  return v;  // long long, pointer: no truncation needed
}

// Constant expression evaluator for compile-time evaluation
// Used for array sizes, case labels, enum values, and global initializers
class ConstEval {
  std::function<i32(Type)> getSizeOf;
  // Optional callbacks for codegen-time address resolution
  std::function<std::optional<u32>(DVar *)> getGlobalAddress;
  std::function<std::optional<u32>(DFunc *)> getFunctionIndex;
  std::function<u32(const Buffer &)> getStringAddress;

 public:
  // Optional callback for resolving file-scope compound literal addresses
  std::function<std::optional<u32>(ECompoundLiteral *)> getCompoundLiteralAddress;
  // Parser-time constructor (no address resolution)
  ConstEval(std::function<i32(Type)> getSizeOf) : getSizeOf(std::move(getSizeOf)) {}

  // Codegen-time constructor (with address resolution)
  ConstEval(std::function<i32(Type)> getSizeOf,
      std::function<std::optional<u32>(DVar *)> getGlobalAddress,
      std::function<std::optional<u32>(DFunc *)> getFunctionIndex,
      std::function<u32(const Buffer &)> getStringAddress)
      : getSizeOf(std::move(getSizeOf)),
        getGlobalAddress(std::move(getGlobalAddress)),
        getFunctionIndex(std::move(getFunctionIndex)),
        getStringAddress(std::move(getStringAddress)) {}

  // Evaluate an lvalue expression to get its constant address.
  // This handles arbitrary nesting of member access, arrow, and subscript.
  std::optional<u32> evaluateLValue(Expr expr) {
    switch (expr.kind) {
      case ExprKind::IDENT: {
        EIdent *ident = expr.as.ident;
        if (ident->decl.kind == DeclKind::VAR && getGlobalAddress) {
          DVar *var = ident->decl.as.var;
          if (var->definition) var = var->definition;
          return getGlobalAddress(var);
        }
        return std::nullopt;
      }
      case ExprKind::MEMBER: {
        // struct.field => evaluateLValue(struct) + field_offset
        EMember *em = expr.as.member;
        auto base = evaluateLValue(em->base);
        if (base)
          return *base + static_cast<u32>(em->memberDecl->byteOffset);
        return std::nullopt;
      }
      case ExprKind::ARROW: {
        // ptr->field => evaluate(ptr) as rvalue + field_offset
        EArrow *ea = expr.as.arrow;
        auto base = evaluate(ea->base);
        if (base) {
          u32 baseVal = 0;
          if (base->kind == ConstValue::ADDRESS)
            baseVal = base->addrVal;
          else if (auto iv = base->asInt())
            baseVal = static_cast<u32>(*iv);
          else
            return std::nullopt;
          return baseVal + static_cast<u32>(ea->memberDecl->byteOffset);
        }
        return std::nullopt;
      }
      case ExprKind::SUBSCRIPT: {
        // arr[i] => evaluateLValue(arr) + i * sizeof(elem)
        //   or for pointer base: evaluate(ptr) + i * sizeof(elem)
        ESubscript *sub = expr.as.subscript;
        auto idx = evaluate(sub->index);
        if (!idx) return std::nullopt;
        auto iv = idx->asInt();
        if (!iv) return std::nullopt;
        u32 elemSize = static_cast<u32>(!sub->type.isVoid() ? getSizeOf(sub->type) : 1);
        u32 indexOffset = static_cast<u32>(*iv) * elemSize;
        // Try as lvalue first (array member), then as rvalue (pointer)
        if (auto base = evaluateLValue(sub->array))
          return *base + indexOffset;
        if (auto base = evaluate(sub->array)) {
          if (base->kind == ConstValue::ADDRESS)
            return base->addrVal + indexOffset;
          if (auto bv = base->asInt())
            return static_cast<u32>(*bv) + indexOffset;
        }
        return std::nullopt;
      }
      case ExprKind::UNARY: {
        // *ptr => evaluate(ptr) as rvalue
        EUnary *un = expr.as.unary;
        if (un->op == Uop::OP_DEREF) {
          auto val = evaluate(un->operand);
          if (val) {
            if (val->kind == ConstValue::ADDRESS)
              return val->addrVal;
            if (auto iv = val->asInt())
              return static_cast<u32>(*iv);
          }
        }
        return std::nullopt;
      }
      case ExprKind::COMPOUND_LITERAL: {
        if (getCompoundLiteralAddress) {
          return getCompoundLiteralAddress(expr.as.compoundLiteral);
        }
        return std::nullopt;
      }
      default:
        return std::nullopt;
    }
  }

  std::optional<ConstValue> evaluate(Expr expr) {
    if (expr == nullptr) return std::nullopt;

    switch (expr.kind) {
      case ExprKind::INT: return ConstValue::fromInt(static_cast<i64>(expr.as.intLit->value));

      case ExprKind::FLOAT: return ConstValue::fromFloat(expr.as.floatLit->value);

      case ExprKind::STRING: {
        // String literals have addresses at codegen time
        if (getStringAddress) {
          EString *str = expr.as.stringLit;
          return ConstValue::fromAddress(getStringAddress(str->value));
        }
        return std::nullopt;
      }

      case ExprKind::IDENT: {
        EIdent *ident = expr.as.ident;
        // Enum constants
        if (ident->decl.kind == DeclKind::ENUM_CONST) {
          return ConstValue::fromInt(ident->decl.as.enumConst->value);
        }
        // Global variables/arrays (at codegen time)
        if (ident->decl.kind == DeclKind::VAR && getGlobalAddress) {
          DVar *var = ident->decl.as.var;
          if (var->definition) var = var->definition;
          auto addr = getGlobalAddress(var);
          if (addr) {
            // Arrays decay to their address
            if (var->type.isArray()) {
              return ConstValue::fromAddress(*addr);
            }
            // Non-array globals: we can't evaluate their value, but we can take their address
          }
        }
        // Functions (at codegen time)
        if (ident->decl.kind == DeclKind::FUNC && getFunctionIndex) {
          DFunc *func = ident->decl.as.func;
          if (func->definition) func = func->definition;
          auto idx = getFunctionIndex(func);
          if (idx) {
            return ConstValue::fromAddress(*idx);
          }
        }
        return std::nullopt;
      }

      case ExprKind::BINARY: {
        EBinary *bin = expr.as.binary;
        auto left = evaluate(bin->left);
        auto right = evaluate(bin->right);

        // Handle short-circuit operators separately
        if (bin->op == Bop::LAND) {
          if (!left) return std::nullopt;
          auto lv = left->asInt();
          if (!lv) return std::nullopt;
          if (*lv == 0) return ConstValue::fromInt(0);
          if (!right) return std::nullopt;
          auto rv = right->asInt();
          if (!rv) return std::nullopt;
          return ConstValue::fromInt(*rv != 0 ? 1 : 0);
        }
        if (bin->op == Bop::LOR) {
          if (!left) return std::nullopt;
          auto lv = left->asInt();
          if (!lv) return std::nullopt;
          if (*lv != 0) return ConstValue::fromInt(1);
          if (!right) return std::nullopt;
          auto rv = right->asInt();
          if (!rv) return std::nullopt;
          return ConstValue::fromInt(*rv != 0 ? 1 : 0);
        }

        if (!left || !right) return std::nullopt;

        // Check if we're dealing with addresses (pointer arithmetic)
        bool hasAddress = (left->kind == ConstValue::ADDRESS || right->kind == ConstValue::ADDRESS);

        if (hasAddress) {
          // Pointer arithmetic: address +/- int, address - address
          if (bin->op == Bop::ADD) {
            // address + int or int + address
            if (left->kind == ConstValue::ADDRESS && right->kind != ConstValue::ADDRESS) {
              auto rv = right->asInt();
              if (!rv) return std::nullopt;
              // Get element size from the binary expression's left type
              Type leftType = bin->left.getType();
              i32 elemSize = leftType.isPointer() ? getSizeOf(leftType.getPointee())
                           : leftType.isArray()   ? getSizeOf(leftType.getArrayBase())
                           : 1;
              return ConstValue::fromAddress(left->addrVal + static_cast<u32>(*rv * elemSize));
            }
            if (right->kind == ConstValue::ADDRESS && left->kind != ConstValue::ADDRESS) {
              auto lv = left->asInt();
              if (!lv) return std::nullopt;
              Type rightType = bin->right.getType();
              i32 elemSize = rightType.isPointer() ? getSizeOf(rightType.getPointee())
                           : rightType.isArray()   ? getSizeOf(rightType.getArrayBase())
                           : 1;
              return ConstValue::fromAddress(right->addrVal + static_cast<u32>(*lv * elemSize));
            }
          } else if (bin->op == Bop::SUB) {
            // address - int
            if (left->kind == ConstValue::ADDRESS && right->kind != ConstValue::ADDRESS) {
              auto rv = right->asInt();
              if (!rv) return std::nullopt;
              Type leftType = bin->left.getType();
              i32 elemSize = leftType.isPointer() ? getSizeOf(leftType.getPointee())
                           : leftType.isArray()   ? getSizeOf(leftType.getArrayBase())
                           : 1;
              return ConstValue::fromAddress(left->addrVal - static_cast<u32>(*rv * elemSize));
            }
            // address - address (pointer difference)
            if (left->kind == ConstValue::ADDRESS && right->kind == ConstValue::ADDRESS) {
              Type leftType = bin->left.getType();
              i32 elemSize = leftType.isPointer() ? getSizeOf(leftType.getPointee())
                           : leftType.isArray()   ? getSizeOf(leftType.getArrayBase())
                           : 1;
              if (elemSize == 0) return std::nullopt;
              return ConstValue::fromInt(
                  static_cast<i64>(left->addrVal - right->addrVal) / elemSize);
            }
          } else if (bin->op == Bop::EQ) {
            return ConstValue::fromInt(left->addrVal == right->addrVal ? 1 : 0);
          } else if (bin->op == Bop::NE) {
            return ConstValue::fromInt(left->addrVal != right->addrVal ? 1 : 0);
          } else if (bin->op == Bop::LT) {
            return ConstValue::fromInt(left->addrVal < right->addrVal ? 1 : 0);
          } else if (bin->op == Bop::GT) {
            return ConstValue::fromInt(left->addrVal > right->addrVal ? 1 : 0);
          } else if (bin->op == Bop::LE) {
            return ConstValue::fromInt(left->addrVal <= right->addrVal ? 1 : 0);
          } else if (bin->op == Bop::GE) {
            return ConstValue::fromInt(left->addrVal >= right->addrVal ? 1 : 0);
          }
          return std::nullopt;
        }

        // Check if we're dealing with floats
        bool hasFloat = (left->kind == ConstValue::FLOAT || right->kind == ConstValue::FLOAT);

        if (hasFloat) {
          auto lv = left->asFloat();
          auto rv = right->asFloat();
          if (!lv || !rv) return std::nullopt;
          switch (bin->op) {
            case Bop::ADD: return ConstValue::fromFloat(*lv + *rv);
            case Bop::SUB: return ConstValue::fromFloat(*lv - *rv);
            case Bop::MUL: return ConstValue::fromFloat(*lv * *rv);
            case Bop::DIV:
              // IEEE 754: float division by zero produces infinity, not an error
              return ConstValue::fromFloat(*lv / *rv);
            case Bop::EQ: return ConstValue::fromInt(*lv == *rv ? 1 : 0);
            case Bop::NE: return ConstValue::fromInt(*lv != *rv ? 1 : 0);
            case Bop::LT: return ConstValue::fromInt(*lv < *rv ? 1 : 0);
            case Bop::GT: return ConstValue::fromInt(*lv > *rv ? 1 : 0);
            case Bop::LE: return ConstValue::fromInt(*lv <= *rv ? 1 : 0);
            case Bop::GE: return ConstValue::fromInt(*lv >= *rv ? 1 : 0);
            default: return std::nullopt;  // Bitwise ops not valid for floats
          }
        } else {
          auto lv = left->asInt();
          auto rv = right->asInt();
          if (!lv || !rv) return std::nullopt;
          switch (bin->op) {
            case Bop::ADD: return ConstValue::fromInt(*lv + *rv);
            case Bop::SUB: return ConstValue::fromInt(*lv - *rv);
            case Bop::MUL: return ConstValue::fromInt(*lv * *rv);
            case Bop::DIV:
              if (*rv == 0) return std::nullopt;
              return ConstValue::fromInt(*lv / *rv);
            case Bop::MOD:
              if (*rv == 0) return std::nullopt;
              return ConstValue::fromInt(*lv % *rv);
            case Bop::BAND: return ConstValue::fromInt(*lv & *rv);
            case Bop::BOR: return ConstValue::fromInt(*lv | *rv);
            case Bop::BXOR: return ConstValue::fromInt(*lv ^ *rv);
            case Bop::SHL: return ConstValue::fromInt(*lv << *rv);
            case Bop::SHR: return ConstValue::fromInt(*lv >> *rv);
            case Bop::EQ: return ConstValue::fromInt(*lv == *rv ? 1 : 0);
            case Bop::NE: return ConstValue::fromInt(*lv != *rv ? 1 : 0);
            case Bop::LT: return ConstValue::fromInt(*lv < *rv ? 1 : 0);
            case Bop::GT: return ConstValue::fromInt(*lv > *rv ? 1 : 0);
            case Bop::LE: return ConstValue::fromInt(*lv <= *rv ? 1 : 0);
            case Bop::GE: return ConstValue::fromInt(*lv >= *rv ? 1 : 0);
            default: return std::nullopt;  // Assignment operators not valid
          }
        }
      }

      case ExprKind::UNARY: {
        EUnary *un = expr.as.unary;

        // Handle address-of operator specially (don't evaluate operand)
        if (un->op == Uop::OP_ADDR) {
          Expr operandExpr = un->operand;
          // &lvalue => evaluate operand as an lvalue (get its address)
          if (auto addr = evaluateLValue(operandExpr))
            return ConstValue::fromAddress(*addr);
          // &function => function pointer
          if (operandExpr.kind == ExprKind::IDENT && getFunctionIndex) {
            EIdent *ident = operandExpr.as.ident;
            if (ident->decl.kind == DeclKind::FUNC) {
              DFunc *func = ident->decl.as.func;
              if (func->definition) func = func->definition;
              auto idx = getFunctionIndex(func);
              if (idx) return ConstValue::fromAddress(*idx);
            }
          }
          return std::nullopt;
        }

        auto operand = evaluate(un->operand);
        if (!operand) return std::nullopt;

        switch (un->op) {
          case Uop::OP_POS: return operand;
          case Uop::OP_NEG:
            if (operand->kind == ConstValue::INT) {
              return ConstValue::fromInt(-operand->intVal);
            } else if (operand->kind == ConstValue::FLOAT) {
              return ConstValue::fromFloat(-operand->floatVal);
            }
            return std::nullopt;
          case Uop::OP_LNOT: {
            auto v = operand->asInt();
            if (!v) {
              auto f = operand->asFloat();
              if (!f) return std::nullopt;
              return ConstValue::fromInt(*f == 0.0 ? 1 : 0);
            }
            return ConstValue::fromInt(*v == 0 ? 1 : 0);
          }
          case Uop::OP_BNOT: {
            auto v = operand->asInt();
            if (!v) return std::nullopt;
            return ConstValue::fromInt(~(*v));
          }
          case Uop::OP_DEREF:
            // *ptr - can't dereference at compile time
            return std::nullopt;
          default: return std::nullopt;  // ++, -- not supported
        }
      }

      case ExprKind::TERNARY: {
        ETernary *tern = expr.as.ternary;
        auto cond = evaluate(tern->condition);
        if (!cond) return std::nullopt;
        auto cv = cond->asInt();
        if (!cv) {
          auto fv = cond->asFloat();
          if (!fv) return std::nullopt;
          return evaluate(*fv != 0.0 ? tern->thenExpr : tern->elseExpr);
        }
        return evaluate(*cv != 0 ? tern->thenExpr : tern->elseExpr);
      }

      case ExprKind::CAST: {
        ECast *cast = expr.as.cast;
        auto operand = evaluate(cast->expr);
        if (!operand) return std::nullopt;

        Type target = cast->targetType;
        if (target.isFloatingPoint()) {
          auto v = operand->asFloat();
          if (!v) return std::nullopt;
          return ConstValue::fromFloat(*v);
        } else if (target.isInteger() || target.isPointer()) {
          auto v = operand->asInt();
          if (!v) return std::nullopt;
          return ConstValue::fromInt(truncateConstInt(*v, target));
        }
        return std::nullopt;
      }

      case ExprKind::IMPLICIT_CAST: {
        EImplicitCast *ic = expr.as.implicitCast;
        auto operand = evaluate(ic->expr);
        if (!operand) return std::nullopt;

        Type target = ic->type;
        if (target.isFloatingPoint()) {
          auto v = operand->asFloat();
          if (!v) return std::nullopt;
          return ConstValue::fromFloat(*v);
        } else if (target.isInteger() || target.isPointer()) {
          auto v = operand->asInt();
          if (!v) return std::nullopt;
          return ConstValue::fromInt(truncateConstInt(*v, target));
        }
        return std::nullopt;
      }

      case ExprKind::SIZEOF_EXPR: {
        ESizeOfExpr *se = expr.as.sizeofExpr;
        Type t = se->expr.getType();
        return ConstValue::fromInt(getSizeOf(t));
      }

      case ExprKind::SIZEOF_TYPE: {
        ESizeOfType *st = expr.as.sizeofType;
        return ConstValue::fromInt(getSizeOf(st->operandType));
      }

      case ExprKind::ALIGNOF_EXPR: {
        EAlignOfExpr *ae = expr.as.alignofExpr;
        Type t = ae->expr.getType();
        return ConstValue::fromInt(t.getAlign());
      }

      case ExprKind::ALIGNOF_TYPE: {
        EAlignOfType *at = expr.as.alignofType;
        return ConstValue::fromInt(at->operandType.getAlign());
      }

      case ExprKind::COMPOUND_LITERAL: {
        ECompoundLiteral *cl = expr.as.compoundLiteral;
        // File-scope compound literals: arrays decay to their address
        if (getCompoundLiteralAddress) {
          auto addr = getCompoundLiteralAddress(cl);
          if (addr) {
            if (cl->type.isArray()) {
              return ConstValue::fromAddress(*addr);
            }
          }
        }
        // Scalar compound literal: evaluate the init list element
        if (!cl->type.isArray() && !cl->type.isAggregate() &&
            cl->initList && !cl->initList->elements.empty()) {
          return evaluate(cl->initList->elements[0]);
        }
        return std::nullopt;
      }

      default: return std::nullopt;
    }
  }

  std::optional<i64> evaluateInt(Expr expr) {
    auto result = evaluate(expr);
    if (!result) return std::nullopt;
    return result->asInt();
  }

  std::optional<u32> evaluateAddress(Expr expr) {
    auto result = evaluate(expr);
    if (!result) return std::nullopt;
    return result->asAddress();
  }
};

// Type methods that depend on DTag being fully defined
void Type::setTagDecl(Decl decl) {
  if (isTag()) {
    info->data.tag.tagDecl = decl;
    computeTagSizeAndAlign();
  }
}

void Type::computeTagSizeAndAlign() {
  if (!isTag()) return;

  Decl tagDecl = info->data.tag.tagDecl;
  if (tagDecl.kind != DeclKind::TAG) return;

  DTag *tag = tagDecl.as.tag;
  TagKind tagKind = tag->tagKind;

  if (tagKind == TagKind::ENUM) {
    // Enums have the size/align of int
    info->size = 4;
    info->align = 4;
    info->isComplete = true;
  } else if (tagKind == TagKind::STRUCT) {
    i32 size = 0;
    i32 maxAlign = 1;
    // Bit-field packing state
    i32 bfBitsUsed = 0;       // bits used in current storage unit
    i32 bfUnitSize = 0;       // size of current storage unit in bytes
    Type bfUnitType;          // type of current bit-field storage unit
    bool inBitField = false;  // currently packing bit-fields?

    for (const auto &member : tag->members) {
      if (member.kind == DeclKind::VAR) {
        DVar *memberVar = member.as.var;
        Type memberType = memberVar->type;
        i32 memberAlign = tag->isPacked ? 1 : memberType.getAlign();
        i32 memberSize = memberType.getSize();
        // Honor _Alignas override on struct member
        if (memberVar->requestedAlignment > 0 && memberVar->requestedAlignment > memberAlign) {
          memberAlign = memberVar->requestedAlignment;
        }
        if (memberAlign > maxAlign) maxAlign = memberAlign;

        if (memberVar->isBitField()) {
          i32 bw = memberVar->bitWidth;
          i32 unitBits = memberSize * 8;

          if (bw == 0) {
            // Zero-width bit-field: finish current unit
            if (inBitField) {
              size += bfUnitSize;
              inBitField = false;
              bfBitsUsed = 0;
            }
            // Align to next boundary of this type
            size = (size + memberAlign - 1) & ~(memberAlign - 1);
            continue;
          }

          if (inBitField && memberType.removeQualifiers() == bfUnitType.removeQualifiers() &&
              bfBitsUsed + bw <= unitBits) {
            // Fits in current storage unit
            memberVar->bitOffset = bfBitsUsed;
            memberVar->byteOffset = size;
            bfBitsUsed += bw;
          } else {
            // Finish previous unit if any
            if (inBitField) {
              size += bfUnitSize;
            }
            // Start new storage unit
            size = (size + memberAlign - 1) & ~(memberAlign - 1);
            memberVar->bitOffset = 0;
            memberVar->byteOffset = size;
            bfBitsUsed = bw;
            bfUnitSize = memberSize;
            bfUnitType = memberType;
            inBitField = true;
          }
        } else {
          // Regular (non-bit-field) member: finish any pending bit-field unit
          if (inBitField) {
            size += bfUnitSize;
            inBitField = false;
            bfBitsUsed = 0;
          }
          // Align current offset
          size = (size + memberAlign - 1) & ~(memberAlign - 1);
          memberVar->byteOffset = size;
          size += memberSize;
        }
      }
    }
    // Finish any trailing bit-field unit
    if (inBitField) {
      size += bfUnitSize;
    }
    // Final struct size must be aligned to struct alignment
    size = (size + maxAlign - 1) & ~(maxAlign - 1);
    info->size = size;
    info->align = maxAlign;
    info->isComplete = true;
  } else if (tagKind == TagKind::UNION) {
    i32 maxSize = 0;
    i32 maxAlign = 1;
    for (const auto &member : tag->members) {
      if (member.kind == DeclKind::VAR) {
        DVar *memberVar = member.as.var;
        Type memberType = memberVar->type;
        i32 memberAlign = tag->isPacked ? 1 : memberType.getAlign();
        i32 memberSize = memberType.getSize();
        // Honor _Alignas override on union member
        if (memberVar->requestedAlignment > 0 && memberVar->requestedAlignment > memberAlign) {
          memberAlign = memberVar->requestedAlignment;
        }
        if (memberAlign > maxAlign) maxAlign = memberAlign;
        if (memberSize > maxSize) maxSize = memberSize;
      }
    }
    info->size = maxSize;
    info->align = maxAlign;
    info->isComplete = true;
  }

  // Propagate completion to const/volatile-qualified variants.
  // toggleConst()/toggleVolatile() create separate Info copies that cache
  // a snapshot of size/align/isComplete/tagDecl. When the struct is completed
  // after those copies were made, they become stale. Sync them here.
  auto syncTagInfo = [&](Info *dst) {
    if (dst) {
      dst->size = info->size;
      dst->align = info->align;
      dst->isComplete = info->isComplete;
      dst->data.tag.tagDecl = info->data.tag.tagDecl;
    }
  };
  syncTagInfo(info->cache.flipConstType);
  syncTagInfo(info->cache.flipVolatileType);
  if (info->cache.flipConstType) syncTagInfo(info->cache.flipConstType->cache.flipVolatileType);
  if (info->cache.flipVolatileType) syncTagInfo(info->cache.flipVolatileType->cache.flipConstType);
}

template <typename T, size_t N>
struct ConcatView {
  struct Span {
    const T *data;
    size_t size;
  };
  std::array<Span, N> spans;

  struct Iterator {
    const ConcatView *view;
    size_t spanIdx, elemIdx;
    T operator*() const { return view->spans[spanIdx].data[elemIdx]; }
    Iterator &operator++() {
      if (++elemIdx >= view->spans[spanIdx].size) {
        elemIdx = 0;
        while (++spanIdx < N && view->spans[spanIdx].size == 0) {
        }
      }
      return *this;
    }
    bool operator!=(const Iterator &other) const {
      return spanIdx != other.spanIdx || elemIdx != other.elemIdx;
    }
  };

  Iterator begin() const {
    size_t i = 0;
    while (i < N && spans[i].size == 0) ++i;
    return {this, i, 0};
  }
  Iterator end() const { return {this, N, 0}; }
};

template <typename T, typename... Ranges>
auto concat(const Ranges &...ranges) {
  using View = ConcatView<T, sizeof...(Ranges)>;
  using Span = typename View::Span;
  return View{{Span{ranges.data(), ranges.size()}...}};
}

struct TUnit {
  Symbol filename;
  SrcLoc loc;

  // Functions
  std::vector<DFunc *> importedFunctions;  // __import functions
  std::vector<DFunc *> definedFunctions;   // non-static functions with bodies
  std::vector<DFunc *> staticFunctions;    // static functions with bodies
  std::vector<DFunc *> declaredFunctions;  // prototypes without bodies (static & non-static)

  // Variables
  std::vector<DVar *> definedVariables;  // non-extern variables (includes static)
  std::vector<DVar *> externVariables;   // extern variable declarations

  // Local-scope externs (from inside function bodies, need linking)
  std::vector<DVar *> localExternVariables;     // extern vars from funcDef->externLocals
  std::vector<DFunc *> localDeclaredFunctions;  // func decls from funcDef->externLocalFuncs

  std::vector<Symbol> requiredSources;

  // __minstack directive: minimum stack size in bytes (0 = no request)
  u32 minStackBytes = 0;

  // __export directives: (exportName, func)
  std::vector<std::pair<Symbol, DFunc *>> exportDirectives;

  // #pragma custom_section directives: (sectionName, content)
  std::vector<std::pair<std::string, std::string>> customSections;

  // __exception tags declared in this unit
  std::vector<ExceptionTag *> exceptionTags;

  // Symbols referenced at file scope (global variable initializers, etc.)
  std::set<Decl> globalUsedSymbols;

  // Compound literals at file scope (static storage duration)
  std::vector<ECompoundLiteral *> fileScopeCompoundLiterals;

  std::string toString(u32 depth = 0) const;
};

Type Expr::getType() const {
  switch (kind) {
    case ExprKind::INT: return as.intLit->type;
    case ExprKind::FLOAT: return as.floatLit->type;
    case ExprKind::STRING: return as.stringLit->type;
    case ExprKind::IDENT: return as.ident->type;
    case ExprKind::BINARY: return as.binary->type;
    case ExprKind::UNARY: return as.unary->type;
    case ExprKind::TERNARY: return as.ternary->type;
    case ExprKind::CALL: return as.call->type;
    case ExprKind::SUBSCRIPT: return as.subscript->type;
    case ExprKind::MEMBER: return as.member->type;
    case ExprKind::ARROW: return as.arrow->type;
    case ExprKind::CAST: return as.cast->type;
    case ExprKind::SIZEOF_EXPR: return as.sizeofExpr->type;
    case ExprKind::SIZEOF_TYPE: return as.sizeofType->type;
    case ExprKind::ALIGNOF_EXPR: return as.alignofExpr->type;
    case ExprKind::ALIGNOF_TYPE: return as.alignofType->type;
    case ExprKind::COMMA: return as.comma->type;
    case ExprKind::INIT_LIST: return as.initList->type;
    case ExprKind::INTRINSIC: return as.intrinsic->type;
    case ExprKind::WASM: return as.wasm->type;
    case ExprKind::COMPOUND_LITERAL: return as.compoundLiteral->type;
    case ExprKind::IMPLICIT_CAST: return as.implicitCast->type;
    default: panicf("Expr::getType() called on unknown expression kind"); return TUNKNOWN;
  }
}

// --- Debugging ---

struct DumpContext {
  std::map<uintptr_t, int> idMap;
  int nextId = 1;

  std::string formatId(uintptr_t raw) {
    if (raw == 0) return "$0";
    auto it = idMap.find(raw);
    if (it != idMap.end()) return "$" + std::to_string(it->second);
    int id = nextId++;
    idMap[raw] = id;
    return "$" + std::to_string(id);
  }

  std::string formatDeclId(const Decl &decl) {
    return formatId(decl.getRawId());
  }

  std::string formatDeclIdOfDefinition(const Decl &decl) {
    uintptr_t defnId = 0;
    if (decl.kind == DeclKind::FUNC) {
      defnId = Decl{decl.as.func->definition}.getRawId();
    } else if (decl.kind == DeclKind::VAR) {
      defnId = Decl{decl.as.var->definition}.getRawId();
    } else {
      defnId = decl.getRawId();
    }
    return formatId(defnId);
  }
};

std::string indentation(u32 indent) { return "\n" + std::string(indent * 2, ' '); }

// Forward declarations for dump methods
std::string dumpExpr(const Expr &expr, DumpContext &ctx, u32 indent);
std::string dumpStmt(const Stmt &stmt, DumpContext &ctx, u32 indent);
std::string dumpDecl(const Decl &decl, DumpContext &ctx, u32 indent);

std::string dumpTUnit(const TUnit &unit, DumpContext &ctx, u32 depth) {
  std::string ret = indentation(depth);
  ret += "Translation Unit " + *unit.filename;
  auto show = [&](auto *p) { ret += dumpDecl(Decl(p), ctx, depth + 1); };
  for (auto *f : unit.importedFunctions) show(f);
  for (auto *f : unit.definedFunctions) show(f);
  for (auto *f : unit.staticFunctions) show(f);
  for (auto *f : unit.declaredFunctions) show(f);
  for (auto *f : unit.localDeclaredFunctions) show(f);
  for (auto *v : unit.definedVariables) show(v);
  for (auto *v : unit.externVariables) show(v);
  for (auto *v : unit.localExternVariables) show(v);
  return ret;
}

uintptr_t Decl::getRawIdOfDefinition() const {
  if (kind == DeclKind::FUNC) {
    return Decl{as.func->definition}.getRawId();
  } else if (kind == DeclKind::VAR) {
    return Decl{as.var->definition}.getRawId();
  }
  return getRawId();
}

std::string dumpDecl(const Decl &decl, DumpContext &ctx, u32 indent) {
  auto ret = indentation(indent);
  ret += "Decl ";
  ret += strDeclKind(decl.kind);
  ret += " " + ctx.formatDeclId(decl);
  auto defnStr = ctx.formatDeclIdOfDefinition(decl);
  if (defnStr != ctx.formatDeclId(decl)) {
    ret += " (def=" + defnStr + ")";
  }
  ret += ":";
  if (decl.kind == DeclKind::VAR) {
    ret += " " + *decl.as.var->name;
    ret += " " + decl.as.var->type.toString();
    if (decl.as.var->storageClass != StorageClass::NONE) {
      ret += " (";
      ret += strStorageClass(decl.as.var->storageClass);
      ret += ")";
    }
    if (decl.as.var->initExpr) {
      ret += dumpExpr(decl.as.var->initExpr, ctx, indent + 1);
    }
  } else if (decl.kind == DeclKind::FUNC) {
    ret += " " + *decl.as.func->name;
    ret += " " + decl.as.func->type.toString();
    if (decl.as.func->storageClass != StorageClass::NONE) {
      ret += " (";
      ret += strStorageClass(decl.as.func->storageClass);
      ret += ")";
    }
    ret += indentation(indent + 1);
    ret += std::to_string(decl.as.func->parameters.size()) + " parameters";
    for (const auto &param : decl.as.func->parameters) {
      ret += dumpDecl(param, ctx, indent + 2);
    }
    if (decl.as.func->body) {
      ret += dumpStmt(decl.as.func->body, ctx, indent + 1);
    }
  }
  return ret;
}

// Keep old toString for backward compat (used by error messages, etc.)
std::string Decl::toString(u32 indent) const {
  DumpContext ctx;
  return dumpDecl(*this, ctx, indent);
}

SrcLoc Expr::getLoc() const {
  switch (kind) {
    case ExprKind::INT: return as.intLit->loc;
    case ExprKind::FLOAT: return as.floatLit->loc;
    case ExprKind::STRING: return as.stringLit->loc;
    case ExprKind::IDENT: return as.ident->loc;
    case ExprKind::BINARY: return as.binary->loc;
    case ExprKind::UNARY: return as.unary->loc;
    case ExprKind::TERNARY: return as.ternary->loc;
    case ExprKind::CALL: return as.call->loc;
    case ExprKind::SUBSCRIPT: return as.subscript->loc;
    case ExprKind::MEMBER: return as.member->loc;
    case ExprKind::ARROW: return as.arrow->loc;
    case ExprKind::CAST: return as.cast->loc;
    case ExprKind::SIZEOF_EXPR: return as.sizeofExpr->loc;
    case ExprKind::SIZEOF_TYPE: return as.sizeofType->loc;
    case ExprKind::ALIGNOF_EXPR: return as.alignofExpr->loc;
    case ExprKind::ALIGNOF_TYPE: return as.alignofType->loc;
    case ExprKind::COMMA: return as.comma->loc;
    case ExprKind::INIT_LIST: return as.initList->loc;
    case ExprKind::INTRINSIC: return as.intrinsic->loc;
    case ExprKind::WASM: return as.wasm->loc;
    case ExprKind::COMPOUND_LITERAL: return as.compoundLiteral->loc;
    case ExprKind::IMPLICIT_CAST: return as.implicitCast->loc;
  }
  return SrcLoc{};
}

SrcLoc Stmt::getLoc() const {
  switch (kind) {
    case StmtKind::EXPR: return as.exprStmt->loc;
    case StmtKind::DECL: return as.declStmt->loc;
    case StmtKind::COMPOUND: return as.compound->loc;
    case StmtKind::IF: return as.ifStmt->loc;
    case StmtKind::WHILE: return as.whileStmt->loc;
    case StmtKind::DO_WHILE: return as.doWhileStmt->loc;
    case StmtKind::FOR: return as.forStmt->loc;
    case StmtKind::BREAK: return as.breakStmt->loc;
    case StmtKind::CONTINUE: return as.continueStmt->loc;
    case StmtKind::RETURN: return as.returnStmt->loc;
    case StmtKind::SWITCH: return as.switchStmt->loc;
    case StmtKind::GOTO: return as.gotoStmt->loc;
    case StmtKind::LABEL: return as.labelStmt->loc;
    case StmtKind::TRY_CATCH: return as.tryCatch->loc;
    case StmtKind::THROW: return as.throwStmt->loc;
    case StmtKind::EMPTY: return SrcLoc{};
  }
  return SrcLoc{};
}

SrcLoc Decl::getLoc() const {
  switch (kind) {
    case DeclKind::VAR: return as.var->loc;
    case DeclKind::FUNC: return as.func->loc;
    case DeclKind::TAG: return as.tag->loc;
    case DeclKind::ENUM_CONST: return as.enumConst->loc;
    default: panicf("Decl::getLoc() called on unknown declaration kind"); return SrcLoc{};
  }
}

std::string dumpStmt(const Stmt &stmt, DumpContext &ctx, u32 indent) {
  auto ret = indentation(indent);
  ret += "Stmt ";
  ret += strStmtKind(stmt.kind);
  ret += ":";
  switch (stmt.kind) {
    case StmtKind::EXPR:
      ret += dumpExpr(stmt.as.exprStmt->expr, ctx, indent + 1);
      break;
    case StmtKind::RETURN:
      if (stmt.as.returnStmt->expr) {
        ret += dumpExpr(stmt.as.returnStmt->expr, ctx, indent + 1);
      } else {
        ret += " (no expression)";
      }
      break;
    case StmtKind::DECL:
      for (const auto &d : stmt.as.declStmt->declarations) {
        ret += dumpDecl(d, ctx, indent + 1);
      }
      break;
    case StmtKind::COMPOUND:
      ret += " " + std::to_string(stmt.as.compound->statements.size()) + " statements";
      for (const auto &s : stmt.as.compound->statements) {
        ret += dumpStmt(s, ctx, indent + 1);
      }
      break;
    case StmtKind::GOTO:
      ret += " " + stmt.as.gotoStmt->label;
      break;
    case StmtKind::LABEL:
      ret += " " + stmt.as.labelStmt->name;
      break;
    case StmtKind::IF:
      ret += dumpExpr(stmt.as.ifStmt->condition, ctx, indent + 1);
      ret += dumpStmt(stmt.as.ifStmt->thenBranch, ctx, indent + 1);
      if (stmt.as.ifStmt->elseBranch) {
        ret += dumpStmt(stmt.as.ifStmt->elseBranch, ctx, indent + 1);
      }
      break;
    case StmtKind::WHILE:
      ret += dumpExpr(stmt.as.whileStmt->condition, ctx, indent + 1);
      ret += dumpStmt(stmt.as.whileStmt->body, ctx, indent + 1);
      break;
    case StmtKind::DO_WHILE:
      ret += dumpStmt(stmt.as.doWhileStmt->body, ctx, indent + 1);
      ret += dumpExpr(stmt.as.doWhileStmt->condition, ctx, indent + 1);
      break;
    case StmtKind::FOR:
      if (stmt.as.forStmt->init) {
        ret += dumpStmt(stmt.as.forStmt->init, ctx, indent + 1);
      } else {
        ret += indentation(indent + 1) + "(no init)";
      }
      if (stmt.as.forStmt->condition) {
        ret += dumpExpr(stmt.as.forStmt->condition, ctx, indent + 1);
      } else {
        ret += indentation(indent + 1) + "(no condition)";
      }
      if (stmt.as.forStmt->increment) {
        ret += dumpExpr(stmt.as.forStmt->increment, ctx, indent + 1);
      } else {
        ret += indentation(indent + 1) + "(no increment)";
      }
      ret += dumpStmt(stmt.as.forStmt->body, ctx, indent + 1);
      break;
    case StmtKind::SWITCH:
      ret += dumpExpr(stmt.as.switchStmt->expr, ctx, indent + 1);
      ret += indentation(indent + 1);
      ret += std::to_string(stmt.as.switchStmt->cases.size()) + " cases";
      for (const auto &c : stmt.as.switchStmt->cases) {
        ret += indentation(indent + 2);
        if (c.isDefault) {
          ret += "default: @" + std::to_string(c.stmtIndex);
        } else {
          ret += "case " + std::to_string(c.value) + ": @" + std::to_string(c.stmtIndex);
        }
      }
      ret += dumpStmt(Stmt(stmt.as.switchStmt->body), ctx, indent + 1);
      break;
    case StmtKind::TRY_CATCH:
      ret += dumpStmt(stmt.as.tryCatch->tryBody, ctx, indent + 1);
      for (const auto &cc : stmt.as.tryCatch->catches) {
        ret += indentation(indent + 1);
        if (cc.tag) {
          ret += "catch " + *cc.tag->name;
        } else {
          ret += "catch_all";
        }
        ret += dumpStmt(cc.body, ctx, indent + 2);
      }
      break;
    case StmtKind::THROW:
      ret += " " + *stmt.as.throwStmt->tag->name;
      for (const auto &arg : stmt.as.throwStmt->args) {
        ret += dumpExpr(arg, ctx, indent + 1);
      }
      break;
    case StmtKind::EMPTY:
    case StmtKind::BREAK:
    case StmtKind::CONTINUE:
      break;
  }
  return ret;
}

std::string Stmt::toString(u32 indent) const {
  DumpContext ctx;
  return dumpStmt(*this, ctx, indent);
}

std::string dumpExpr(const Expr &expr, DumpContext &ctx, u32 indent) {
  std::string ret = indentation(indent);
  ret += "Expr: ";
  ret += "Type=" + expr.getType().toString() + " ";
  switch (expr.kind) {
    case ExprKind::IDENT:
      ret += "IDENT " + *expr.as.ident->name;
      if (expr.as.ident->decl) {
        auto id = ctx.formatDeclId(expr.as.ident->decl);
        auto defnId = ctx.formatDeclIdOfDefinition(expr.as.ident->decl);
        if (id == defnId) {
          ret += " (decl=" + id + ")";
        } else {
          ret += " (decl=" + id + ", defn=" + defnId + ")";
        }
      }
      break;
    case ExprKind::INT:
      ret += "INT " + std::to_string(expr.as.intLit->value);
      break;
    case ExprKind::FLOAT:
      ret += "FLOAT " + std::to_string(expr.as.floatLit->value);
      break;
    case ExprKind::STRING:
      ret += "STRING len=" + std::to_string(expr.as.stringLit->value.size());
      break;
    case ExprKind::BINARY:
      ret += "BINARY " + std::string(strBop(expr.as.binary->op));
      ret += dumpExpr(expr.as.binary->left, ctx, indent + 1);
      ret += dumpExpr(expr.as.binary->right, ctx, indent + 1);
      break;
    case ExprKind::UNARY:
      ret += "UNARY " + std::string(strUop(expr.as.unary->op));
      ret += dumpExpr(expr.as.unary->operand, ctx, indent + 1);
      break;
    case ExprKind::TERNARY:
      ret += "TERNARY";
      ret += dumpExpr(expr.as.ternary->condition, ctx, indent + 1);
      ret += dumpExpr(expr.as.ternary->thenExpr, ctx, indent + 1);
      ret += dumpExpr(expr.as.ternary->elseExpr, ctx, indent + 1);
      break;
    case ExprKind::CALL:
      ret += "CALL " + std::to_string(expr.as.call->arguments.size()) + " args";
      ret += dumpExpr(expr.as.call->callee, ctx, indent + 1);
      for (const auto &arg : expr.as.call->arguments) {
        ret += dumpExpr(arg, ctx, indent + 1);
      }
      break;
    case ExprKind::SUBSCRIPT:
      ret += "SUBSCRIPT";
      ret += dumpExpr(expr.as.subscript->array, ctx, indent + 1);
      ret += dumpExpr(expr.as.subscript->index, ctx, indent + 1);
      break;
    case ExprKind::MEMBER:
      ret += "MEMBER ." + (expr.as.member->memberName ? *expr.as.member->memberName : "(anon)");
      ret += dumpExpr(expr.as.member->base, ctx, indent + 1);
      break;
    case ExprKind::ARROW:
      ret += "ARROW ->" + (expr.as.arrow->memberName ? *expr.as.arrow->memberName : "(anon)");
      ret += dumpExpr(expr.as.arrow->base, ctx, indent + 1);
      break;
    case ExprKind::CAST:
      ret += "CAST " + expr.as.cast->targetType.toString();
      ret += dumpExpr(expr.as.cast->expr, ctx, indent + 1);
      break;
    case ExprKind::SIZEOF_EXPR:
      ret += "SIZEOF_EXPR";
      ret += dumpExpr(expr.as.sizeofExpr->expr, ctx, indent + 1);
      break;
    case ExprKind::SIZEOF_TYPE:
      ret += "SIZEOF_TYPE " + expr.as.sizeofType->operandType.toString();
      break;
    case ExprKind::ALIGNOF_EXPR:
      ret += "ALIGNOF_EXPR";
      ret += dumpExpr(expr.as.alignofExpr->expr, ctx, indent + 1);
      break;
    case ExprKind::ALIGNOF_TYPE:
      ret += "ALIGNOF_TYPE " + expr.as.alignofType->operandType.toString();
      break;
    case ExprKind::COMMA:
      ret += "COMMA " + std::to_string(expr.as.comma->expressions.size());
      for (const auto &e : expr.as.comma->expressions) {
        ret += dumpExpr(e, ctx, indent + 1);
      }
      break;
    case ExprKind::INIT_LIST:
      ret += "INIT_LIST " + std::to_string(expr.as.initList->elements.size());
      for (const auto &e : expr.as.initList->elements) {
        ret += dumpExpr(e, ctx, indent + 1);
      }
      break;
    case ExprKind::INTRINSIC:
      ret += "INTRINSIC " + std::string(strIntrinsicKind(expr.as.intrinsic->kind));
      for (const auto &arg : expr.as.intrinsic->args) {
        ret += dumpExpr(arg, ctx, indent + 1);
      }
      break;
    case ExprKind::WASM:
      ret += "WASM " + std::to_string(expr.as.wasm->bytes.size()) + " bytes";
      ret += " " + std::to_string(expr.as.wasm->args.size()) + " args";
      for (const auto &arg : expr.as.wasm->args) {
        ret += dumpExpr(arg, ctx, indent + 1);
      }
      break;
    case ExprKind::COMPOUND_LITERAL:
      ret += "COMPOUND_LITERAL";
      ret += dumpExpr(Expr(expr.as.compoundLiteral->initList), ctx, indent + 1);
      break;
    case ExprKind::IMPLICIT_CAST:
      ret += "IMPLICIT_CAST " + expr.as.implicitCast->type.toString();
      ret += dumpExpr(expr.as.implicitCast->expr, ctx, indent + 1);
      break;
    default:
      ret += strExprKind(expr.kind);
      break;
  }
  return ret;
}

std::string Expr::toString(u32 indent) const {
  DumpContext ctx;
  return dumpExpr(*this, ctx, indent);
}

std::string TUnit::toString(u32 depth) const {
  DumpContext ctx;
  return dumpTUnit(*this, ctx, depth);
}

// ====================
// Parser
// ====================

template <typename V>
class Scope {
  std::vector<std::map<Symbol, V>> stack = {{}};  // start with a global scope
 public:
  void push() { stack.emplace_back(); }
  void pop() {
    if (!stack.empty()) {
      stack.pop_back();
    }
  }
  bool set(Symbol name, V value) {
    if (stack.empty()) {
      return false;
    }
    auto &current = stack.back();
    if (current.count(name) > 0) {
      return false;  // already exists in current scope
    }
    current[name] = value;
    return true;
  }
  V &get(Symbol name) {
    for (auto it = stack.rbegin(); it != stack.rend(); ++it) {
      auto found = it->find(name);
      if (found != it->end()) {
        return found->second;
      }
    }
    throw std::runtime_error("Symbol not found in any scope");
  }
  const V &get(Symbol name) const {
    for (auto it = stack.rbegin(); it != stack.rend(); ++it) {
      auto found = it->find(name);
      if (found != it->end()) {
        return found->second;
      }
    }
    throw std::runtime_error("Symbol not found in any scope");
  }
  bool has(Symbol name) const {
    for (auto it = stack.rbegin(); it != stack.rend(); ++it) {
      if (it->count(name) > 0) {
        return true;
      }
    }
    return false;
  }
  bool hasInCurrentScope(Symbol name) const {
    if (stack.empty()) return false;
    return stack.back().count(name) > 0;
  }
};

using ParseError = LexError;
using ParseWarning = LexError;

struct ParseResult {
  TUnit translationUnit;
  std::vector<ParseError> errors;
  std::vector<ParseWarning> warnings;
};

// Parse a list of tokens into a ParseResult
//
// NOTE: while we largely try to follow C89, we do have a few extensions
// and a few simplifications. K&R style function definitions are supported
// when --allow-knr-definitions or --allow-old-c is passed.
//
void filterUnusedDeclarations(TUnit &unit) {
  if (compilerOptions.noUndefined) return;

  std::set<Decl> active;
  std::vector<Decl> worklist;

  auto activate = [&](Decl d) {
    if (d && active.insert(d).second) worklist.push_back(d);
  };

  // Seed non-static definitions
  for (auto *f : unit.definedFunctions) {
    if (f->storageClass != StorageClass::STATIC) activate(Decl(f));
  }
  for (auto *v : unit.definedVariables) {
    if (v->storageClass != StorageClass::STATIC) activate(Decl(v));
  }

  // Seed global-scope usages
  for (auto &d : unit.globalUsedSymbols) activate(d);

  // Seed export directives
  for (auto &[name, func] : unit.exportDirectives) activate(Decl(func));

  // Fixed-point walk
  while (!worklist.empty()) {
    Decl d = worklist.back();
    worklist.pop_back();
    if (d.kind == DeclKind::FUNC) {
      DFunc *f = d.as.func;
      if (f->definition && f->definition != f) activate(Decl(f->definition));
      for (auto &used : f->usedSymbols) activate(used);
    } else if (d.kind == DeclKind::VAR) {
      DVar *v = d.as.var;
      if (v->definition && v->definition != v) activate(Decl(v->definition));
    }
  }

  // Filter all lists
  auto filter = [&](auto &vec) {
    std::erase_if(vec, [&](auto *p) { return !active.count(Decl(p)); });
  };
  filter(unit.importedFunctions);
  filter(unit.definedFunctions);
  filter(unit.staticFunctions);
  filter(unit.declaredFunctions);
  filter(unit.definedVariables);
  filter(unit.externVariables);
  filter(unit.localExternVariables);
  filter(unit.localDeclaredFunctions);
}

void gcSections(std::vector<TUnit> &units) {
  std::set<Decl> active;
  std::vector<Decl> worklist;

  auto activate = [&](Decl d) {
    if (d && active.insert(d).second) worklist.push_back(d);
  };

  // Seed entry points
  Symbol mainSym = intern("main");
  Symbol allocaSym = intern("alloca");
  for (auto &unit : units) {
    for (auto *f : unit.definedFunctions) {
      if (f->name == mainSym || f->name == allocaSym) activate(Decl(f));
    }
    for (auto &[name, func] : unit.exportDirectives) activate(Decl(func));
    for (auto &d : unit.globalUsedSymbols) activate(d);
  }

  // Fixed-point walk
  while (!worklist.empty()) {
    Decl d = worklist.back();
    worklist.pop_back();
    if (d.kind == DeclKind::FUNC) {
      DFunc *f = d.as.func;
      if (f->definition && f->definition != f) activate(Decl(f->definition));
      for (auto &used : f->usedSymbols) activate(used);
    } else if (d.kind == DeclKind::VAR) {
      DVar *v = d.as.var;
      if (v->definition && v->definition != v) activate(Decl(v->definition));
    }
  }

  // Filter all TUnit lists
  auto filter = [&](auto &vec) {
    std::erase_if(vec, [&](auto *p) { return !active.count(Decl(p)); });
  };
  for (auto &unit : units) {
    filter(unit.importedFunctions);
    filter(unit.definedFunctions);
    filter(unit.staticFunctions);
    filter(unit.declaredFunctions);
    filter(unit.definedVariables);
    filter(unit.externVariables);
    filter(unit.localExternVariables);
    filter(unit.localDeclaredFunctions);
  }
}

// C99 §6.3.1.8 usual arithmetic conversions.
// Strips qualifiers, ranks float types, promotes small integers, then ranks integer types.
// Used by parser (computeBinaryType, computeTernaryType), codegen, and implicit cast annotation.
static Type usualArithmeticConversions(Type a, Type b) {
  a = a.removeQualifiers();
  b = b.removeQualifiers();
  if (a.isFloatingPoint() || b.isFloatingPoint()) {
    if (a == TLDOUBLE || b == TLDOUBLE) return TLDOUBLE;
    if (a == TDOUBLE || b == TDOUBLE) return TDOUBLE;
    return TFLOAT;
  }
  // Integer promotions: char, short, bool → int
  auto promote = [](Type t) -> Type {
    if (t == TCHAR || t == TSCHAR || t == TUCHAR || t == TSHORT || t == TUSHORT || t == TBOOL)
      return TINT;
    return t;
  };
  a = promote(a);
  b = promote(b);
  if (a == b) return a;
  // C99 §6.3.1.8: rank by size, then handle signed/unsigned conflicts.
  auto isUnsigned = [](Type t) -> bool {
    return t == TUINT || t == TULONG || t == TULLONG;
  };
  auto toUnsigned = [](Type t) -> Type {
    if (t == TINT) return TUINT;
    if (t == TLONG) return TULONG;
    if (t == TLLONG) return TULLONG;
    return t;  // already unsigned
  };
  bool aU = isUnsigned(a), bU = isUnsigned(b);
  i32 aSize = a.getSize(), bSize = b.getSize();
  // Same signedness: higher rank (larger size) wins
  if (aU == bU) return aSize >= bSize ? a : b;
  // Different signedness: identify signed and unsigned operands
  Type signedT = aU ? b : a;
  Type unsignedT = aU ? a : b;
  i32 sSize = signedT.getSize(), uSize = unsignedT.getSize();
  // If unsigned rank >= signed rank, convert to unsigned
  if (uSize >= sSize) return unsignedT;
  // If signed type can represent all values of unsigned, convert to signed
  if (sSize > uSize) return signedT;
  // Otherwise, convert to unsigned version of signed type
  return toUnsigned(signedT);
}

ParseResult parseTokens(std::span<const Token> tokens) {
  ParseResult result;
  if (tokens.empty()) {
    result.errors.push_back({"No tokens to parse", nullptr, 0});
    return result;
  }
  result.translationUnit.filename = tokens[0].filename;

  // The Parser struct encapsulates the state and logic
  struct Parser {
    std::span<const Token> tokens;
    std::vector<ParseError> &errors;
    std::vector<ParseWarning> &warnings;
    size_t pos = 0;

    Scope<Type> typeScope;
    Scope<Type> tagScope;
    Scope<Decl> varScope;

    DFunc *currentParsingFunc = nullptr;
    const Symbol kw__func__ = intern("__func__");
    const Symbol kw__FUNCTION__ = intern("__FUNCTION__");
    int anonCount = 0;
    std::vector<Symbol> requiredSources;
    std::set<Symbol> requiredSourcesSeen;
    std::vector<std::pair<Symbol, DFunc *>> exportDirectives;
    std::vector<ExceptionTag *> parsedExceptionTags;
    std::set<Decl> globalUsedSymbols;
    std::vector<ECompoundLiteral *> fileScopeCompoundLiterals;

    // Goto/label tracking (per function)
    std::map<std::string, SLabel *> parsedLabels;              // labels seen so far
    std::map<std::string, std::vector<SGoto *>> pendingGotos;  // gotos awaiting resolution
    SCompound *currentCompound = nullptr;                      // innermost compound being parsed

    Parser(std::span<const Token> t, std::vector<ParseError> &errors,
        std::vector<ParseWarning> &warnings)
        : tokens(t), errors(errors), warnings(warnings) {
      // Global scope is already pushed by Scope constructor
    }

    // Set allocClass on a DVar based on its type and storage class
    // Aggregates always need MEMORY; extern globals also use MEMORY for simplicity
    void setInitialAllocClass(DVar *var, [[maybe_unused]] bool isGlobal) {
      if (var->type.isAggregate()) {
        var->allocClass = AllocClass::MEMORY;
      } else if (var->storageClass == StorageClass::EXTERN) {
        var->allocClass = AllocClass::MEMORY;
      }
      // else: keep REGISTER (default)
    }

    // --- Token Helpers ---

    bool atEnd() const { return pos >= tokens.size() || tokens[pos].kind == TokenKind::EOS; }

    const Token &peek(int offset = 0) const {
      if (pos + offset >= tokens.size()) return tokens.back();
      return tokens[pos + offset];
    }

    const Token &advance() {
      if (!atEnd()) pos++;
      return tokens[pos - 1];
    }

    bool at(TokenKind kind) const { return !atEnd() && peek().kind == kind; }

    bool at(std::string_view text) const { return !atEnd() && peek().text == text; }

    bool at(Punct p) const { return !atEnd() && peek().atPunct(p); }

    bool at(Keyword keyword) const {
      return !atEnd() && peek().kind == TokenKind::KEYWORD && peek().value.keyword == keyword;
    }

    bool match(TokenKind kind) {
      if (at(kind)) {
        advance();
        return true;
      }
      return false;
    }

    bool match(Keyword keyword) {
      if (at(keyword)) {
        advance();
        return true;
      }
      return false;
    }

    bool match(Punct p) {
      if (at(p)) {
        advance();
        return true;
      }
      return false;
    }

    bool match(std::string_view text) {
      if (at(text)) {
        advance();
        return true;
      }
      return false;
    }

    const Token &expect(Punct p, const std::string &message) {
      if (at(p)) return advance();
      error(peek(), message);
      return tokens[pos];
    }

    const Token &expect(TokenKind kind, const std::string &message) {
      if (at(kind)) return advance();
      error(peek(), message);
      return tokens[pos];
    }

    const Token &expect(Keyword keyword, const std::string &message) {
      if (at(keyword)) return advance();
      error(peek(), message);
      return tokens[pos];
    }

    const Token &expect(std::string_view text, const std::string &message) {
      if (at(text)) return advance();
      error(peek(), message);
      return tokens[pos];
    }

    void recoverableError(const Token &token, const std::string &message) {
      errors.push_back(ParseError{
          message,
          token.filename,
          token.line,
      });
    }

    void warning(const Token &token, const std::string &message) {
      warnings.push_back(ParseWarning{message, token.filename, token.line});
    }

    void error(const Token &token, const std::string &message) {
      throw ParseError{
          message,
          token.filename,
          token.line,
      };
    }

    void error(const std::string &message) { error(peek(), message); }

    // Normalize an initializer list for a given container type using a cursor model.
    // Handles chained designators (.a.b, [i].x, etc.), brace elision, anonymous
    // member lookup, and type propagation in one unified pass.
    // For unsized arrays (arraySize == 0), infers the size and updates initList->type.
    void normalizeInitList(EInitList *initList, Type containerType) {
      SrcLoc loc = initList->loc;
      initList->type = containerType;

      // Save source elements and designators, then clear for output
      std::vector<Expr> src = std::move(initList->elements);
      std::vector<InitDesignator> desigs = std::move(initList->designators);
      initList->elements.clear();
      initList->designators.clear();

      // --- Helper: collect VAR members of a struct/union tag ---
      auto getVarMembers = [](DTag *tag) -> std::vector<DVar *> {
        std::vector<DVar *> result;
        for (const auto &member : tag->members) {
          if (member.kind != DeclKind::VAR) continue;
          if (member.as.var->isBitField() && !member.as.var->name) continue;
          result.push_back(member.as.var);
        }
        return result;
      };

      // --- Helper: child count for an aggregate type ---
      // Returns the number of initializable children.
      // For unsized arrays, returns INT32_MAX (sentinel).
      auto childCount = [&](Type t) -> i32 {
        if (t.isArray()) {
          i32 sz = t.getArraySize();
          return sz == 0 ? INT32_MAX : sz;
        }
        if (t.isTag()) {
          Decl td = t.getTagDecl();
          if (td.kind != DeclKind::TAG) return 0;
          DTag *tag = td.as.tag;
          if (tag->tagKind == TagKind::UNION) return 1;
          // STRUCT: count VAR members
          i32 count = 0;
          for (const auto &m : tag->members) {
            if (m.kind == DeclKind::VAR) count++;
          }
          return count;
        }
        return 0;
      };

      // --- Helper: type of the i-th child of an aggregate ---
      auto childType = [&](Type t, i32 index, EInitList *output) -> Type {
        if (t.isArray()) return t.getArrayBase();
        if (t.isTag()) {
          Decl td = t.getTagDecl();
          if (td.kind != DeclKind::TAG) return Type();
          DTag *tag = td.as.tag;
          if (tag->tagKind == TagKind::UNION) {
            // Use unionMemberIndex from the output init list
            auto members = getVarMembers(tag);
            i32 umi = output->unionMemberIndex;
            if (umi >= 0 && umi < static_cast<i32>(members.size())) {
              return members[umi]->type;
            }
            return members.empty() ? Type() : members[0]->type;
          }
          // STRUCT
          auto members = getVarMembers(tag);
          if (index >= 0 && index < static_cast<i32>(members.size())) {
            return members[index]->type;
          }
        }
        return Type();
      };

      // --- Helper: create a zero expression for a given type ---
      auto makeZero = [&](Type t) -> Expr {
        if (t.isFloatingPoint()) {
          return Expr(new EFloat{loc, t, 0.0});
        }
        return Expr(new EInt{loc, TINT, 0});
      };

      // --- Cursor: stack of levels tracking position in the type tree ---
      struct CursorLevel {
        Type type;
        i32 index;
        i32 count;
        EInitList *output;
      };
      std::vector<CursorLevel> stack;

      // --- Helper: ensure output has a slot at 'index'; grow if needed ---
      auto ensureSlot = [&](EInitList *list, i32 index) {
        if (index >= static_cast<i32>(list->elements.size())) {
          list->elements.resize(index + 1, nullptr);
        }
      };

      // --- Helper: ensure output[index] is a sub-EInitList for an aggregate child ---
      auto ensureSubList = [&](EInitList *list, i32 index, Type subType) -> EInitList * {
        ensureSlot(list, index);
        if (list->elements[index] == nullptr || list->elements[index].kind != ExprKind::INIT_LIST) {
          auto *sub = new EInitList{loc, subType, {}, {}, 0};
          // Pre-allocate elements for sized aggregates
          i32 cc = childCount(subType);
          if (cc != INT32_MAX && cc > 0) {
            sub->elements.resize(cc, nullptr);
          }
          list->elements[index] = Expr(sub);
        }
        return list->elements[index].as.initList;
      };

      // --- Helper: advance cursor to next position after placing an element ---
      auto advance = [&]() {
        while (!stack.empty()) {
          stack.back().index++;
          if (stack.back().index < stack.back().count) return;
          stack.pop_back();
        }
      };

      // --- Helper: descend into current slot (for brace elision) ---
      auto descend = [&]() {
        auto &top = stack.back();
        Type slotType = childType(top.type, top.index, top.output);
        EInitList *sub = ensureSubList(top.output, top.index, slotType);
        i32 cc = childCount(slotType);
        stack.push_back({slotType, 0, cc, sub});
      };

      // Initialize root level
      i32 rootCount = childCount(containerType);
      if (rootCount != INT32_MAX && rootCount > 0) {
        initList->elements.resize(rootCount, nullptr);
      }
      stack.push_back({containerType, 0, rootCount, initList});

      // Track max extent for unsized arrays
      i32 maxExtent = 0;

      ConstEval eval([](Type t) { return t.getSize(); });

      size_t srcIdx = 0;
      while (srcIdx < src.size()) {
        // 1. Handle designator — reset cursor to root and navigate
        bool hasDesig = srcIdx < desigs.size() && !desigs[srcIdx].steps.empty();
        if (!hasDesig && stack.empty()) break;
        if (hasDesig) {
          auto &steps = desigs[srcIdx].steps;

          // Reset to root (rebuild if stack was emptied by advance)
          stack.clear();
          stack.push_back({containerType, 0, rootCount, initList});

          for (size_t si = 0; si < steps.size(); si++) {
            auto &step = steps[si];
            auto &top = stack.back();

            if (step.kind == DesigStep::FIELD) {
              // Resolve field name — may need to navigate through anonymous members
              if (!top.type.isTag()) {
                error("Field designator on non-struct/union type");
                goto done;
              }
              Decl td = top.type.getTagDecl();
              if (td.kind != DeclKind::TAG) {
                error("Field designator on incomplete type");
                goto done;
              }
              DTag *tag = td.as.tag;

              if (tag->tagKind == TagKind::UNION) {
                // For unions: find the member, set unionMemberIndex, index stays 0
                auto members = getVarMembers(tag);
                bool found = false;
                for (i32 j = 0; j < static_cast<i32>(members.size()); j++) {
                  if (members[j]->name == step.fieldName) {
                    top.output->unionMemberIndex = j;
                    top.index = 0;
                    found = true;
                    break;
                  }
                }
                if (!found) {
                  error("Field '" + std::string(*step.fieldName) + "' not found in union");
                  goto done;
                }
              } else {
                // Struct: use findMemberChain for anonymous member support
                std::vector<DVar *> chain;
                if (!findMemberChain(tag, step.fieldName, chain)) {
                  error("Field '" + std::string(*step.fieldName) + "' not found in struct");
                  goto done;
                }
                // Navigate through anonymous intermediaries
                for (size_t ci = 0; ci < chain.size(); ci++) {
                  DVar *member = chain[ci];
                  auto members = getVarMembers(td.as.tag);
                  bool foundMember = false;
                  for (i32 j = 0; j < static_cast<i32>(members.size()); j++) {
                    if (members[j] == member) {
                      if (td.as.tag->tagKind == TagKind::UNION) {
                        stack.back().output->unionMemberIndex = j;
                        stack.back().index = 0;
                      } else {
                        stack.back().index = j;
                      }
                      foundMember = true;
                      break;
                    }
                  }
                  if (!foundMember) {
                    error("Internal error: member chain lookup failed");
                    goto done;
                  }
                  // If not the final member in chain, descend into anonymous aggregate
                  if (ci < chain.size() - 1) {
                    descend();
                    // Update td for next iteration
                    td = chain[ci]->type.getTagDecl();
                  }
                }
              }
            } else {
              // INDEX designator
              if (!top.type.isArray()) {
                error("Array designator on non-array type");
                goto done;
              }
              auto val = eval.evaluate(step.indexExpr);
              if (!val) {
                error("Designator index is not a constant expression");
                goto done;
              }
              top.index = static_cast<i32>(val->intVal);
              // Grow output if needed (for unsized or if index exceeds current size)
              ensureSlot(top.output, top.index);
            }

            // If not the last step, descend into the current slot
            if (si + 1 < steps.size()) {
              descend();
            }
          }
        }

        if (stack.empty()) break;

        // 2. Place element — descend through aggregates for brace elision
        //    in a local loop so we don't re-trigger designator processing
        while (!stack.empty()) {
          auto &top = stack.back();
          ensureSlot(top.output, top.index);
          Type slotType = childType(top.type, top.index, top.output);

          if (src[srcIdx].kind == ExprKind::INIT_LIST) {
            // Braced sub-init-list: place and recurse
            top.output->elements[top.index] = std::move(src[srcIdx]);
            normalizeInitList(top.output->elements[top.index].as.initList, slotType);
            srcIdx++;
            if (top.index + 1 > maxExtent) maxExtent = top.index + 1;
            advance();
            break;
          } else if (src[srcIdx].kind == ExprKind::STRING && slotType.isArray()) {
            // String literal for char array
            top.output->elements[top.index] = std::move(src[srcIdx]);
            srcIdx++;
            if (top.index + 1 > maxExtent) maxExtent = top.index + 1;
            advance();
            break;
          } else if (slotType.isAggregate() &&
                     src[srcIdx].getType().removeQualifiers().isCompatibleWith(slotType.removeQualifiers())) {
            // Aggregate expression matching slot type: place directly (e.g. struct B b at struct B slot)
            top.output->elements[top.index] = std::move(src[srcIdx]);
            srcIdx++;
            if (top.index + 1 > maxExtent) maxExtent = top.index + 1;
            advance();
            break;
          } else if (slotType.isAggregate()) {
            // Brace elision: descend into aggregate without consuming srcIdx
            descend();
            continue;
          } else {
            // Scalar at scalar slot
            top.output->elements[top.index] = std::move(src[srcIdx]);
            srcIdx++;
            if (top.index + 1 > maxExtent) maxExtent = top.index + 1;
            advance();
            break;
          }
        }
      }

    done:
      // For unsized arrays, finalize type based on actual extent
      if (containerType.isArray() && containerType.getArraySize() == 0) {
        // maxExtent tracks the root level; also account for elements already in output
        i32 finalSize = std::max(maxExtent, static_cast<i32>(initList->elements.size()));
        Type elemType = containerType.getArrayBase();
        initList->type = Type::arrayOf(elemType, finalSize);
        initList->elements.resize(finalSize, nullptr);
      }

      // fillZeros: recursively replace null elements with zero values
      std::function<void(EInitList *, Type)> fillZeros = [&](EInitList *list, Type type) {
        if (type.isArray()) {
          Type elemType = type.getArrayBase();
          i32 sz = type.getArraySize();
          // For incomplete arrays (FAM), don't truncate existing elements
          if (sz > 0) list->elements.resize(sz, nullptr);
          sz = static_cast<i32>(list->elements.size());
          for (i32 i = 0; i < sz; i++) {
            if (list->elements[i] == nullptr) {
              if (elemType.isAggregate()) {
                auto *sub = new EInitList{loc, elemType, {}, {}, 0};
                list->elements[i] = Expr(sub);
                fillZeros(sub, elemType);
              } else {
                list->elements[i] = makeZero(elemType);
              }
            } else if (list->elements[i].kind == ExprKind::INIT_LIST) {
              fillZeros(list->elements[i].as.initList, elemType);
            }
          }
        } else if (type.isTag()) {
          Decl td = type.getTagDecl();
          if (td.kind != DeclKind::TAG) return;
          DTag *tag = td.as.tag;
          if (tag->tagKind == TagKind::STRUCT) {
            auto members = getVarMembers(tag);
            i32 mc = static_cast<i32>(members.size());
            list->elements.resize(mc, nullptr);
            for (i32 i = 0; i < mc; i++) {
              Type mt = members[i]->type;
              if (list->elements[i] == nullptr) {
                if (mt.isAggregate()) {
                  auto *sub = new EInitList{loc, mt, {}, {}, 0};
                  list->elements[i] = Expr(sub);
                  fillZeros(sub, mt);
                } else {
                  list->elements[i] = makeZero(mt);
                }
              } else if (list->elements[i].kind == ExprKind::INIT_LIST) {
                fillZeros(list->elements[i].as.initList, mt);
              }
            }
          } else if (tag->tagKind == TagKind::UNION) {
            // Union: ensure single element exists
            if (list->elements.empty() || list->elements[0] == nullptr) {
              list->elements.resize(1, nullptr);
              auto members = getVarMembers(tag);
              i32 umi = list->unionMemberIndex;
              if (umi >= 0 && umi < static_cast<i32>(members.size())) {
                Type mt = members[umi]->type;
                if (mt.isAggregate()) {
                  auto *sub = new EInitList{loc, mt, {}, {}, 0};
                  list->elements[0] = Expr(sub);
                  fillZeros(sub, mt);
                } else {
                  list->elements[0] = makeZero(mt);
                }
              }
            } else if (list->elements[0].kind == ExprKind::INIT_LIST) {
              auto members = getVarMembers(tag);
              i32 umi = list->unionMemberIndex;
              if (umi >= 0 && umi < static_cast<i32>(members.size())) {
                fillZeros(list->elements[0].as.initList, members[umi]->type);
              }
            }
          }
        }
      };
      fillZeros(initList, initList->type);
    }

    // Check if the current token starts a type-name or declaration.
    // Used both for cast detection and for distinguishing declarations from expressions.
    bool isTypeName(const Token &t) {
      if (t.kind == TokenKind::KEYWORD) {
        switch (t.value.keyword) {
          // Type specifiers
          case Keyword::VOID:
          case Keyword::BOOL:
          case Keyword::CHAR:
          case Keyword::SHORT:
          case Keyword::INT:
          case Keyword::LONG:
          case Keyword::FLOAT:
          case Keyword::DOUBLE:
          case Keyword::SIGNED:
          case Keyword::UNSIGNED:
          case Keyword::STRUCT:
          case Keyword::UNION:
          case Keyword::ENUM:
          // Type qualifiers (a type-name can start with these)
          case Keyword::CONST:
          case Keyword::VOLATILE:
          case Keyword::RESTRICT:
          // Storage class (not a type, but starts a declaration)
          case Keyword::TYPEDEF:
          case Keyword::STATIC:
          case Keyword::EXTERN:
          case Keyword::REGISTER:
          case Keyword::AUTO:
          // Alignment specifier (starts a declaration)
          case Keyword::ALIGNAS:
          case Keyword::THREAD_LOCAL: return true;
          default: return false;
        }
      }
      if (t.kind == TokenKind::IDENT) {
        return typeScope.has(intern(t.text));
      }
      return false;
    }

    // --- Expression Parsing (Pratt-style precedence climbing) ---

    // Precedence levels for binary operators (higher = binds tighter)
    int getBinaryPrecedence(std::string_view op) {
      if (op == ",") return 1;
      if (op == "=" || op == "+=" || op == "-=" || op == "*=" || op == "/=" || op == "%=" ||
          op == "&=" || op == "|=" || op == "^=" || op == "<<=" || op == ">>=")
        return 2;
      if (op == "?") return 3;  // Ternary ?: handled specially
      if (op == "||") return 4;
      if (op == "&&") return 5;
      if (op == "|") return 6;
      if (op == "^") return 7;
      if (op == "&") return 8;
      if (op == "==" || op == "!=") return 9;
      if (op == "<" || op == ">" || op == "<=" || op == ">=") return 10;
      if (op == "<<" || op == ">>") return 11;
      if (op == "+" || op == "-") return 12;
      if (op == "*" || op == "/" || op == "%") return 13;
      return 0;  // not a binary operator
    }

    bool isRightAssociative(std::string_view op) {
      return op == "=" || op == "+=" || op == "-=" || op == "*=" || op == "/=" || op == "%=" ||
          op == "&=" || op == "|=" || op == "^=" || op == "<<=" || op == ">>=";
    }

    Bop textToBop(std::string_view op) {
      if (op == "+") return Bop::ADD;
      if (op == "-") return Bop::SUB;
      if (op == "*") return Bop::MUL;
      if (op == "/") return Bop::DIV;
      if (op == "%") return Bop::MOD;
      if (op == "==") return Bop::EQ;
      if (op == "!=") return Bop::NE;
      if (op == "<") return Bop::LT;
      if (op == ">") return Bop::GT;
      if (op == "<=") return Bop::LE;
      if (op == ">=") return Bop::GE;
      if (op == "&&") return Bop::LAND;
      if (op == "||") return Bop::LOR;
      if (op == "&") return Bop::BAND;
      if (op == "|") return Bop::BOR;
      if (op == "^") return Bop::BXOR;
      if (op == "<<") return Bop::SHL;
      if (op == ">>") return Bop::SHR;
      if (op == "=") return Bop::ASSIGN;
      if (op == "+=") return Bop::ADD_ASSIGN;
      if (op == "-=") return Bop::SUB_ASSIGN;
      if (op == "*=") return Bop::MUL_ASSIGN;
      if (op == "/=") return Bop::DIV_ASSIGN;
      if (op == "%=") return Bop::MOD_ASSIGN;
      if (op == "&=") return Bop::BAND_ASSIGN;
      if (op == "|=") return Bop::BOR_ASSIGN;
      if (op == "^=") return Bop::BXOR_ASSIGN;
      if (op == "<<=") return Bop::SHL_ASSIGN;
      if (op == ">>=") return Bop::SHR_ASSIGN;
      panicf("Unknown binary operator: %s", std::string(op).c_str());
      return Bop::ADD;
    }

    // Apply C99 6.3.1.1 integer promotions for a bitfield expression.
    // A bitfield with width N promotes to signed int if all values fit
    // in int (i.e., width <= 31 for signed, width < 32 for unsigned),
    // otherwise to unsigned int.
    Type promoteExprType(Expr e) {
      Type t = e.getType();
      DVar *bf = nullptr;
      if (e.kind == ExprKind::MEMBER && e.as.member->memberDecl &&
          e.as.member->memberDecl->isBitField()) {
        bf = e.as.member->memberDecl;
      } else if (e.kind == ExprKind::ARROW && e.as.arrow->memberDecl &&
                 e.as.arrow->memberDecl->isBitField()) {
        bf = e.as.arrow->memberDecl;
      }
      if (bf) {
        i32 bw = bf->bitWidth;
        bool isSigned = t.removeQualifiers() == TINT || t.removeQualifiers() == TLONG ||
                        t.removeQualifiers() == TSHORT || t.removeQualifiers() == TSCHAR ||
                        t.removeQualifiers() == TCHAR;
        // If the bitfield fits in a signed int (32-bit), promote to int
        if (isSigned || bw < 32) {
          return TINT;
        }
        return TUINT;
      }
      return t;
    }

    // Compute the result type of a binary expression
    Type computeBinaryType(Bop op, Type leftType, Type rightType) {
      // Comparison and logical operators always return int
      switch (op) {
        case Bop::EQ:
        case Bop::NE:
        case Bop::LT:
        case Bop::GT:
        case Bop::LE:
        case Bop::GE:
        case Bop::LAND:
        case Bop::LOR: return TINT;
        default: break;
      }

      // Assignment operators return the left operand type
      switch (op) {
        case Bop::ASSIGN:
        case Bop::ADD_ASSIGN:
        case Bop::SUB_ASSIGN:
        case Bop::MUL_ASSIGN:
        case Bop::DIV_ASSIGN:
        case Bop::MOD_ASSIGN:
        case Bop::BAND_ASSIGN:
        case Bop::BOR_ASSIGN:
        case Bop::BXOR_ASSIGN:
        case Bop::SHL_ASSIGN:
        case Bop::SHR_ASSIGN: return leftType;
        default: break;
      }

      // Shift operators: result type is the promoted left operand type
      // (C99 6.5.7: "The integer promotions are performed on each of the
      // operands. The type of the result is that of the promoted left operand.")
      // Must strip qualifiers before checking for small types.
      if (op == Bop::SHL || op == Bop::SHR) {
        Type uq = leftType.removeQualifiers();
        if (uq == TCHAR || uq == TSCHAR || uq == TUCHAR || uq == TSHORT ||
            uq == TUSHORT || uq == TBOOL) {
          return TINT;
        }
        return uq;
      }

      // Pointer arithmetic
      if (leftType.isPointer() && rightType.isInteger()) {
        return leftType;
      }
      if (rightType.isPointer() && leftType.isInteger() && op == Bop::ADD) {
        return rightType;
      }
      if (leftType.isPointer() && rightType.isPointer() && op == Bop::SUB) {
        return TLONG;  // ptrdiff_t
      }

      // Array arithmetic (array decays to pointer)
      if (leftType.isArray() && rightType.isInteger()) {
        return leftType.decay();
      }
      if (rightType.isArray() && leftType.isInteger() && op == Bop::ADD) {
        return rightType.decay();
      }
      // pointer - array or array - pointer (array decays to pointer, result is ptrdiff_t)
      if (op == Bop::SUB &&
          ((leftType.isPointer() && rightType.isArray()) ||
              (leftType.isArray() && rightType.isPointer()))) {
        return TLONG;  // ptrdiff_t
      }

      return usualArithmeticConversions(leftType, rightType);
    }

    Type computeTernaryType(Type thenType, Type elseType) {
      if (thenType == elseType) return thenType;
      if (thenType.isPointer() && elseType.isPointer()) return thenType;
      if (thenType.isPointer()) return thenType;
      if (elseType.isPointer()) return elseType;
      return usualArithmeticConversions(thenType, elseType);
    }

    // Compute the result type of a unary expression
    Type computeUnaryType(Uop op, Type operandType) {
      switch (op) {
        case Uop::OP_LNOT: return TINT;  // logical not always returns int
        case Uop::OP_ADDR: return operandType.pointer();
        case Uop::OP_DEREF:
          if (operandType.isPointer()) return operandType.getPointee();
          if (operandType.isArray()) return operandType.getArrayBase();
          return TUNKNOWN;
        case Uop::OP_POS:
        case Uop::OP_NEG:
        case Uop::OP_BNOT:
          // Integer promotion
          if (operandType.isInteger() && operandType.getSize() < TINT.getSize()) {
            return TINT;
          }
          return operandType;
        case Uop::OP_PRE_INC:
        case Uop::OP_PRE_DEC:
        case Uop::OP_POST_INC:
        case Uop::OP_POST_DEC: return operandType;
        default: return operandType;
      }
    }

    // Parse a type name (for casts and sizeof)
    Type parseTypeName() {
      auto specs = parseDeclSpecifiers();
      Type baseType = specs.type;

      // Parse abstract declarator (pointers, arrays, etc. without a name)
      DeclaratorInput input{baseType, true, false, false};
      DeclaratorResult declRes = parseDeclarator(input);
      return declRes.type;
    }

    // Parse the body of an initializer list (after '{' has been consumed).
    // Returns an EInitList with raw elements and designators.
    EInitList *parseInitListBody(SrcLoc loc) {
      std::vector<Expr> elements;
      std::vector<InitDesignator> designators;
      bool hasDesignators = false;
      if (!at(Punct::RBRACE)) {
        do {
          InitDesignator desig;
          bool inDesig = false;
          if (at(Punct::DOT) && peek(1).kind == TokenKind::IDENT && peek(2).kind == TokenKind::PUNCT &&
              (peek(2).atPunct(Punct::EQ) || peek(2).atPunct(Punct::DOT) || peek(2).atPunct(Punct::LBRACK))) {
            inDesig = true;
          } else if (at(Punct::LBRACK)) {
            inDesig = true;
          }
          while (inDesig) {
            if (at(Punct::DOT) && peek(1).kind == TokenKind::IDENT) {
              advance();
              DesigStep step;
              step.kind = DesigStep::FIELD;
              step.fieldName = intern(peek(0).text);
              advance();
              desig.steps.push_back(std::move(step));
              hasDesignators = true;
            } else if (at(Punct::LBRACK)) {
              advance();
              DesigStep step;
              step.kind = DesigStep::INDEX;
              step.indexExpr = parseAssignmentExpression();
              expect(Punct::RBRACK, "Expected ']' after designated index");
              desig.steps.push_back(std::move(step));
              hasDesignators = true;
            } else {
              break;
            }
            if (!at(Punct::DOT) && !at(Punct::LBRACK)) break;
          }
          if (!desig.steps.empty()) {
            expect(Punct::EQ, "Expected '=' after designator");
          }
          designators.push_back(std::move(desig));
          elements.push_back(parseAssignmentExpression());
        } while (match(Punct::COMMA) && !at(Punct::RBRACE));
      }
      expect(Punct::RBRACE, "Expected '}' after initializer list");
      auto *initList = new EInitList{loc, Type(), std::move(elements), {}, 0};
      if (hasDesignators) initList->designators = std::move(designators);
      return initList;
    }

    Expr parsePrimaryExpression() {
      Token t = peek();
      SrcLoc loc = {t.filename, t.line, t.column};

      // C11 _Generic selection expression
      if (match(Keyword::GENERIC)) {
        expect(Punct::LPAREN, "Expected '(' after _Generic");
        Expr controlling = parseAssignmentExpression();
        Type controlType = controlling.getType().decay().removeQualifiers();
        Expr defaultExpr = nullptr;
        Expr matchedExpr = nullptr;
        bool foundMatch = false;
        while (match(Punct::COMMA)) {
          if (match(Keyword::DEFAULT)) {
            expect(Punct::COLON, "Expected ':' after 'default' in _Generic");
            Expr e = parseAssignmentExpression();
            if (defaultExpr) {
              error(peek(-1), "_Generic may not have more than one 'default' association");
            }
            defaultExpr = e;
          } else {
            Type assocType = parseTypeName();
            expect(Punct::COLON, "Expected ':' after type in _Generic");
            Expr e = parseAssignmentExpression();
            if (!foundMatch && assocType.decay() == controlType) {
              matchedExpr = e;
              foundMatch = true;
            }
          }
        }
        expect(Punct::RPAREN, "Expected ')' after _Generic");
        if (foundMatch) return matchedExpr;
        if (defaultExpr) return defaultExpr;
        error(peek(-1), "_Generic: no matching type and no 'default' association");
        return Expr(nullptr);
      }

      if (at(Punct::LPAREN)) {
        advance();  // consume '('
        Expr expr = parseExpression();
        expect(Punct::RPAREN, "Expected ')' after expression");
        return expr;
      } else if (at(TokenKind::INT)) {
        advance();
        // Prefixed char literals (u'x', U'x', L'x') have a stringPrefix
        // that determines their type instead of the normal integer suffix rules
        Type intType;
        switch (t.flags.stringPrefix) {
          case StringPrefix::PREFIX_u: intType = TUSHORT; break;  // char16_t
          case StringPrefix::PREFIX_U:                              // char32_t
          case StringPrefix::PREFIX_L: intType = TINT; break;      // wchar_t
          default: {
            intType = Type::getIntegerTypeFromTokenFlags(t.flags);
            // C99 §6.4.4.1: If the value doesn't fit in the suffix-implied type,
            // promote through the type sequence based on decimal vs hex/octal.
            u64 val = t.value.integer;
            bool isDecimal = t.flags.isDecimal;
            auto fitsI32 = [](u64 v) { return v <= 0x7FFFFFFFU; };
            auto fitsU32 = [](u64 v) { return v <= 0xFFFFFFFFU; };
            auto fitsI64 = [](u64 v) { return v <= 0x7FFFFFFFFFFFFFFFULL; };
            if (!t.flags.isUnsigned && !t.flags.isLong && !t.flags.isLongLong) {
              // No suffix: decimal → int, long, long long
              //            hex/oct → int, uint, long, ulong, llong, ullong
              if (fitsI32(val)) intType = TINT;
              else if (!isDecimal && fitsU32(val)) intType = TUINT;
              else if (fitsI32(val)) intType = TLONG;  // long==int on wasm32
              else if (!isDecimal && fitsU32(val)) intType = TULONG;
              else if (fitsI64(val)) intType = TLLONG;
              else intType = isDecimal ? TLLONG : TULLONG;
            } else if (t.flags.isUnsigned && !t.flags.isLong && !t.flags.isLongLong) {
              // U suffix: uint, ulong, ullong
              if (fitsU32(val)) intType = TUINT;
              else intType = TULLONG;
            } else if (!t.flags.isUnsigned && t.flags.isLong && !t.flags.isLongLong) {
              // L suffix: decimal → long, llong
              //           hex/oct → long, ulong, llong, ullong
              if (fitsI32(val)) intType = TLONG;
              else if (!isDecimal && fitsU32(val)) intType = TULONG;
              else if (fitsI64(val)) intType = TLLONG;
              else intType = isDecimal ? TLLONG : TULLONG;
            } else if (t.flags.isUnsigned && t.flags.isLong && !t.flags.isLongLong) {
              // UL suffix: ulong, ullong
              if (fitsU32(val)) intType = TULONG;
              else intType = TULLONG;
            } else if (!t.flags.isUnsigned && t.flags.isLongLong) {
              // LL suffix: decimal → llong
              //            hex/oct → llong, ullong
              if (fitsI64(val)) intType = TLLONG;
              else intType = isDecimal ? TLLONG : TULLONG;
            }
            // ULL suffix: always ullong — already correct from getIntegerTypeFromTokenFlags
            break;
          }
        }
        return new EInt{loc, intType, t.value.integer};
      } else if (at(TokenKind::FLOAT)) {
        advance();
        return new EFloat{loc, t.flags.isFloat ? TFLOAT : TDOUBLE, t.value.floating};
      } else if (at(TokenKind::STRING)) {
        // C allows consecutive string literals to be concatenated.
        // Determine the "widest" prefix among all concatenated tokens:
        //   none/u8 < u < U/L  (C11 §6.4.5p5)
        auto effectivePrefix = StringPrefix::NONE;
        auto upgradePrefix = [](StringPrefix a, StringPrefix b) -> StringPrefix {
          auto rank = [](StringPrefix p) -> int {
            switch (p) {
              case StringPrefix::NONE: return 0;
              case StringPrefix::PREFIX_u8: return 0;
              case StringPrefix::PREFIX_u: return 1;
              case StringPrefix::PREFIX_U: return 2;
              case StringPrefix::PREFIX_L: return 2;
            }
            return 0;
          };
          return rank(a) >= rank(b) ? a : b;
        };

        // Helper to skip prefix chars in token text to reach the opening quote
        auto skipPrefix = [](const char *p) -> const char * {
          if (*p == 'L' || *p == 'U') return p + 1;
          if (*p == 'u') { p++; if (*p == '8') p++; return p; }
          return p;
        };

        // Peek ahead to determine effective prefix
        {
          size_t save = pos;
          while (at(TokenKind::STRING)) {
            effectivePrefix = upgradePrefix(effectivePrefix, peek().flags.stringPrefix);
            advance();
          }
          pos = save;
        }

        bool isWide = (effectivePrefix == StringPrefix::PREFIX_u ||
                       effectivePrefix == StringPrefix::PREFIX_U ||
                       effectivePrefix == StringPrefix::PREFIX_L);

        if (!isWide) {
          // Regular string or u8"..." — byte-by-byte
          Buffer value;
          while (at(TokenKind::STRING)) {
            const Token &strTok = peek();
            advance();
            const char *ptr = skipPrefix(strTok.text.data());
            ptr++;  // Skip opening "
            const char *end = strTok.text.data() + strTok.text.size() - 1;
            while (ptr < end) {
              i32 cp = unescape(ptr, end);
              if (cp <= 0xFF) value.push_back(static_cast<u8>(cp));
              else encodeUtf8(cp, value);
            }
          }
          value.push_back(0);  // null terminator
          Type strType = Type::arrayOf(TCHAR, static_cast<i32>(value.size()));
          return new EString{loc, strType, std::move(value)};
        }

        // Wide string: collect Unicode codepoints, then encode
        std::vector<i32> codepoints;
        while (at(TokenKind::STRING)) {
          const Token &strTok = peek();
          advance();
          const char *ptr = skipPrefix(strTok.text.data());
          ptr++;  // Skip opening "
          const char *end = strTok.text.data() + strTok.text.size() - 1;
          while (ptr < end) {
            codepoints.push_back(unescapeCodepoint(ptr, end));
          }
        }

        Buffer value;
        Type elemType;
        if (effectivePrefix == StringPrefix::PREFIX_u) {
          elemType = TUSHORT;  // char16_t
          for (i32 cp : codepoints) encodeUtf16LE(cp, value);
        } else if (effectivePrefix == StringPrefix::PREFIX_L) {
          elemType = TINT;  // wchar_t
          for (i32 cp : codepoints) encodeUtf32LE(cp, value);
        } else {
          elemType = TUINT;  // char32_t
          for (i32 cp : codepoints) encodeUtf32LE(cp, value);
        }

        // Null terminator
        i32 elemSize = elemType.getSize();
        for (i32 i = 0; i < elemSize; i++) value.push_back(0);
        i32 numElems = static_cast<i32>(value.size()) / elemSize;
        Type strType = Type::arrayOf(elemType, numElems);
        return new EString{loc, strType, std::move(value)};
      } else if (at(TokenKind::IDENT)) {
        advance();
        Symbol name = intern(t.text);

        // C99 __func__ predefined identifier
        if ((name == kw__func__ || name == kw__FUNCTION__) && currentParsingFunc) {
          const std::string &fname = *currentParsingFunc->name;
          Buffer buf(fname.begin(), fname.end());
          buf.push_back(0);  // null terminator
          Type strType = Type::arrayOf(TCHAR, static_cast<i32>(buf.size()));
          return new EString{loc, strType, std::move(buf)};
        }

        Decl decl = nullptr;
        Type type = TUNKNOWN;

        // Lookup in scope
        if (varScope.has(name)) {
          decl = varScope.get(name);

          // Record symbol usage for unused-declaration filtering
          if (decl && decl.kind != DeclKind::ENUM_CONST) {
            if (currentParsingFunc) {
              currentParsingFunc->usedSymbols.insert(decl);
            } else {
              globalUsedSymbols.insert(decl);
            }
          }

          // Resolve type from the declaration
          if (decl.kind == DeclKind::VAR) {
            type = decl.as.var->type;
          } else if (decl.kind == DeclKind::FUNC) {
            type = decl.as.func->type;
          } else if (decl.kind == DeclKind::ENUM_CONST) {
            type = TINT;
          }
        } else {
          // Implicit function declaration: C89 allowed calling undeclared functions.
          // Gated behind --allow-implicit-function-decl / --allow-old-c.
          if (compilerOptions.allowImplicitFunctionDecl && at(Punct::LPAREN)) {
            Type ftype = Type::function(TINT, {}, false);
            auto *fd = new DFunc{loc, name, ftype, {}, StorageClass::EXTERN, false, nullptr};
            decl = fd;
            type = ftype;
            varScope.set(name, decl);
            if (currentParsingFunc) {
              currentParsingFunc->usedSymbols.insert(decl);
            } else {
              globalUsedSymbols.insert(decl);
            }
          } else {
            recoverableError(t, "Undeclared identifier: " + std::string(*name));
          }
        }

        return new EIdent{loc, type, name, decl};
      } else if (at(Punct::LBRACE)) {
        // Initializer list: {expr, expr, ...}
        advance();  // consume '{'
        return parseInitListBody(loc);
      } else {
        error("Expected expression");
        return Expr(nullptr);
      }
    }

    // Recursively search for a named member in a tag, descending into
    // anonymous struct/union members.  On success the chain contains the
    // path of DVar* from the outermost anonymous member down to the target.
    bool findMemberChain(DTag *tag, Symbol name, std::vector<DVar *> &chain) {
      for (const auto &member : tag->members) {
        if (member.kind != DeclKind::VAR) continue;
        DVar *mVar = member.as.var;
        if (mVar->name == name) {
          chain.push_back(mVar);
          return true;
        }
        // Recurse into anonymous struct/union members
        if (!mVar->name && mVar->type.isTag()) {
          Decl innerTagDecl = mVar->type.getTagDecl();
          if (innerTagDecl.as.tag) {
            chain.push_back(mVar);
            if (findMemberChain(innerTagDecl.as.tag, name, chain)) return true;
            chain.pop_back();
          }
        }
      }
      return false;
    }

    // Parse postfix operators (calls, subscripts, member access, etc.)
    // starting from a given expression. Factored out so compound literals
    // can reuse the tail after parsing `(type){...}`.
    Expr parsePostfixTail(Expr expr) {
      while (true) {
        Token t = peek();
        SrcLoc loc = {t.filename, t.line, t.column};

        if (match(Punct::LPAREN)) {
          // Function call
          std::vector<Expr> args;
          if (!at(Punct::RPAREN)) {
            do {
              args.push_back(parseAssignmentExpression());
            } while (match(Punct::COMMA));
          }
          expect(Punct::RPAREN, "Expected ')' after arguments");

          Type resultType = TUNKNOWN;
          Type calleeType = expr.getType().decay();
          if (calleeType.isFunction()) {
            resultType = calleeType.getReturnType();
          } else if (calleeType.isPointer() && calleeType.getPointee().isFunction()) {
            resultType = calleeType.getPointee().getReturnType();
          }

          DFunc *funcDecl = nullptr;
          if (expr.kind == ExprKind::IDENT && expr.as.ident->decl.kind == DeclKind::FUNC) {
            funcDecl = expr.as.ident->decl.as.func;
          }

          expr = new ECall{loc, resultType, expr, std::move(args), funcDecl};
        } else if (match(Punct::LBRACK)) {
          // Array subscript
          Expr index = parseExpression();
          expect(Punct::RBRACK, "Expected ']' after subscript");

          Type baseType = expr.getType();
          Type indexType = index.getType();
          if (baseType.isInteger() && (indexType.isPointer() || indexType.isArray())) {
            error(t, "Commutative subscript (e.g. 0[arr]) is not supported; write arr[0] instead");
          }

          Type resultType = TUNKNOWN;
          if (baseType.isPointer()) {
            resultType = baseType.getPointee();
          } else if (baseType.isArray()) {
            resultType = baseType.getArrayBase();
          }

          expr = new ESubscript{loc, resultType, expr, index};
        } else if (match(Punct::DOT)) {
          // Member access
          Token memberTok = expect(TokenKind::IDENT, "Expected member name");
          Symbol memberName = intern(memberTok.text);

          Type baseType = expr.getType();
          if (!baseType.isTag()) {
            error(memberTok, "member access on non-struct/union type");
          }
          Decl tagDecl = baseType.getTagDecl();
          DTag *tag = tagDecl.as.tag;
          std::vector<DVar *> chain;
          findMemberChain(tag, memberName, chain);
          if (chain.empty()) {
            error(memberTok, "no member named '" + std::string(*memberName) + "' in struct/union");
          }
          for (auto *mVar : chain) {
            Type mType = mVar->type;
            expr = new EMember{loc, mType, expr, mVar->name, mVar};
          }
        } else if (match(Punct::ARROW)) {
          // Arrow access
          Token memberTok = expect(TokenKind::IDENT, "Expected member name");
          Symbol memberName = intern(memberTok.text);

          Type exprType = expr.getType();
          Type ptrType = exprType.decay();
          if (!ptrType.isPointer()) {
            error(memberTok, "arrow access on non-pointer type");
          }
          Type baseType = ptrType.getPointee();
          if (!baseType.isTag()) {
            error(memberTok, "arrow access on pointer to non-struct/union type");
          }
          Decl tagDecl = baseType.getTagDecl();
          DTag *tag = tagDecl.as.tag;
          std::vector<DVar *> chain;
          findMemberChain(tag, memberName, chain);
          if (chain.empty()) {
            error(
                memberTok, "no member named '" + std::string(*memberName) + "' in struct/union");
          }
          auto *first = chain[0];
          expr = new EArrow{loc, first->type, expr, first->name, first};
          for (size_t i = 1; i < chain.size(); i++) {
            auto *mVar = chain[i];
            expr = new EMember{loc, mVar->type, expr, mVar->name, mVar};
          }
        } else if (match(Punct::PLUSPLUS)) {
          expr = new EUnary{loc, expr.getType(), Uop::OP_POST_INC, expr};
        } else if (match(Punct::MINUSMINUS)) {
          expr = new EUnary{loc, expr.getType(), Uop::OP_POST_DEC, expr};
        } else {
          break;
        }
      }
      return expr;
    }

    Expr parsePostfixExpression() {
      Expr expr = parsePrimaryExpression();
      return parsePostfixTail(expr);
    }

    // Mark a variable as requiring memory allocation (for address-of operator)
    void markAddressTaken(Expr expr) {
      if (!expr) return;  // Safety check
      switch (expr.kind) {
        case ExprKind::IDENT: {
          EIdent *ei = expr.as.ident;
          if (ei && ei->decl.kind == DeclKind::VAR && ei->decl.as.var) {
            ei->decl.as.var->allocClass = AllocClass::MEMORY;
          }
          break;
        }
        case ExprKind::MEMBER: {
          // &s.field -> mark s as MEMORY
          if (expr.as.member) {
            markAddressTaken(expr.as.member->base);
          }
          break;
        }
        case ExprKind::SUBSCRIPT: {
          // &arr[i] -> if arr is array type, recurse; if pointer, stop
          ESubscript *es = expr.as.subscript;
          if (es && es->array.getType().isArray()) {
            markAddressTaken(es->array);
          }
          // else: pointer subscript, no variable to mark
          break;
        }
        case ExprKind::ARROW:
        case ExprKind::UNARY:  // OP_DEREF: &(*p) -> p stays REGISTER
          // Pointer dereference - base pointer stays REGISTER
          break;
        case ExprKind::COMPOUND_LITERAL: break;  // Already allocated on stack; nothing to mark
        default:
          // Other expressions - type error will be caught later
          break;
      }
    }

    Expr parseUnaryExpression() {
      Token t = peek();
      SrcLoc loc = {t.filename, t.line, t.column};

      if (match(Punct::PLUSPLUS)) {
        Expr operand = parseUnaryExpression();
        return new EUnary{loc, operand.getType(), Uop::OP_PRE_INC, operand};
      }
      if (match(Punct::MINUSMINUS)) {
        Expr operand = parseUnaryExpression();
        return new EUnary{loc, operand.getType(), Uop::OP_PRE_DEC, operand};
      }
      if (match(Punct::AMP)) {
        Expr operand = parseCastExpression();
        markAddressTaken(operand);  // Mark variable as requiring memory allocation
        return new EUnary{loc, operand.getType().pointer(), Uop::OP_ADDR, operand};
      }
      if (match(Punct::STAR)) {
        Expr operand = parseCastExpression();
        Type resultType = computeUnaryType(Uop::OP_DEREF, operand.getType());
        return new EUnary{loc, resultType, Uop::OP_DEREF, operand};
      }
      if (match(Punct::PLUS)) {
        Expr operand = parseCastExpression();
        return new EUnary{
            loc, computeUnaryType(Uop::OP_POS, operand.getType()), Uop::OP_POS, operand};
      }
      if (match(Punct::MINUS)) {
        Expr operand = parseCastExpression();
        return new EUnary{
            loc, computeUnaryType(Uop::OP_NEG, operand.getType()), Uop::OP_NEG, operand};
      }
      if (match(Punct::TILDE)) {
        Expr operand = parseCastExpression();
        return new EUnary{
            loc, computeUnaryType(Uop::OP_BNOT, operand.getType()), Uop::OP_BNOT, operand};
      }
      if (match(Punct::BANG)) {
        Expr operand = parseCastExpression();
        return new EUnary{loc, TINT, Uop::OP_LNOT, operand};
      }
      if (match(Keyword::SIZEOF)) {
        if (at(Punct::LPAREN) && isTypeName(peek(1))) {
          advance();  // consume '('
          Type operandType = parseTypeName();
          expect(Punct::RPAREN, "Expected ')' after type");
          return new ESizeOfType{loc, TULONG, operandType};
        } else {
          Expr operand = parseUnaryExpression();
          return new ESizeOfExpr{loc, TULONG, operand};
        }
      }
      if (match(Keyword::ALIGNOF)) {
        // C11 _Alignof always requires parenthesized type-name: _Alignof(type)
        // But we also support _Alignof(expr) as a GNU extension for convenience
        expect(Punct::LPAREN, "Expected '(' after _Alignof");
        if (isTypeName(peek())) {
          Type operandType = parseTypeName();
          expect(Punct::RPAREN, "Expected ')' after type");
          // C11 6.5.3.4p1: shall not be applied to a function type or an incomplete type
          if (operandType.isFunction()) {
            error(peek(-1), "_Alignof cannot be applied to a function type");
          }
          if (!operandType.isComplete()) {
            error(peek(-1),
                "_Alignof cannot be applied to incomplete type '" + operandType.toString() + "'");
          }
          return new EAlignOfType{loc, TULONG, operandType};
        } else {
          Expr operand = parseAssignmentExpression();
          expect(Punct::RPAREN, "Expected ')' after expression");
          return new EAlignOfExpr{loc, TULONG, operand};
        }
      }

      // Variadic function intrinsics
      if (match(Keyword::X_BUILTIN_VA_START)) {
        expect(Punct::LPAREN, "Expected '(' after __builtin_va_start");
        Expr apExpr = parseAssignmentExpression();
        expect(Punct::COMMA, "Expected ',' in __builtin_va_start");
        Expr lastParam = parseAssignmentExpression();  // for compatibility, not used
        expect(Punct::RPAREN, "Expected ')' after __builtin_va_start");
        return new EIntrinsic{loc, TVOID, IntrinsicKind::VA_START, {apExpr, lastParam}, {}};
      }

      if (match(Keyword::X_BUILTIN_VA_ARG)) {
        expect(Punct::LPAREN, "Expected '(' after __builtin_va_arg");
        Expr apExpr = parseAssignmentExpression();
        expect(Punct::COMMA, "Expected ',' in __builtin_va_arg");
        Type argType = parseTypeName();
        expect(Punct::RPAREN, "Expected ')' after __builtin_va_arg");
        return new EIntrinsic{loc, argType, IntrinsicKind::VA_ARG, {apExpr}, argType};
      }

      if (match(Keyword::X_BUILTIN_VA_END)) {
        expect(Punct::LPAREN, "Expected '(' after __builtin_va_end");
        Expr apExpr = parseAssignmentExpression();
        expect(Punct::RPAREN, "Expected ')' after __builtin_va_end");
        return new EIntrinsic{loc, TVOID, IntrinsicKind::VA_END, {apExpr}, {}};
      }

      if (match(Keyword::X_BUILTIN_VA_COPY)) {
        expect(Punct::LPAREN, "Expected '(' after __builtin_va_copy");
        Expr destExpr = parseAssignmentExpression();
        expect(Punct::COMMA, "Expected ',' in __builtin_va_copy");
        Expr srcExpr = parseAssignmentExpression();
        expect(Punct::RPAREN, "Expected ')' after __builtin_va_copy");
        return new EIntrinsic{loc, TVOID, IntrinsicKind::VA_COPY, {destExpr, srcExpr}, {}};
      }

      if (match(Keyword::X_BUILTIN_UNREACHABLE) || match(Keyword::X_BUILTIN_ABORT)) {
        expect(Punct::LPAREN, "Expected '(' after builtin");
        expect(Punct::RPAREN, "Expected ')' after builtin(");
        return new EIntrinsic{loc, TVOID, IntrinsicKind::UNREACHABLE, {}, {}};
      }

      if (match(Keyword::X_BUILTIN_EXPECT)) {
        expect(Punct::LPAREN, "Expected '(' after __builtin_expect");
        Expr first = parseAssignmentExpression();
        expect(Punct::COMMA, "Expected ',' in __builtin_expect");
        parseAssignmentExpression();  // discard the hint
        expect(Punct::RPAREN, "Expected ')' after __builtin_expect");
        return first;
      }

      // WebAssembly memory intrinsics
      if (match(Keyword::X_MEMORY_SIZE)) {
        expect(Punct::LPAREN, "Expected '(' after __memory_size");
        expect(Punct::RPAREN, "Expected ')' after __memory_size");
        return new EIntrinsic{loc, TULONG, IntrinsicKind::MEMORY_SIZE, {}, {}};
      }

      if (match(Keyword::X_MEMORY_GROW)) {
        expect(Punct::LPAREN, "Expected '(' after __memory_grow");
        Expr deltaExpr = parseAssignmentExpression();
        expect(Punct::RPAREN, "Expected ')' after __memory_grow");
        return new EIntrinsic{loc, TULONG, IntrinsicKind::MEMORY_GROW, {deltaExpr}, {}};
      }

      if (match(Keyword::X_BUILTIN)) {
        expect(Punct::LPAREN, "Expected '(' after __builtin");
        if (!at(TokenKind::IDENT)) error("Expected intrinsic name after __builtin(");
        std::string name(advance().text);
        if (name == "heap_base") {
          expect(Punct::RPAREN, "Expected ')' after __builtin(heap_base");
          return new EIntrinsic{loc, TULONG, IntrinsicKind::HEAP_BASE, {}, {}};
        } else if (name == "memory_size") {
          expect(Punct::RPAREN, "Expected ')' after __builtin(memory_size");
          return new EIntrinsic{loc, TULONG, IntrinsicKind::MEMORY_SIZE, {}, {}};
        } else if (name == "memory_grow") {
          expect(Punct::COMMA, "Expected ',' after __builtin(memory_grow");
          Expr deltaExpr = parseAssignmentExpression();
          expect(Punct::RPAREN, "Expected ')' after __builtin(memory_grow, expr");
          return new EIntrinsic{loc, TULONG, IntrinsicKind::MEMORY_GROW, {deltaExpr}, {}};
        } else if (name == "memory_copy") {
          // __builtin(memory_copy, dest, src, len)
          expect(Punct::COMMA, "Expected ',' after __builtin(memory_copy");
          Expr dest = parseAssignmentExpression();
          expect(Punct::COMMA, "Expected ',' in __builtin(memory_copy");
          Expr src = parseAssignmentExpression();
          expect(Punct::COMMA, "Expected ',' in __builtin(memory_copy");
          Expr len = parseAssignmentExpression();
          expect(Punct::RPAREN, "Expected ')' after __builtin(memory_copy, ...)");
          return new EIntrinsic{loc, TVOID, IntrinsicKind::MEMORY_COPY, {dest, src, len}, {}};
        } else if (name == "memory_fill") {
          // __builtin(memory_fill, dest, value, len)
          expect(Punct::COMMA, "Expected ',' after __builtin(memory_fill");
          Expr dest = parseAssignmentExpression();
          expect(Punct::COMMA, "Expected ',' in __builtin(memory_fill");
          Expr val = parseAssignmentExpression();
          expect(Punct::COMMA, "Expected ',' in __builtin(memory_fill");
          Expr len = parseAssignmentExpression();
          expect(Punct::RPAREN, "Expected ')' after __builtin(memory_fill, ...)");
          return new EIntrinsic{loc, TVOID, IntrinsicKind::MEMORY_FILL, {dest, val, len}, {}};
        } else if (name == "va_start") {
          expect(Punct::COMMA, "Expected ',' after __builtin(va_start");
          Expr apExpr = parseAssignmentExpression();
          expect(Punct::COMMA, "Expected second argument for __builtin(va_start");
          Expr lastParam = parseAssignmentExpression();
          expect(Punct::RPAREN, "Expected ')' after __builtin(va_start, ...");
          return new EIntrinsic{loc, TVOID, IntrinsicKind::VA_START, {apExpr, lastParam}, {}};
        } else if (name == "va_arg") {
          expect(Punct::COMMA, "Expected ',' after __builtin(va_arg");
          Expr apExpr = parseAssignmentExpression();
          expect(Punct::COMMA, "Expected type argument for __builtin(va_arg");
          Type argType = parseTypeName();
          expect(Punct::RPAREN, "Expected ')' after __builtin(va_arg, ...");
          return new EIntrinsic{loc, argType, IntrinsicKind::VA_ARG, {apExpr}, argType};
        } else if (name == "va_end") {
          expect(Punct::COMMA, "Expected ',' after __builtin(va_end");
          Expr apExpr = parseAssignmentExpression();
          expect(Punct::RPAREN, "Expected ')' after __builtin(va_end, ...");
          return new EIntrinsic{loc, TVOID, IntrinsicKind::VA_END, {apExpr}, {}};
        } else if (name == "va_copy") {
          expect(Punct::COMMA, "Expected ',' after __builtin(va_copy");
          Expr destExpr = parseAssignmentExpression();
          expect(Punct::COMMA, "Expected second argument for __builtin(va_copy");
          Expr srcExpr = parseAssignmentExpression();
          expect(Punct::RPAREN, "Expected ')' after __builtin(va_copy, ...");
          return new EIntrinsic{loc, TVOID, IntrinsicKind::VA_COPY, {destExpr, srcExpr}, {}};
        } else if (name == "alloca") {
          expect(Punct::COMMA, "Expected ',' after __builtin(alloca");
          Expr sizeExpr = parseAssignmentExpression();
          expect(Punct::RPAREN, "Expected ')' after __builtin(alloca, expr");
          return new EIntrinsic{loc, TVOID.pointer(), IntrinsicKind::ALLOCA, {sizeExpr}, {}};
        } else {
          error("Unknown __builtin intrinsic: " + name);
        }
      }

      // Raw WebAssembly bytecode embedding
      // Syntax: __wasm(TYPE, (args...), INSTRUCTION, ...)
      if (match(Keyword::X_WASM)) {
        expect(Punct::LPAREN, "Expected '(' after __wasm");
        Type resultType = parseTypeName();
        std::vector<Expr> wasmArgs;
        Buffer wasmBytes;
        // Parse required argument list (can be empty)
        expect(Punct::COMMA, "Expected ',' after type in __wasm");
        expect(Punct::LPAREN, "Expected '(' for __wasm argument list");
        if (!at(Punct::RPAREN)) {
          wasmArgs.push_back(parseAssignmentExpression());
          while (match(Punct::COMMA)) {
            wasmArgs.push_back(parseAssignmentExpression());
          }
        }
        expect(Punct::RPAREN, "Expected ')' after __wasm arguments");
        // Parse instructions
        while (match(Punct::COMMA)) {
          Token instrTok = advance();
          if (instrTok.kind != TokenKind::IDENT) {
            error(instrTok, "Expected instruction (op, lebU, lebI, i32, i64, f32, or f64)");
          }
          if (instrTok.text == "op") {
            // Consume all consecutive integer tokens
            while (peek().kind == TokenKind::INT) {
              Token numTok = advance();
              wasmBytes.push_back(static_cast<u8>(numTok.value.integer));
            }
          } else if (instrTok.text == "lebU") {
            Token numTok = advance();
            if (numTok.kind != TokenKind::INT) {
              error(numTok, "Expected integer after lebU");
            }
            lebU(wasmBytes, numTok.value.integer);
          } else if (instrTok.text == "lebI") {
            bool negative = match(Punct::MINUS);
            Token numTok = advance();
            if (numTok.kind != TokenKind::INT) {
              error(numTok, "Expected integer after lebI");
            }
            i64 val = static_cast<i64>(numTok.value.integer);
            if (negative) val = -val;
            lebI(wasmBytes, val);
          } else if (instrTok.text == "i32") {
            bool negative = match(Punct::MINUS);
            Token numTok = advance();
            if (numTok.kind != TokenKind::INT) {
              error(numTok, "Expected integer after i32");
            }
            i32 val = static_cast<i32>(numTok.value.integer);
            if (negative) val = -val;
            wasmBytes.push_back(0x41);  // i32.const
            lebI(wasmBytes, val);
          } else if (instrTok.text == "i64") {
            bool negative = match(Punct::MINUS);
            Token numTok = advance();
            if (numTok.kind != TokenKind::INT) {
              error(numTok, "Expected integer after i64");
            }
            i64 val = static_cast<i64>(numTok.value.integer);
            if (negative) val = -val;
            wasmBytes.push_back(0x42);  // i64.const
            lebI(wasmBytes, val);
          } else if (instrTok.text == "f32") {
            bool negative = match(Punct::MINUS);
            Token numTok = advance();
            float val;
            if (numTok.kind == TokenKind::INT) {
              val = static_cast<float>(numTok.value.integer);
            } else if (numTok.kind == TokenKind::FLOAT) {
              val = static_cast<float>(numTok.value.floating);
            } else {
              error(numTok, "Expected number after f32");
            }
            if (negative) val = -val;
            wasmBytes.push_back(0x43);  // f32.const
            appendF32(wasmBytes, val);
          } else if (instrTok.text == "f64") {
            bool negative = match(Punct::MINUS);
            Token numTok = advance();
            double val;
            if (numTok.kind == TokenKind::INT) {
              val = static_cast<double>(numTok.value.integer);
            } else if (numTok.kind == TokenKind::FLOAT) {
              val = numTok.value.floating;
            } else {
              error(numTok, "Expected number after f64");
            }
            if (negative) val = -val;
            wasmBytes.push_back(0x44);  // f64.const
            appendF64(wasmBytes, val);
          } else {
            error(instrTok, "Unknown instruction: expected op, lebU, lebI, i32, i64, f32, or f64");
          }
        }
        expect(Punct::RPAREN, "Expected ')' after __wasm");
        return new EWasm{loc, resultType, std::move(wasmArgs), std::move(wasmBytes)};
      }

      return parsePostfixExpression();
    }

    Expr parseCastExpression() {
      if (at(Punct::LPAREN) && isTypeName(peek(1))) {
        Token t = peek();
        SrcLoc loc = {t.filename, t.line, t.column};
        advance();  // consume '('
        Type targetType = parseTypeName();
        expect(Punct::RPAREN, "Expected ')' after cast type");
        if (at(Punct::LBRACE)) {
          // C99 compound literal: (type){init-list}
          advance();  // consume '{'
          auto *initList = parseInitListBody(loc);
          // Handle (char[]){"hello"}: string literal initializing a char array
          if (targetType.isArray() && targetType.getArraySize() == 0 &&
              initList->elements.size() == 1 && initList->elements[0].kind == ExprKind::STRING) {
            targetType = initList->elements[0].as.stringLit->type;
            initList->type = targetType;
          } else if (targetType.isArray() && targetType.getArraySize() == 0) {
            normalizeInitList(initList, targetType);
            targetType = initList->type;
          } else if (targetType.isAggregate()) {
            normalizeInitList(initList, targetType);
          } else {
            initList->type = targetType;
          }
          auto *cl = new ECompoundLiteral{loc, targetType, initList};
          if (currentParsingFunc) {
            currentParsingFunc->compoundLiterals.push_back(cl);
          } else {
            fileScopeCompoundLiterals.push_back(cl);
          }
          return parsePostfixTail(Expr(cl));
        }
        Expr operand = parseCastExpression();
        // GCC extension: cast-to-union — (union_type) expr → compound literal
        if (targetType.isTag() && !targetType.isEnum() &&
            targetType.getTagDecl().as.tag->tagKind == TagKind::UNION) {
          auto *initList = new EInitList{loc, targetType, {operand}, {}};
          normalizeInitList(initList, targetType);
          auto *cl = new ECompoundLiteral{loc, targetType, initList};
          if (currentParsingFunc) {
            currentParsingFunc->compoundLiterals.push_back(cl);
          } else {
            fileScopeCompoundLiterals.push_back(cl);
          }
          return parsePostfixTail(Expr(cl));
        }
        return new ECast{loc, targetType, targetType, operand};
      }
      return parseUnaryExpression();
    }

    // Pratt-style precedence climbing for binary expressions
    Expr parseBinaryExpression(int minPrecedence) {
      Expr left = parseCastExpression();

      while (true) {
        Token opTok = peek();
        if (opTok.kind != TokenKind::PUNCT) break;

        int prec = getBinaryPrecedence(opTok.text);
        if (prec < minPrecedence || prec == 0) break;

        SrcLoc loc = {opTok.filename, opTok.line, opTok.column};

        // Handle ternary operator specially
        if (opTok.atPunct(Punct::QMARK)) {
          advance();  // consume '?'
          Expr thenExpr = parseExpression();
          expect(Punct::COLON, "Expected ':' in ternary expression");
          Expr elseExpr = parseBinaryExpression(3);  // ternary precedence

          // Compute result type using usual arithmetic conversions
          Type resultType = computeTernaryType(thenExpr.getType(), elseExpr.getType());
          left = new ETernary{loc, resultType, left, thenExpr, elseExpr};
          continue;
        }

        // For right-associative operators, use same precedence for right side
        // For left-associative operators, use prec+1 for right side
        int nextMinPrec = isRightAssociative(opTok.text) ? prec : prec + 1;

        Bop op = textToBop(opTok.text);
        advance();  // consume operator

        Expr right = parseBinaryExpression(nextMinPrec);

        // Warn when array is used directly in pointer arithmetic (should decay)
        if (warningFlags.pointerDecay && (left.getType().isArray() || right.getType().isArray())) {
          if ((op == Bop::ADD || op == Bop::SUB) &&
              (left.getType().isInteger() || right.getType().isInteger())) {
            warning(opTok, "array used in arithmetic expression; decaying to pointer");
          }
        }

        // Apply C99 6.3.1.1 integer promotions for bitfield operands
        Type resultType = computeBinaryType(op, promoteExprType(left), promoteExprType(right));

        left = new EBinary{loc, resultType, op, left, right};
      }

      return left;
    }

    // Assignment expression (excludes comma operator)
    Expr parseAssignmentExpression() { return parseBinaryExpression(2); }

    // Full expression including comma operator
    Expr parseExpression() {
      Expr expr = parseAssignmentExpression();

      if (at(Punct::COMMA)) {
        Token t = peek();
        SrcLoc loc = {t.filename, t.line, t.column};
        std::vector<Expr> exprs;
        exprs.push_back(expr);

        while (match(Punct::COMMA)) {
          exprs.push_back(parseAssignmentExpression());
        }

        Type resultType = exprs.back().getType();
        return new EComma{loc, resultType, std::move(exprs)};
      }

      return expr;
    }

    // --- Statement Parsing ---

    Stmt parseStatement() {
      if (at(Punct::SEMI)) {
        advance();
        return Stmt::empty();
      }
      if (at(Punct::LBRACE)) {
        return parseCompoundStatement();
      }
      if (match(Keyword::RETURN)) {
        return parseReturnStatement();
      }
      if (match(Keyword::IF)) {
        return parseIfStatement();
      }
      if (match(Keyword::WHILE)) {
        return parseWhileStatement();
      }
      if (match(Keyword::DO)) {
        return parseDoWhileStatement();
      }
      if (match(Keyword::FOR)) {
        return parseForStatement();
      }
      if (match(Keyword::BREAK)) {
        SrcLoc loc = {peek().filename, peek().line, peek().column};
        expect(Punct::SEMI, "Expected ';' after 'break'");
        return new SBreak{loc};
      }
      if (match(Keyword::CONTINUE)) {
        SrcLoc loc = {peek().filename, peek().line, peek().column};
        expect(Punct::SEMI, "Expected ';' after 'continue'");
        return new SContinue{loc};
      }
      if (match(Keyword::SWITCH)) {
        return parseSwitchStatement();
      }
      if (at(Keyword::X_THROW)) {
        return parseThrowStatement();
      }
      if (at(Keyword::X_TRY)) {
        return parseTryCatchStatement();
      }
      if (match(Keyword::GOTO)) {
        auto &tok = peek();
        SrcLoc loc = {tok.filename, tok.line, tok.column};
        if (tok.kind != TokenKind::IDENT) {
          error(tok, "Expected label name after 'goto'");
        }
        std::string labelName = std::string(advance().text);
        expect(Punct::SEMI, "Expected ';' after goto");
        SGoto *sg = new SGoto{loc, labelName};
        if (parsedLabels.count(labelName)) {
          // Backward goto — label already defined, must be a loop label
          SLabel *target = parsedLabels[labelName];
          if (target->hasGotos && target->labelKind == LabelKind::FORWARD) {
            // Label already has forward gotos, now also has backward goto
            target->labelKind = LabelKind::BOTH;
          } else {
            target->labelKind = LabelKind::LOOP;
          }
          target->hasGotos = true;
          sg->target = target;
        } else {
          // Forward goto — label not yet seen
          pendingGotos[labelName].push_back(sg);
        }
        return sg;
      }
      // Check for label: identifier followed by ':'
      if (peek().kind == TokenKind::IDENT && peek(1).atPunct(Punct::COLON)) {
        SrcLoc loc = {peek().filename, peek().line, peek().column};
        auto &labelTok = peek();
        std::string labelName = std::string(advance().text);
        advance();  // consume ':'
        if (parsedLabels.count(labelName)) {
          error(labelTok, "Duplicate label '" + labelName + "'");
        }
        SLabel *sl = new SLabel{loc, labelName, currentCompound};
        parsedLabels[labelName] = sl;
        if (currentCompound) {
          currentCompound->labels.push_back(sl);
        }
        // Resolve pending gotos (these are forward gotos → this is a forward label)
        auto it = pendingGotos.find(labelName);
        if (it != pendingGotos.end()) {
          sl->labelKind = LabelKind::FORWARD;
          sl->hasGotos = true;
          for (SGoto *sg : it->second) {
            sg->target = sl;
          }
          pendingGotos.erase(it);
        }
        // If no pending gotos and no backward gotos, label is unused (default FORWARD, no gotos)
        return sl;
      }
      // Handle _Static_assert inside function bodies
      if (match(Keyword::STATIC_ASSERT)) {
        parseStaticAssert();
        // Return an empty compound statement as a placeholder (static_assert has no runtime effect)
        SrcLoc loc = {peek(-1).filename, peek(-1).line, peek(-1).column};
        return new SCompound{loc, {}, {}};
      }
      // If it looks like a declaration, parse it as a DeclStmt
      if (isTypeName(peek())) {
        SrcLoc loc = {peek().filename, peek().line, peek().column};
        std::vector<Decl> decls = parseDeclaration();

        // Declarations inside statements are always definitions
        // (except extern declarations, which are just declarations)
        for (auto &decl : decls) {
          if (decl.kind == DeclKind::VAR && decl.as.var->storageClass != StorageClass::EXTERN) {
            decl.as.var->definition = decl.as.var;
          }
        }

        // Divert static/extern locals: treat them as globals for allocation/linking
        if (currentParsingFunc) {
          std::vector<Decl> remaining;
          for (auto &decl : decls) {
            if (decl.kind == DeclKind::VAR && decl.as.var->storageClass == StorageClass::STATIC) {
              DVar *var = decl.as.var;
              setInitialAllocClass(var, true);
              currentParsingFunc->staticLocals.push_back(var);
            } else if (decl.kind == DeclKind::VAR &&
                decl.as.var->storageClass == StorageClass::EXTERN) {
              DVar *var = decl.as.var;
              setInitialAllocClass(var, false);
              currentParsingFunc->externLocals.push_back(var);
            } else if (decl.kind == DeclKind::FUNC) {
              currentParsingFunc->externLocalFuncs.push_back(decl.as.func);
            } else {
              remaining.push_back(std::move(decl));
            }
          }
          decls = std::move(remaining);
        }

        return new SDecl{loc, std::move(decls)};
      }

      // Otherwise, Expression Statement
      SrcLoc loc = {peek().filename, peek().line, peek().column};
      Expr expr = parseExpression();
      expect(Punct::SEMI, "Expected ';' after expression");
      return Stmt(new SExpr{loc, expr});
    }

    bool isValidWasmValueType(Type type) {
      if (type.isVoid() || type.isFunction()) return false;
      if (type.isArray()) return false;
      if (type.isTag()) return false;  // reject C struct/union/enum by value
      return true;  // primitives, pointers (i32) all OK
    }

    void parseExceptionDirective(TUnit &unit) {
      advance();  // consume __exception
      auto &nameTok = expect(TokenKind::IDENT, "Expected exception tag name after '__exception'");
      Symbol name = intern(nameTok.text);

      expect(Punct::LPAREN, "Expected '(' after exception tag name");

      std::vector<Type> paramTypes;
      if (!at(Punct::RPAREN)) {
        do {
          auto specs = parseDeclSpecifiers();
          Type paramType = specs.type;
          // Parse pointer stars
          while (at(Punct::STAR)) {
            advance();
            paramType = paramType.pointer();
          }
          // Optionally skip parameter name
          if (peek().kind == TokenKind::IDENT && !isTypeName(peek())) {
            advance();
          }
          if (!isValidWasmValueType(paramType)) {
            error(peek(-1),
                "Invalid type '" + paramType.toString() +
                    "' for __exception parameter; "
                    "only primitives, pointers, and GC refs are allowed");
          }
          paramTypes.push_back(paramType);
        } while (match(Punct::COMMA));
      }

      expect(Punct::RPAREN, "Expected ')' after exception tag parameters");
      expect(Punct::SEMI, "Expected ';' after __exception declaration");

      if (exceptionTags.count(name)) {
        ExceptionTag *existing = exceptionTags[name];
        if (existing->paramTypes != paramTypes) {
          recoverableError(
              nameTok, "Conflicting types for __exception tag '" + std::string(*name) + "'");
          return;
        }
        // Re-declaration with matching types — reuse existing tag
        unit.exceptionTags.push_back(existing);
        return;
      }

      auto *tag = new ExceptionTag{
          SrcLoc{nameTok.filename, nameTok.line, nameTok.column},
          name,
          std::move(paramTypes),
      };
      tag->definition = tag;  // canonical definition
      exceptionTags[name] = tag;
      unit.exceptionTags.push_back(tag);
      parsedExceptionTags.push_back(tag);
    }

    Stmt parseThrowStatement() {
      auto &tok = peek();
      SrcLoc loc = {tok.filename, tok.line, tok.column};
      advance();  // consume __throw

      auto &nameTok = expect(TokenKind::IDENT, "Expected exception tag name after '__throw'");
      Symbol name = intern(nameTok.text);

      auto it = exceptionTags.find(name);
      if (it == exceptionTags.end()) {
        error(nameTok, "Undeclared exception tag '" + std::string(*name) + "'");
      }
      ExceptionTag *tag = it->second;

      expect(Punct::LPAREN, "Expected '(' after exception tag name in __throw");

      std::vector<Expr> args;
      if (!at(Punct::RPAREN)) {
        do {
          args.push_back(parseAssignmentExpression());
        } while (match(Punct::COMMA));
      }

      expect(Punct::RPAREN, "Expected ')' after __throw arguments");
      expect(Punct::SEMI, "Expected ';' after __throw statement");

      if (args.size() != tag->paramTypes.size()) {
        error(nameTok,
            "__throw " + std::string(*name) + " expects " + std::to_string(tag->paramTypes.size()) +
                " argument(s), got " + std::to_string(args.size()));
      }

      return new SThrow{loc, tag, std::move(args)};
    }

    Stmt parseTryCatchStatement() {
      auto &tok = peek();
      SrcLoc loc = {tok.filename, tok.line, tok.column};
      advance();  // consume __try

      Stmt tryBody = parseCompoundStatement();

      std::vector<CatchClause> catches;
      bool hasCatchAll = false;

      while (at(Keyword::X_CATCH)) {
        auto &catchTok = peek();
        SrcLoc catchLoc = {catchTok.filename, catchTok.line, catchTok.column};
        advance();  // consume __catch

        if (hasCatchAll) {
          error(catchTok, "catch_all must be the last __catch clause");
        }

        if (at(Punct::LBRACE)) {
          // catch_all
          hasCatchAll = true;
          Stmt catchBody = parseCompoundStatement();
          catches.push_back(CatchClause{catchLoc, nullptr, {}, {}, catchBody});
        } else {
          auto &tagNameTok =
              expect(TokenKind::IDENT, "Expected exception tag name or '{' after '__catch'");
          Symbol tagName = intern(tagNameTok.text);

          auto it = exceptionTags.find(tagName);
          if (it == exceptionTags.end()) {
            error(tagNameTok, "Undeclared exception tag '" + std::string(*tagName) + "'");
          }
          ExceptionTag *tag = it->second;

          expect(Punct::LPAREN, "Expected '(' after exception tag name in __catch");

          std::vector<Symbol> bindings;
          if (!at(Punct::RPAREN)) {
            do {
              auto &bindTok =
                  expect(TokenKind::IDENT, "Expected binding name in __catch parameter list");
              bindings.push_back(intern(bindTok.text));
            } while (match(Punct::COMMA));
          }

          expect(Punct::RPAREN, "Expected ')' after __catch parameter bindings");

          if (bindings.size() != tag->paramTypes.size()) {
            error(tagNameTok,
                "__catch " + std::string(*tagName) + " expects " +
                    std::to_string(tag->paramTypes.size()) + " binding(s), got " +
                    std::to_string(bindings.size()));
          }

          // Push scope, create bindings, parse body, pop scope
          typeScope.push();
          tagScope.push();
          varScope.push();

          std::vector<DVar *> bindingVars;
          for (size_t i = 0; i < bindings.size(); i++) {
            DVar *bindVar = new DVar{
                catchLoc,
                bindings[i],
                tag->paramTypes[i],
                StorageClass::NONE,
            };
            bindVar->definition = bindVar;
            varScope.set(bindings[i], Decl(bindVar));
            bindingVars.push_back(bindVar);
          }

          Stmt catchBody = parseCompoundStatement();

          varScope.pop();
          tagScope.pop();
          typeScope.pop();

          catches.push_back(
              CatchClause{catchLoc, tag, std::move(bindings), std::move(bindingVars), catchBody});
        }
      }

      if (catches.empty()) {
        error(tok, "__try must have at least one __catch clause");
      }

      return new STryCatch{loc, tryBody, std::move(catches)};
    }

    Stmt parseCompoundStatement(std::span<const Decl> injectedDecls = {}) {
      auto tok = peek();
      SrcLoc loc = {tok.filename, tok.line, tok.column};
      expect(Punct::LBRACE, "Expected '{' to start block");

      SCompound *block = new SCompound{loc, {}, {}};

      // Enter new scope for local variables
      typeScope.push();
      tagScope.push();
      varScope.push();

      SCompound *savedCompound = currentCompound;
      currentCompound = block;

      // Inject any declarations (for function parameters)
      for (const auto &decl : injectedDecls) {
        if (decl.kind == DeclKind::VAR) {
          varScope.set(decl.as.var->name, decl);

          // parameters are always definitions
          decl.as.var->definition = decl.as.var;
        }
      }

      while (!at(Punct::RBRACE) && !atEnd()) {
        Stmt stmt = parseStatement();
        block->statements.push_back(stmt);
      }

      expect(Punct::RBRACE, "Expected '}' to close block");

      // Leave scope
      currentCompound = savedCompound;
      varScope.pop();
      tagScope.pop();
      typeScope.pop();

      return block;
    }

    Stmt parseReturnStatement() {
      auto tok = peek();
      SrcLoc loc = {tok.filename, tok.line, tok.column};
      Expr val = nullptr;
      if (!at(Punct::SEMI)) {
        val = parseExpression();
      }
      expect(Punct::SEMI, "Expected ';' after return value");
      return new SReturn{loc, val};
    }

    Stmt parseIfStatement() {
      auto tok = peek();
      SrcLoc loc = {tok.filename, tok.line, tok.column};
      expect(Punct::LPAREN, "Expected '(' after 'if'");
      Expr condition = parseExpression();
      expect(Punct::RPAREN, "Expected ')' after if condition");
      Stmt thenBranch = parseStatement();
      Stmt elseBranch = nullptr;
      if (match(Keyword::ELSE)) {
        elseBranch = parseStatement();
      }
      return new SIf{loc, condition, thenBranch, elseBranch};
    }

    Stmt parseWhileStatement() {
      auto tok = peek();
      SrcLoc loc = {tok.filename, tok.line, tok.column};
      expect(Punct::LPAREN, "Expected '(' after 'while'");
      Expr condition = parseExpression();
      expect(Punct::RPAREN, "Expected ')' after while condition");
      Stmt body = parseStatement();
      return new SWhile{loc, condition, body};
    }

    Stmt parseDoWhileStatement() {
      auto tok = peek();
      SrcLoc loc = {tok.filename, tok.line, tok.column};
      Stmt body = parseStatement();
      expect(Keyword::WHILE, "Expected 'while' after do body");
      expect(Punct::LPAREN, "Expected '(' after 'while'");
      Expr condition = parseExpression();
      expect(Punct::RPAREN, "Expected ')' after while condition");
      expect(Punct::SEMI, "Expected ';' after do-while");
      return new SDoWhile{loc, body, condition};
    }

    Stmt parseForStatement() {
      auto tok = peek();
      SrcLoc loc = {tok.filename, tok.line, tok.column};
      expect(Punct::LPAREN, "Expected '(' after 'for'");

      // Init: either a declaration or an expression (or empty)
      // Per C99, declarations in the init clause are scoped to the for-loop.
      Stmt init = nullptr;
      bool pushedScope = false;
      if (!at(Punct::SEMI)) {
        if (isTypeName(peek())) {
          // Push a scope so the init declaration is local to this for-loop
          typeScope.push();
          tagScope.push();
          varScope.push();
          pushedScope = true;

          // Declaration
          SrcLoc initLoc = {peek().filename, peek().line, peek().column};
          std::vector<Decl> decls = parseDeclaration();
          for (auto &decl : decls) {
            if (decl.kind == DeclKind::VAR) {
              decl.as.var->definition = decl.as.var;
            }
          }
          init = new SDecl{initLoc, std::move(decls)};
          // parseDeclaration already consumed the semicolon
        } else {
          // Expression
          SrcLoc initLoc = {peek().filename, peek().line, peek().column};
          Expr initExpr = parseExpression();
          expect(Punct::SEMI, "Expected ';' after for init");
          init = new SExpr{initLoc, initExpr};
        }
      } else {
        advance();  // consume ';'
      }

      // Condition (optional)
      Expr condition = nullptr;
      if (!at(Punct::SEMI)) {
        condition = parseExpression();
      }
      expect(Punct::SEMI, "Expected ';' after for condition");

      // Increment (optional)
      Expr increment = nullptr;
      if (!at(Punct::RPAREN)) {
        increment = parseExpression();
      }
      expect(Punct::RPAREN, "Expected ')' after for clauses");

      Stmt body = parseStatement();

      if (pushedScope) {
        varScope.pop();
        tagScope.pop();
        typeScope.pop();
      }

      return new SFor{loc, init, condition, increment, body};
    }

    Stmt parseSwitchStatement() {
      auto tok = peek();
      SrcLoc loc = {tok.filename, tok.line, tok.column};
      expect(Punct::LPAREN, "Expected '(' after 'switch'");
      Expr expr = parseExpression();
      expect(Punct::RPAREN, "Expected ')' after switch expression");
      expect(Punct::LBRACE, "Expected '{' to start switch body");

      SCompound *switchBody = new SCompound{loc, {}, {}};
      SSwitch *sw = new SSwitch{loc, expr, {}, switchBody};

      SCompound *savedCompound = currentCompound;
      currentCompound = switchBody;

      while (!at(Punct::RBRACE) && !atEnd()) {
        if (match(Keyword::CASE)) {
          // Parse case value (must be constant integer expression)
          Expr caseExpr = parseExpression();
          ConstEval eval([](Type t) { return t.getSize(); });
          auto lowVal = eval.evaluateInt(caseExpr);
          if (!lowVal) {
            error("Case value must be a constant expression");
          }
          i64 lo = lowVal.value_or(0);
          i64 hi = lo;
          // GNU case range extension: case low ... high:
          if (at(Punct::ELLIPSIS)) {
            advance();
            Expr highExpr = parseExpression();
            auto highVal = eval.evaluateInt(highExpr);
            if (!highVal) {
              error("Case range value must be a constant expression");
            }
            hi = highVal.value_or(0);
          }
          expect(Punct::COLON, "Expected ':' after case value");
          u32 stmtIdx = static_cast<u32>(switchBody->statements.size());
          for (i64 v = lo; v <= hi; v++) {
            sw->cases.push_back({v, false, stmtIdx});
          }
        } else if (match(Keyword::DEFAULT)) {
          expect(Punct::COLON, "Expected ':' after 'default'");
          sw->cases.push_back({0, true, static_cast<u32>(switchBody->statements.size())});
        } else {
          // Regular statement
          switchBody->statements.push_back(parseStatement());
        }
      }

      currentCompound = savedCompound;
      expect(Punct::RBRACE, "Expected '}' to end switch body");
      return sw;
    }

    // --- Declaration Parsing ---

    // Parses a declaration (variable, typedef, or function prototype)
    // Returns a list because one line can declare multiple things: "int x, y, z;"
    std::vector<Decl> parseDeclaration() {
      std::vector<Decl> result;

      // 1. Specifiers (int, static, const, etc.)
      auto specs = parseDeclSpecifiers();
      Type baseType = specs.type;
      StorageClass sc = specs.storageClass;

      // Handle "struct Foo;" (no declarators)
      if (at(Punct::SEMI)) {
        advance();
        return result;
      }

      // 2. Comma-separated declarators
      bool first = true;
      while (true) {
        if (!first) {
          if (!match(Punct::COMMA)) break;
        }
        first = false;

        // Parse Declarator (e.g., "*x[5]")
        DeclaratorInput input{baseType, false, false, false, sc == StorageClass::TYPEDEF};
        DeclaratorResult declRes = parseDeclarator(input);

        // Parse __attribute__ after declarator
        auto localAttrs = parseGCCAttributes();
        if (localAttrs.aligned > 0 && specs.requestedAlignment < localAttrs.aligned) {
          specs.requestedAlignment = localAttrs.aligned;
        }

        // Handle Initializer
        // Use parseAssignmentExpression (not parseExpression) so commas
        // are treated as declarator separators, not comma operators.
        Expr init = nullptr;
        if (match(Punct::EQ)) {
          init = parseAssignmentExpression();
        }

        // Infer array size from string literal if type is unsized array
        if (init && init.kind == ExprKind::STRING && declRes.type.isArray() &&
            declRes.type.getArraySize() == 0) {
          // Use the string literal's size but preserve the declared base type
          // (e.g. keep 'const' from 'const char foo[] = "..."')
          declRes.type =
              Type::arrayOf(declRes.type.getArrayBase(), init.as.stringLit->type.getArraySize());
        }

        // Normalize initializer list: resolve designators, brace elision, type propagation
        if (init && init.kind == ExprKind::INIT_LIST && declRes.type.isArray() &&
            declRes.type.getArraySize() == 0) {
          normalizeInitList(init.as.initList, declRes.type);
          declRes.type = init.as.initList->type;
        } else if (init && init.kind == ExprKind::INIT_LIST && declRes.type.isAggregate()) {
          normalizeInitList(init.as.initList, declRes.type);
        }

        // Create the AST Node based on storage class and type
        Decl newDecl = nullptr;

        if (sc == StorageClass::TYPEDEF) {
          // C11 6.7.5p2: _Alignas shall not be specified in a declaration of a typedef
          if (specs.requestedAlignment > 0) {
            error(peek(-1), "_Alignas cannot be applied to a typedef");
          }
          // Register typedef immediately so it can be used in subsequent parses
          // No need to create separate typedef decls
          // C11 6.7p3: typedef redefinition is allowed if the types are compatible
          if (!typeScope.set(declRes.name, declRes.type)) {
            if (typeScope.hasInCurrentScope(declRes.name) &&
                typeScope.get(declRes.name).isCompatibleWith(declRes.type)) {
              // OK — compatible redefinition in same scope
            } else {
              error(peek(-1), "redefinition of typedef '" + std::string(*declRes.name) + "'");
            }
          }
          newDecl = nullptr;
        } else if (declRes.type.isFunction()) {
          // C11 6.7.5p2: _Alignas shall not be specified in a declaration of a function
          if (specs.requestedAlignment > 0) {
            error(peek(-1), "_Alignas cannot be applied to a function declaration");
          }
          std::vector<Decl> parameters;
          for (const auto &paramRes : declRes.parameters) {
            auto tok = peek(-1);
            DVar *paramVar = new DVar{
                SrcLoc{tok.filename, tok.line, tok.column},
                paramRes.name,
                paramRes.type,
                StorageClass::AUTO,
            };
            setInitialAllocClass(paramVar, false);  // params are not global
            parameters.push_back(Decl(paramVar));
          }
          DFunc *f = new DFunc{
              SrcLoc{peek(-1).filename, peek(-1).line, peek(-1).column},
              declRes.name,
              declRes.type,
              parameters,
              sc,
              specs.isInline,
              nullptr,  // body
              {},       // staticLocals
              {},       // externLocals
          };
          newDecl = Decl(f);
          // Register function name
          varScope.set(declRes.name, newDecl);

        } else {
          // Variable (local)
          if (!declRes.type.isComplete() && sc != StorageClass::EXTERN) {
            error(peek(-1),
                "variable '" + std::string(*declRes.name) + "' has incomplete type '" +
                    declRes.type.toString() + "'");
          }
          DVar *v = new DVar{SrcLoc{peek(-1).filename, peek(-1).line, peek(-1).column},
              declRes.name, declRes.type, sc, AllocClass::REGISTER, init};
          if (specs.requestedAlignment > 0) {
            // C11 6.7.5p2: _Alignas shall not appear on a register variable
            if (sc == StorageClass::REGISTER) {
              error(peek(-1), "_Alignas cannot be applied to a register variable");
            }
            if (specs.requestedAlignment < declRes.type.getAlign()) {
              error(peek(-1),
                  "_Alignas cannot reduce alignment below natural alignment of type '" +
                      declRes.type.toString() + "'");
            }
            v->requestedAlignment = specs.requestedAlignment;
          }
          setInitialAllocClass(v, false);  // local variable
          newDecl = Decl(v);
          varScope.set(declRes.name, newDecl);
        }

        // Ignore typedef decls in the result
        if (newDecl != nullptr) result.push_back(newDecl);
      }

      expect(Punct::SEMI, "Expected ';' after declaration");
      return result;
    }

    // Parses _Static_assert(expr, message)
    void parseStaticAssert() {
      Token startTok = peek(-1);  // The _Static_assert keyword token
      expect(Punct::LPAREN, "Expected '(' after _Static_assert");
      Expr condExpr = parseAssignmentExpression();
      expect(Punct::COMMA, "Expected ',' after _Static_assert condition");
      auto &msgTok = expect(TokenKind::STRING, "Expected string literal message in _Static_assert");
      std::string msg(msgTok.text.substr(1, msgTok.text.size() - 2));  // strip quotes
      expect(Punct::RPAREN, "Expected ')' after _Static_assert");
      expect(Punct::SEMI, "Expected ';' after _Static_assert");

      ConstEval eval([](Type t) { return t.getSize(); });
      auto val = eval.evaluateInt(condExpr);
      if (!val) {
        error(startTok, "_Static_assert condition must be a constant expression");
      }
      if (*val == 0) {
        error(startTok, "_Static_assert failed: " + msg);
      }
    }

    // Parses top-level globals, typedefs, OR function definitions
    void parseExternalDeclaration(TUnit &unit) {
      // Handle _Static_assert at file scope
      if (match(Keyword::STATIC_ASSERT)) {
        parseStaticAssert();
        return;
      }

      // 1. Specifiers
      auto specs = parseDeclSpecifiers();
      Type baseType = specs.type;
      StorageClass sc = specs.storageClass;

      // Handle "struct Foo;" at top level
      if (at(Punct::SEMI)) {
        advance();
        return;
      }

    nextDeclarator:

      // 2. Declarator
      DeclaratorInput input{baseType, false, false, false, sc == StorageClass::TYPEDEF};
      DeclaratorResult declRes = parseDeclarator(input);

      // 2b. K&R parameter declarations: parse type declarations between ')' and '{'
      if (declRes.isKnRParams && declRes.type.isFunction() && !at(Punct::LBRACE) && !at(Punct::SEMI) && !at(Punct::COMMA)) {
        // Parse K&R-style parameter type declarations until we hit '{'
        while (!at(Punct::LBRACE) && !atEnd()) {
          auto pSpecs = parseDeclSpecifiers();
          do {
            DeclaratorInput pInput{pSpecs.type, false, true, false};
            DeclaratorResult pDecl = parseDeclarator(pInput);
            Type finalType = pDecl.type.decay();
            // Find and update the matching parameter
            for (auto &p : declRes.parameters) {
              if (p.name == pDecl.name) {
                p.type = finalType;
                break;
              }
            }
          } while (match(Punct::COMMA));
          expect(Punct::SEMI, "Expected ';' after K&R parameter declaration");
        }
        // Rebuild the function type with updated parameter types
        std::vector<Type> newParamTypes;
        for (const auto &p : declRes.parameters) {
          newParamTypes.push_back(p.type);
        }
        declRes.type = Type::function(
            declRes.type.getReturnType(), newParamTypes,
            declRes.type.isVarArg(), false);
      }

      // Parse __attribute__ after declarator (e.g., void f(void) __attribute__((noinline)))
      auto declAttrs = parseGCCAttributes();
      if (declAttrs.aligned > 0 && specs.requestedAlignment < declAttrs.aligned) {
        specs.requestedAlignment = declAttrs.aligned;
      }

      // 3. Check for Function Definition
      // If it is a function and followed by '{', it is a definition
      if (declRes.type.isFunction() && at(Punct::LBRACE)) {
        // C11 6.7.5p2: _Alignas shall not be specified in a declaration of a function
        if (specs.requestedAlignment > 0) {
          error(peek(-1), "_Alignas cannot be applied to a function declaration");
        }
        // Extract parameters from declarator result
        std::vector<Decl> parameters;
        for (const auto &paramRes : declRes.parameters) {
          DVar *paramVar = new DVar{
              SrcLoc{peek(-1).filename, peek(-1).line, peek(-1).column},
              paramRes.name,
              paramRes.type,
              StorageClass::AUTO,
          };
          setInitialAllocClass(paramVar, false);  // params are not global
          parameters.push_back(Decl(paramVar));
        }
        DFunc *funcDef = new DFunc{
            SrcLoc{peek(-1).filename, peek(-1).line, peek(-1).column},
            declRes.name,
            declRes.type,  // full function type
            parameters,
            sc,
            specs.isInline,
            nullptr,  // body
            {},       // staticLocals
            {},       // externLocals
        };

        // Pre-link: if there's already a declaration for this name, point it to this definition
        if (varScope.has(declRes.name)) {
          Decl prev = varScope.get(declRes.name);
          if (prev.kind == DeclKind::FUNC) {
            if (!prev.as.func->type.isCompatibleWith(funcDef->type)) {
              recoverableError(peek(-1),
                  "conflicting types for '" + std::string(*declRes.name) +
                      "' (previously declared as '" + prev.as.func->type.toString() +
                      "', now defined as '" + funcDef->type.toString() + "')");
            }
            prev.as.func->definition = funcDef;
          }
        }

        // Add to scope before parsing body (allows recursion)
        Decl fDecl(funcDef);
        varScope.set(declRes.name, fDecl);

        // Parse Body
        currentParsingFunc = funcDef;
        parsedLabels.clear();
        pendingGotos.clear();
        funcDef->body = parseCompoundStatement(parameters);
        // Check for unresolved gotos
        for (auto &[name, gotos] : pendingGotos) {
          error("Undefined label '" + name + "'");
        }
        pendingGotos.clear();
        parsedLabels.clear();
        currentParsingFunc = nullptr;

        if (funcDef->storageClass == StorageClass::STATIC) {
          unit.staticFunctions.push_back(funcDef);
        } else {
          unit.definedFunctions.push_back(funcDef);
        }
        // Register extern locals so the linker can resolve them
        for (DVar *var : funcDef->externLocals) {
          unit.localExternVariables.push_back(var);
        }
        for (DFunc *f : funcDef->externLocalFuncs) {
          unit.localDeclaredFunctions.push_back(f);
        }
        return;
      }

      // 4. Otherwise, it's a standard declaration (Global var or Function prototype)
      // We already parsed one declarator, but there might be more: "int x, y;"

      // Re-use the logic for the first declarator
      Decl firstDecl;
      // C11 6.7.5p2: _Alignas shall not be specified in a declaration of a typedef or a function
      if (specs.requestedAlignment > 0) {
        if (sc == StorageClass::TYPEDEF) {
          error(peek(-1), "_Alignas cannot be applied to a typedef");
        }
        if (declRes.type.isFunction()) {
          error(peek(-1), "_Alignas cannot be applied to a function declaration");
        }
      }
      if (declRes.type.isFunction()) {
        std::vector<Decl> parameters;
        for (const auto &paramRes : declRes.parameters) {
          DVar *paramVar = new DVar{
              SrcLoc{peek(-1).filename, peek(-1).line, peek(-1).column},
              paramRes.name,
              paramRes.type,
              StorageClass::AUTO,
          };
          setInitialAllocClass(paramVar, false);  // params are not global
          parameters.push_back(Decl(paramVar));
        }
        firstDecl = Decl(new DFunc{SrcLoc{peek(-1).filename, peek(-1).line, peek(-1).column},
            declRes.name, declRes.type, parameters, sc, specs.isInline, nullptr, {}, {}});
      } else {
        Expr init = nullptr;
        if (match(Punct::EQ)) {
          init = parseAssignmentExpression();
        }

        // Infer array size from string literal if type is unsized array
        Type varType = declRes.type;
        if (init && init.kind == ExprKind::STRING && varType.isArray() &&
            varType.getArraySize() == 0) {
          // Use the string literal's size but preserve the declared base type
          // (e.g. keep 'const' from 'const char foo[] = "..."')
          varType = Type::arrayOf(varType.getArrayBase(), init.as.stringLit->type.getArraySize());
        }

        // Normalize initializer list: resolve designators, brace elision, type propagation
        if (init && init.kind == ExprKind::INIT_LIST && varType.isArray() &&
            varType.getArraySize() == 0) {
          normalizeInitList(init.as.initList, varType);
          varType = init.as.initList->type;
        } else if (init && init.kind == ExprKind::INIT_LIST && varType.isAggregate()) {
          normalizeInitList(init.as.initList, varType);
        }

        if (!varType.isComplete() && sc != StorageClass::EXTERN && sc != StorageClass::TYPEDEF) {
          error(peek(-1),
              "variable '" + std::string(*declRes.name) + "' has incomplete type '" +
                  varType.toString() + "'");
        }
        DVar *v = new DVar{SrcLoc{peek(-1).filename, peek(-1).line, peek(-1).column}, declRes.name,
            varType, sc, AllocClass::REGISTER, init};
        if (specs.requestedAlignment > 0) {
          if (specs.requestedAlignment < varType.getAlign()) {
            error(peek(-1),
                "_Alignas cannot reduce alignment below natural alignment of type '" +
                    varType.toString() + "'");
          }
          v->requestedAlignment = specs.requestedAlignment;
        }
        setInitialAllocClass(v, true);  // global variable
        firstDecl = Decl(v);
      }

      if (sc == StorageClass::TYPEDEF) {
        // C11 6.7p3: typedef redefinition is allowed if the types are compatible
        if (!typeScope.set(declRes.name, declRes.type)) {
          if (typeScope.hasInCurrentScope(declRes.name) &&
              typeScope.get(declRes.name).isCompatibleWith(declRes.type)) {
            // OK — compatible redefinition in same scope
          } else {
            error(peek(-1), "redefinition of typedef '" + std::string(*declRes.name) + "'");
          }
        }
      } else {
        // Check type compatibility with any previous declaration of the same name
        if (varScope.has(declRes.name)) {
          Decl prev = varScope.get(declRes.name);
          Type prevType, newType;
          if (prev.kind == DeclKind::FUNC && firstDecl.kind == DeclKind::FUNC) {
            prevType = prev.as.func->type;
            newType = firstDecl.as.func->type;
          } else if (prev.kind == DeclKind::VAR && firstDecl.kind == DeclKind::VAR) {
            prevType = prev.as.var->type;
            newType = firstDecl.as.var->type;
          }
          if (prevType != Type{} && !prevType.isCompatibleWith(newType)) {
            recoverableError(peek(-1),
                "conflicting types for '" + std::string(*declRes.name) +
                    "' (previously declared as '" + prevType.toString() + "', now declared as '" +
                    newType.toString() + "')");
          }
          // Pre-link: point previous declaration to this definition
          if (firstDecl.kind == DeclKind::VAR && sc != StorageClass::EXTERN &&
              prev.kind == DeclKind::VAR) {
            prev.as.var->definition = firstDecl.as.var;
          }
          // Update the scope entry so subsequent uses see the complete type
          // (e.g. extern char foo[]; char foo[] = "..."; sizeof(foo) should work)
          varScope.get(declRes.name) = firstDecl;
        }
        if (!varScope.has(declRes.name)) varScope.set(declRes.name, firstDecl);
        // Classify into the appropriate typed list
        if (firstDecl.kind == DeclKind::FUNC) {
          DFunc *f = firstDecl.as.func;
          if (f->storageClass == StorageClass::IMPORT) {
            unit.importedFunctions.push_back(f);
          } else {
            unit.declaredFunctions.push_back(f);
          }
        } else {
          DVar *v = firstDecl.as.var;
          if (v->storageClass == StorageClass::EXTERN) {
            unit.externVariables.push_back(v);
          } else {
            unit.definedVariables.push_back(v);
          }
        }
      }

      // Parse remaining declarators in the list: ", y = 10;"
      while (match(Punct::COMMA)) {
        goto nextDeclarator;
      }

      expect(Punct::SEMI, "Expected ';' after external declaration");
    }

    // --- Type Parsing ---

    // Parses a list of specifiers and returns the base Type, StorageClass, and function specifiers
    DeclSpecifiers parseDeclSpecifiers() {
      StorageClass sc = StorageClass::NONE;
      bool isInline = false;
      i32 requestedAlignment = 0;

      // Internal state to track the accumulation of specifiers
      enum BaseKind { NONE, VOID, BOOL, CHAR, INT, FLOAT, DOUBLE, TAG, TYPE_NAME };
      BaseKind base = NONE;

      int longCount = 0;  // 0 = default, 1 = long, 2 = long long
      bool isShort = false;
      bool isSigned = false;
      bool isUnsigned = false;
      bool isConst = false;
      bool isVolatile = false;

      Type finalType = TUNKNOWN;

      while (true) {
        // 1. Storage Classes
        if (match(Keyword::CONST)) {
          isConst = true;
          continue;
        }
        if (match(Keyword::VOLATILE)) {
          isVolatile = true;
          continue;
        }
        if (match(Keyword::RESTRICT)) {
          continue;  // Recognized but ignored (optimization hint)
        }
        if (match(Keyword::EXTERN)) {
          sc = StorageClass::EXTERN;
          continue;
        }
        if (match(Keyword::STATIC)) {
          sc = StorageClass::STATIC;
          continue;
        }
        if (match(Keyword::TYPEDEF)) {
          sc = StorageClass::TYPEDEF;
          continue;
        }
        if (match(Keyword::X_IMPORT)) {
          sc = StorageClass::IMPORT;
          continue;
        }
        if (match(Keyword::REGISTER)) {
          sc = StorageClass::REGISTER;
          continue;
        }
        if (match(Keyword::AUTO)) {
          sc = StorageClass::AUTO;
          continue;
        }
        if (match(Keyword::INLINE)) {
          isInline = true;
          continue;
        }
        if (match(Keyword::NORETURN)) {
          // _Noreturn is recognized but not enforced (just like inline is an optimization hint)
          continue;
        }
        if (match(Keyword::THREAD_LOCAL)) {
          // _Thread_local is recognized but ignored (WASM is single-threaded)
          continue;
        }
        if (at(Keyword::X_ATTRIBUTE)) {
          auto attrs = parseGCCAttributes();
          if (attrs.aligned > requestedAlignment) requestedAlignment = attrs.aligned;
          continue;
        }
        if (match(Keyword::ALIGNAS)) {
          Token alignTok = peek(-1);
          expect(Punct::LPAREN, "Expected '(' after _Alignas");
          i32 alignVal;
          if (isTypeName(peek())) {
            Type alignType = parseTypeName();
            alignVal = alignType.getAlign();
          } else {
            Expr alignExpr = parseAssignmentExpression();
            ConstEval eval([](Type t) { return t.getSize(); });
            auto v = eval.evaluateInt(alignExpr);
            if (!v) error(alignTok, "_Alignas requires a constant expression");
            alignVal = static_cast<i32>(v.value_or(0));
          }
          expect(Punct::RPAREN, "Expected ')' after _Alignas");
          // C11 6.7.5p6: "An alignment specification of zero has no effect."
          if (alignVal == 0) {
            continue;
          }
          if (alignVal < 0 || (alignVal & (alignVal - 1)) != 0) {
            error(alignTok, "_Alignas value must be a positive power of 2");
          }
          // C11 6.2.8: extended alignments (> max_align_t = 8 on wasm32) are
          // implementation-defined. We don't support them.
          if (alignVal > 8) {
            error(alignTok,
                "_Alignas(" + std::to_string(alignVal) +
                    ") exceeds maximum supported alignment of 8");
          }
          // C11: if multiple _Alignas, the strictest (largest) wins
          if (alignVal > requestedAlignment) requestedAlignment = alignVal;
          continue;
        }

        // 2. Type Qualifiers that modify the base
        if (match(Keyword::LONG)) {
          longCount++;
          continue;
        }
        if (match(Keyword::SHORT)) {
          isShort = true;
          continue;
        }
        if (match(Keyword::SIGNED)) {
          isSigned = true;
          continue;
        }
        if (match(Keyword::UNSIGNED)) {
          isUnsigned = true;
          continue;
        }

        // 3. Base Types
        // If we already found a base type (e.g., 'int'), we can't accept another (e.g., 'char').
        // However, we continue loop to catch trailing qualifiers like "int const".
        if (base != NONE) {
          // If we see a keyword that MUST be a type, we break.
          // If we see an identifier that IS a typedef, we also break because it must be the
          // declarator.
          if (at(TokenKind::KEYWORD)) {
            Keyword k = peek().value.keyword;
            if (k == Keyword::VOID || k == Keyword::BOOL || k == Keyword::CHAR ||
                k == Keyword::INT || k == Keyword::FLOAT || k == Keyword::DOUBLE ||
                k == Keyword::STRUCT || k == Keyword::UNION || k == Keyword::ENUM) {
              break;
            }
          } else if (at(TokenKind::IDENT) && typeScope.has(intern(peek().text))) {
            break;
          }
          // Otherwise, it might be a qualifier (handled above) or start of declarator (break below)
          if (!at(Keyword::CONST) && !at(Keyword::VOLATILE) && !at(Keyword::RESTRICT) &&
              !at(Keyword::LONG) && !at(Keyword::SHORT) && !at(Keyword::SIGNED) &&
              !at(Keyword::UNSIGNED) && !at(Keyword::ALIGNAS) && !at(Keyword::X_ATTRIBUTE)) {
            break;
          }
          continue;
        }

        if (match(Keyword::VOID)) {
          base = VOID;
        } else if (match(Keyword::BOOL)) {
          base = BOOL;
        } else if (match(Keyword::CHAR)) {
          base = CHAR;
        } else if (match(Keyword::INT)) {
          base = INT;
        } else if (match(Keyword::FLOAT)) {
          base = FLOAT;
        } else if (match(Keyword::DOUBLE)) {
          base = DOUBLE;
        } else if (match(Keyword::STRUCT) || match(Keyword::UNION) || match(Keyword::ENUM)) {
          // --- Tag Parsing Logic ---
          TagKind tk = TagKind::STRUCT;
          // We looked at the token *before* the current pos to identify which keyword matched
          Token prev = tokens[pos - 1];
          if (prev.value.keyword == Keyword::UNION) tk = TagKind::UNION;
          if (prev.value.keyword == Keyword::ENUM) tk = TagKind::ENUM;

          // Parse optional __attribute__ after struct/union keyword
          auto tagAttrs = parseGCCAttributes();

          Symbol name = nullptr;
          bool isAnonymous = false;

          // Check for tag name: "struct Foo"
          if (at(TokenKind::IDENT)) {
            name = intern(advance().text);
          } else {
            // Anonymous: "struct { ... }"
            int &anonCount = this->anonCount;
            name = intern("__anon_" + std::to_string(anonCount++));
            isAnonymous = true;
          }

          Type tagType;
          bool isDefining = at(Punct::LBRACE);

          // Scope Resolution
          if (!isDefining && !isAnonymous && tagScope.has(name)) {
            // Forward declaration or usage of existing: "struct Foo x;"
            tagType = tagScope.get(name);
          } else {
            // New definition OR First time seeing forward decl
            if (tagScope.hasInCurrentScope(name) && isDefining) {
              // Completing a forward declaration in the same scope - reuse existing type
              tagType = tagScope.get(name);
            } else {
              // Either first time, or shadowing an outer scope's tag
              tagType = Type::newTag(tk, name);
              tagScope.set(name, tagType);
            }
          }

          // Body Definition
          if (match(Punct::LBRACE)) {
            // We are defining the contents.
            // Note: We "leak" the DTag into the AST nodes.
            DTag *tagDecl =
                new DTag{SrcLoc{prev.filename, prev.line, prev.column}, tk, name, true, false, {}};

            if (tk == TagKind::ENUM) {
              // Enum Members: IDENT = EXPR, ...
              i64 runningValue = 0;
              while (!at(Punct::RBRACE) && !atEnd()) {
                Token id = expect(TokenKind::IDENT, "Expected enum constant name");
                i64 val = runningValue;
                if (match(Punct::EQ)) {
                  // Use parseAssignmentExpression to avoid comma being parsed as operator
                  Expr valExpr = parseAssignmentExpression();
                  ConstEval eval([](Type t) { return t.getSize(); });
                  auto v = eval.evaluateInt(valExpr);
                  if (!v) {
                    error("Enum value must be a constant expression");
                  }
                  val = v.value_or(0);
                }
                runningValue = val + 1;

                // Enums inject their constants into the *enclosing* scope (usually global)
                DEnumConst *enumConst = new DEnumConst{
                    SrcLoc{id.filename, id.line, id.column},
                    intern(id.text),
                    val,
                };
                tagDecl->members.push_back(enumConst);
                // Add to scope so subsequent enum constants and expressions can reference it
                varScope.set(enumConst->name, Decl(enumConst));

                if (!match(Punct::COMMA)) break;
              }
            } else {
              // Struct/Union Members: Type Declarator, ...;
              while (!at(Punct::RBRACE) && !atEnd()) {
                // C11 6.7.2.1p1: _Static_assert is allowed as a struct-declaration
                if (match(Keyword::STATIC_ASSERT)) {
                  parseStaticAssert();
                  continue;
                }
                // Recursively parse the type of the member
                auto memSpecs = parseDeclSpecifiers();
                Type memBaseType = memSpecs.type;

                // Parse declarator list: "int x, *y, z[3];"
                bool first = true;
                while (true) {
                  if (!first && !match(Punct::COMMA)) break;
                  first = false;

                  // Stop if we hit semicolon (empty declarator list)
                  // If the base type is a struct/union, this is an anonymous
                  // member whose fields should be accessible on the parent.
                  if (at(Punct::SEMI)) {
                    if (memBaseType.isTag()) {
                      auto tok = peek(-1);
                      DVar *memberVar = new DVar{
                          SrcLoc{tok.filename, tok.line, tok.column},
                          Symbol{},  // anonymous
                          memBaseType,
                          StorageClass::NONE,
                      };
                      tagDecl->members.push_back(Decl(memberVar));
                    }
                    break;
                  }

                  // Check for anonymous bit-field: just ": width" with no declarator
                  if (at(Punct::COLON)) {
                    advance();  // consume ':'
                    Expr widthExpr = parseAssignmentExpression();
                    ConstEval eval([](Type t) { return t.getSize(); });
                    auto w = eval.evaluateInt(widthExpr);
                    if (!w) error("Bit-field width must be a constant expression");
                    if (memBaseType.getSize() > 4)
                      error(
                          "Bit-fields wider than 32 bits are not supported (use int or unsigned "
                          "int)");
                    i32 width = static_cast<i32>(w.value_or(0));
                    auto tok = peek(-1);
                    DVar *memberVar = new DVar{
                        SrcLoc{tok.filename, tok.line, tok.column},
                        Symbol{},  // anonymous
                        memBaseType,
                        StorageClass::NONE,
                    };
                    memberVar->bitWidth = width;
                    tagDecl->members.push_back(Decl(memberVar));
                    break;  // anonymous bit-fields end the declarator list
                  }

                  // Parse the declarator
                  DeclaratorInput input{memBaseType, false, false, true};
                  DeclaratorResult declRes = parseDeclarator(input);

                  // Parse __attribute__ after member declarator
                  auto memAttrs = parseGCCAttributes();
                  if (memAttrs.aligned > 0 && memSpecs.requestedAlignment < memAttrs.aligned) {
                    memSpecs.requestedAlignment = memAttrs.aligned;
                  }

                  // Check for bit-field width after declarator
                  i32 bitWidth = -1;
                  if (match(Punct::COLON)) {
                    Expr widthExpr = parseAssignmentExpression();
                    ConstEval eval([](Type t) { return t.getSize(); });
                    auto w = eval.evaluateInt(widthExpr);
                    if (!w) error("Bit-field width must be a constant expression");
                    if (declRes.type.getSize() > 4)
                      error(
                          "Bit-fields wider than 32 bits are not supported (use int or unsigned "
                          "int)");
                    bitWidth = static_cast<i32>(w.value_or(0));
                  }

                  // Create member variable declaration
                  auto tok = peek(-1);
                  DVar *memberVar = new DVar{
                      SrcLoc{tok.filename, tok.line, tok.column},
                      declRes.name,
                      declRes.type,
                      StorageClass::NONE,
                  };
                  memberVar->bitWidth = bitWidth;
                  if (memSpecs.requestedAlignment > 0) {
                    // C11 6.7.5p2: _Alignas shall not be specified in a declaration of a bit-field
                    if (memberVar->isBitField()) {
                      error(tok, "_Alignas cannot be applied to a bit-field");
                    }
                    if (memSpecs.requestedAlignment < declRes.type.getAlign()) {
                      error(tok,
                          "_Alignas cannot reduce alignment below natural alignment of type '" +
                              declRes.type.toString() + "'");
                    }
                    memberVar->requestedAlignment = memSpecs.requestedAlignment;
                  }
                  tagDecl->members.push_back(Decl(memberVar));
                }
                expect(Punct::SEMI, "Expected ';' after struct member declaration");
              }

              // Validate flexible array members (C99):
              // - Only allowed in structs (not unions or GC structs)
              // - Must be the last member
              // - Struct must have at least one other named member before the FAM
              {
                bool foundFAM = false;
                size_t famIdx = 0;
                size_t namedVarCount = 0;
                for (size_t i = 0; i < tagDecl->members.size(); i++) {
                  const auto &m = tagDecl->members[i];
                  if (m.kind != DeclKind::VAR) continue;
                  DVar *mv = m.as.var;
                  if (mv->name) namedVarCount++;
                  if (mv->type.isArray() && mv->type.getArraySize() == 0) {
                    if (tk == TagKind::UNION) {
                      error("flexible array member not allowed in a union");
                    }
                    if (foundFAM) {
                      error("only one flexible array member is allowed per struct");
                    }
                    foundFAM = true;
                    famIdx = i;
                  }
                }
                if (foundFAM) {
                  // Check it's the last VAR member
                  for (size_t i = famIdx + 1; i < tagDecl->members.size(); i++) {
                    if (tagDecl->members[i].kind == DeclKind::VAR) {
                      error("flexible array member must be the last member of a struct");
                    }
                  }
                  // Must have at least one other named member
                  if (namedVarCount < 2) {
                    error("flexible array member in a struct with no other named members");
                  }
                }
              }
            }
            expect(Punct::RBRACE, "Expected '}' after tag body");

            // Parse __attribute__ after closing } (e.g., struct S { ... } __attribute__((packed)))
            auto postTagAttrs = parseGCCAttributes();

            // Apply attributes from both before and after the tag body
            if (tagAttrs.packed || postTagAttrs.packed) tagDecl->isPacked = true;
            if (tagAttrs.aligned > 0 || postTagAttrs.aligned > 0) {
              i32 a = std::max(tagAttrs.aligned, postTagAttrs.aligned);
              if (a > requestedAlignment) requestedAlignment = a;
            }

            // Fill in the tag declaration in the type
            // While Types are largely immutable, this is ok because
            // the decl actually does not change the 'identity' of the Type.
            // Its Type::Info* pointer essentially serves as the identity.
            tagType.setTagDecl(tagDecl);
          }

          base = TAG;
          finalType = tagType;
        } else if (at(TokenKind::IDENT)) {
          // Typedef Lookup
          // Only consider it a type if we haven't found a base yet.
          Symbol sym = intern(peek().text);
          if (typeScope.has(sym)) {
            advance();
            finalType = typeScope.get(sym);
            base = TYPE_NAME;
          } else {
            break;  // It's an identifier, but not a type. Must be start of declarator.
          }
        } else {
          break;  // Not a type specifier
        }
      }

      // 4. Final Type Resolution
      // Construct the specific primitive type based on the flags
      if (base == TAG || base == TYPE_NAME) {
        // finalType is already set.
        // Tags and Typedefs cannot be modified by short/long/signed/unsigned
        // (Standard C allows `typedef int I; unsigned I x;`? No, that is invalid C).

        // In C, enum types are compatible with int. Erase enum types to int
        // early so codegen never needs to handle them as a special case.
        if (finalType.isEnum()) {
          finalType = TINT;
        }
      } else if (base == VOID) {
        finalType = TVOID;
      } else if (base == BOOL) {
        finalType = TBOOL;
      } else if (base == FLOAT) {
        finalType = TFLOAT;
      } else if (base == DOUBLE) {
        if (longCount > 0) finalType = TLDOUBLE;
        else finalType = TDOUBLE;
      } else if (base == CHAR) {
        if (isUnsigned) finalType = TUCHAR;
        else if (isSigned) finalType = TSCHAR;
        else finalType = TCHAR;  // Plain char is distinct
      } else {
        // Implicit INT (covers "int", "short", "long", "unsigned", etc.)
        if (isShort) {
          finalType = isUnsigned ? TUSHORT : TSHORT;
        } else if (longCount == 1) {
          finalType = isUnsigned ? TULONG : TLONG;
        } else if (longCount >= 2) {
          finalType = isUnsigned ? TULLONG : TLLONG;
        } else {
          if (base == NONE && !isSigned && !isUnsigned && !compilerOptions.allowImplicitInt)
            error("type specifier missing (implicit int is not allowed in C99)");
          finalType = isUnsigned ? TUINT : TINT;
        }
      }

      // 5. Apply Top-Level Qualifiers
      if (isConst) finalType = finalType.addConst();
      if (isVolatile) finalType = finalType.addVolatile();

      return {finalType, sc, isInline, requestedAlignment};
    }

    struct DeclaratorInput {
      Type baseType;
      bool allowAbstract = false;  // allow no name (e.g., for casts)
      bool isParameter = false;    // special rules for function parameters
      bool isMember = false;       // special rules for struct/union members
      bool isTypedef = false;      // typedef declarator (relaxes GC struct pointer requirement)
    };

    struct Parameter {
      SrcLoc loc;
      Type type;
      Symbol name;
    };

    struct DeclaratorResult {
      Symbol name = nullptr;
      Type type;
      std::vector<Parameter> parameters;
      bool isKnRParams = false;  // true if parameters were K&R-style identifier list

      // For member declarators with bit-fields
      Expr bitWidth = nullptr;
    };

    // Helper to skip balanced parentheses/brackets to find the end of a construct
    // Returns the index of the token *after* the matching closing delimiter
    // Skip balanced parentheses content. Assumes opening '(' was already consumed.
    void skipBalancedParens() {
      int depth = 1;
      while (depth > 0 && !atEnd()) {
        if (match(Punct::LPAREN)) depth++;
        else if (match(Punct::RPAREN)) depth--;
        else advance();
      }
    }

    // Parse a single attribute inside __attribute__((...))
    void parseSingleAttribute(ParsedAttributes &attrs) {
      if (at(Punct::RPAREN) || at(Punct::COMMA)) return;  // empty attribute

      // Get attribute name — can be identifier or keyword (e.g., const, unused)
      Token nameTok = advance();
      std::string_view rawName = nameTok.text;

      // Normalize __foo__ -> foo
      std::string_view name = rawName;
      if (name.size() > 4 && name.substr(0, 2) == "__" && name.substr(name.size() - 2) == "__") {
        name = name.substr(2, name.size() - 4);
      }

      // --- Attributes with dedicated handling ---
      if (name == "packed") {
        attrs.packed = true;
        if (match(Punct::LPAREN)) skipBalancedParens();
        return;
      }
      if (name == "aligned") {
        if (match(Punct::LPAREN)) {
          if (at(Punct::RPAREN)) {
            attrs.aligned = std::max(attrs.aligned, (i32)8);
          } else {
            Expr alignExpr = parseAssignmentExpression();
            ConstEval eval([](Type t) { return t.getSize(); });
            auto v = eval.evaluateInt(alignExpr);
            if (v) attrs.aligned = std::max(attrs.aligned, static_cast<i32>(*v));
          }
          expect(Punct::RPAREN, "Expected ')' after aligned argument");
        } else {
          attrs.aligned = std::max(attrs.aligned, (i32)8);
        }
        return;
      }

      // --- No-arg attributes stored in flags ---
      // Optimization hints (no-op for us but stored for future use)
      if (name == "noinline" || name == "noipa" || name == "always_inline" ||
          name == "noclone" || name == "noreturn" || name == "cold" || name == "hot" ||
          // Warning/diagnostic hints
          name == "unused" || name == "used" ||
          // Purity/side-effect hints
          name == "const" || name == "pure" || name == "nothrow" || name == "malloc" ||
          // Other safe no-arg attributes
          name == "no_instrument_function" || name == "externally_visible" ||
          name == "may_alias" ||
          name == "flatten" || name == "leaf" ||
          name == "returns_twice" || name == "warn_unused_result" ||
          name == "deprecated" || name == "visibility") {
        attrs.flags.insert(intern(std::string(name)));
        // Some of these can optionally take args (e.g. constructor(priority))
        if (match(Punct::LPAREN)) skipBalancedParens();
        return;
      }

      // --- Attributes with args that are safe to parse and store ---
      if (name == "format" || name == "nonnull" || name == "optimize" ||
          name == "section" || name == "sentinel" || name == "alloc_size" ||
          name == "assume_aligned" || name == "target") {
        attrs.flags.insert(intern(std::string(name)));
        if (match(Punct::LPAREN)) skipBalancedParens();
        return;
      }

      // --- Attributes that change semantics — error ---
      if (name == "vector_size" || name == "mode" || name == "scalar_storage_order" ||
          name == "constructor" || name == "destructor" || name == "alias" ||
          name == "ifunc" || name == "weak") {
        if (match(Punct::LPAREN)) skipBalancedParens();
        error(nameTok, "__attribute__((" + std::string(name) + ")) is not supported");
        return;
      }

      // --- Unknown attribute — error ---
      if (match(Punct::LPAREN)) skipBalancedParens();
      error(nameTok, "unknown __attribute__((" + std::string(name) + "))");
    }

    // Parse __attribute__((...)) sequences. Can be called anywhere attributes may appear.
    ParsedAttributes parseGCCAttributes() {
      ParsedAttributes attrs;
      while (at(Keyword::X_ATTRIBUTE)) {
        advance();  // consume __attribute__
        expect(Punct::LPAREN, "Expected '(' after __attribute__");
        expect(Punct::LPAREN, "Expected '((' after __attribute__");
        while (!at(Punct::RPAREN) && !atEnd()) {
          parseSingleAttribute(attrs);
          if (!match(Punct::COMMA)) break;
        }
        expect(Punct::RPAREN, "Expected '))' in __attribute__");
        expect(Punct::RPAREN, "Expected '))' in __attribute__");
      }
      return attrs;
    }

    size_t scanToMatching(size_t start, std::string_view open, std::string_view close) {
      int depth = 1;
      for (size_t i = start + 1; i < tokens.size(); ++i) {
        if (tokens[i].kind == TokenKind::EOS) break;

        if (tokens[i].text == open) {
          depth++;
        } else if (tokens[i].text == close) {
          depth--;
          if (depth == 0) {
            return i + 1;
          }
        }
      }
      return tokens.size();  // Not found
    }

    // Parses: [ const/volatile/static assignment_expr? ]
    // Returns the array dimension (size) without modifying any type
    i32 parseArrayDimension() {
      advance();  // consume '['

      // C99: skip static and type qualifiers in array dimensions (e.g. int a[static const 10])
      while (at(Keyword::STATIC) || at(Keyword::CONST) || at(Keyword::VOLATILE) ||
          at(Keyword::RESTRICT)) {
        advance();
      }
      i32 size = 0;

      if (!at(Punct::RBRACK)) {
        Expr sizeExpr = parseAssignmentExpression();
        ConstEval eval([](Type t) { return t.getSize(); });
        auto val = eval.evaluateInt(sizeExpr);
        if (!val) {
          error("Array size must be a constant expression");
        }
        size = static_cast<i32>(val.value_or(0));
      }
      expect(Punct::RBRACK, "Expected ']' after array size");
      return size;
    }

    // Parses: [ const/volatile/static assignment_expr? ]
    // Modifies baseType to be Array(baseType)
    void parseArraySuffix(Type &baseType) {
      baseType = Type::arrayOf(baseType, parseArrayDimension());
    }

    // Parses: ( parameter-type-list )
    // Modifies baseType to be Function(baseType)
    // Fills outParams if this is a function definition
    void parseFunctionSuffix(Type &baseType, std::vector<Parameter> &outParams,
                             bool &outIsKnR) {
      advance();  // consume '('
      outIsKnR = false;

      std::vector<Type> paramTypes;
      std::vector<Parameter> params;
      bool isVarArg = false;
      bool hasUnspecifiedParams = false;

      // C++ style: f(void) is equivalent to f()
      if (at(Keyword::VOID) && peek(1).atPunct(Punct::RPAREN)) {
        advance();  // consume 'void'
      } else if (at(Punct::RPAREN)) {
        hasUnspecifiedParams = true;  // f() means unspecified params
      } else if (compilerOptions.allowKnRDefinitions &&
                 at(TokenKind::IDENT) && !isTypeName(peek()) &&
                 (peek(1).atPunct(Punct::COMMA) || peek(1).atPunct(Punct::RPAREN))) {
        // K&R identifier list: f(a, b, c)
        outIsKnR = true;
        while (at(TokenKind::IDENT)) {
          SrcLoc pLoc{peek().filename, peek().line, peek().column};
          Symbol pName = intern(advance().text);
          paramTypes.push_back(TINT);  // placeholder, will be overwritten
          params.push_back(Parameter{pLoc, TINT, pName});
          if (!match(Punct::COMMA)) break;
        }
      } else {
        while (true) {
          if (match(Punct::ELLIPSIS)) {
            isVarArg = true;
            break;
          }

          // Parse Parameter Declaration
          // 1. Specifiers
          auto pSpecs = parseDeclSpecifiers();
          Type pType = pSpecs.type;
          // C11 6.7.5p2: _Alignas shall not be specified in a declaration of a parameter
          if (pSpecs.requestedAlignment > 0) {
            error(peek(-1), "_Alignas cannot be applied to a function parameter");
          }

          // 2. Declarator
          // Param declarators can be abstract (int) or named (int a)
          DeclaratorInput pInput{pType, true, true, false};
          DeclaratorResult pDecl = parseDeclarator(pInput);

          // Function parameters decay: Array -> Pointer, Function -> Pointer
          Type finalType = pDecl.type.decay();
          paramTypes.push_back(finalType);

          // Create DVar for the parameter
          // Generate synthetic name for unnamed params to match JS behavior
          Symbol paramName = pDecl.name;
          if (!paramName) {
            paramName = intern("__param" + std::to_string(params.size()));
          }
          auto parameter =
              Parameter{SrcLoc{peek().filename, peek().line, peek().column}, finalType, paramName};
          params.push_back(parameter);

          if (!match(Punct::COMMA)) break;
        }
      }

      expect(Punct::RPAREN, "Expected ')' after parameter list");

      baseType = Type::function(baseType, paramTypes, isVarArg, hasUnspecifiedParams);
      outParams = std::move(params);
    }

    // Core "Direct Declarator" parser that handles the logic of skipping/jumping
    DeclaratorResult parseDirectDeclarator(DeclaratorInput input) {
      DeclaratorResult result;
      result.type = input.baseType;

      // 1. Handle Nested Parentheses: ( declarator )
      //    In abstract declarator context, we must disambiguate between:
      //      ( abstract-declarator )                              — grouping
      //      direct-abstract-declarator_opt ( param-list_opt )    — function suffix
      //    The grouping production requires a non-empty abstract-declarator inside,
      //    which can only start with '*', '(', or '['. A parameter list starts with
      //    declaration-specifiers, ')', or '...'. The sets are disjoint, so 1 token
      //    of lookahead after '(' resolves it.
      if (at(Punct::LPAREN) &&
          !(input.allowAbstract &&
              (peek(1).atPunct(Punct::RPAREN) || peek(1).atPunct(Punct::ELLIPSIS) || isTypeName(peek(1))))) {
        size_t openParenIdx = pos;

        // A. JUMP: Scan ahead to find the matching ')'
        size_t closeParenIdx = scanToMatching(openParenIdx, "(", ")") - 1;

        if (closeParenIdx >= tokens.size()) {
          error("Unmatched parentheses in declarator");
          return result;
        }

        // B. PROCESS SUFFIXES: Apply suffixes appearing *after* the ')' first
        //    (Precedence: Suffixes bind to the inner group before the group binds to prefixes)
        pos = closeParenIdx + 1;  // Jump to after ')'

        // Loop to consume all chained suffixes: int (*x)[5][6]...
        // For arrays, collect dimensions and apply in reverse order.
        while (true) {
          if (at(Punct::LBRACK)) {
            // Collect all consecutive array dimensions
            std::vector<i32> arrayDims;
            while (at(Punct::LBRACK)) {
              arrayDims.push_back(parseArrayDimension());
            }
            // Apply in reverse order
            for (auto it = arrayDims.rbegin(); it != arrayDims.rend(); ++it) {
              result.type = Type::arrayOf(result.type, *it);
            }
            // Arrays obscure parameters (variable 'x' is array, not function)
            result.parameters.clear();
          } else if (at(Punct::LPAREN)) {
            parseFunctionSuffix(result.type, result.parameters, result.isKnRParams);
          } else {
            break;
          }
        }

        // C. RECURSE: Jump back inside the parens and parse the inner declarator
        //    using the Type we just built as the NEW base.
        size_t endOfSuffixes = pos;
        pos = openParenIdx + 1;  // inside (

        // Constrain the inner parser to stop at the closing paren
        // In a full implementation we might pass a 'end' sentinel or rely on the fact
        // that the inner parseDeclarator will stop when it hits ')' if it parses correctly.

        DeclaratorInput innerInput = input;
        innerInput.baseType = result.type;  // Pass the suffixed type down
        auto savedParameters = std::move(result.parameters);
        result = parseDeclarator(innerInput);
        // Preserve parameters from function suffix if recursive call didn't set any.
        // This handles parenthesized function names like: int (func)(int x) { ... }
        if (result.parameters.empty()) {
          result.parameters = std::move(savedParameters);
        }

        // Ensure we consumed everything inside
        if (pos != closeParenIdx) {
          // error("Trailing tokens inside declarator parentheses");
          // Recovery: force pos
        }

        // D. RESTORE: Jump to the end of the suffixes we processed earlier
        pos = endOfSuffixes;

        return result;
      }

      // 2. Handle Identifier (The "Core")
      if (at(TokenKind::IDENT)) {
        result.name = intern(advance().text);
      } else if (!input.allowAbstract) {
        error("Expected identifier in declarator");
      }

      // 3. Handle Suffixes (for non-nested identifiers)
      //    e.g. x[5]
      //    For arrays, we need to collect dimensions and apply in REVERSE order
      //    because C's int arr[2][3] means array of 2 elements, each being int[3].
      while (true) {
        if (at(Punct::LBRACK)) {
          // Collect all consecutive array dimensions
          std::vector<i32> arrayDims;
          while (at(Punct::LBRACK)) {
            arrayDims.push_back(parseArrayDimension());
          }
          // Apply in reverse order: int arr[2][3] -> arrayOf(arrayOf(int, 3), 2)
          for (auto it = arrayDims.rbegin(); it != arrayDims.rend(); ++it) {
            result.type = Type::arrayOf(result.type, *it);
          }
          result.parameters.clear();
        } else if (at(Punct::LPAREN)) {
          parseFunctionSuffix(result.type, result.parameters, result.isKnRParams);
        } else {
          break;
        }
      }

      return result;
    }

    // Handles the complex inside-out logic of C declarators. Returns:
    //   * the name declared (if any),
    //   * the full Type constructed,
    //   * a list of (SrcLoc, Type, Symbol) for any parameters if
    //     it's a function declarator.
    //
    // The baseType is the Type returned from parseDeclSpecifiers().
    //
    DeclaratorResult parseDeclarator(DeclaratorInput input) {
      // 1. Handle Pointers (Prefixes)
      //    These apply to the result of the recursive parse.
      //    Since we parse "inside-out" conceptually but "left-to-right" textually,
      //    and * binds looser than suffixes, we simply peel them off here,
      //    parse the rest (which includes suffixes), and then wrap the result.

      // We need to store qualifiers for EACH pointer level: * const * volatile ...
      // For this smaller version, let's just handle simple chains.
      // A proper implementation would use a stack of qualifiers.

      struct PtrLevel {
        bool isConst;
        bool isVolatile;
      };
      std::vector<PtrLevel> ptrs;

      while (match(Punct::STAR)) {
        bool c = false, v = false;
        while (at(Keyword::CONST) || at(Keyword::VOLATILE) || at(Keyword::RESTRICT)) {
          if (match(Keyword::CONST)) c = true;
          if (match(Keyword::VOLATILE)) v = true;
          if (match(Keyword::RESTRICT)) { /* ignored */
          }
        }
        ptrs.push_back({c, v});
      }

      // 2. Apply Pointers to the base type BEFORE parsing direct declarator
      //    This ensures that for "int *func(void)", the function suffix is applied
      //    to "int*" (the pointered base type), giving "function returning int*".
      //    For "int (*func)(void)", the parens cause recursion which handles it
      //    correctly as "pointer to function returning int".
      //
      //    int * * x;  -> Pointer(Pointer(int)).
      //    Stack: [* (outer), * (inner)].
      //    We apply inner first (closest to base type).
      DeclaratorInput modifiedInput = input;
      for (size_t i = 0; i < ptrs.size(); ++i) {
        modifiedInput.baseType = modifiedInput.baseType.pointer();
        const auto &level = ptrs[i];
        if (level.isConst) modifiedInput.baseType = modifiedInput.baseType.addConst();
        if (level.isVolatile) modifiedInput.baseType = modifiedInput.baseType.addVolatile();
      }

      // 3. Parse the Direct Declarator (Identifier + Suffixes)
      //    Suffixes will be applied to the (possibly pointered) baseType.
      DeclaratorResult result = parseDirectDeclarator(modifiedInput);

      return result;
    }

  } parser(tokens, result.errors, result.warnings);

  // --- Main Parse Loop ---

  try {
    while (!parser.atEnd()) {
      // Handle __require_source directive
      if (parser.at(Keyword::X_REQUIRE_SOURCE)) {
        parser.advance();
        parser.expect(Punct::LPAREN, "Expected '(' after __require_source");
        auto &tok = parser.expect(TokenKind::STRING, "Expected string literal");
        // Strip quotes from string literal
        auto filename = tok.text.substr(1, tok.text.size() - 2);
        {
          Symbol req = intern(filename);
          if (parser.requiredSourcesSeen.insert(req).second)
            parser.requiredSources.push_back(req);
        }
        parser.expect(Punct::RPAREN, "Expected ')' after filename");
        parser.expect(Punct::SEMI, "Expected ';' after __require_source");
        continue;
      }
      // Handle __minstack directive
      if (parser.at(Keyword::X_MINSTACK)) {
        auto &kw = parser.peek();
        parser.advance();
        parser.expect(Punct::LPAREN, "Expected '(' after __minstack");
        Expr sizeExpr = parser.parseAssignmentExpression();
        parser.expect(Punct::RPAREN, "Expected ')' after __minstack size");
        parser.expect(Punct::SEMI, "Expected ';' after __minstack");
        ConstEval eval([](Type t) { return t.getSize(); });
        auto val = eval.evaluate(sizeExpr);
        if (!val || !val->asInt() || *val->asInt() < 0) {
          parser.recoverableError(kw, "__minstack requires a non-negative constant integer");
        } else {
          result.translationUnit.minStackBytes =
              std::max(result.translationUnit.minStackBytes, static_cast<u32>(*val->asInt()));
        }
        continue;
      }
      // Handle __export directive
      if (parser.at(Keyword::X_EXPORT)) {
        parser.advance();
        auto &exportNameTok =
            parser.expect(TokenKind::IDENT, "Expected export name after __export");
        Symbol exportName = intern(exportNameTok.text);
        parser.expect(Punct::EQ, "Expected '=' after export name");
        auto &funcNameTok = parser.expect(TokenKind::IDENT, "Expected function name after '='");
        Symbol funcName = intern(funcNameTok.text);
        parser.expect(Punct::SEMI, "Expected ';' after __export directive");
        if (!parser.varScope.has(funcName)) {
          parser.recoverableError(
              funcNameTok, "__export: undeclared identifier '" + std::string(*funcName) + "'");
        } else {
          Decl decl = parser.varScope.get(funcName);
          if (decl.kind != DeclKind::FUNC) {
            parser.recoverableError(
                funcNameTok, "__export: '" + std::string(*funcName) + "' is not a function");
          } else {
            parser.exportDirectives.push_back({exportName, decl.as.func});
          }
        }
        continue;
      }
      // Handle __exception directive
      if (parser.at(Keyword::X_EXCEPTION)) {
        parser.parseExceptionDirective(result.translationUnit);
        continue;
      }
      parser.parseExternalDeclaration(result.translationUnit);
    }
  } catch (const ParseError &e) {
    // Fatal parse error
    result.errors.push_back({e.message, e.filename, e.line});
  }

  result.translationUnit.requiredSources = std::move(parser.requiredSources);
  result.translationUnit.exportDirectives = std::move(parser.exportDirectives);
  result.translationUnit.globalUsedSymbols = std::move(parser.globalUsedSymbols);
  result.translationUnit.fileScopeCompoundLiterals = std::move(parser.fileScopeCompoundLiterals);
  return result;
}

ParseResult parseSource(const Symbol &filename, const std::string &source, PPRegistry &ppr) {
  auto lexResult = tokenize(filename, source, ppr);
  if (!lexResult.errors.empty()) {
    return ParseResult{TUnit{}, std::move(lexResult.errors), std::move(lexResult.warnings)};
  }
  auto parseResult = parseTokens(lexResult.tokens);
  parseResult.warnings.insert(parseResult.warnings.begin(),
      std::make_move_iterator(lexResult.warnings.begin()),
      std::make_move_iterator(lexResult.warnings.end()));
  return parseResult;
}

// ====================
// Linker
// ====================

struct LinkError {
  std::vector<SrcLoc> locations;  // Locations of relevant declarations
  std::string message;
};

struct LinkResult {
  std::vector<LinkError> errors;
};

LinkResult linkTranslationUnits(std::vector<TUnit> &units) {
  LinkResult result;
  std::map<Symbol, Decl> externScope;  // Definitions of extern symbols

  auto addError = [&](std::vector<SrcLoc> locs, const std::string &message) {
    LinkError error;
    error.locations = std::move(locs);
    error.message = message;
    result.errors.push_back(error);
  };

  auto isStatic = [](const Decl &decl) {
    if (decl.kind == DeclKind::VAR) {
      DVar *vd = decl.as.var;
      return vd->storageClass == StorageClass::STATIC;
    } else if (decl.kind == DeclKind::FUNC) {
      DFunc *fd = decl.as.func;
      return fd->storageClass == StorageClass::STATIC;
    }
    return false;
  };

  auto isDefinition = [](const Decl &decl) {
    if (decl.kind == DeclKind::VAR) {
      DVar *vd = decl.as.var;
      return vd->storageClass != StorageClass::EXTERN || vd->initExpr;
    } else if (decl.kind == DeclKind::FUNC) {
      DFunc *fd = decl.as.func;
      return fd->body != nullptr;
    }
    return false;
  };

  auto getName = [](const Decl &decl) -> Symbol {
    if (decl.kind == DeclKind::VAR) {
      return decl.as.var->name;
    } else if (decl.kind == DeclKind::FUNC) {
      return decl.as.func->name;
    }
    return nullptr;
  };

  auto getDeclType = [](const Decl &decl) -> Type {
    if (decl.kind == DeclKind::VAR) return decl.as.var->type;
    if (decl.kind == DeclKind::FUNC) return decl.as.func->type;
    return Type{};
  };

  auto checkCompatibility = [&](const Decl &a, const Decl &b) {
    if (a.kind != b.kind) {
      addError({a.getLoc(), b.getLoc()},
          "declaration and definition kinds do not match for symbol '" + *getName(a) + "'");
      return;
    }
    Type ta = getDeclType(a), tb = getDeclType(b);
    if (!ta.isCompatibleWith(tb)) {
      addError({a.getLoc(), b.getLoc()},
          "conflicting types for '" + *getName(a) + "' ('" + ta.toString() + "' vs '" +
              tb.toString() + "')");
    }
  };

  auto setDefinition = [&](Decl &decl, const Decl &definition) {
    if (decl.kind != definition.kind) return;
    if (decl.kind == DeclKind::VAR) {
      decl.as.var->definition = definition.as.var;
      // Propagate allocClass: if declaration requires MEMORY, definition must too
      if (decl.as.var->allocClass == AllocClass::MEMORY) {
        definition.as.var->allocClass = AllocClass::MEMORY;
      }
    } else if (decl.kind == DeclKind::FUNC) {
      decl.as.func->definition = definition.as.func;
    }
  };

  auto isImportFunction = [](const Decl &decl) {
    return decl.kind == DeclKind::FUNC && decl.as.func->storageClass == StorageClass::IMPORT;
  };

  auto addDecl = [&](std::map<Symbol, Decl> &externScope, std::map<Symbol, Decl> &tuScope,
                     const Decl &decl) {
    auto &scope = isStatic(decl) ? tuScope : externScope;
    Symbol name = getName(decl);
    if (!name) panicf("Declaration has no name");  // should never happen

    auto it = scope.find(name);

    // New symbol
    if (it == scope.end()) {
      scope[name] = decl;
      return;
    }

    // Check type compatibility with the existing declaration
    checkCompatibility(it->second, decl);

    // If we get here, the symbol exists; unless it is a definition, we don't care
    // We also don't care for duplicate __imports
    if (!isDefinition(decl) || isImportFunction(decl)) {
      return;
    }

    // If it is a definition, we should check for duplicates.
    Decl existingDef = it->second;
    if (isDefinition(existingDef)) {
      // Allow duplicate definitions for inline functions — keep the first one
      if (decl.kind == DeclKind::FUNC && decl.as.func->isInline &&
          existingDef.kind == DeclKind::FUNC && existingDef.as.func->isInline) {
        return;
      }
      // Duplicate definition
      addError(
          {decl.getLoc(), existingDef.getLoc()}, "Duplicate definition of symbol '" + *name + "'");
      return;
    }

    // Update to the new definition
    scope[name] = decl;
  };

  auto forEachDecl = [](TUnit &unit, bool forStatic, auto callback) {
    auto checkFunc = [&](DFunc *f) {
      if ((f->storageClass == StorageClass::STATIC) == forStatic) {
        Decl d(f);
        callback(d);
      }
    };
    auto checkVar = [&](DVar *v) {
      if ((v->storageClass == StorageClass::STATIC) == forStatic) {
        Decl d(v);
        callback(d);
      }
    };
    for (auto *f : unit.importedFunctions) checkFunc(f);
    for (auto *f : unit.definedFunctions) checkFunc(f);
    for (auto *f : unit.staticFunctions) checkFunc(f);
    for (auto *f : unit.declaredFunctions) checkFunc(f);
    for (auto *f : unit.localDeclaredFunctions) checkFunc(f);
    for (auto *v : unit.definedVariables) checkVar(v);
    for (auto *v : unit.externVariables) checkVar(v);
    for (auto *v : unit.localExternVariables) checkVar(v);
  };

  auto collectSymbols = [&](TUnit &unit, std::map<Symbol, Decl> &outScope, bool forStatic) {
    forEachDecl(unit, forStatic, [&](Decl &decl) { addDecl(externScope, outScope, decl); });
  };

  auto linkSymbols = [&](const std::map<Symbol, Decl> &scope, TUnit &unit, bool forStatic) {
    forEachDecl(unit, forStatic, [&](Decl &decl) {
      // We need everyone to link to their definitions
      // (for imports its the declaration that appears in the scope)
      auto it = scope.find(getName(decl));
      if (it == scope.end()) panicf("Internal linker error: symbol not found in scope");
      if (!isDefinition(it->second) && !isImportFunction(it->second)) {
        if (compilerOptions.allowUndefined && it->second.kind == DeclKind::FUNC) {
          // Promote unresolved extern function to wasm import
          it->second.as.func->storageClass = StorageClass::IMPORT;
        } else {
          addError({decl.getLoc()}, "Undefined symbol '" + *getName(decl) + "' during linking");
          return;
        }
      }
      setDefinition(decl, it->second);
    });
  };

  // Collect all definitions and link static symbols
  for (auto &unit : units) {
    std::map<Symbol, Decl> tuScope;
    collectSymbols(unit, externScope, false);  // extern
    collectSymbols(unit, tuScope, true);       // static
    linkSymbols(tuScope, unit, true);          // link static
  }

  // Link extern symbols
  for (auto &unit : units) {
    linkSymbols(externScope, unit, false);  // link extern
  }

  return result;
}

// ====================
// Code generation
// ====================

struct CodeGeneraionResult {};

WasmType cToWasmType(Type type) {
  if (type == TUNKNOWN) panicf("cToWasmType called with TUNKNOWN type");
  type = type.removeQualifiers();
  if (type == TFLOAT) return WasmType::F32;
  if (type == TDOUBLE || type == TLDOUBLE) return WasmType::F64;
  if (type == TLLONG || type == TULLONG) return WasmType::I64;

  // Default to i32 for everything else (int, char, pointers, etc.)
  return WasmType::I32;
}

bool isStructOrUnion(Type type) { return type.isAggregate() && !type.isArray(); }

// Compute the size of a variadic arg-block slot for a given type.
// All slots are 8-byte aligned; scalars use 8 bytes, structs use alignup(sizeof, 8).
u32 vaSlotSize(Type type) {
  u32 sz = static_cast<u32>(type.getSize());
  return (sz + 7) & ~7u;
}

WasmFunctionTypeId getWasmFunctionTypeIdForCFunctionType(Type funcType) {
  if (!funcType.isFunction()) {
    panicf("getWasmFunctionTypeIdForCFunctionType called with non-function type");
  }

  // Variadic functions use a single i32 param (arg block pointer) and no WASM return.
  // The return value and all arguments are passed via the arg block in linear memory.
  if (funcType.isVarArg()) {
    return addWasmFunctionTypeId(WasmFunctionType{{WasmType::I32}, {}});
  }

  std::vector<WasmType> paramTypes;

  // If the function returns a struct/union, add a hidden first parameter
  // for the return value pointer (caller allocates space)
  Type retType = funcType.getReturnType();
  if (isStructOrUnion(retType)) {
    paramTypes.push_back(WasmType::I32);  // hidden return pointer
  }

  for (const auto &paramType : funcType.getParamTypes()) {
    paramTypes.push_back(cToWasmType(paramType));
  }

  // All functions return a value (void functions return i32 with undefined value)
  // Struct-returning functions return i32 (the return pointer)
  std::vector<WasmType> returnTypes = {cToWasmType(retType)};

  return addWasmFunctionTypeId(WasmFunctionType{paramTypes, returnTypes});
}

struct CodeGenerator {
  // Maps from C func definitions to Wasm function indices
  std::map<DFunc *, u32> funcDefToWasmFuncIdx;
  std::map<DFunc *, u32> funcDefToTableIdx;

  // Maps from C global variable definitions to Wasm global indices (for scalars)
  std::map<DVar *, u32> globalVarToWasmGlobalIdx;

  // Maps from C global array definitions to their addresses in static memory
  std::map<DVar *, u32> globalArrayAddrs;

  // Maps from file-scope compound literals to their addresses in static memory
  std::map<ECompoundLiteral *, u32> fileScopeCompoundLiteralAddrs;

  // Linear memory layout:
  //   0 to stackPages*64KB: Stack (grows down from stackPages*64KB toward 0)
  //   stackPages*64KB to __heap_base: Static data (strings, etc.)
  //   __heap_base onwards: Heap (grows up)
  u32 stackPages = 1;                             // Number of pages reserved for stack
  u32 staticDataOffset = 0;                       // Current offset in static data region
  Buffer staticData;                              // Accumulated static data bytes
  std::map<Buffer, u32> stringLiteralAddrs;  // Deduplicated string literal addresses

  // Stack pointer global index (for local array allocation)
  u32 stackPointerGlobalIdx = 0;

  // Heap base global index (for malloc/memory management)
  u32 heapBaseGlobalIdx = 0;

  // per-function state
  WasmCode *body = nullptr;
  std::map<DVar *, u32> localVarToWasmLocalIdx;

  // Local array support: arrays/MEMORY vars are allocated on the stack
  std::map<DVar *, u32> localArrayOffsets;   // Offset from frame base
  InsertionOrderMap<DVar *, u32> paramMemoryOffsets;  // For parameters with allocClass == MEMORY
  std::map<ECompoundLiteral *, u32> compoundLiteralOffsets;  // Frame offsets for compound literals
  u32 frameSize = 0;        // Total size of local arrays in current function
  u32 savedSpLocalIdx = 0;  // WASM local: old SP value (for return/epilogue)

  // On-the-fly local allocator state
  std::vector<WasmLocals> *currentFuncLocals = nullptr;
  u32 nextLocalIdx = 0;
  std::map<WasmType, std::vector<u32>> freeLocalsByType;
  std::vector<std::vector<std::pair<WasmType, u32>>> localScopeStack;

  // Deferred struct return SP restoration: when multiple struct-returning calls
  // appear as arguments to the same outer call, their return spaces must not
  // overlap. We defer SP restoration until the outermost call completes.
  u32 structRetDeferred = 0;  // Accumulated deferred struct return space (bytes)
  u32 callNesting = 0;        // Call emission nesting depth

  // Loop control: tracks block nesting for break/continue
  // We track absolute block depth and the target depths for break/continue
  u32 blockDepth = 0;      // Current nesting depth (incremented by block, loop, if)
  u32 breakTarget = 0;     // Block depth to branch to for break
  u32 continueTarget = 0;  // Block depth to branch to for continue
  std::map<SLabel *, u32> gotoLabelDepths;  // label -> blockDepth when its block was opened

  // Exception handling: maps exception tags to WASM tag indices
  std::map<ExceptionTag *, u32> exceptionToWasmTagIdx;

  // Current function being compiled (for return type conversion)
  DFunc *currentFuncDef = nullptr;

  // Variadic function support (new convention: single i32 arg block pointer)
  u32 vaArgsLocalIdx = 0;       // WASM local: pointer to start of varargs in arg block
  bool hasVaArgs = false;        // Whether current function is variadic
  u32 argBlockLocalIdx = 0;      // WASM local: arg block pointer (variadic only)
  u32 vaRetSlotSize = 0;         // Size of return slot in arg block (variadic only)

  // Info for loading fixed params from arg block in prologue (variadic only)
  struct VaParamInfo { DVar *var; u32 localIdx; u32 offset; };
  std::vector<VaParamInfo> vaParamInfos;
  u32 vaStartOffset = 0;  // Offset in arg block where varargs begin

  // Struct return support: hidden first parameter holds pointer to caller-allocated space
  u32 structRetPtrLocalIdx = 0;  // WASM local index for hidden return pointer
  bool hasStructReturn = false;  // Whether current function returns a struct/union

  // Allocate a WASM local of the given type. Reuses freed locals from the
  // free-by-type map when available; otherwise appends a new local entry
  // (merging with the last entry if the type matches).
  u32 allocLocal(WasmType type) {
    auto it = freeLocalsByType.find(type);
    if (it != freeLocalsByType.end() && !it->second.empty()) {
      u32 idx = it->second.back();
      it->second.pop_back();
      if (!localScopeStack.empty()) {
        localScopeStack.back().push_back({type, idx});
      }
      return idx;
    }
    u32 idx = nextLocalIdx++;
    if (!currentFuncLocals->empty() && currentFuncLocals->back().type == type) {
      currentFuncLocals->back().count++;
    } else {
      currentFuncLocals->push_back(WasmLocals{type, 1});
    }
    if (!localScopeStack.empty()) {
      localScopeStack.back().push_back({type, idx});
    }
    return idx;
  }

  void pushLocalScope() { localScopeStack.emplace_back(); }

  void popLocalScope() {
    for (auto &[type, idx] : localScopeStack.back()) {
      freeLocalsByType[type].push_back(idx);
    }
    localScopeStack.pop_back();
  }

  void assignLocals(DFunc *funcDef) {
    u32 funcIdx = funcDefToWasmFuncIdx[funcDef];
    u32 defIdx = funcIdx - toU32(wasmFunctionImports.size());
    currentFuncLocals = &wasmFunctionDefinitions[defIdx].locals;
    currentFuncLocals->clear();
    freeLocalsByType.clear();
    localScopeStack.clear();
    localVarToWasmLocalIdx.clear();

    u32 localIdx = 0;

    hasVaArgs = funcDef->type.isVarArg();
    vaParamInfos.clear();
    vaStartOffset = 0;
    vaRetSlotSize = 0;

    if (hasVaArgs) {
      // New variadic convention: single WASM parameter = arg block pointer.
      // All fixed params and return value are in the arg block.
      argBlockLocalIdx = localIdx++;
      nextLocalIdx = localIdx;

      // Compute return slot size
      Type retType = funcDef->type.getReturnType();
      vaRetSlotSize = (retType == TVOID) ? 0 : vaSlotSize(retType);

      // Allocate WASM locals for each fixed param and record arg block offsets
      u32 paramOffset = vaRetSlotSize;
      for (const auto &param : funcDef->parameters) {
        DVar *paramVar = param.as.var;
        WasmType wt = isStructOrUnion(paramVar->type) ? WasmType::I32 : cToWasmType(paramVar->type);
        u32 paramLocalIdx = allocLocal(wt);
        localVarToWasmLocalIdx[paramVar] = paramLocalIdx;
        u32 slotSz = vaSlotSize(paramVar->type);
        vaParamInfos.push_back({paramVar, paramLocalIdx, paramOffset});
        paramOffset += slotSz;
      }
      vaStartOffset = paramOffset;

      // Allocate local for va_start base (set in prologue)
      vaArgsLocalIdx = allocLocal(WasmType::I32);

      hasStructReturn = false;  // struct return handled via arg block
    } else {
      // Non-variadic: existing convention
      // If the function returns a struct/union, the first WASM parameter is
      // a hidden pointer to caller-allocated return space
      hasStructReturn = isStructOrUnion(funcDef->type.getReturnType());
      if (hasStructReturn) {
        structRetPtrLocalIdx = localIdx++;
      }

      // Parameters
      for (const auto &param : funcDef->parameters) {
        localVarToWasmLocalIdx[param.as.var] = localIdx++;
      }

      // Set the allocator's starting index after all params
      nextLocalIdx = localIdx;
    }

    // Collect MEMORY vars by walking the AST (needed upfront for frame layout)
    std::vector<DVar *> memoryVars;
    {
      auto addMemoryDecls = [&](std::span<Decl> decls) {
        for (const auto &decl : decls) {
          if (decl.kind == DeclKind::VAR) {
            DVar *varDecl = decl.as.var;
            if (varDecl->storageClass != StorageClass::STATIC && varDecl->definition == varDecl) {
              DVar *def = varDecl->definition ? varDecl->definition : varDecl;
              if (def->allocClass == AllocClass::MEMORY) {
                memoryVars.push_back(varDecl);
              }
            }
          }
        }
      };

      std::vector<Stmt> stack{funcDef->body};
      while (!stack.empty()) {
        Stmt stmt = stack.back();
        stack.pop_back();
        if (stmt.kind == StmtKind::DECL) {
          addMemoryDecls(stmt.as.declStmt->declarations);
        } else if (stmt.kind == StmtKind::COMPOUND) {
          SCompound *comp = stmt.as.compound;
          for (auto it = comp->statements.rbegin(); it != comp->statements.rend(); ++it) {
            stack.push_back(*it);
          }
        } else if (stmt.kind == StmtKind::IF) {
          SIf *sif = stmt.as.ifStmt;
          stack.push_back(sif->thenBranch);
          if (sif->elseBranch) stack.push_back(sif->elseBranch);
        } else if (stmt.kind == StmtKind::WHILE) {
          stack.push_back(stmt.as.whileStmt->body);
        } else if (stmt.kind == StmtKind::DO_WHILE) {
          stack.push_back(stmt.as.doWhileStmt->body);
        } else if (stmt.kind == StmtKind::FOR) {
          SFor *sfor = stmt.as.forStmt;
          if (sfor->init && sfor->init.kind == StmtKind::DECL) {
            addMemoryDecls(sfor->init.as.declStmt->declarations);
          }
          stack.push_back(sfor->body);
        } else if (stmt.kind == StmtKind::SWITCH) {
          SSwitch *sw = stmt.as.switchStmt;
          for (auto it = sw->body->statements.rbegin(); it != sw->body->statements.rend(); ++it) {
            stack.push_back(*it);
          }
        } else if (stmt.kind == StmtKind::TRY_CATCH) {
          STryCatch *tc = stmt.as.tryCatch;
          stack.push_back(tc->tryBody);
          for (const auto &cc : tc->catches) {
            stack.push_back(cc.body);
          }
        }
      }
    }

    // Also check parameters - some might need MEMORY (if address taken)
    std::vector<DVar *> memoryParams;
    for (const auto &param : funcDef->parameters) {
      DVar *paramVar = param.as.var;
      DVar *def = paramVar->definition ? paramVar->definition : paramVar;
      if (def->allocClass == AllocClass::MEMORY) {
        memoryParams.push_back(paramVar);
      }
    }

    // Compute stack frame layout for MEMORY vars/params/compound literals
    localArrayOffsets.clear();
    paramMemoryOffsets.clear();
    compoundLiteralOffsets.clear();
    frameSize = 0;
    if (!memoryVars.empty() || !memoryParams.empty() || !funcDef->compoundLiterals.empty()) {
      savedSpLocalIdx = allocLocal(WasmType::I32);

      u32 offset = 0;
      for (DVar *memVar : memoryVars) {
        u32 varAlign = alignOf(memVar->type);
        if (memVar->requestedAlignment > 0 && static_cast<u32>(memVar->requestedAlignment) > varAlign)
          varAlign = static_cast<u32>(memVar->requestedAlignment);
        offset = (offset + varAlign - 1) & ~(varAlign - 1);
        localArrayOffsets[memVar] = offset;
        offset += sizeOf(memVar->type);
      }
      for (DVar *paramVar : memoryParams) {
        u32 varAlign = alignOf(paramVar->type);
        offset = (offset + varAlign - 1) & ~(varAlign - 1);
        paramMemoryOffsets[paramVar] = offset;
        offset += sizeOf(paramVar->type);
      }
      for (ECompoundLiteral *cl : funcDef->compoundLiterals) {
        u32 clAlign = alignOf(cl->type);
        offset = (offset + clAlign - 1) & ~(clAlign - 1);
        compoundLiteralOffsets[cl] = offset;
        offset += sizeOf(cl->type);
      }
      frameSize = (offset + 15) & ~15u;
    }
  }

  // Get the address of a string literal in static memory.
  // Deduplicates identical strings to save space.
  u32 getStringAddress(const Buffer &buf) {
    auto it = stringLiteralAddrs.find(buf);
    if (it != stringLiteralAddrs.end()) {
      return it->second;
    }
    // Allocate new string in static data region
    u32 baseAddr = stackPages * 65536;  // Static data starts after stack
    u32 addr = baseAddr + staticDataOffset;
    stringLiteralAddrs[buf] = addr;
    // Append bytes (value already includes null terminator)
    staticData.insert(staticData.end(), buf.begin(), buf.end());
    staticDataOffset += toU32(buf.size());
    return addr;
  }

  // Get the alignment requirement of a C type.
  // All types have their alignment cached in Type::Info::align.
  u32 alignOf(Type type) { return static_cast<u32>(type.getAlign()); }

  // Get the size in bytes of a C type.
  // All types have their size cached in Type::Info::size.
  u32 sizeOf(Type type) { return static_cast<u32>(type.getSize()); }

  // Emit code to push the address savedSp + (offset - frameSize) onto the WASM stack.
  void emitFrameAddr(u32 offset) {
    body->localGet(savedSpLocalIdx);
    i32 adjustedOffset = static_cast<i32>(offset) - static_cast<i32>(frameSize);
    if (adjustedOffset != 0) {
      body->i32Const(adjustedOffset);
      body->aop(WasmType::I32, OP_ADD);
    }
  }

  // Get the offset of a field within a struct
  // Byte offsets are cached on DVar during computeTagSizeAndAlign()
  u32 getFieldOffset(DTag *tag, DVar *field) {
    (void)tag;
    return static_cast<u32>(field->byteOffset);
  }

  // Allocate space in static memory and return the address
  u32 allocateStatic(u32 size, u32 align = 4) {
    if (align == 0) panicf("allocateStatic: align must be non-zero");
    // Align the offset and add padding bytes to staticData
    u32 alignedOffset = (staticDataOffset + align - 1) & ~(align - 1);
    u32 padding = alignedOffset - staticDataOffset;
    for (u32 i = 0; i < padding; i++) {
      staticData.push_back(0);  // add alignment padding
    }
    staticDataOffset = alignedOffset;

    u32 baseAddr = stackPages * 65536;
    u32 addr = baseAddr + staticDataOffset;
    // Reserve space (zero-initialized)
    for (u32 i = 0; i < size; i++) {
      staticData.push_back(0);
    }
    staticDataOffset += size;
    return addr;
  }

  // Compute the extra bytes needed for a flexible array member (FAM) initializer.
  // Returns 0 if the type has no FAM or no init data for it.
  u32 computeFAMExtraSize(Type type, Expr initExpr) {
    if (!type.isTag() || initExpr.kind != ExprKind::INIT_LIST) return 0;
    Decl tagDecl = type.getTagDecl();
    if (tagDecl.kind != DeclKind::TAG) return 0;
    DTag *tag = tagDecl.as.tag;
    if (tag->tagKind != TagKind::STRUCT) return 0;
    // Find the FAM (last member with array size 0)
    DVar *famMember = nullptr;
    i32 famIdx = -1, varIdx = 0;
    for (const auto &member : tag->members) {
      if (member.kind != DeclKind::VAR) continue;
      DVar *mv = member.as.var;
      if (mv->type.isArray() && mv->type.getArraySize() == 0) {
        famMember = mv;
        famIdx = varIdx;
      }
      varIdx++;
    }
    if (!famMember) return 0;
    EInitList *il = initExpr.as.initList;
    if (famIdx < 0 || static_cast<size_t>(famIdx) >= il->elements.size()) return 0;
    Expr &famElem = il->elements[static_cast<size_t>(famIdx)];
    Type elemType = famMember->type.getArrayBase();
    u32 elemSize = sizeOf(elemType);
    if (famElem.kind == ExprKind::STRING) {
      return toU32(famElem.as.stringLit->value.size()) * elemSize;
    } else if (famElem.kind == ExprKind::INIT_LIST) {
      return toU32(famElem.as.initList->elements.size()) * elemSize;
    }
    return elemSize;  // single element
  }

  // Compute the total allocation size for a variable, including FAM extra data.
  u32 computeInitAllocSize(Type type, Expr initExpr) {
    return sizeOf(type) + computeFAMExtraSize(type, initExpr);
  }

  // Write a constant value to static data for a specific type.
  // Handles int-to-float conversion when val is INT but type is floating point.
  void writeConstValueToStatic(u32 offset, Type type, const ConstValue &val) {
    u32 size = sizeOf(type);
    ConstValue v = val;
    if (v.kind == ConstValue::INT && type.removeQualifiers().isFloatingPoint()) {
      v = ConstValue::fromFloat(static_cast<double>(v.intVal));
    }
    if (v.kind == ConstValue::INT) {
      i64 iv = v.intVal;
      for (u32 b = 0; b < size; b++) {
        staticData[offset + b] = static_cast<u8>((iv >> (b * 8)) & 0xFF);
      }
    } else if (v.kind == ConstValue::FLOAT) {
      if (size == 4) {
        float fv = static_cast<float>(v.floatVal);
        u32 bits;
        std::memcpy(&bits, &fv, sizeof(bits));
        for (u32 b = 0; b < 4; b++) {
          staticData[offset + b] = static_cast<u8>((bits >> (b * 8)) & 0xFF);
        }
      } else if (size == 8) {
        double dv = v.floatVal;
        u64 bits;
        std::memcpy(&bits, &dv, sizeof(bits));
        for (u32 b = 0; b < 8; b++) {
          staticData[offset + b] = static_cast<u8>((bits >> (b * 8)) & 0xFF);
        }
      }
    } else if (v.kind == ConstValue::ADDRESS) {
      u32 addrVal = v.addrVal;
      for (u32 b = 0; b < size && b < 4; b++) {
        staticData[offset + b] = static_cast<u8>((addrVal >> (b * 8)) & 0xFF);
      }
    }
  }

  // Copy a string literal's bytes inline into static data at the given offset.
  // Used when a char[] field/element is initialized with a string literal.
  void writeStringLiteralToStatic(EString *str, Type arrayType, u32 offset) {
    u32 copySize = sizeOf(arrayType);
    u32 strLen = toU32(str->value.size());  // value already includes null terminator
    // For incomplete arrays (FAM), copySize is 0; use full string length
    u32 len = copySize == 0 ? strLen : std::min(copySize, strLen);
    for (u32 i = 0; i < len; i++) {
      staticData[offset + i] = str->value[i];
    }
  }

  // Recursively populate static data from an init list
  void populateInitListStatic(EInitList *initList, Type type, u32 baseOffset, ConstEval &eval,
      bool warnOnFailure = true) {
    if (type.isArray()) {
      Type elemType = type.getArrayBase();
      u32 elemSize = sizeOf(elemType);
      for (size_t i = 0; i < initList->elements.size(); i++) {
        u32 elemOffset = baseOffset + static_cast<u32>(i) * elemSize;
        Expr &elem = initList->elements[i];
        if (elem.kind == ExprKind::INIT_LIST) {
          // Nested init list (e.g., nested array or struct)
          populateInitListStatic(elem.as.initList, elemType, elemOffset, eval, warnOnFailure);
        } else if (elem.kind == ExprKind::STRING && elemType.isArray()) {
          writeStringLiteralToStatic(elem.as.stringLit, elemType, elemOffset);
        } else {
          auto val = eval.evaluate(elem);
          if (val) {
            writeConstValueToStatic(elemOffset, elemType, *val);
          } else if (warnOnFailure) {
            SrcLoc loc = elem.getLoc();
            fprintf(stderr, "%s:%u: warning: could not evaluate static initializer element; "
                    "defaulting to zero\n", loc.filename ? loc.filename->c_str() : "<unknown>", loc.line);
          }
        }
      }
    } else if (type.isTag()) {
      Decl tagDecl = type.getTagDecl();
      if (tagDecl.kind != DeclKind::TAG) return;
      DTag *tag = tagDecl.as.tag;
      if (tag->tagKind == TagKind::STRUCT) {
        size_t elemIdx = 0;
        for (const auto &member : tag->members) {
          if (member.kind != DeclKind::VAR) continue;
          DVar *memberVar = member.as.var;
          Type memberType = memberVar->type;

          // Anonymous bitfields (including zero-width) don't consume init-list elements
          if (memberVar->isBitField() && !memberVar->name) continue;

          u32 fieldOffset = baseOffset + static_cast<u32>(memberVar->byteOffset);

          if (elemIdx < initList->elements.size()) {
            Expr &elem = initList->elements[elemIdx];
            if (memberVar->isBitField()) {
              // Bitfield: read-modify-write the storage unit in staticData
              auto val = eval.evaluate(elem);
              if (val) {
                i32 bw = memberVar->bitWidth;
                i32 bo = memberVar->bitOffset;
                u32 unitSize = sizeOf(memberType);
                u32 mask = (1u << bw) - 1;
                u32 bits = static_cast<u32>(val->intVal) & mask;
                u32 unit = 0;
                for (u32 b = 0; b < unitSize; b++) {
                  unit |= static_cast<u32>(staticData[fieldOffset + b]) << (b * 8);
                }
                unit = (unit & ~(mask << bo)) | (bits << bo);
                for (u32 b = 0; b < unitSize; b++) {
                  staticData[fieldOffset + b] = static_cast<u8>((unit >> (b * 8)) & 0xFF);
                }
              }
            } else if (elem.kind == ExprKind::INIT_LIST) {
              populateInitListStatic(elem.as.initList, memberType, fieldOffset, eval, warnOnFailure);
            } else if (elem.kind == ExprKind::STRING && memberType.isArray()) {
              writeStringLiteralToStatic(elem.as.stringLit, memberType, fieldOffset);
            } else {
              auto val = eval.evaluate(elem);
              if (val) {
                writeConstValueToStatic(fieldOffset, memberType, *val);
              } else if (warnOnFailure) {
                SrcLoc loc = elem.getLoc();
                fprintf(stderr, "%s:%u: warning: could not evaluate static initializer element; "
                        "defaulting to zero\n", loc.filename ? loc.filename->c_str() : "<unknown>", loc.line);
              }
            }
          }
          elemIdx++;
        }
      } else if (tag->tagKind == TagKind::UNION) {
        // Union: initialize the designated member (or first by default)
        if (!initList->elements.empty() && initList->elements[0] != nullptr) {
          i32 targetIdx = initList->unionMemberIndex;
          i32 varIdx = 0;
          for (const auto &member : tag->members) {
            if (member.kind != DeclKind::VAR) continue;
            if (varIdx++ != targetIdx) continue;
            Type memberType = member.as.var->type;
            Expr &elem = initList->elements[0];
            if (elem.kind == ExprKind::INIT_LIST) {
              populateInitListStatic(elem.as.initList, memberType, baseOffset, eval, warnOnFailure);
            } else if (elem.kind == ExprKind::STRING && memberType.isArray()) {
              writeStringLiteralToStatic(elem.as.stringLit, memberType, baseOffset);
            } else {
              auto val = eval.evaluate(elem);
              if (val) {
                writeConstValueToStatic(baseOffset, memberType, *val);
              } else if (warnOnFailure) {
                SrcLoc loc = elem.getLoc();
                fprintf(stderr, "%s:%u: warning: could not evaluate static initializer element; "
                        "defaulting to zero\n", loc.filename ? loc.filename->c_str() : "<unknown>", loc.line);
              }
            }
            break;
          }
        }
      }
    }
  }

  // Emit runtime stores for non-constant elements in a local aggregate init list.
  // Called after the static template has been memory.copy'd to the stack.
  // Mirrors the walk in populateInitListStatic, but emits wasm store instructions
  // for elements that ConstEval cannot resolve at compile time.
  void emitInitListRuntimeStores(
      EInitList *initList, Type type, u32 baseLocalIdx, u32 baseOffset, ConstEval &eval) {
    if (type.isArray()) {
      Type elemType = type.getArrayBase();
      u32 elemSize = sizeOf(elemType);
      for (size_t i = 0; i < initList->elements.size(); i++) {
        u32 elemOffset = baseOffset + static_cast<u32>(i) * elemSize;
        Expr &elem = initList->elements[i];
        if (elem.kind == ExprKind::INIT_LIST) {
          emitInitListRuntimeStores(elem.as.initList, elemType, baseLocalIdx, elemOffset, eval);
        } else {
          auto val = eval.evaluate(elem);
          if (!val) {
            // Runtime value — emit store
            if (elemType.isAggregate()) {
              // Aggregate element: memory.copy
              body->localGet(baseLocalIdx);
              if (elemOffset != 0) {
                body->i32Const(static_cast<i32>(elemOffset));
                body->aop(WasmType::I32, OP_ADD);
              }
              emitExpr(elem);
              body->i32Const(static_cast<i32>(sizeOf(elemType)));
              body->memoryCopy();
            } else {
              // Scalar element: store
              body->localGet(baseLocalIdx);
              if (elemOffset != 0) {
                body->i32Const(static_cast<i32>(elemOffset));
                body->aop(WasmType::I32, OP_ADD);
              }
              emitExpr(elem);
              emitConversion(elem.getType(), elemType);
              emitStore(elemType);
            }
          }
        }
      }
    } else if (type.isTag()) {
      Decl tagDecl = type.getTagDecl();
      if (tagDecl.kind != DeclKind::TAG) return;
      DTag *tag = tagDecl.as.tag;
      if (tag->tagKind == TagKind::STRUCT) {
        size_t elemIdx = 0;
        for (const auto &member : tag->members) {
          if (member.kind != DeclKind::VAR) continue;
          DVar *memberVar = member.as.var;
          Type memberType = memberVar->type;

          // Anonymous bitfields don't consume init-list elements
          if (memberVar->isBitField() && !memberVar->name) continue;

          u32 fieldOffset = baseOffset + static_cast<u32>(memberVar->byteOffset);

          if (elemIdx < initList->elements.size()) {
            Expr &elem = initList->elements[elemIdx];
            if (memberVar->isBitField()) {
              // Bitfield: emit runtime bitfield store if not a compile-time constant
              auto val = eval.evaluate(elem);
              if (!val) {
                // Emit address of storage unit
                body->localGet(baseLocalIdx);
                if (fieldOffset != 0) {
                  body->i32Const(static_cast<i32>(fieldOffset));
                  body->aop(WasmType::I32, OP_ADD);
                }
                emitExpr(elem);
                emitConversion(elem.getType(), memberType);
                emitBitFieldStore(memberVar);
              }
            } else if (elem.kind == ExprKind::INIT_LIST) {
              emitInitListRuntimeStores(
                  elem.as.initList, memberType, baseLocalIdx, fieldOffset, eval);
            } else {
              auto val = eval.evaluate(elem);
              if (!val) {
                if (memberType.isAggregate()) {
                  body->localGet(baseLocalIdx);
                  if (fieldOffset != 0) {
                    body->i32Const(static_cast<i32>(fieldOffset));
                    body->aop(WasmType::I32, OP_ADD);
                  }
                  emitExpr(elem);
                  body->i32Const(static_cast<i32>(sizeOf(memberType)));
                  body->memoryCopy();
                } else {
                  body->localGet(baseLocalIdx);
                  if (fieldOffset != 0) {
                    body->i32Const(static_cast<i32>(fieldOffset));
                    body->aop(WasmType::I32, OP_ADD);
                  }
                  emitExpr(elem);
                  emitConversion(elem.getType(), memberType);
                  emitStore(memberType);
                }
              }
            }
          }
          elemIdx++;
        }
      } else if (tag->tagKind == TagKind::UNION) {
        if (!initList->elements.empty() && initList->elements[0] != nullptr) {
          i32 targetIdx = initList->unionMemberIndex;
          i32 varIdx = 0;
          for (const auto &member : tag->members) {
            if (member.kind != DeclKind::VAR) continue;
            if (varIdx++ != targetIdx) continue;
            Type memberType = member.as.var->type;
            Expr &elem = initList->elements[0];
            if (elem.kind == ExprKind::INIT_LIST) {
              emitInitListRuntimeStores(
                  elem.as.initList, memberType, baseLocalIdx, baseOffset, eval);
            } else {
              auto val = eval.evaluate(elem);
              if (!val) {
                if (memberType.isAggregate()) {
                  body->localGet(baseLocalIdx);
                  if (baseOffset != 0) {
                    body->i32Const(static_cast<i32>(baseOffset));
                    body->aop(WasmType::I32, OP_ADD);
                  }
                  emitExpr(elem);
                  body->i32Const(static_cast<i32>(sizeOf(memberType)));
                  body->memoryCopy();
                } else {
                  body->localGet(baseLocalIdx);
                  if (baseOffset != 0) {
                    body->i32Const(static_cast<i32>(baseOffset));
                    body->aop(WasmType::I32, OP_ADD);
                  }
                  emitExpr(elem);
                  emitConversion(elem.getType(), memberType);
                  emitStore(memberType);
                }
              }
            }
            break;
          }
        }
      }
    }
  }

  // Allocate static storage for an init list and populate with values
  // Create a ConstEval configured for codegen-time evaluation (with address resolution).
  ConstEval makeCodegenConstEval() {
    ConstEval eval([this](Type t) { return sizeOf(t); },
        [this](DVar *v) -> std::optional<u32> {
          auto it = globalArrayAddrs.find(v);
          if (it != globalArrayAddrs.end()) return it->second;
          return std::nullopt;
        },
        [this](DFunc *f) -> std::optional<u32> {
          auto it = funcDefToTableIdx.find(f);
          if (it != funcDefToTableIdx.end()) return it->second;
          return std::nullopt;
        },
        [this](const Buffer &s) { return getStringAddress(s); });
    eval.getCompoundLiteralAddress = [this](ECompoundLiteral *cl) -> std::optional<u32> {
      auto it = fileScopeCompoundLiteralAddrs.find(cl);
      if (it != fileScopeCompoundLiteralAddrs.end()) return it->second;
      return std::nullopt;
    };
    return eval;
  }

  u32 allocateInitListStatic(EInitList *initList, Type aggType) {
    u32 totalSize = sizeOf(aggType);
    u32 addr = allocateStatic(totalSize, alignOf(aggType));
    u32 baseOffset = addr - (stackPages * 65536);
    ConstEval eval = makeCodegenConstEval();
    populateInitListStatic(initList, aggType, baseOffset, eval, false);
    return addr;
  }

  // Copy a string literal into a frame slot, zeroing any remaining bytes.
  // Per C99 §6.7.8p14, a char array initialized with a shorter string literal
  // has its remaining elements zero-initialized.
  void emitStringToFrameSlot(const Buffer &strValue, Type arrayType, u32 frameOffset) {
    u32 arraySize = sizeOf(arrayType);
    u32 strLen = toU32(strValue.size());
    u32 copyLen = std::min(arraySize, strLen);
    u32 srcAddr = getStringAddress(strValue);
    emitFrameAddr(frameOffset);
    body->i32Const(static_cast<i32>(srcAddr));
    body->i32Const(static_cast<i32>(copyLen));
    body->memoryCopy();
    if (copyLen < arraySize) {
      // Zero remaining bytes
      emitFrameAddr(frameOffset + copyLen);
      body->i32Const(0);
      body->i32Const(static_cast<i32>(arraySize - copyLen));
      body->memoryFill();
    }
  }

  // Initialize a frame slot from an initializer expression.
  // Handles all init patterns: STRING→char array, INIT_LIST→aggregate,
  // struct-from-expr, and scalars.
  void emitInitToFrameSlot(Type type, Expr initExpr, u32 frameOffset) {
    // String literal → char array (direct: char buf[] = "hello")
    if (type.isArray() && initExpr.kind == ExprKind::STRING) {
      emitStringToFrameSlot(initExpr.as.stringLit->value, type, frameOffset);
      return;
    }
    // Init list for aggregate (including INIT_LIST wrapping a string for char arrays)
    if (type.isAggregate() && initExpr.kind == ExprKind::INIT_LIST) {
      EInitList *il = initExpr.as.initList;
      // (char[]){"hello"}: init list wrapping a single string literal
      if (type.isArray() && il->elements.size() == 1 && il->elements[0].kind == ExprKind::STRING) {
        emitStringToFrameSlot(il->elements[0].as.stringLit->value, type, frameOffset);
        return;
      }
      // General aggregate: static template + memory.copy + runtime patches
      u32 srcAddr = allocateInitListStatic(il, type);
      emitFrameAddr(frameOffset);
      body->i32Const(static_cast<i32>(srcAddr));
      body->i32Const(static_cast<i32>(sizeOf(type)));
      body->memoryCopy();

      pushLocalScope();
      u32 baseAddrLocal = allocLocal(WasmType::I32);
      emitFrameAddr(frameOffset);
      body->localSet(baseAddrLocal);
      ConstEval eval = makeCodegenConstEval();
      emitInitListRuntimeStores(il, type, baseAddrLocal, 0, eval);
      popLocalScope();
      return;
    }
    // Struct/union from expression (e.g. struct Point b = a)
    if (isStructOrUnion(type)) {
      emitFrameAddr(frameOffset);
      emitExpr(initExpr);
      body->i32Const(static_cast<i32>(sizeOf(type)));
      body->memoryCopy();
      return;
    }
    // Scalar
    emitFrameAddr(frameOffset);
    emitExpr(initExpr);
    emitStore(type);
  }

  // Initialize a compound literal's stack slot.
  void emitCompoundLiteralInit(ECompoundLiteral *cl) {
    u32 offset = compoundLiteralOffsets[cl];
    if (cl->type.isAggregate()) {
      emitInitToFrameSlot(cl->type, Expr(cl->initList), offset);
    } else {
      // Scalar: unwrap the init list element
      Expr initExpr = cl->initList->elements.empty() ? Expr(new EInt{cl->loc, TINT, 0})
                                                     : cl->initList->elements[0];
      emitInitToFrameSlot(cl->type, initExpr, offset);
    }
  }

  void emitFunctionBody(DFunc *funcDef) {
    u32 funcIdx = funcDefToWasmFuncIdx[funcDef];
    assignLocals(funcDef);
    u32 defIdx = funcIdx - toU32(wasmFunctionImports.size());
    WasmCode wasmCode{wasmFunctionDefinitions[defIdx].body};
    body = &wasmCode;
    currentFuncDef = funcDef;
    structRetDeferred = 0;
    callNesting = 0;

    // Variadic function prologue: load fixed params from arg block
    if (hasVaArgs) {
      for (auto &pi : vaParamInfos) {
        if (isStructOrUnion(pi.var->type)) {
          // Struct param: store pointer into arg block (callee copies to frame if MEMORY)
          body->localGet(argBlockLocalIdx);
          if (pi.offset > 0) {
            body->i32Const(static_cast<i32>(pi.offset));
            body->aop(WasmType::I32, OP_ADD);
          }
          body->localSet(pi.localIdx);
        } else {
          // Scalar param: load value from arg block slot
          body->localGet(argBlockLocalIdx);
          if (pi.offset > 0) {
            body->i32Const(static_cast<i32>(pi.offset));
            body->aop(WasmType::I32, OP_ADD);
          }
          emitVaArgLoad(pi.var->type);
          body->localSet(pi.localIdx);
        }
      }
      // Set va_start base: pointer past all fixed params in arg block
      body->localGet(argBlockLocalIdx);
      if (vaStartOffset > 0) {
        body->i32Const(static_cast<i32>(vaStartOffset));
        body->aop(WasmType::I32, OP_ADD);
      }
      body->localSet(vaArgsLocalIdx);
    }

    // Emit stack frame prologue if we have local MEMORY vars/params
    if (frameSize > 0) {
      // savedSp = __stack_pointer
      body->globalGet(stackPointerGlobalIdx);
      body->localSet(savedSpLocalIdx);
      // __stack_pointer = savedSp - frameSize
      body->localGet(savedSpLocalIdx);
      body->i32Const(static_cast<i32>(frameSize));
      body->aop(WasmType::I32, OP_SUB);
      body->globalSet(stackPointerGlobalIdx);

      // Copy MEMORY parameters from WASM locals to stack memory
      for (const auto &[paramVar, offset] : paramMemoryOffsets) {
        emitFrameAddr(offset);
        // Load parameter value from WASM local
        auto paramIt = localVarToWasmLocalIdx.find(paramVar);
        if (paramIt != localVarToWasmLocalIdx.end()) {
          if (isStructOrUnion(paramVar->type)) {
            // Struct param: WASM local holds source address, use memory.copy
            body->localGet(paramIt->second);  // source address
            body->i32Const(static_cast<i32>(sizeOf(paramVar->type)));
            body->memoryCopy();
          } else {
            body->localGet(paramIt->second);
            // Store to stack memory
            emitStore(paramVar->type);
          }
        }
      }
    }

    emitStmt(funcDef->body);

    // Emit implicit return for functions that fall through
    if (frameSize > 0) {
      body->localGet(savedSpLocalIdx);
      body->globalSet(stackPointerGlobalIdx);
    }
    if (hasVaArgs) {
      // Variadic: WASM function returns void, nothing to push
    } else {
      // Non-variadic: all functions return a value (void returns i32 with undefined value)
      Type retType = funcDef->type.getReturnType();
      WasmType wasmRetType = cToWasmType(retType);
      if (wasmRetType == WasmType::I32) body->i32Const(0);
      else if (wasmRetType == WasmType::I64) body->i64Const(0);
      else if (wasmRetType == WasmType::F32) body->f32Const(0.0f);
      else if (wasmRetType == WasmType::F64) body->f64Const(0.0);
      else body->i32Const(0);  // fallback for void/other
    }
    body->ret();
    body = nullptr;
  }

  // Helper for managing goto label blocks (forward blocks + loop blocks).
  // Used by both COMPOUND and SWITCH codegen to avoid duplicating label logic.
  struct LabelScope {
    WasmCode *body;
    u32 &blockDepth;
    std::map<SLabel *, u32> &gotoLabelDepths;
    std::vector<SLabel *> forwardLabels;
    std::vector<SLabel *> openLoopLabels;

    // Scan statements for FORWARD/BOTH labels and open forward blocks
    void openForwardBlocks(const std::vector<Stmt> &stmts) {
      for (auto &subStmt : stmts) {
        if (subStmt.kind != StmtKind::LABEL) continue;
        SLabel *lbl = subStmt.as.labelStmt;
        if (!lbl->hasGotos) continue;
        if (lbl->labelKind == LabelKind::FORWARD || lbl->labelKind == LabelKind::BOTH)
          forwardLabels.push_back(lbl);
      }
      // Open forward-label blocks (reverse source order, first label innermost)
      for (int i = static_cast<int>(forwardLabels.size()) - 1; i >= 0; i--) {
        body->block();
        blockDepth++;
        gotoLabelDepths[forwardLabels[i]] = blockDepth;
      }
    }

    // Return the number of forward labels (call after openForwardBlocks)
    u32 numForwardBlocks() const { return static_cast<u32>(forwardLabels.size()); }

    // Handle a label during statement iteration
    void handleLabel(SLabel *lbl) {
      if (!lbl->hasGotos) return;
      if (lbl->labelKind == LabelKind::FORWARD || lbl->labelKind == LabelKind::BOTH) {
        // Close all open loop blocks before forward/BOTH label
        for (auto rit = openLoopLabels.rbegin(); rit != openLoopLabels.rend(); ++rit) {
          blockDepth--;
          body->end();
          gotoLabelDepths.erase(*rit);
        }
        openLoopLabels.clear();
        // Close forward label block
        blockDepth--;
        body->end();
        gotoLabelDepths.erase(lbl);
      }
      if (lbl->labelKind == LabelKind::LOOP || lbl->labelKind == LabelKind::BOTH) {
        // Open a loop block at the label position
        body->loop();
        blockDepth++;
        gotoLabelDepths[lbl] = blockDepth;
        openLoopLabels.push_back(lbl);
      }
    }

    // Close remaining loop blocks after iteration
    void closeRemainingLoops() {
      for (auto rit = openLoopLabels.rbegin(); rit != openLoopLabels.rend(); ++rit) {
        blockDepth--;
        body->end();
        gotoLabelDepths.erase(*rit);
      }
      openLoopLabels.clear();
    }
  };

  void emitStmt(Stmt stmt) {
    switch (stmt.kind) {
      case StmtKind::COMPOUND: {
        SCompound *comp = stmt.as.compound;
        pushLocalScope();
        LabelScope ls{body, blockDepth, gotoLabelDepths, {}, {}};
        ls.openForwardBlocks(comp->statements);
        for (auto &subStmt : comp->statements) {
          if (subStmt.kind == StmtKind::LABEL) {
            ls.handleLabel(subStmt.as.labelStmt);
          } else {
            emitStmt(subStmt);
          }
        }
        ls.closeRemainingLoops();
        popLocalScope();
        break;
      }
      case StmtKind::EXPR: {
        SExpr *sexpr = stmt.as.exprStmt;
        emitExpr(sexpr->expr, ExprContext::DROP);
        break;
      }
      case StmtKind::DECL: {
        SDecl *sdecl = stmt.as.declStmt;
        for (auto &decl : sdecl->declarations) {
          if (decl.kind == DeclKind::VAR) {
            DVar *varDecl = decl.as.var;
            // Allocate WASM local for REGISTER vars on-the-fly
            if (varDecl->storageClass != StorageClass::STATIC && varDecl->definition == varDecl &&
                varDecl->allocClass == AllocClass::REGISTER) {
              localVarToWasmLocalIdx[varDecl] = allocLocal(cToWasmType(varDecl->type));
            }
            if (varDecl->initExpr) {
              auto lait = localArrayOffsets.find(varDecl);
              if (lait != localArrayOffsets.end()) {
                // MEMORY variable (array, struct, or address-taken scalar)
                emitInitToFrameSlot(varDecl->type, varDecl->initExpr, lait->second);
              } else {
                // REGISTER scalar
                auto lit = localVarToWasmLocalIdx.find(varDecl);
                if (lit != localVarToWasmLocalIdx.end()) {
                  emitExpr(varDecl->initExpr);
                  body->localSet(lit->second);
                } else {
                  panicf("Local variable not found in locals or localArrayOffsets");
                }
              }
            }
          }
        }
        break;
      }
      case StmtKind::RETURN: {
        SReturn *ret = stmt.as.returnStmt;
        if (hasVaArgs) {
          // Variadic function: store return value to arg block, WASM returns void
          Type retType = currentFuncDef->type.getReturnType();
          if (ret->expr && isStructOrUnion(retType)) {
            // Struct return: memcpy to arg block return slot
            body->localGet(argBlockLocalIdx);  // dest = argBlock + 0
            emitExpr(ret->expr);               // src address
            body->i32Const(static_cast<i32>(sizeOf(retType)));
            body->memoryCopy();
          } else if (ret->expr) {
            // Scalar return: store to arg block return slot
            body->localGet(argBlockLocalIdx);  // dest = argBlock + 0
            emitExpr(ret->expr);
            emitVaArgStore(retType);
          }
          // void return: nothing to store
        } else if (ret->expr && hasStructReturn) {
          // Non-variadic struct return: copy to caller-allocated space via hidden pointer
          body->localGet(structRetPtrLocalIdx);  // dest
          emitExpr(ret->expr);                   // src address
          Type retType = currentFuncDef->type.getReturnType();
          body->i32Const(static_cast<i32>(sizeOf(retType)));
          body->memoryCopy();
          // Return the pointer
          body->localGet(structRetPtrLocalIdx);
        } else if (ret->expr) {
          emitExpr(ret->expr);
        } else {
          // Void return - non-variadic functions return a value, so push dummy i32
          if (!hasVaArgs) body->i32Const(0);
        }
        // Restore stack pointer before returning if we have local arrays
        if (frameSize > 0) {
          body->localGet(savedSpLocalIdx);
          body->globalSet(stackPointerGlobalIdx);
        }
        body->ret();
        break;
      }
      case StmtKind::IF: {
        SIf *sif = stmt.as.ifStmt;
        // Emit condition (must produce i32)
        emitExpr(sif->condition);
        emitConditionToI32(sif->condition.getType());
        if (sif->elseBranch) {
          // if-else
          body->if_(WasmType::Empty);
          blockDepth++;
          emitStmt(sif->thenBranch);
          body->else_();
          emitStmt(sif->elseBranch);
          blockDepth--;
          body->end();
        } else {
          // if without else
          body->if_(WasmType::Empty);
          blockDepth++;
          emitStmt(sif->thenBranch);
          blockDepth--;
          body->end();
        }
        break;
      }
      case StmtKind::WHILE: {
        SWhile *swhile = stmt.as.whileStmt;
        // WebAssembly structure:
        //   block $break
        //     loop $continue
        //       condition
        //       i32.eqz
        //       br_if $break (label 1)
        //       body
        //       br $continue (label 0)
        //     end
        //   end
        u32 savedBreak = breakTarget;
        u32 savedContinue = continueTarget;

        body->block();  // $break block
        blockDepth++;
        breakTarget = blockDepth;

        body->loop();  // $continue loop
        blockDepth++;
        continueTarget = blockDepth;

        emitExpr(swhile->condition);
        emitConditionToI32(swhile->condition.getType());
        body->aop(WasmType::I32, OP_EQZ);      // invert condition
        body->brIf(blockDepth - breakTarget);  // br_if to $break
        emitStmt(swhile->body);
        body->br(blockDepth - continueTarget);  // br to $continue

        blockDepth--;
        body->end();  // end loop
        blockDepth--;
        body->end();  // end block

        breakTarget = savedBreak;
        continueTarget = savedContinue;
        break;
      }
      case StmtKind::DO_WHILE: {
        SDoWhile *sdowhile = stmt.as.doWhileStmt;
        // WebAssembly structure:
        //   block $break
        //     loop $loop
        //       block $continue          ;; continue branches to end of this block
        //         body
        //       end
        //       condition
        //       br_if $loop (label 0)    ;; if condition true, loop back
        //     end
        //   end
        u32 savedBreak = breakTarget;
        u32 savedContinue = continueTarget;

        body->block();  // $break block
        blockDepth++;
        breakTarget = blockDepth;

        body->loop();  // $loop
        blockDepth++;
        u32 loopDepth = blockDepth;

        body->block();  // $continue block (continue lands at end of this)
        blockDepth++;
        continueTarget = blockDepth;

        emitStmt(sdowhile->body);

        blockDepth--;
        body->end();  // end $continue block

        emitExpr(sdowhile->condition);
        emitConditionToI32(sdowhile->condition.getType());
        body->brIf(blockDepth - loopDepth);  // if condition true, loop back

        blockDepth--;
        body->end();  // end loop
        blockDepth--;
        body->end();  // end block

        breakTarget = savedBreak;
        continueTarget = savedContinue;
        break;
      }
      case StmtKind::FOR: {
        SFor *sfor = stmt.as.forStmt;
        // WebAssembly structure (continue must execute increment):
        //   <init>
        //   block $break
        //     loop $loop
        //       <condition> (if present)
        //       i32.eqz
        //       br_if $break
        //       block $continue    <- continue jumps here (to end of block)
        //         body
        //       end
        //       <increment> (if present)
        //       br $loop
        //     end
        //   end
        u32 savedBreak = breakTarget;
        u32 savedContinue = continueTarget;

        // Scope for for-init declarations (e.g. for (int i = 0; ...))
        pushLocalScope();

        // Emit init
        if (sfor->init) {
          emitStmt(sfor->init);
        }

        body->block();  // $break block
        blockDepth++;
        breakTarget = blockDepth;

        body->loop();  // $loop
        blockDepth++;
        u32 loopTarget = blockDepth;

        // Emit condition (if present)
        if (sfor->condition) {
          emitExpr(sfor->condition);
          emitConditionToI32(sfor->condition.getType());
          body->aop(WasmType::I32, OP_EQZ);      // invert condition
          body->brIf(blockDepth - breakTarget);  // br_if to $break
        }

        body->block();  // $continue block (continue exits this block to reach increment)
        blockDepth++;
        continueTarget = blockDepth;

        // Emit body
        emitStmt(sfor->body);

        blockDepth--;
        body->end();  // end $continue block

        // Emit increment (if present)
        if (sfor->increment) {
          emitExpr(sfor->increment, ExprContext::DROP);
        }

        body->br(blockDepth - loopTarget);  // br to $loop

        blockDepth--;
        body->end();  // end loop
        blockDepth--;
        body->end();  // end $break block

        popLocalScope();

        breakTarget = savedBreak;
        continueTarget = savedContinue;
        break;
      }
      case StmtKind::BREAK: {
        // Break: branch to the break target block
        body->br(blockDepth - breakTarget);
        break;
      }
      case StmtKind::CONTINUE: {
        // Continue: branch to the continue target loop
        body->br(blockDepth - continueTarget);
        break;
      }
      case StmtKind::SWITCH: {
        SSwitch *sw = stmt.as.switchStmt;
        u32 savedBreak = breakTarget;

        // Find default case index (-1 if none)
        i32 defaultIdx = -1;
        for (u32 i = 0; i < sw->cases.size(); i++) {
          if (sw->cases[i].isDefault) {
            defaultIdx = static_cast<i32>(i);
            break;
          }
        }

        // Structure (cases laid out so fall-through works):
        //   block $break
        //     block $case_last (cases after label are outer)
        //       block $fwd_label  (interleaved at correct position)
        //         block $case_N
        //           ...
        //           block $case_0
        //             <dispatch>
        //           end  <- jump here runs case_0, then falls through
        //           <case_0_stmts>
        //         end  <- jump here runs case_N
        //         <case_N_stmts (includes label)>
        //       end $fwd_label  <- forward goto lands here
        //       <code after label>
        //     end $case_last
        //     <case_last_stmts>
        //   end  <- break jumps here

        LabelScope ls{body, blockDepth, gotoLabelDepths, {}, {}};

        // Outer break block
        body->block();
        blockDepth++;
        breakTarget = blockDepth;

        u32 numCases = static_cast<u32>(sw->cases.size());

        // Collect forward labels and their statement positions in switch body
        struct SwitchFwdLabel { SLabel *label; u32 stmtPos; };
        std::vector<SwitchFwdLabel> switchFwdLabels;
        for (u32 si = 0; si < sw->body->statements.size(); si++) {
          auto &subStmt = sw->body->statements[si];
          if (subStmt.kind != StmtKind::LABEL) continue;
          SLabel *lbl = subStmt.as.labelStmt;
          if (!lbl->hasGotos) continue;
          if (lbl->labelKind == LabelKind::FORWARD || lbl->labelKind == LabelKind::BOTH)
            switchFwdLabels.push_back({lbl, si});
        }
        u32 numSwitchForwardBlocks = static_cast<u32>(switchFwdLabels.size());

        // Compute adjusted br index for each case.
        // A forward label at stmtPos P is interleaved between cases with
        // stmtIndex <= P (inner) and cases with stmtIndex > P (outer).
        // So caseBrIdx[i] = i + count(fwd labels with stmtPos < cases[i].stmtIndex)
        std::vector<u32> caseBrIdx(numCases);
        for (u32 i = 0; i < numCases; i++) {
          u32 adj = 0;
          for (auto &fl : switchFwdLabels) {
            if (fl.stmtPos < sw->cases[i].stmtIndex) adj++;
          }
          caseBrIdx[i] = i + adj;
        }

        // Open case blocks and forward label blocks interleaved.
        // Blocks opened first are outermost. We sort by stmtPos descending
        // (higher pos = outermost), with forward blocks outer for equal pos.
        struct SwitchBlockEntry {
          u32 pos;
          bool isForward;
          u32 idx;
        };
        std::vector<SwitchBlockEntry> blockEntries;
        for (u32 i = 0; i < numCases; i++) {
          blockEntries.push_back({sw->cases[i].stmtIndex, false, i});
        }
        for (u32 i = 0; i < switchFwdLabels.size(); i++) {
          blockEntries.push_back({switchFwdLabels[i].stmtPos, true, i});
        }
        std::sort(blockEntries.begin(), blockEntries.end(),
            [](const SwitchBlockEntry &a, const SwitchBlockEntry &b) {
              if (a.pos != b.pos) return a.pos > b.pos;
              if (a.isForward != b.isForward) return a.isForward;
              return a.idx > b.idx;
            });

        for (auto &e : blockEntries) {
          body->block();
          blockDepth++;
          if (e.isForward) {
            gotoLabelDepths[switchFwdLabels[e.idx].label] = blockDepth;
          }
        }

        // Dispatch: evaluate expr ONCE and branch to correct case
        // br caseBrIdx[i] = run case i
        // br (numCases + numSwitchForwardBlocks) = break
        {
          pushLocalScope();
          u32 switchLocal = allocLocal(WasmType::I32);
          emitExpr(sw->expr);
          body->localSet(switchLocal);

          // Count non-default cases and find min/max for density check
          u32 nonDefaultCount = 0;
          i32 minVal = INT32_MAX, maxVal = INT32_MIN;
          for (u32 i = 0; i < numCases; i++) {
            if (sw->cases[i].isDefault) continue;
            i32 v = static_cast<i32>(sw->cases[i].value);
            if (nonDefaultCount == 0 || v < minVal) minVal = v;
            if (nonDefaultCount == 0 || v > maxVal) maxVal = v;
            nonDefaultCount++;
          }

          u32 range = (nonDefaultCount > 0) ? static_cast<u32>(maxVal - minVal) + 1 : 0;
          bool dense = nonDefaultCount >= 4 && range <= 512 &&
              nonDefaultCount * 10 / range >= 4;  // density >= 40%

          if (compilerOptions.compilerDebugSwitch) {
            std::cerr << sw->loc.filename->c_str() << ":" << sw->loc.line
                      << ": switch: " << (dense ? "br_table" : "br_if") << "\n";
          }

          if (dense) {
            // br_table path: build a jump table
            u32 fallbackIdx = (defaultIdx >= 0) ? caseBrIdx[static_cast<u32>(defaultIdx)]
                                                : numCases + numSwitchForwardBlocks;
            std::vector<u32> table(range, fallbackIdx);
            for (u32 i = 0; i < numCases; i++) {
              if (sw->cases[i].isDefault) continue;
              i32 v = static_cast<i32>(sw->cases[i].value);
              table[static_cast<u32>(v - minVal)] = caseBrIdx[i];
            }
            body->localGet(switchLocal);
            body->i32Const(minVal);
            body->aop(WasmType::I32, OP_SUB);
            body->brTable(table, fallbackIdx);
          } else {
            // Linear br_if chain for sparse switches
            for (u32 i = 0; i < numCases; i++) {
              if (sw->cases[i].isDefault) continue;
              body->localGet(switchLocal);
              body->i32Const(static_cast<i32>(sw->cases[i].value));
              body->aop(WasmType::I32, OP_EQ);
              body->brIf(caseBrIdx[i]);
            }
            if (defaultIdx >= 0) {
              body->br(caseBrIdx[static_cast<u32>(defaultIdx)]);
            } else {
              body->br(numCases + numSwitchForwardBlocks);
            }
          }
          popLocalScope();
        }

        // Emit case bodies (in order, with fall-through)
        for (u32 i = 0; i < numCases; i++) {
          blockDepth--;
          body->end();

          // Find statements for this case
          u32 startIdx = sw->cases[i].stmtIndex;
          u32 endIdx = (i + 1 < numCases) ? sw->cases[i + 1].stmtIndex
                                          : static_cast<u32>(sw->body->statements.size());
          for (u32 j = startIdx; j < endIdx; j++) {
            auto &subStmt = sw->body->statements[j];
            if (subStmt.kind == StmtKind::LABEL) {
              ls.handleLabel(subStmt.as.labelStmt);
            } else {
              emitStmt(subStmt);
            }
          }
        }

        ls.closeRemainingLoops();

        // Close break block
        blockDepth--;
        body->end();

        breakTarget = savedBreak;
        break;
      }
      case StmtKind::GOTO: {
        SGoto *sg = stmt.as.gotoStmt;
        auto it = gotoLabelDepths.find(sg->target);
        if (it == gotoLabelDepths.end()) {
          panicf(
              "%s:%d: goto '%s': target label not in scope"
              " (in function '%s')"
              " (label may be in a nested block, or a loop label's scope was closed by a forward "
              "label)",
              sg->loc.filename->c_str(), sg->loc.line, sg->label.c_str(),
              currentFuncDef ? currentFuncDef->name->c_str() : "?");
        }
        body->br(blockDepth - it->second);
        break;
      }
      case StmtKind::LABEL:
        // Labels are handled in COMPOUND emission
        break;
      case StmtKind::EMPTY: break;
      case StmtKind::THROW: {
        SThrow *st = stmt.as.throwStmt;
        u32 tagIdx = exceptionToWasmTagIdx[st->tag];
        // Emit each argument expression, with conversion to the tag param type
        for (size_t i = 0; i < st->args.size(); i++) {
          emitExpr(st->args[i]);
        }
        body->throw_(tagIdx);
        body->unreachable();
        break;
      }
      case StmtKind::TRY_CATCH: {
        STryCatch *tc = stmt.as.tryCatch;
        size_t numCatches = tc->catches.size();

        // 0. Save stack pointer so we can restore it in catch handlers.
        //    When an exception unwinds through functions, their epilogues
        //    (which restore __stack_pointer) are skipped, leaking stack space.
        u32 savedSpLocal = allocLocal(WasmType::I32);
        body->globalGet(stackPointerGlobalIdx);
        body->localSet(savedSpLocal);

        // 1. block $end (Empty)
        body->block();
        blockDepth++;
        u32 endDepth = blockDepth;

        // 2. Catch target blocks in reverse order
        std::vector<u32> catchBlockDepths(numCatches);
        for (int i = static_cast<int>(numCatches) - 1; i >= 0; i--) {
          const CatchClause &cc = tc->catches[i];
          if (!cc.tag || cc.tag->paramTypes.empty()) {
            body->block();
          } else if (cc.tag->paramTypes.size() == 1) {
            body->block(cToWasmType(cc.tag->paramTypes[0]));
          } else {
            // multi-param: use function type index for block type
            WasmFunctionType blockFuncType;
            for (const Type &pt : cc.tag->paramTypes) {
              blockFuncType.results.push_back(cToWasmType(pt));
            }
            WasmFunctionTypeId typeIdx = addWasmFunctionTypeId(blockFuncType);
            body->push(0x02);  // block opcode
            lebI(body->bytes, static_cast<i64>(typeIdx));
          }
          blockDepth++;
          catchBlockDepths[i] = blockDepth;
        }

        // 3. try_table with catch clauses
        std::vector<std::tuple<u8, u32, u32>> catchEntries;
        for (size_t i = 0; i < numCatches; i++) {
          const CatchClause &cc = tc->catches[i];
          u32 labelIdx = blockDepth - catchBlockDepths[i];
          if (!cc.tag) {
            catchEntries.push_back({0x02, 0, labelIdx});
          } else {
            u32 tagIdx = exceptionToWasmTagIdx[cc.tag];
            catchEntries.push_back({0x00, tagIdx, labelIdx});
          }
        }
        body->tryTable(WasmType::Empty, catchEntries);
        blockDepth++;

        // 4. Emit try body
        emitStmt(tc->tryBody);

        // 5. end try_table
        blockDepth--;
        body->end();

        // 6. br to $end (normal exit skips catches)
        body->br(blockDepth - endDepth);

        // 7. Catch bodies in forward order
        for (size_t i = 0; i < numCatches; i++) {
          blockDepth--;
          body->end();

          const CatchClause &cc = tc->catches[i];
          pushLocalScope();

          // Restore stack pointer saved before the try body
          body->localGet(savedSpLocal);
          body->globalSet(stackPointerGlobalIdx);

          if (cc.tag && !cc.tag->paramTypes.empty()) {
            // Allocate locals for bindings, set caught values from stack
            std::vector<u32> bindLocals;
            for (size_t j = 0; j < cc.bindingVars.size(); j++) {
              u32 localIdx = allocLocal(cToWasmType(cc.tag->paramTypes[j]));
              localVarToWasmLocalIdx[cc.bindingVars[j]] = localIdx;
              bindLocals.push_back(localIdx);
            }
            // local.set in reverse order (last param is on top of stack)
            for (int j = static_cast<int>(bindLocals.size()) - 1; j >= 0; j--) {
              body->localSet(bindLocals[j]);
            }
          }

          emitStmt(cc.body);
          popLocalScope();

          if (i + 1 < numCatches) {
            body->br(blockDepth - endDepth);
          }
        }

        // 8. Close $end block
        blockDepth--;
        body->end();
        break;
      }
      default:
        panicf(
            "emitStmt: unhandled statement kind %s", std::string(strStmtKind(stmt.kind)).c_str());
    }
  }

  // Get the WasmType for the result of a binary operation
  WasmType getBinaryWasmType(Type type) {
    if (type == TUNKNOWN) panicf("getBinaryWasmType called with TUNKNOWN type");
    type = type.removeQualifiers();
    if (type == TFLOAT) return WasmType::F32;
    if (type == TDOUBLE || type == TLDOUBLE) return WasmType::F64;
    if (type == TLLONG || type == TULLONG) return WasmType::I64;
    return WasmType::I32;
  }

  // Check if type is unsigned for operations that care
  bool isUnsignedType(Type type) {
    Type uq = type.removeQualifiers();
    return uq == TUCHAR || uq == TUSHORT || uq == TUINT || uq == TULONG ||
        uq == TULLONG || uq == TBOOL;
  }

  // ── ExprContext & LValue abstraction ─────────────────────────────────
  enum class ExprContext { VALUE, DROP };

  struct LValue {
    enum Kind { REGISTER, MEMORY };
    Kind kind;
    Type type;  // C type of the lvalue's value

    // REGISTER fields
    u32 regIndex = 0;
    bool regIsGlobal = false;

    // MEMORY fields
    DVar *bitField = nullptr;  // non-null for bit-fields
    enum AddrSource { ADDR_LOCAL, ADDR_GLOBAL_STATIC, ADDR_FRAME };
    AddrSource addrSource = ADDR_LOCAL;  // how lvaluePush re-emits the address
    u32 addrImmediate = 0;               // static addr or frame offset

    // Saved locals (set by emitLValue for expensive addresses)
    u32 savedLocal = 0;      // MEMORY addr temp
  };

  // Resolve an expression that is an lvalue.
  // After this call, any stack-resident parts (address, ref, index) are on the WASM stack.
  LValue emitLValue(Expr expr) {
    if (expr.kind == ExprKind::IDENT) {
      EIdent *eident = expr.as.ident;
      if (eident->decl.kind == DeclKind::VAR) {
        DVar *varDecl = eident->decl.as.var->definition;
        if (!varDecl) varDecl = eident->decl.as.var;

        // Check REGISTER first (but skip MEMORY-alloc vars that also have a wasm local)
        auto lit = localVarToWasmLocalIdx.find(varDecl);
        auto git = globalVarToWasmGlobalIdx.find(varDecl);
        bool isLocal = lit != localVarToWasmLocalIdx.end();
        bool isGlobal = git != globalVarToWasmGlobalIdx.end();

        if ((isLocal || isGlobal) && varDecl->allocClass != AllocClass::MEMORY) {
          LValue lv;
          lv.kind = LValue::REGISTER;
          lv.type = varDecl->type;
          lv.regIndex = isLocal ? lit->second : git->second;
          lv.regIsGlobal = isGlobal;
          return lv;
        }

        // MEMORY variable — cheap: record address source for re-emission
        auto gait = globalArrayAddrs.find(varDecl);
        if (gait != globalArrayAddrs.end()) {
          LValue lv;
          lv.kind = LValue::MEMORY;
          lv.type = varDecl->type;
          lv.addrSource = LValue::ADDR_GLOBAL_STATIC;
          lv.addrImmediate = gait->second;
          return lv;
        }
        auto lait = localArrayOffsets.find(varDecl);
        if (lait != localArrayOffsets.end()) {
          LValue lv;
          lv.kind = LValue::MEMORY;
          lv.type = varDecl->type;
          lv.addrSource = LValue::ADDR_FRAME;
          lv.addrImmediate = lait->second;
          return lv;
        }
        auto pait = paramMemoryOffsets.find(varDecl);
        if (pait != paramMemoryOffsets.end()) {
          LValue lv;
          lv.kind = LValue::MEMORY;
          lv.type = varDecl->type;
          lv.addrSource = LValue::ADDR_FRAME;
          lv.addrImmediate = pait->second;
          return lv;
        }
        panicf("emitLValue: variable '%s' not found", varDecl->name->c_str());
      }
    }

    if (expr.kind == ExprKind::MEMBER) {
      EMember *em = expr.as.member;

      // Struct member: compute address, save to temp
      emitAddressOf(expr);
      LValue lv;
      lv.kind = LValue::MEMORY;
      lv.type = em->type;
      lv.bitField = em->memberDecl->isBitField() ? em->memberDecl : nullptr;
      lv.addrSource = LValue::ADDR_LOCAL;
      lv.savedLocal = allocLocal(WasmType::I32);
      body->localSet(lv.savedLocal);
      return lv;
    }

    if (expr.kind == ExprKind::ARROW) {
      EArrow *ea = expr.as.arrow;
      // Compute address: base pointer + field offset, save to temp
      emitAddressOf(expr);
      LValue lv;
      lv.kind = LValue::MEMORY;
      lv.type = ea->type;
      lv.bitField = ea->memberDecl->isBitField() ? ea->memberDecl : nullptr;
      lv.addrSource = LValue::ADDR_LOCAL;
      lv.savedLocal = allocLocal(WasmType::I32);
      body->localSet(lv.savedLocal);
      return lv;
    }

    if (expr.kind == ExprKind::SUBSCRIPT) {
      ESubscript *es = expr.as.subscript;

      // Subscript: compute address, save to temp
      u32 elemSize = sizeOf(es->type);
      emitExpr(es->array);
      emitExpr(es->index);
      if (getBinaryWasmType(es->index.getType()) == WasmType::I64) {
        body->aop(WasmType::I32, OP_WRAP_I64);
      }
      if (elemSize != 1) {
        body->i32Const(static_cast<i32>(elemSize));
        body->aop(WasmType::I32, OP_MUL);
      }
      body->aop(WasmType::I32, OP_ADD);
      LValue lv;
      lv.kind = LValue::MEMORY;
      lv.type = es->type;
      lv.addrSource = LValue::ADDR_LOCAL;
      lv.savedLocal = allocLocal(WasmType::I32);
      body->localSet(lv.savedLocal);
      return lv;
    }

    if (expr.kind == ExprKind::UNARY) {
      EUnary *eu = expr.as.unary;
      if (eu->op == Uop::OP_DEREF) {
        emitExpr(eu->operand);
        LValue lv;
        lv.kind = LValue::MEMORY;
        lv.type = eu->type;
        lv.addrSource = LValue::ADDR_LOCAL;
        lv.savedLocal = allocLocal(WasmType::I32);
        body->localSet(lv.savedLocal);
        return lv;
      }
    }

    panicf("emitLValue: unsupported expression kind %s",
        std::string(strExprKind(expr.kind)).c_str());
    return {};  // unreachable
  }

  // Push the lvalue's address onto the WASM stack.
  // For MEMORY: re-emits address (cheap for IDENT vars, localGet for saved).
  void lvaluePush(LValue &lv) {
    switch (lv.kind) {
      case LValue::REGISTER:
        break;  // nothing to push
      case LValue::MEMORY:
        switch (lv.addrSource) {
          case LValue::ADDR_LOCAL:
            body->localGet(lv.savedLocal);
            break;
          case LValue::ADDR_GLOBAL_STATIC:
            body->i32Const(static_cast<i32>(lv.addrImmediate));
            break;
          case LValue::ADDR_FRAME:
            emitFrameAddr(lv.addrImmediate);
            break;
        }
        break;
    }
  }

  // Load instruction: consume [addr] from the stack, produce [value].
  // REGISTER: no addr consumed; emits local.get/global.get.
  // MEMORY: consumes [addr]; emits i32.load / bitfield load.
  void lvalueLoad(LValue &lv) {
    switch (lv.kind) {
      case LValue::REGISTER:
        if (lv.regIsGlobal) body->globalGet(lv.regIndex);
        else body->localGet(lv.regIndex);
        break;
      case LValue::MEMORY:
        if (lv.bitField) {
          emitBitFieldLoad(lv.bitField);
        } else {
          emitLoad(lv.type);
        }
        break;
    }
  }

  // Store instruction: consume [addr, value] from the stack.
  // REGISTER: consumes [value]; emits local.set/global.set.
  // MEMORY: consumes [addr, value]; emits i32.store / bitfield store.
  void lvalueStore(LValue &lv) {
    switch (lv.kind) {
      case LValue::REGISTER:
        if (lv.regIsGlobal) body->globalSet(lv.regIndex);
        else body->localSet(lv.regIndex);
        break;
      case LValue::MEMORY:
        if (lv.bitField) {
          emitBitFieldStore(lv.bitField);
        } else {
          emitStore(lv.type);
        }
        break;
    }
  }

  // Convenience: push addr-parts then load. [] → [value].
  void lvaluePushAndLoad(LValue &lv) {
    lvaluePush(lv);
    lvalueLoad(lv);
  }

  // Compute the operation type for compound assignment.
  // Per C99 §6.5.16.2, E1 op= E2 behaves as E1 = E1 op E2, so we need
  // usual arithmetic conversions for all arithmetic types, not just floats.
  Type getCompoundOpType(Type lhsType, Type rhsType) {
    if (!lhsType.isPointer()) {
      return usualArithmeticConversions(lhsType, rhsType);
    }
    return lhsType;
  }

  void emitExpr(Expr expr, ExprContext ctx = ExprContext::VALUE) {
    switch (expr.kind) {
      case ExprKind::INT: {
        EInt *ei = expr.as.intLit;
        Type type = ei->type;
        if (type == TLLONG || type == TULLONG) {
          body->i64Const(static_cast<i64>(ei->value));
        } else {
          body->i32Const(static_cast<i32>(ei->value));
        }
        break;
      }
      case ExprKind::FLOAT: {
        EFloat *ef = expr.as.floatLit;
        if (ef->type == TFLOAT) {
          body->f32Const(static_cast<float>(ef->value));
        } else {
          body->f64Const(ef->value);
        }
        break;
      }
      case ExprKind::STRING: {
        EString *es = expr.as.stringLit;
        u32 addr = getStringAddress(es->value);
        body->i32Const(static_cast<i32>(addr));
        break;
      }
      case ExprKind::IDENT: {
        EIdent *eident = expr.as.ident;
        if (eident->decl.kind == DeclKind::VAR) {
          DVar *varDecl = eident->decl.as.var->definition;
          if (!varDecl) varDecl = eident->decl.as.var;

          // Check for global MEMORY var (arrays, structs, or address-taken scalars)
          auto gait = globalArrayAddrs.find(varDecl);
          if (gait != globalArrayAddrs.end()) {
            // Global MEMORY var - for arrays/structs, decay to address; for scalars, load
            if (varDecl->type.isArray() || varDecl->type.isAggregate()) {
              body->i32Const(static_cast<i32>(gait->second));
            } else {
              body->i32Const(static_cast<i32>(gait->second));
              emitLoad(varDecl->type);
            }
            break;
          }

          // Check for local MEMORY var (arrays, structs, or address-taken scalars)
          auto lait = localArrayOffsets.find(varDecl);
          if (lait != localArrayOffsets.end()) {
            emitFrameAddr(lait->second);
            // For arrays/structs, leave address on stack; for scalars, load
            if (!varDecl->type.isArray() && !varDecl->type.isAggregate()) {
              emitLoad(varDecl->type);
            }
            break;
          }

          // Check for MEMORY parameter (address-taken)
          auto pait = paramMemoryOffsets.find(varDecl);
          if (pait != paramMemoryOffsets.end()) {
            emitFrameAddr(pait->second);
            // For arrays/structs, leave address on stack; for scalars, load
            if (!varDecl->type.isArray() && !varDecl->type.isAggregate()) {
              emitLoad(varDecl->type);
            }
            break;
          }

          auto lit = localVarToWasmLocalIdx.find(varDecl);
          if (lit != localVarToWasmLocalIdx.end()) {
            // Local variable (REGISTER)
            body->localGet(lit->second);
          } else {
            // Global variable (REGISTER)
            auto git = globalVarToWasmGlobalIdx.find(varDecl);
            if (git != globalVarToWasmGlobalIdx.end()) {
              body->globalGet(git->second);
            } else {
              panicf(
                  "emitExpr: variable '%s' not found in locals or globals", varDecl->name->c_str());
            }
          }
        } else if (eident->decl.kind == DeclKind::ENUM_CONST) {
          // Enum constants are just integer values
          DEnumConst *ec = eident->decl.as.enumConst;
          body->i32Const(ec->value);
        } else if (eident->decl.kind == DeclKind::FUNC) {
          // Function name used as value → decays to function pointer (table index)
          DFunc *func = eident->decl.as.func;
          if (func->definition) func = func->definition;
          auto it = funcDefToTableIdx.find(func);
          if (it == funcDefToTableIdx.end()) {
            panicf("emitExpr: function '%s' not found in funcDefToTableIdx", func->name->c_str());
          }
          body->i32Const(static_cast<i32>(it->second));
        } else {
          panicf("emitExpr: identifier is not a variable, enum constant, or function");
        }
        break;
      }
      case ExprKind::BINARY: {
        EBinary *eb = expr.as.binary;
        Type resultType = eb->type;
        Type leftType = eb->left.getType();
        Type rightType = eb->right.getType();

        // Handle assignment operators specially
        if (eb->op >= Bop::ASSIGN && eb->op <= Bop::SHR_ASSIGN) {
          emitAssignment(eb, ctx);
          return;
        }

        // After annotation pass, operands are already converted to opType.
        // For comparisons, leftType (post-cast) is the common comparison type.
        // For arithmetic, resultType is the operation type.
        bool isComparison = eb->op >= Bop::EQ && eb->op <= Bop::GE;
        WasmType wt = getBinaryWasmType(isComparison ? leftType : resultType);
        bool isUnsigned = isUnsignedType(leftType);

        // Handle pointer arithmetic specially
        if (eb->op == Bop::ADD &&
            (leftType.isPointer() || rightType.isPointer() || leftType.isArray() ||
                rightType.isArray())) {
          // ptr + int or int + ptr (or array + int / int + array)
          Expr ptrExpr, intExpr;
          Type elemType;
          if (leftType.isPointer()) {
            ptrExpr = eb->left;
            intExpr = eb->right;
            elemType = leftType.getPointee();
          } else if (leftType.isArray()) {
            ptrExpr = eb->left;
            intExpr = eb->right;
            elemType = leftType.getArrayBase();
          } else if (rightType.isPointer()) {
            ptrExpr = eb->right;
            intExpr = eb->left;
            elemType = rightType.getPointee();
          } else {
            ptrExpr = eb->right;
            intExpr = eb->left;
            elemType = rightType.getArrayBase();
          }
          u32 elemSize = sizeOf(elemType);
          emitExpr(ptrExpr);
          emitExpr(intExpr);
          if (getBinaryWasmType(intExpr.getType()) == WasmType::I64) {
            body->aop(WasmType::I32, OP_WRAP_I64);
          }
          if (elemSize != 1) {
            body->i32Const(static_cast<i32>(elemSize));
            body->aop(WasmType::I32, OP_MUL);
          }
          body->aop(WasmType::I32, OP_ADD);
          break;
        }

        if (eb->op == Bop::SUB && (leftType.isPointer() || leftType.isArray())) {
          Type leftElemType = leftType.isArray() ? leftType.getArrayBase() : leftType.getPointee();
          emitExpr(eb->left);
          emitExpr(eb->right);
          if (rightType.isPointer() || rightType.isArray()) {
            // ptr - ptr: subtract, then divide by element size
            body->aop(WasmType::I32, OP_SUB);
            u32 elemSize = sizeOf(leftElemType);
            if (elemSize != 1) {
              body->i32Const(static_cast<i32>(elemSize));
              body->aop(WasmType::I32, OP_DIV, true);  // signed division
            }
          } else {
            // ptr - int: scale int, then subtract
            if (getBinaryWasmType(rightType) == WasmType::I64) {
              body->aop(WasmType::I32, OP_WRAP_I64);
            }
            u32 elemSize = sizeOf(leftElemType);
            if (elemSize != 1) {
              body->i32Const(static_cast<i32>(elemSize));
              body->aop(WasmType::I32, OP_MUL);
            }
            body->aop(WasmType::I32, OP_SUB);
          }
          break;
        }

        // Handle logical operators with short-circuit evaluation
        if (eb->op == Bop::LAND) {
          // if (left != 0) { right != 0 } else { 0 }
          emitExpr(eb->left);
          emitBoolNormalize(leftType);
          body->if_(WasmType::I32);
          emitExpr(eb->right);
          emitBoolNormalize(rightType);
          body->else_();
          body->i32Const(0);
          body->end();
          break;
        }
        if (eb->op == Bop::LOR) {
          // if (left != 0) { 1 } else { right != 0 }
          emitExpr(eb->left);
          emitBoolNormalize(leftType);
          body->if_(WasmType::I32);
          body->i32Const(1);
          body->else_();
          emitExpr(eb->right);
          emitBoolNormalize(rightType);
          body->end();
          break;
        }

        // Emit operands (implicit casts already inserted by annotation pass)
        emitExpr(eb->left);
        emitExpr(eb->right);

        // Emit the operation
        switch (eb->op) {
          case Bop::ADD: body->aop(wt, OP_ADD); break;
          case Bop::SUB: body->aop(wt, OP_SUB); break;
          case Bop::MUL: body->aop(wt, OP_MUL); break;
          case Bop::DIV: body->aop(wt, OP_DIV, !isUnsigned); break;
          case Bop::MOD: body->aop(wt, OP_REM, !isUnsigned); break;
          case Bop::EQ: body->aop(wt, OP_EQ); break;
          case Bop::NE: body->aop(wt, OP_NE); break;
          case Bop::LT: body->aop(wt, OP_LT, !isUnsigned); break;
          case Bop::GT: body->aop(wt, OP_GT, !isUnsigned); break;
          case Bop::LE: body->aop(wt, OP_LE, !isUnsigned); break;
          case Bop::GE: body->aop(wt, OP_GE, !isUnsigned); break;
          case Bop::BAND: body->aop(wt, OP_AND); break;
          case Bop::BOR: body->aop(wt, OP_OR); break;
          case Bop::BXOR: body->aop(wt, OP_XOR); break;
          case Bop::SHL: body->aop(wt, OP_SHL); break;
          case Bop::SHR: body->aop(wt, isUnsigned ? OP_SHR_U : OP_SHR_S); break;
          case Bop::LAND:
          case Bop::LOR: panicf("LAND/LOR should be handled before operand emission"); break;
          default: panicf("emitExpr: unhandled binary operator");
        }
        break;
      }
      case ExprKind::UNARY: {
        EUnary *eu = expr.as.unary;
        Type operandType = eu->operand.getType();

        switch (eu->op) {
          case Uop::OP_NEG: {
            // -x = 0 - x
            WasmType wt = getBinaryWasmType(operandType);
            if (wt == WasmType::I32) {
              body->i32Const(0);
            } else if (wt == WasmType::I64) {
              body->i64Const(0);
            } else if (wt == WasmType::F32) {
              emitExpr(eu->operand);
              body->aop(wt, OP_NEG);
              break;
            } else {
              emitExpr(eu->operand);
              body->aop(wt, OP_NEG);
              break;
            }
            emitExpr(eu->operand);
            body->aop(wt, OP_SUB);
            break;
          }
          case Uop::OP_POS:
            // +x is just x
            emitExpr(eu->operand);
            break;
          case Uop::OP_LNOT: {
            // !x = (x == 0)
            emitExpr(eu->operand);
            WasmType wt = getBinaryWasmType(operandType);
            if (wt == WasmType::F32) {
              body->f32Const(0.0f);
              body->aop(WasmType::F32, OP_EQ);
            } else if (wt == WasmType::F64) {
              body->f64Const(0.0);
              body->aop(WasmType::F64, OP_EQ);
            } else {
              body->aop(wt, OP_EQZ);
            }
            break;
          }
          case Uop::OP_BNOT: {
            // ~x = x ^ -1
            WasmType wt = getBinaryWasmType(operandType);
            emitExpr(eu->operand);
            if (wt == WasmType::I32) {
              body->i32Const(-1);
            } else {
              body->i64Const(-1);
            }
            body->aop(wt, OP_XOR);
            break;
          }
          case Uop::OP_PRE_INC:
          case Uop::OP_PRE_DEC:
          case Uop::OP_POST_INC:
          case Uop::OP_POST_DEC: emitIncDec(eu, ctx); return;
          case Uop::OP_DEREF:
            // *ptr - load from memory
            // For function types, dereferencing a function pointer yields a
            // function designator that immediately decays back to a pointer,
            // so it's effectively a no-op (just evaluate the operand).
            emitExpr(eu->operand);
            if (!eu->type.isAggregate() && !eu->type.isFunction()) {
              emitLoad(eu->type);
            }
            break;
          case Uop::OP_ADDR:
            // &x - get address of variable (bit-fields cannot have their address taken)
            if (eu->operand.kind == ExprKind::MEMBER &&
                eu->operand.as.member->memberDecl->isBitField()) {
              auto loc = eu->operand.getLoc();
              std::cerr << "Got 1 parse errors in " << *loc.filename << ".\n";
              std::cerr << *loc.filename << ":" << loc.line << ": error: "
                        << "Cannot take address of bit-field member '"
                        << *eu->operand.as.member->memberName << "'\n";
              exit(1);
            }
            if (eu->operand.kind == ExprKind::ARROW &&
                eu->operand.as.arrow->memberDecl->isBitField()) {
              auto loc = eu->operand.getLoc();
              std::cerr << "Got 1 parse errors in " << *loc.filename << ".\n";
              std::cerr << *loc.filename << ":" << loc.line << ": error: "
                        << "Cannot take address of bit-field member '"
                        << *eu->operand.as.arrow->memberName << "'\n";
              exit(1);
            }
            emitAddressOf(eu->operand);
            break;
          default: panicf("emitExpr: unhandled unary operator");
        }
        break;
      }
      case ExprKind::CALL: {
        ECall *ec = expr.as.call;
        if (ec->funcDecl) {
          DFunc *funcDef = ec->funcDecl->definition;
          if (!funcDef) funcDef = ec->funcDecl;
          Type funcType = funcDef->type;

          auto it = funcDefToWasmFuncIdx.find(funcDef);
          if (it == funcDefToWasmFuncIdx.end()) {
            panicf(
                "%s:%d: emitExpr: function '%s' not found in funcDefToWasmFuncIdx"
                " (called from '%s')",
                ec->loc.filename->c_str(), ec->loc.line, funcDef->name->c_str(),
                currentFuncDef ? currentFuncDef->name->c_str() : "?");
          }

          if (funcType.isVarArg()) {
            // Variadic function call — new convention:
            // All args (fixed + variadic) and return value are in a single
            // contiguous arg block on the linear memory stack.
            // WASM signature: (i32) -> () — single arg block pointer, void return.
            Type varRetType = funcType.getReturnType();
            auto paramTypes = funcType.getParamTypes();
            u32 numFixedParams = toU32(paramTypes.size());

            bool varStructRet = isStructOrUnion(varRetType);
            u32 retSlotSize = (varRetType == TVOID) ? 0 : vaSlotSize(varRetType);

            // Compute arg block layout: [retSlot] [fixedArg0] [fixedArg1] ... [varArg0] ...
            u32 blockSize = retSlotSize;
            std::vector<u32> argOffsets;
            for (u32 i = 0; i < ec->arguments.size(); i++) {
              argOffsets.push_back(blockSize);
              Type argType;
              if (i < numFixedParams) {
                argType = paramTypes[i];
              } else {
                // Decay arrays→pointers, apply default argument promotions
                argType = ec->arguments[i].getType().decay();
                if (argType.removeQualifiers() == TFLOAT) argType = TDOUBLE;
              }
              blockSize += vaSlotSize(argType);
            }
            blockSize = (blockSize + 7) & ~7u;  // ensure 8-byte aligned

            callNesting++;

            // Allocate arg block on linear memory stack
            body->globalGet(stackPointerGlobalIdx);
            body->i32Const(static_cast<i32>(blockSize));
            body->aop(WasmType::I32, OP_SUB);
            body->globalSet(stackPointerGlobalIdx);

            pushLocalScope();
            u32 argBlockBase = allocLocal(WasmType::I32);
            body->globalGet(stackPointerGlobalIdx);
            body->localSet(argBlockBase);

            u32 deferredAtVaAlloc = structRetDeferred;

            // Store each argument into the arg block
            for (u32 i = 0; i < ec->arguments.size(); i++) {
              Expr &arg = ec->arguments[i];
              Type argType = arg.getType();
              bool isFixed = i < numFixedParams;

              // Determine the storage type (decayed + promoted for varargs)
              Type storeType;
              if (isFixed) {
                storeType = paramTypes[i];
              } else {
                storeType = argType.decay();
                if (storeType.removeQualifiers() == TFLOAT) storeType = TDOUBLE;
              }

              // Push destination address
              body->localGet(argBlockBase);
              if (argOffsets[i] > 0) {
                body->i32Const(static_cast<i32>(argOffsets[i]));
                body->aop(WasmType::I32, OP_ADD);
              }

              if (isStructOrUnion(storeType)) {
                // Struct/union arg: memcpy into the arg block slot
                emitExpr(arg);  // source address
                body->i32Const(static_cast<i32>(sizeOf(storeType)));
                body->memoryCopy();
              } else {
                // Scalar arg
                emitExpr(arg);
                emitVaArgStore(storeType);
              }

              // Reload base pointer in case emitExpr contained a nested
              // call that modified the global stack pointer.
              body->globalGet(stackPointerGlobalIdx);
              u32 deferredDelta = structRetDeferred - deferredAtVaAlloc;
              if (deferredDelta > 0) {
                body->i32Const(static_cast<i32>(deferredDelta));
                body->aop(WasmType::I32, OP_ADD);
              }
              body->localSet(argBlockBase);
            }

            // Push the arg block pointer as the single WASM argument
            body->localGet(argBlockBase);

            // Make the call (returns void at WASM level)
            body->call(it->second);

            // Load return value from arg block.
            // Use argBlockBase local (NOT globalGet SP) because SP may have
            // been shifted by deferred struct returns from subexpressions.
            if (varStructRet) {
              // Struct return: push pointer to return slot (= argBlockBase)
              // Defer SP restoration to keep the struct data alive
              body->localGet(argBlockBase);
              structRetDeferred += blockSize;
            } else if (varRetType != TVOID) {
              // Scalar return: load from arg block return slot
              body->localGet(argBlockBase);
              emitVaArgLoad(varRetType);
              // Restore SP: argBlockBase + blockSize = original SP before this call
              body->localGet(argBlockBase);
              body->i32Const(static_cast<i32>(blockSize));
              body->aop(WasmType::I32, OP_ADD);
              body->globalSet(stackPointerGlobalIdx);
            } else {
              // Void return: restore SP, push dummy i32
              body->localGet(argBlockBase);
              body->i32Const(static_cast<i32>(blockSize));
              body->aop(WasmType::I32, OP_ADD);
              body->globalSet(stackPointerGlobalIdx);
              body->i32Const(0);  // dummy value for void
            }

            popLocalScope();

            callNesting--;
            if (callNesting == 0 && structRetDeferred > 0) {
              body->globalGet(stackPointerGlobalIdx);
              body->i32Const(static_cast<i32>(structRetDeferred));
              body->aop(WasmType::I32, OP_ADD);
              body->globalSet(stackPointerGlobalIdx);
              structRetDeferred = 0;
            }
          } else {
            // Non-variadic function call - emit arguments normally
            Type callRetType = funcType.getReturnType();
            bool structRet = isStructOrUnion(callRetType);
            u32 structRetAllocSize = 0;

            callNesting++;

            if (structRet) {
              // Allocate stack space for return value and pass as hidden first arg
              u32 retSize = sizeOf(callRetType);
              structRetAllocSize = (retSize + 15) & ~15u;  // align to 16 bytes
              body->globalGet(stackPointerGlobalIdx);
              body->i32Const(static_cast<i32>(structRetAllocSize));
              body->aop(WasmType::I32, OP_SUB);
              body->globalSet(stackPointerGlobalIdx);
              // Push the return pointer as the hidden first argument
              body->globalGet(stackPointerGlobalIdx);
            }

            for (u32 i = 0; i < ec->arguments.size(); i++) {
              emitExpr(ec->arguments[i]);
            }
            body->call(it->second);

            if (structRet) {
              // Defer SP restoration: don't restore here to prevent aliasing
              // when multiple struct-returning calls are arguments to the same
              // outer call. The struct address remains on the WASM operand stack.
              structRetDeferred += structRetAllocSize;
            }

            callNesting--;
            if (callNesting == 0 && structRetDeferred > 0) {
              // Outermost call completed: restore all deferred struct return
              // space. The call result sits below us on the WASM operand stack
              // and is undisturbed by these stack pointer operations.
              body->globalGet(stackPointerGlobalIdx);
              body->i32Const(static_cast<i32>(structRetDeferred));
              body->aop(WasmType::I32, OP_ADD);
              body->globalSet(stackPointerGlobalIdx);
              structRetDeferred = 0;
            }
          }
        } else {
          // Indirect call through function pointer
          // Decay for correctness; unclear if an array/function type is
          // reachable here in practice.
          Type calleeType = ec->callee.getType().decay();
          Type funcType = calleeType.isPointer() ? calleeType.getPointee() : calleeType;
          Type callRetType = funcType.getReturnType();
          bool structRet = isStructOrUnion(callRetType);

          if (funcType.isVarArg()) {
            panicf("indirect variadic calls not supported");
          }

          u32 structRetAllocSize = 0;

          callNesting++;

          if (structRet) {
            u32 retSize = sizeOf(callRetType);
            structRetAllocSize = (retSize + 15) & ~15u;
            body->globalGet(stackPointerGlobalIdx);
            body->i32Const(static_cast<i32>(structRetAllocSize));
            body->aop(WasmType::I32, OP_SUB);
            body->globalSet(stackPointerGlobalIdx);
            body->globalGet(stackPointerGlobalIdx);
          }

          for (u32 i = 0; i < ec->arguments.size(); i++) {
            emitExpr(ec->arguments[i]);
          }

          // Table index (callee) must be last on the stack
          emitExpr(ec->callee);

          WasmFunctionTypeId typeId = getWasmFunctionTypeIdForCFunctionType(funcType);
          body->callIndirect(typeId);

          if (structRet) {
            structRetDeferred += structRetAllocSize;
          }

          callNesting--;
          if (callNesting == 0 && structRetDeferred > 0) {
            body->globalGet(stackPointerGlobalIdx);
            body->i32Const(static_cast<i32>(structRetDeferred));
            body->aop(WasmType::I32, OP_ADD);
            body->globalSet(stackPointerGlobalIdx);
            structRetDeferred = 0;
          }
        }
        break;
      }
      case ExprKind::SUBSCRIPT: {
        ESubscript *es = expr.as.subscript;
        Type elemType = es->type;

        // Address arithmetic + load
        u32 elemSize = sizeOf(elemType);
        emitExpr(es->array);
        emitExpr(es->index);
        if (getBinaryWasmType(es->index.getType()) == WasmType::I64) {
          body->aop(WasmType::I32, OP_WRAP_I64);
        }
        if (elemSize != 1) {
          body->i32Const(static_cast<i32>(elemSize));
          body->aop(WasmType::I32, OP_MUL);
        }
        body->aop(WasmType::I32, OP_ADD);
        if (!elemType.isAggregate()) {
          emitLoad(elemType);
        }
        break;
      }
      case ExprKind::MEMBER: {
        EMember *em = expr.as.member;
        emitExpr(em->base);
        DVar *field = em->memberDecl;
        Type baseType = em->base.getType();

        // Struct: address + byte offset + load
        Decl tagDecl = baseType.getTagDecl();
        DTag *tag = tagDecl.as.tag;
        u32 fieldOffset = getFieldOffset(tag, field);
        if (fieldOffset != 0) {
          body->i32Const(static_cast<i32>(fieldOffset));
          body->aop(WasmType::I32, OP_ADD);
        }
        if (field->isBitField()) {
          emitBitFieldLoad(field);
        } else if (!em->type.isArray() && !em->type.isAggregate()) {
          emitLoad(em->type);
        }
        break;
      }
      case ExprKind::ARROW: {
        // p->field - load pointer, add field offset, load (unless array - then decay)
        EArrow *ea = expr.as.arrow;
        emitExpr(ea->base);  // Get pointer value
        DVar *field = ea->memberDecl;
        // Get the tag declaration from the pointed-to type
        Type ptrType = ea->base.getType().decay();
        Type baseType = ptrType.getPointee();
        Decl tagDecl = baseType.getTagDecl();
        DTag *tag = tagDecl.as.tag;
        u32 fieldOffset = getFieldOffset(tag, field);
        if (fieldOffset != 0) {
          body->i32Const(static_cast<i32>(fieldOffset));
          body->aop(WasmType::I32, OP_ADD);
        }
        // Load the value (unless it's an array/struct - leave address on stack)
        if (field->isBitField()) {
          emitBitFieldLoad(field);
        } else if (!ea->type.isArray() && !ea->type.isAggregate()) {
          emitLoad(ea->type);
        }
        break;
      }
      case ExprKind::SIZEOF_EXPR: {
        // sizeof(expr) - compute size at compile time
        ESizeOfExpr *se = expr.as.sizeofExpr;
        Type operandType = se->expr.getType();
        u32 size = sizeOf(operandType);
        body->i32Const(static_cast<i32>(size));
        break;
      }
      case ExprKind::SIZEOF_TYPE: {
        // sizeof(type) - compute size at compile time
        ESizeOfType *st = expr.as.sizeofType;
        u32 size = sizeOf(st->operandType);
        body->i32Const(static_cast<i32>(size));
        break;
      }
      case ExprKind::ALIGNOF_EXPR: {
        EAlignOfExpr *ae = expr.as.alignofExpr;
        u32 align = alignOf(ae->expr.getType());
        body->i32Const(static_cast<i32>(align));
        break;
      }
      case ExprKind::ALIGNOF_TYPE: {
        EAlignOfType *at = expr.as.alignofType;
        u32 align = alignOf(at->operandType);
        body->i32Const(static_cast<i32>(align));
        break;
      }
      case ExprKind::IMPLICIT_CAST: {
        EImplicitCast *eic = expr.as.implicitCast;
        if (ctx == ExprContext::DROP) {
          emitExpr(eic->expr, ExprContext::DROP);
          return;
        }
        emitExpr(eic->expr);
        emitConversion(eic->expr.getType(), eic->type);
        break;
      }
      case ExprKind::CAST: {
        // (type)expr - emit the expression and convert if needed
        ECast *ec = expr.as.cast;
        Type fromType = ec->expr.getType();
        Type toType = ec->targetType;

        // Emit the source expression
        emitExpr(ec->expr);

        // Emit conversion instructions if types differ
        // Note: void is treated as i32 with undefined value, so casting to void
        // is a no-op (the value stays on the stack for the caller to drop)
        emitConversion(fromType, toType);
        break;
      }
      case ExprKind::TERNARY: {
        // cond ? then : else
        // In WASM: evaluate condition, then use if-else block with result type
        ETernary *et = expr.as.ternary;
        WasmType resultType = cToWasmType(et->type);

        // Emit condition (must be i32 for WASM if)
        emitExpr(et->condition);

        // Convert condition to i32
        Type condType = et->condition.getType();
        emitConditionToI32(condType);

        // Emit if-else block with result type
        body->if_(resultType);
        emitExpr(et->thenExpr);
        body->else_();
        emitExpr(et->elseExpr);
        body->end();
        break;
      }
      case ExprKind::INTRINSIC: {
        EIntrinsic *ei = expr.as.intrinsic;
        switch (ei->kind) {
          case IntrinsicKind::VA_START: {
            // args[0] = ap (lvalue)
            // Store hidden va_args pointer into *ap
            emitAddressOf(ei->args[0]);      // address of ap
            body->localGet(vaArgsLocalIdx);  // hidden pointer
            body->mop(I32_STORE, 0, 2);      // *ap = hidden_ptr
            body->i32Const(0);               // push dummy value for void return
            break;
          }
          case IntrinsicKind::VA_ARG: {
            // args[0] = ap (lvalue), argType = type to read
            // Load current value from *ap, then advance ap by vaSlotSize(argType)
            //
            // Stack operations:
            // 1. Read currentPtr from *ap
            // 2. Save currentPtr in temp
            // 3. Update *ap = currentPtr + slotSize
            // 4. Load value from currentPtr (or return ptr for structs)
            // Result: the loaded value (or address for structs)

            u32 slotSize = vaSlotSize(ei->argType);

            // Step 1: Load currentPtr = *ap
            emitAddressOf(ei->args[0]);  // [apAddr]
            body->mop(I32_LOAD, 0, 2);   // [currentPtr]

            // Step 2: Save currentPtr in temp for later use
            pushLocalScope();
            u32 vaArgTemp = allocLocal(WasmType::I32);
            body->localTee(vaArgTemp);  // [currentPtr], temp=currentPtr

            // Step 3: Update *ap = currentPtr + slotSize
            emitAddressOf(ei->args[0]);                          // [currentPtr, apAddr]
            body->localGet(vaArgTemp);                           // [currentPtr, apAddr, currentPtr]
            body->i32Const(static_cast<i32>(slotSize));          // [currentPtr, apAddr, currentPtr, slotSize]
            body->aop(WasmType::I32, OP_ADD);                    // [currentPtr, apAddr, currentPtr+slotSize]
            body->mop(I32_STORE, 0, 2);                          // [currentPtr]  (*apAddr = currentPtr+slotSize)

            // Step 4: Load value from currentPtr (still on stack)
            // For struct/union: leave the pointer as the result (address of struct in arg block)
            // For scalars: load the value from the slot
            emitVaArgLoad(ei->argType);  // [value or address]
            popLocalScope();
            break;
          }
          case IntrinsicKind::VA_END: {
            // No-op in this implementation, but emit arg for side effects
            emitExpr(ei->args[0]);
            body->push(0x1A);  // drop
            body->i32Const(0);
            break;
          }
          case IntrinsicKind::VA_COPY: {
            // args[0] = dest (lvalue), args[1] = src (value)
            // *dest = src (simple pointer copy)
            emitAddressOf(ei->args[0]);
            emitExpr(ei->args[1]);
            body->mop(I32_STORE, 0, 2);
            body->i32Const(0);  // push dummy value for void return
            break;
          }
          case IntrinsicKind::MEMORY_SIZE: {
            // Returns current memory size in pages (64KB each)
            body->memorySize();
            break;
          }
          case IntrinsicKind::MEMORY_GROW: {
            // args[0] = delta (number of pages to grow)
            // Returns previous size or -1 on failure
            emitExpr(ei->args[0]);
            body->memoryGrow();
            break;
          }
          case IntrinsicKind::MEMORY_COPY: {
            // args: dest, src, len
            emitExpr(ei->args[0]);
            emitExpr(ei->args[1]);
            emitExpr(ei->args[2]);
            body->memoryCopy();
            body->i32Const(0);  // void return dummy
            break;
          }
          case IntrinsicKind::MEMORY_FILL: {
            // args: dest, value, len
            emitExpr(ei->args[0]);
            emitExpr(ei->args[1]);
            emitExpr(ei->args[2]);
            body->memoryFill();
            body->i32Const(0);  // void return dummy
            break;
          }
          case IntrinsicKind::HEAP_BASE: {
            body->globalGet(heapBaseGlobalIdx);
            break;
          }
          case IntrinsicKind::ALLOCA: {
            // sp = sp - align16(size); return sp
            body->globalGet(stackPointerGlobalIdx);
            emitExpr(ei->args[0]);
            body->i32Const(15);
            body->aop(WasmType::I32, OP_ADD);
            body->i32Const(-16);
            body->aop(WasmType::I32, OP_AND);  // align to 16
            body->aop(WasmType::I32, OP_SUB);
            body->globalSet(stackPointerGlobalIdx);
            body->globalGet(stackPointerGlobalIdx);
            break;
          }
          case IntrinsicKind::UNREACHABLE: {
            body->unreachable();
            break;
          }
        }
        break;
      }
      case ExprKind::WASM: {
        EWasm *ew = expr.as.wasm;
        for (const Expr &arg : ew->args) {
          emitExpr(arg);
        }
        append(body->bytes, ew->bytes);
        break;
      }
      case ExprKind::COMMA: {
        EComma *ec = expr.as.comma;
        for (size_t i = 0; i < ec->expressions.size(); i++) {
          bool isLast = (i + 1 == ec->expressions.size());
          emitExpr(ec->expressions[i], isLast ? ctx : ExprContext::DROP);
        }
        return;  // ctx already handled
      }
      case ExprKind::INIT_LIST:
        panicf("emitExpr: initializer lists are not supported in expression context");
        break;
      case ExprKind::COMPOUND_LITERAL: {
        ECompoundLiteral *cl = expr.as.compoundLiteral;
        auto fsIt = fileScopeCompoundLiteralAddrs.find(cl);
        if (fsIt != fileScopeCompoundLiteralAddrs.end()) {
          // File-scope compound literal: static storage, just emit the address
          body->i32Const(static_cast<i32>(fsIt->second));
          if (!cl->type.isArray() && !cl->type.isAggregate()) {
            emitLoad(cl->type);
          }
        } else {
          emitCompoundLiteralInit(cl);
          u32 offset = compoundLiteralOffsets[cl];
          emitFrameAddr(offset);
          // For non-aggregate, non-array types, load the value
          if (!cl->type.isArray() && !cl->type.isAggregate()) {
            emitLoad(cl->type);
          }
        }
        break;
      }
      default:
        panicf(
            "emitExpr: unhandled expression kind %s", std::string(strExprKind(expr.kind)).c_str());
    }
    if (ctx == ExprContext::DROP) body->push(0x1A);  // drop
  }

  void emitLoad(Type type) {
    type = type.removeQualifiers();
    if (type == TCHAR || type == TSCHAR) {
      body->mop(I32_LOAD8_S, 0, 0);
    } else if (type == TUCHAR || type == TBOOL) {
      body->mop(I32_LOAD8_U, 0, 0);
    } else if (type == TSHORT) {
      body->mop(I32_LOAD16_S, 0, 1);
    } else if (type == TUSHORT) {
      body->mop(I32_LOAD16_U, 0, 1);
    } else if (type == TINT || type == TUINT || type == TLONG || type == TULONG ||
        type.isPointer()) {
      body->mop(I32_LOAD, 0, 2);
    } else if (type == TLLONG || type == TULLONG) {
      body->mop(I64_LOAD, 0, 3);
    } else if (type == TFLOAT) {
      body->mop(F32_LOAD, 0, 2);
    } else if (type == TDOUBLE || type == TLDOUBLE) {
      body->mop(F64_LOAD, 0, 3);
    } else {
      panicf("emitLoad: unsupported type: %s", type.toString().c_str());
    }
  }

  void emitStore(Type type) {
    type = type.removeQualifiers();
    if (type == TCHAR || type == TSCHAR || type == TUCHAR || type == TBOOL) {
      body->mop(I32_STORE8, 0, 0);
    } else if (type == TSHORT || type == TUSHORT) {
      body->mop(I32_STORE16, 0, 1);
    } else if (type == TINT || type == TUINT || type == TLONG || type == TULONG ||
        type.isPointer()) {
      body->mop(I32_STORE, 0, 2);
    } else if (type == TLLONG || type == TULLONG) {
      body->mop(I64_STORE, 0, 3);
    } else if (type == TFLOAT) {
      body->mop(F32_STORE, 0, 2);
    } else if (type == TDOUBLE || type == TLDOUBLE) {
      body->mop(F64_STORE, 0, 3);
    } else {
      panicf("emitStore: unsupported type: %s", type.toString().c_str());
    }
  }

  // Emit a bit-field load: stack has [addr_of_storage_unit] -> [extracted_value]
  void emitBitFieldLoad(DVar *field) {
    i32 bw = field->bitWidth;
    i32 bo = field->bitOffset;
    // Load the full storage unit (always i32 for int/unsigned/short/char bit-fields on wasm32)
    emitLoad(field->type);
    // Shift right to position the field at bit 0
    if (bo != 0) {
      body->i32Const(bo);
      body->aop(WasmType::I32, OP_SHR_U);
    }
    // Mask to bitWidth bits
    if (bw < 32) {
      body->i32Const((1 << bw) - 1);
      body->aop(WasmType::I32, OP_AND);
    }
    // Sign-extend if signed type
    if (!isUnsignedType(field->type) && bw < 32) {
      // Sign extend: shift left then arithmetic shift right
      i32 shift = 32 - bw;
      body->i32Const(shift);
      body->aop(WasmType::I32, OP_SHL);
      body->i32Const(shift);
      body->aop(WasmType::I32, OP_SHR_S);
    }
  }

  // Emit a bit-field store: stack has [addr, value] -> []
  // After this, the value is stored. Does NOT leave anything on the stack.
  void emitBitFieldStore(DVar *field) {
    // Stack: [addr, newValue]
    i32 bw = field->bitWidth;
    i32 bo = field->bitOffset;

    // Full-width bit-field: just a plain store, no masking needed
    if (bw >= 32) {
      emitStore(field->type);
      return;
    }

    i32 mask = ((1 << bw) - 1) << bo;

    pushLocalScope();
    u32 valLocal = allocLocal(WasmType::I32);
    u32 addrLocal = allocLocal(WasmType::I32);

    body->localSet(valLocal);   // save newValue, stack = [addr]
    body->localSet(addrLocal);  // save addr, stack = []

    // Read current storage unit: (old & ~mask) | ((new & widthMask) << bitOffset)
    body->localGet(addrLocal);
    emitLoad(field->type);  // [oldUnit]
    body->i32Const(~mask);
    body->aop(WasmType::I32, OP_AND);  // [oldUnit & ~mask]

    body->localGet(valLocal);
    body->i32Const((1 << bw) - 1);
    body->aop(WasmType::I32, OP_AND);
    if (bo != 0) {
      body->i32Const(bo);
      body->aop(WasmType::I32, OP_SHL);
    }
    body->aop(WasmType::I32, OP_OR);  // [newUnit]

    // Store: need [addr, newUnit]
    body->localSet(valLocal);   // save newUnit, stack = []
    body->localGet(addrLocal);  // [addr]
    body->localGet(valLocal);   // [addr, newUnit]
    emitStore(field->type);
    popLocalScope();
  }

  // Store a value into a va_arg slot. Stack: [dest_addr, value] -> [].
  // For struct/union, the caller handles memcpy separately (not this function).
  // Each scalar slot is 8 bytes; smaller types are stored at offset 0 with padding.
  void emitVaArgStore(Type type) {
    WasmType wt = cToWasmType(type);
    if (wt == WasmType::I32) {
      body->mop(I32_STORE, 0, 2);
    } else if (wt == WasmType::I64) {
      body->mop(I64_STORE, 0, 3);
    } else if (wt == WasmType::F32) {
      body->mop(F32_STORE, 0, 2);
    } else if (wt == WasmType::F64) {
      body->mop(F64_STORE, 0, 3);
    }
  }

  // Load a value from a va_arg slot. Stack: [src_addr] -> [value].
  // For struct/union: no-op (leaves the address on stack as the result).
  void emitVaArgLoad(Type type) {
    type = type.removeQualifiers();
    if (isStructOrUnion(type)) {
      // Struct/union: the address IS the value (pointer to struct data in arg block)
      return;
    }
    WasmType wt = cToWasmType(type);
    if (type == TCHAR || type == TSCHAR) {
      body->mop(I32_LOAD8_S, 0, 0);
    } else if (type == TUCHAR || type == TBOOL) {
      body->mop(I32_LOAD8_U, 0, 0);
    } else if (type == TSHORT) {
      body->mop(I32_LOAD16_S, 0, 1);
    } else if (type == TUSHORT) {
      body->mop(I32_LOAD16_U, 0, 1);
    } else if (wt == WasmType::I32) {
      body->mop(I32_LOAD, 0, 2);
    } else if (wt == WasmType::I64) {
      body->mop(I64_LOAD, 0, 3);
    } else if (wt == WasmType::F32) {
      body->mop(F32_LOAD, 0, 2);
    } else if (wt == WasmType::F64) {
      body->mop(F64_LOAD, 0, 3);
    }
  }

  // Emit WASM instructions to convert a value from one C type to another
  // Convert a condition value to i32 (for if/while/for/do-while).
  // Most conditions are already i32 (comparisons, int vars), but float/double/i64
  // values used directly as conditions need explicit conversion.
  void emitConditionToI32(Type condType) {
    WasmType wt = getBinaryWasmType(condType);
    if (wt == WasmType::F32) {
      body->f32Const(0.0f);
      body->aop(WasmType::F32, OP_NE);
    } else if (wt == WasmType::F64) {
      body->f64Const(0.0);
      body->aop(WasmType::F64, OP_NE);
    } else if (wt == WasmType::I64) {
      body->i64Const(0);
      body->aop(WasmType::I64, OP_NE);
    }
    // i32 is already the right type, nothing to do
  }

  // Normalize any value to i32 0 or 1 (for && and || which must produce 0/1).
  // Unlike emitConditionToI32, this also normalizes i32 values.
  void emitBoolNormalize(Type type) {
    WasmType wt = getBinaryWasmType(type);
    if (wt == WasmType::F32) {
      body->f32Const(0.0f);
      body->aop(WasmType::F32, OP_NE);
    } else if (wt == WasmType::F64) {
      body->f64Const(0.0);
      body->aop(WasmType::F64, OP_NE);
    } else if (wt == WasmType::I64) {
      body->i64Const(0);
      body->aop(WasmType::I64, OP_NE);
    } else {
      body->i32Const(0);
      body->aop(WasmType::I32, OP_NE);
    }
  }

  // Emit narrowing for sub-i32 types (char, short).
  // WASM locals are always i32, so we must explicitly truncate after
  // any operation that may leave high bits set.
  void emitSubIntNarrowing(Type toType) {
    toType = toType.removeQualifiers();
    if (toType == TCHAR || toType == TSCHAR) {
      body->i32Const(24);
      body->aop(WasmType::I32, OP_SHL);
      body->i32Const(24);
      body->aop(WasmType::I32, OP_SHR_S);
    } else if (toType == TUCHAR) {
      body->i32Const(0xFF);
      body->aop(WasmType::I32, OP_AND);
    } else if (toType == TSHORT) {
      body->i32Const(16);
      body->aop(WasmType::I32, OP_SHL);
      body->i32Const(16);
      body->aop(WasmType::I32, OP_SHR_S);
    } else if (toType == TUSHORT) {
      body->i32Const(0xFFFF);
      body->aop(WasmType::I32, OP_AND);
    }
  }

  void emitConversion(Type fromType, Type toType) {
    // Get the WASM types for source and destination
    WasmType fromWasm = getBinaryWasmType(fromType);
    WasmType toWasm = getBinaryWasmType(toType);

    // Bool conversion: compare != 0 directly in the source type.
    // All WASM comparisons produce i32, so this handles every source type.
    if (toType.removeQualifiers() == TBOOL) {
      if (fromWasm == WasmType::I32) {
        body->i32Const(0);
        body->aop(WasmType::I32, OP_NE);
      } else if (fromWasm == WasmType::I64) {
        body->i64Const(0);
        body->aop(WasmType::I64, OP_NE);
      } else if (fromWasm == WasmType::F32) {
        body->f32Const(0.0f);
        body->aop(WasmType::F32, OP_NE);
      } else if (fromWasm == WasmType::F64) {
        body->f64Const(0.0);
        body->aop(WasmType::F64, OP_NE);
      }
      return;
    }

    // If WASM types are the same, we might still need narrowing (handled by store/load)
    // but at the WASM level, no conversion is needed
    if (fromWasm == toWasm) {
      if (fromWasm == WasmType::I32) emitSubIntNarrowing(toType);
      return;
    }

    bool fromSigned = !isUnsignedType(fromType);
    bool toSigned = !isUnsignedType(toType);

    // Handle all the cross-type conversions
    if (fromWasm == WasmType::I32 && toWasm == WasmType::I64) {
      // i32 -> i64: extend
      body->aop(WasmType::I64, OP_EXTEND_I32, fromSigned);
    } else if (fromWasm == WasmType::I64 && toWasm == WasmType::I32) {
      // i64 -> i32: wrap, then narrow for sub-int targets
      body->aop(WasmType::I32, OP_WRAP_I64);
      emitSubIntNarrowing(toType);
    } else if (fromWasm == WasmType::I32 && toWasm == WasmType::F32) {
      // i32 -> f32: convert
      body->aop(WasmType::F32, OP_CONVERT_I32, fromSigned);
    } else if (fromWasm == WasmType::I32 && toWasm == WasmType::F64) {
      // i32 -> f64: convert
      body->aop(WasmType::F64, OP_CONVERT_I32, fromSigned);
    } else if (fromWasm == WasmType::I64 && toWasm == WasmType::F32) {
      // i64 -> f32: convert
      body->aop(WasmType::F32, OP_CONVERT_I64, fromSigned);
    } else if (fromWasm == WasmType::I64 && toWasm == WasmType::F64) {
      // i64 -> f64: convert
      body->aop(WasmType::F64, OP_CONVERT_I64, fromSigned);
    } else if (fromWasm == WasmType::F32 && toWasm == WasmType::I32) {
      // f32 -> i32: truncate, then narrow for sub-int targets
      body->aop(WasmType::I32, OP_TRUNC_F32, toSigned);
      emitSubIntNarrowing(toType);
    } else if (fromWasm == WasmType::F32 && toWasm == WasmType::I64) {
      // f32 -> i64: truncate
      body->aop(WasmType::I64, OP_TRUNC_F32, toSigned);
    } else if (fromWasm == WasmType::F64 && toWasm == WasmType::I32) {
      // f64 -> i32: truncate, then narrow for sub-int targets
      body->aop(WasmType::I32, OP_TRUNC_F64, toSigned);
      emitSubIntNarrowing(toType);
    } else if (fromWasm == WasmType::F64 && toWasm == WasmType::I64) {
      // f64 -> i64: truncate
      body->aop(WasmType::I64, OP_TRUNC_F64, toSigned);
    } else if (fromWasm == WasmType::F32 && toWasm == WasmType::F64) {
      // f32 -> f64: promote
      body->aop(WasmType::F64, OP_PROMOTE_F32);
    } else if (fromWasm == WasmType::F64 && toWasm == WasmType::F32) {
      // f64 -> f32: demote
      body->aop(WasmType::F32, OP_DEMOTE_F64);
    }
    // Pointer casts are no-ops at the WASM level (all pointers are i32)
  }

  void emitAddressOf(Expr expr) {
    if (expr.kind == ExprKind::IDENT) {
      EIdent *eident = expr.as.ident;
      if (eident->decl.kind == DeclKind::FUNC) {
        // &func → function pointer (table index)
        DFunc *func = eident->decl.as.func;
        if (func->definition) func = func->definition;
        auto it = funcDefToTableIdx.find(func);
        if (it == funcDefToTableIdx.end()) {
          panicf(
              "emitAddressOf: function '%s' not found in funcDefToTableIdx", func->name->c_str());
        }
        body->i32Const(static_cast<i32>(it->second));
        return;
      } else if (eident->decl.kind == DeclKind::VAR) {
        DVar *varDecl = eident->decl.as.var->definition;
        if (!varDecl) varDecl = eident->decl.as.var;

        // Check for global MEMORY var (array/struct or address-taken scalar)
        auto gait = globalArrayAddrs.find(varDecl);
        if (gait != globalArrayAddrs.end()) {
          body->i32Const(static_cast<i32>(gait->second));
          return;
        }

        // Check for local MEMORY var (array/struct or address-taken scalar)
        auto lait = localArrayOffsets.find(varDecl);
        if (lait != localArrayOffsets.end()) {
          emitFrameAddr(lait->second);
          return;
        }

        // Check for MEMORY parameter (address-taken)
        auto pait = paramMemoryOffsets.find(varDecl);
        if (pait != paramMemoryOffsets.end()) {
          emitFrameAddr(pait->second);
          return;
        }

        panicf(
            "Cannot take address of REGISTER variable '%s'. "
            "This variable was not marked as needing memory allocation.",
            varDecl->name->c_str());
      }
    } else if (expr.kind == ExprKind::MEMBER) {
      // &(s.field) - get address of struct + field offset
      EMember *em = expr.as.member;
      emitAddressOf(em->base);
      Type baseType = em->base.getType();
      Decl tagDecl = baseType.getTagDecl();
      DTag *tag = tagDecl.as.tag;
      u32 fieldOffset = getFieldOffset(tag, em->memberDecl);
      if (fieldOffset != 0) {
        body->i32Const(static_cast<i32>(fieldOffset));
        body->aop(WasmType::I32, OP_ADD);
      }
      return;
    } else if (expr.kind == ExprKind::ARROW) {
      // &(p->field) - load pointer + field offset
      EArrow *ea = expr.as.arrow;
      emitExpr(ea->base);
      Type ptrType = ea->base.getType().decay();
      Type baseType = ptrType.getPointee();
      Decl tagDecl = baseType.getTagDecl();
      DTag *tag = tagDecl.as.tag;
      u32 fieldOffset = getFieldOffset(tag, ea->memberDecl);
      if (fieldOffset != 0) {
        body->i32Const(static_cast<i32>(fieldOffset));
        body->aop(WasmType::I32, OP_ADD);
      }
      return;
    } else if (expr.kind == ExprKind::SUBSCRIPT) {
      // &(arr[i]) - base + index * size
      ESubscript *es = expr.as.subscript;
      u32 elemSize = sizeOf(es->type);
      emitExpr(es->array);
      emitExpr(es->index);
      if (elemSize != 1) {
        body->i32Const(static_cast<i32>(elemSize));
        body->aop(WasmType::I32, OP_MUL);
      }
      body->aop(WasmType::I32, OP_ADD);
      return;
    } else if (expr.kind == ExprKind::UNARY) {
      EUnary *eu = expr.as.unary;
      if (eu->op == Uop::OP_DEREF) {
        // &(*p) is just p
        emitExpr(eu->operand);
        return;
      }
    } else if (expr.kind == ExprKind::COMPOUND_LITERAL) {
      ECompoundLiteral *cl = expr.as.compoundLiteral;
      auto fsIt = fileScopeCompoundLiteralAddrs.find(cl);
      if (fsIt != fileScopeCompoundLiteralAddrs.end()) {
        body->i32Const(static_cast<i32>(fsIt->second));
      } else {
        emitCompoundLiteralInit(cl);
        emitFrameAddr(compoundLiteralOffsets[cl]);
      }
      return;
    }
    panicf("emitAddressOf: unsupported expression kind %s",
        std::string(strExprKind(expr.kind)).c_str());
  }

  // Emit the WASM binary op corresponding to a compound assignment operator.
  void emitCompoundOp(WasmType wt, Bop op, bool isUnsigned) {
    switch (op) {
      case Bop::ADD_ASSIGN: body->aop(wt, OP_ADD); break;
      case Bop::SUB_ASSIGN: body->aop(wt, OP_SUB); break;
      case Bop::MUL_ASSIGN: body->aop(wt, OP_MUL); break;
      case Bop::DIV_ASSIGN: body->aop(wt, OP_DIV, !isUnsigned); break;
      case Bop::MOD_ASSIGN: body->aop(wt, OP_REM, !isUnsigned); break;
      case Bop::BAND_ASSIGN: body->aop(wt, OP_AND); break;
      case Bop::BOR_ASSIGN: body->aop(wt, OP_OR); break;
      case Bop::BXOR_ASSIGN: body->aop(wt, OP_XOR); break;
      case Bop::SHL_ASSIGN: body->aop(wt, OP_SHL); break;
      case Bop::SHR_ASSIGN: body->aop(wt, isUnsigned ? OP_SHR_U : OP_SHR_S); break;
      default: panicf("emitCompoundOp: unexpected operator");
    }
  }

  void emitAssignment(EBinary *eb, ExprContext ctx = ExprContext::VALUE) {
    Expr lhs = eb->left;
    Expr rhs = eb->right;
    Bop op = eb->op;
    Type lhsType = lhs.getType();
    bool wantValue = (ctx == ExprContext::VALUE);

    pushLocalScope();
    LValue lv = emitLValue(lhs);

    if (op == Bop::ASSIGN) {
      // --- Simple assignment ---
      if (lv.kind != LValue::REGISTER && isStructOrUnion(lhsType)) {
        // Aggregate (struct/union) assignment: memory.copy
        lvaluePush(lv);         // dest address
        emitExpr(rhs);          // src address
        body->i32Const(static_cast<i32>(sizeOf(lhsType)));
        body->memoryCopy();
        if (wantValue) lvaluePush(lv);  // return dest address
      } else {
        // Stack: [] → push addr, evaluate rhs → [addr-parts, value]
        lvaluePush(lv);
        emitExpr(rhs);
        emitConversion(rhs.getType(), lhsType);
        if (wantValue && !lv.bitField) {
          // Tee: save value, store, push value back
          u32 vt = allocLocal(cToWasmType(lhsType));
          body->localTee(vt);
          lvalueStore(lv);
          body->localGet(vt);
        } else {
          lvalueStore(lv);
          // Bitfield VALUE: re-read (stored value may differ due to truncation)
          if (wantValue) lvaluePushAndLoad(lv);
        }
      }
    } else {
      // --- Compound assignment ---
      Type rhsType = rhs.getType();
      Type opType = getCompoundOpType(lhsType, rhsType);
      WasmType opWt = getBinaryWasmType(opType);
      bool isUnsigned = isUnsignedType(opType);

      // Stack: push addr (for store), push addr (for load), load
      lvaluePush(lv);
      lvaluePushAndLoad(lv);
      emitConversion(lhsType, opType);
      // Emit RHS
      emitExpr(rhs);
      emitConversion(rhsType, opType);
      // Pointer arithmetic scaling
      if (lhsType.isPointer() && (op == Bop::ADD_ASSIGN || op == Bop::SUB_ASSIGN)) {
        u32 elemSize = sizeOf(lhsType.getPointee());
        if (elemSize != 1) {
          body->i32Const(static_cast<i32>(elemSize));
          body->aop(WasmType::I32, OP_MUL);
        }
      }
      emitCompoundOp(opWt, op, isUnsigned);
      // Convert back to lhs type
      if (opType != lhsType) emitConversion(opType, lhsType);
      // For REGISTER narrow integers, truncate
      if (lv.kind == LValue::REGISTER && lhsType.isInteger() &&
          lhsType.getSize() < TINT.getSize()) {
        emitConversion(TINT, lhsType);
      }
      // Stack: [addr-parts, result] — store
      if (wantValue && !lv.bitField) {
        u32 vt = allocLocal(getBinaryWasmType(lhsType));
        body->localTee(vt);
        lvalueStore(lv);
        body->localGet(vt);
      } else {
        lvalueStore(lv);
        if (wantValue) lvaluePushAndLoad(lv);
      }
    }
    popLocalScope();
  }

  void emitIncDec(EUnary *eu, ExprContext ctx = ExprContext::VALUE) {
    Expr operand = eu->operand;
    bool isIncrement = (eu->op == Uop::OP_PRE_INC || eu->op == Uop::OP_POST_INC);
    bool isPre = (eu->op == Uop::OP_PRE_INC || eu->op == Uop::OP_PRE_DEC);
    bool wantValue = (ctx == ExprContext::VALUE);
    Type type = operand.getType();

    pushLocalScope();
    LValue lv = emitLValue(operand);

    // Determine WasmType for the delta
    WasmType wt = getBinaryWasmType(type);

    // Emit the delta constant
    auto emitDelta = [&]() {
      if (type.isPointer()) {
        i32 delta = static_cast<i32>(sizeOf(type.getPointee()));
        if (wt == WasmType::I32) body->i32Const(delta);
        else body->i64Const(delta);
      } else if (wt == WasmType::F32) {
        body->f32Const(1.0f);
      } else if (wt == WasmType::F64) {
        body->f64Const(1.0);
      } else if (wt == WasmType::I64) {
        body->i64Const(1);
      } else {
        body->i32Const(1);
      }
    };

    // Narrowing check for REGISTER narrow integers
    bool needsNarrowing = (lv.kind == LValue::REGISTER) && wt == WasmType::I32 &&
        type.isInteger() && type.getSize() < TINT.getSize() && !type.isPointer();

    if (isPre) {
      // ++x: push addr (for store), push addr + load, delta, add/sub, [narrow], store
      lvaluePush(lv);
      lvaluePushAndLoad(lv);
      emitDelta();
      body->aop(wt, isIncrement ? OP_ADD : OP_SUB);
      if (needsNarrowing) emitConversion(TINT, type);
      // Stack: [addr-parts, newVal]
      if (wantValue && !lv.bitField) {
        u32 vt = allocLocal(wt);
        body->localTee(vt);
        lvalueStore(lv);
        body->localGet(vt);
      } else {
        lvalueStore(lv);
        if (wantValue) lvaluePushAndLoad(lv);
      }
    } else {
      // x++: push addr (for store), push addr + load, [save old], delta, add/sub, [narrow], store
      lvaluePush(lv);
      lvaluePushAndLoad(lv);
      u32 oldTemp = 0;
      if (wantValue) {
        oldTemp = allocLocal(wt);
        body->localTee(oldTemp);
      }
      emitDelta();
      body->aop(wt, isIncrement ? OP_ADD : OP_SUB);
      if (needsNarrowing) emitConversion(TINT, type);
      // Stack: [addr, newVal]
      lvalueStore(lv);
      if (wantValue) body->localGet(oldTemp);
    }
    popLocalScope();
  }
};

CodeGeneraionResult generateCode(
    const std::vector<TUnit> &units, u32 stackPagesOverride = 0, bool dumpFunctions = false) {
  CodeGeneraionResult result;

  CodeGenerator cg;
  if (stackPagesOverride > 0) cg.stackPages = stackPagesOverride;

  // Apply __minstack directives: take max across all TUs, round up to pages
  {
    u32 maxMinStack = 0;
    for (auto &unit : units) maxMinStack = std::max(maxMinStack, unit.minStackBytes);
    if (maxMinStack > 0) {
      u32 minPages = (maxMinStack + 65535) / 65536;
      cg.stackPages = std::max(cg.stackPages, minPages);
    }
  }

  // Memory layout:
  //   Pages 0 to stackPages-1: Stack (grows down from stackPages*64KB toward 0)
  //   stackPages*64KB onwards: Static data, then heap
  // We'll add the data segment after code generation when we know the total size.

  // Create stack pointer global (initialized to top of stack region)
  // Stack grows downward from stackPages * 64KB toward 0
  u32 initialSp = cg.stackPages * 65536;
  cg.stackPointerGlobalIdx = addWasmGlobal(static_cast<i32>(initialSp), true);  // mutable

  // Create heap base global with placeholder value (patched after static data is finalized)
  cg.heapBaseGlobalIdx = addWasmGlobal(static_cast<i32>(0), false);  // immutable

  // Register __imports (must happen before global var init so funcDefToTableIdx is populated)
  for (const auto &unit : units) {
    for (DFunc *func : unit.importedFunctions) {
      DFunc *fdef = func->definition;
      WasmFunctionTypeId funcTypeId = getWasmFunctionTypeIdForCFunctionType(fdef->type);
      u32 funcIdx = addWasmFunctionImport("c.mtots.com", *fdef->name, funcTypeId);
      cg.funcDefToWasmFuncIdx[fdef] = funcIdx;
      cg.funcDefToTableIdx[fdef] = funcIdx + 1;  // table index 0 is reserved (null)
    }
  }

  // Register function definitions
  for (const auto &unit : units) {
    for (DFunc *func : concat<DFunc *>(unit.definedFunctions, unit.staticFunctions)) {
      DFunc *fdef = func->definition;
      if (fdef != func) continue;  // non-canonical (e.g. duplicate inline)
      WasmFunctionTypeId funcTypeId = getWasmFunctionTypeIdForCFunctionType(fdef->type);
      u32 funcIdx = addWasmFunctionDefinition(funcTypeId);
      cg.funcDefToWasmFuncIdx[fdef] = funcIdx;
      cg.funcDefToTableIdx[fdef] = funcIdx + 1;  // table index 0 is reserved (null)

      // Export 'main' function
      if (fdef->name == intern("main")) {
        addWasmExport("main", WasmExternKind::FUNC, funcIdx);
      }
      if (fdef->name == intern("alloca")) {
        addWasmExport("alloca", WasmExternKind::FUNC, funcIdx);
      }
    }
  }

  // Dump function index map if requested
  if (dumpFunctions) {
    for (const auto &[fdef, funcIdx] : cg.funcDefToWasmFuncIdx) {
      std::cerr << "func[" << funcIdx << "] = " << *fdef->name << "\n";
    }
  }

  // Register exception tags (WASM tag section)
  for (const auto &unit : units) {
    for (ExceptionTag *tag : unit.exceptionTags) {
      if (cg.exceptionToWasmTagIdx.count(tag)) continue;  // already registered
      // Create function type (paramTypes...) -> ()
      WasmFunctionType funcType;
      for (const Type &pt : tag->paramTypes) {
        funcType.params.push_back(cToWasmType(pt));
      }
      // results is empty (void)
      WasmFunctionTypeId typeId = addWasmFunctionTypeId(funcType);
      u32 tagIdx = addWasmTag(typeId);
      cg.exceptionToWasmTagIdx[tag] = tagIdx;
    }
  }

  // Process __export directives
  for (const auto &unit : units) {
    for (const auto &[exportName, func] : unit.exportDirectives) {
      DFunc *fdef = func->definition;
      if (!fdef) panicf("__export: function '%s' has no definition", (*func->name).c_str());
      auto it = cg.funcDefToWasmFuncIdx.find(fdef);
      if (it == cg.funcDefToWasmFuncIdx.end())
        panicf("__export: function '%s' has no WASM index", (*func->name).c_str());
      addWasmExport(*exportName, WasmExternKind::FUNC, it->second);
    }
  }

  // Collect #pragma custom_section directives
  for (const auto &unit : units) {
    for (const auto &[name, content] : unit.customSections) {
      wasmCustomSections.push_back({name, content});
    }
  }

  // Allocate all MEMORY addresses (globals + static locals) before any initializer evaluation,
  // so cross-TU &var in static initializers resolves correctly regardless of TU order.
  for (const auto &unit : units) {
    for (DVar *var :
        concat<DVar *>(unit.definedVariables, unit.externVariables, unit.localExternVariables)) {
      if (var->storageClass == StorageClass::EXTERN && var->definition != var) continue;
      DVar *varDef = var->definition ? var->definition : var;
      if (varDef->allocClass == AllocClass::MEMORY && !cg.globalArrayAddrs.count(varDef)) {
        u32 size = varDef->initExpr ? cg.computeInitAllocSize(varDef->type, varDef->initExpr)
                                    : cg.sizeOf(varDef->type);
        u32 align = cg.alignOf(varDef->type);
        if (varDef->requestedAlignment > 0 && static_cast<u32>(varDef->requestedAlignment) > align)
          align = static_cast<u32>(varDef->requestedAlignment);
        u32 addr = cg.allocateStatic(size, align);
        cg.globalArrayAddrs[varDef] = addr;
      }
    }
    for (DFunc *func : concat<DFunc *>(unit.definedFunctions, unit.staticFunctions)) {
      DFunc *fdef = func->definition;
      if (!fdef) continue;
      for (DVar *varDef : fdef->staticLocals) {
        if (varDef->allocClass == AllocClass::MEMORY && !cg.globalArrayAddrs.count(varDef)) {
          u32 size = cg.sizeOf(varDef->type);
          u32 align = cg.alignOf(varDef->type);
          if (varDef->requestedAlignment > 0 && static_cast<u32>(varDef->requestedAlignment) > align)
            align = static_cast<u32>(varDef->requestedAlignment);
          u32 addr = cg.allocateStatic(size, align);
          cg.globalArrayAddrs[varDef] = addr;
        }
      }
    }

    // Allocate static storage for file-scope compound literals
    for (ECompoundLiteral *cl : unit.fileScopeCompoundLiterals) {
      u32 size = cg.sizeOf(cl->type);
      u32 align = cg.alignOf(cl->type);
      u32 addr = cg.allocateStatic(size, align);
      cg.fileScopeCompoundLiteralAddrs[cl] = addr;
    }
  }

  // Helper to create a ConstEval with compound literal address resolution
  auto makeCgConstEval = [&cg]() {
    ConstEval eval([&cg](Type t) { return cg.sizeOf(t); },
        [&cg](DVar *v) -> std::optional<u32> {
          auto it = cg.globalArrayAddrs.find(v);
          if (it != cg.globalArrayAddrs.end()) return it->second;
          return std::nullopt;
        },
        [&cg](DFunc *f) -> std::optional<u32> {
          auto it = cg.funcDefToTableIdx.find(f);
          if (it != cg.funcDefToTableIdx.end()) return it->second;
          return std::nullopt;
        },
        [&cg](const Buffer &s) { return cg.getStringAddress(s); });
    eval.getCompoundLiteralAddress = [&cg](ECompoundLiteral *cl) -> std::optional<u32> {
      auto it = cg.fileScopeCompoundLiteralAddrs.find(cl);
      if (it != cg.fileScopeCompoundLiteralAddrs.end()) return it->second;
      return std::nullopt;
    };
    return eval;
  };

  // Initialize file-scope compound literals in static data
  for (const auto &unit : units) {
    for (ECompoundLiteral *cl : unit.fileScopeCompoundLiterals) {
      u32 addr = cg.fileScopeCompoundLiteralAddrs[cl];
      u32 baseOffset = addr - (cg.stackPages * 65536);
      if (cl->type.isArray() && cl->initList->elements.size() == 1 &&
          cl->initList->elements[0].kind == ExprKind::STRING) {
        // String literal initializing a char array: copy string bytes directly
        cg.writeStringLiteralToStatic(cl->initList->elements[0].as.stringLit, cl->type, baseOffset);
      } else if (cl->type.isAggregate() || cl->type.isArray()) {
        ConstEval eval = makeCgConstEval();
        cg.populateInitListStatic(cl->initList, cl->type, baseOffset, eval);
      } else {
        // Scalar compound literal
        ConstEval eval = makeCgConstEval();
        Expr initExpr = cl->initList->elements.empty()
            ? Expr(new EInt{cl->loc, cl->type, 0})
            : cl->initList->elements[0];
        auto constVal = eval.evaluate(initExpr);
        if (constVal && constVal->isValid()) {
          cg.writeConstValueToStatic(baseOffset, cl->type, *constVal);
        }
      }
    }
  }

  // Register global variables: evaluate initializers and handle REGISTER vars
  for (const auto &unit : units) {
    for (DVar *var :
        concat<DVar *>(unit.definedVariables, unit.externVariables, unit.localExternVariables)) {
      // Skip extern declarations without definitions
      if (var->storageClass == StorageClass::EXTERN && var->definition != var) continue;
      DVar *varDef = var->definition ? var->definition : var;

      // MEMORY vars go in static memory, REGISTER vars use WASM globals
      if (varDef->allocClass == AllocClass::MEMORY) {
        u32 addr = cg.globalArrayAddrs[varDef];

        // Handle initializers for MEMORY vars
        if (varDef->initExpr && varDef->initExpr.kind == ExprKind::INIT_LIST) {
          EInitList *initList = varDef->initExpr.as.initList;
          u32 baseOffset = addr - (cg.stackPages * 65536);

          ConstEval eval = makeCgConstEval();

          cg.populateInitListStatic(initList, varDef->type, baseOffset, eval);
        } else if (varDef->initExpr && varDef->initExpr.kind == ExprKind::COMPOUND_LITERAL &&
            (varDef->type.isAggregate() || varDef->type.isArray())) {
          // Compound literal initializer for aggregate/array (e.g. struct S s = (struct S){1, 2})
          ECompoundLiteral *cl = varDef->initExpr.as.compoundLiteral;
          u32 baseOffset = addr - (cg.stackPages * 65536);
          ConstEval eval = makeCgConstEval();
          cg.populateInitListStatic(cl->initList, varDef->type, baseOffset, eval);
        } else if (varDef->initExpr && varDef->type.isArray() &&
            varDef->initExpr.kind == ExprKind::STRING) {
          // String literal initializer for global char array
          // e.g. char greeting[] = "hello";
          const Buffer &str = varDef->initExpr.as.stringLit->value;
          u32 baseOffset = addr - (cg.stackPages * 65536);
          u32 copySize = cg.sizeOf(varDef->type);
          u32 len = std::min(copySize, toU32(str.size()));
          for (u32 i = 0; i < len; i++) {
            cg.staticData[baseOffset + i] = str[i];
          }
        } else if (varDef->initExpr && !varDef->type.isAggregate()) {
          // Scalar MEMORY var with scalar initializer (e.g., address-taken int with initial value)
          u32 baseOffset = addr - (cg.stackPages * 65536);
          ConstEval eval = makeCgConstEval();
          auto constVal = eval.evaluate(varDef->initExpr);
          if (constVal && constVal->isValid()) {
            cg.writeConstValueToStatic(baseOffset, varDef->type, *constVal);
          } else {
            SrcLoc loc = varDef->initExpr.getLoc();
            fprintf(stderr, "%s:%u: warning: could not evaluate static initializer for '%s'; "
                    "defaulting to zero\n", loc.filename ? loc.filename->c_str() : "<unknown>",
                    loc.line, varDef->name ? varDef->name->c_str() : "<anonymous>");
          }
        }
      } else {
        WasmType wt = cToWasmType(varDef->type);

        // Determine initial value (zero or constant from initializer)
        WasmValue initVal;
        if (varDef->initExpr && varDef->initExpr.kind == ExprKind::INT) {
          i64 val = truncateConstInt(
              static_cast<i64>(varDef->initExpr.as.intLit->value), varDef->type);
          if (wt == WasmType::F32) {
            initVal = static_cast<float>(val);
          } else if (wt == WasmType::F64) {
            initVal = static_cast<double>(val);
          } else if (wt == WasmType::I64) {
            initVal = val;
          } else {
            initVal = static_cast<i32>(val);
          }
        } else if (varDef->initExpr && varDef->initExpr.kind == ExprKind::FLOAT) {
          double val = varDef->initExpr.as.floatLit->value;
          if (wt == WasmType::F32) {
            initVal = static_cast<float>(val);
          } else {
            initVal = val;
          }
        } else if (varDef->initExpr && varDef->initExpr.kind == ExprKind::STRING) {
          // String literal initializer for pointer type (e.g., char *s = "hello")
          Buffer str = varDef->initExpr.as.stringLit->value;
          u32 addr = cg.getStringAddress(str);
          initVal = static_cast<i32>(addr);
        } else if (varDef->initExpr) {
          // Try to evaluate as a constant expression using ConstEval
          ConstEval eval = makeCgConstEval();
          auto result = eval.evaluate(varDef->initExpr);
          if (result && result->kind == ConstValue::INT) {
            if (wt == WasmType::I64) {
              initVal = result->intVal;
            } else {
              initVal = static_cast<i32>(result->intVal);
            }
          } else if (result && result->kind == ConstValue::FLOAT) {
            if (wt == WasmType::F32) {
              initVal = static_cast<float>(result->floatVal);
            } else {
              initVal = result->floatVal;
            }
          } else if (result && result->kind == ConstValue::ADDRESS) {
            initVal = static_cast<i32>(result->addrVal);
          } else {
            // Fall through to zero initialization
            if (varDef->initExpr) {
              SrcLoc loc = varDef->initExpr.getLoc();
              fprintf(stderr, "%s:%u: warning: could not evaluate static initializer for '%s'; "
                      "defaulting to zero\n", loc.filename ? loc.filename->c_str() : "<unknown>",
                      loc.line, varDef->name ? varDef->name->c_str() : "<anonymous>");
            }
            goto zero_init;
          }
        } else {
        zero_init:
          // Zero initialize
          if (wt == WasmType::I64) initVal = static_cast<i64>(0);
          else if (wt == WasmType::F32) initVal = 0.0f;
          else if (wt == WasmType::F64) initVal = 0.0;
          else initVal = static_cast<i32>(0);
        }

        u32 globalIdx = addWasmGlobal(initVal, true);  // mutable
        cg.globalVarToWasmGlobalIdx[varDef] = globalIdx;
      }
    }
  }

  // Register static local variables: evaluate initializers and handle REGISTER vars
  for (const auto &unit : units) {
    for (DFunc *func : concat<DFunc *>(unit.definedFunctions, unit.staticFunctions)) {
      DFunc *fdef = func->definition;
      if (!fdef) continue;
      for (DVar *varDef : fdef->staticLocals) {
        if (varDef->allocClass == AllocClass::MEMORY) {
          u32 addr = cg.globalArrayAddrs[varDef];

          if (varDef->initExpr && varDef->initExpr.kind == ExprKind::INIT_LIST) {
            EInitList *initList = varDef->initExpr.as.initList;
            u32 baseOffset = addr - (cg.stackPages * 65536);
            ConstEval eval = makeCgConstEval();
            cg.populateInitListStatic(initList, varDef->type, baseOffset, eval);
          } else if (varDef->initExpr && varDef->initExpr.kind == ExprKind::COMPOUND_LITERAL &&
              (varDef->type.isAggregate() || varDef->type.isArray())) {
            ECompoundLiteral *cl = varDef->initExpr.as.compoundLiteral;
            u32 baseOffset = addr - (cg.stackPages * 65536);
            ConstEval eval = makeCgConstEval();
            cg.populateInitListStatic(cl->initList, varDef->type, baseOffset, eval);
          } else if (varDef->initExpr && varDef->type.isArray() &&
              varDef->initExpr.kind == ExprKind::STRING) {
            const Buffer &str = varDef->initExpr.as.stringLit->value;
            u32 baseOffset = addr - (cg.stackPages * 65536);
            u32 copySize = cg.sizeOf(varDef->type);
            u32 len = std::min(copySize, toU32(str.size()));
            for (u32 i = 0; i < len; i++) {
              cg.staticData[baseOffset + i] = str[i];
            }
          } else if (varDef->initExpr && !varDef->type.isAggregate()) {
            u32 baseOffset = addr - (cg.stackPages * 65536);
            ConstEval eval = makeCgConstEval();
            auto constVal = eval.evaluate(varDef->initExpr);
            if (constVal && constVal->isValid()) {
              cg.writeConstValueToStatic(baseOffset, varDef->type, *constVal);
            } else {
              SrcLoc loc = varDef->initExpr.getLoc();
              fprintf(stderr, "%s:%u: warning: could not evaluate static initializer for '%s'; "
                      "defaulting to zero\n", loc.filename ? loc.filename->c_str() : "<unknown>",
                      loc.line, varDef->name ? varDef->name->c_str() : "<anonymous>");
            }
          }
        } else {
          WasmType wt = cToWasmType(varDef->type);

          WasmValue initVal;
          if (varDef->initExpr && varDef->initExpr.kind == ExprKind::INT) {
            i64 val = static_cast<i64>(varDef->initExpr.as.intLit->value);
            if (wt == WasmType::F32) {
              initVal = static_cast<float>(val);
            } else if (wt == WasmType::F64) {
              initVal = static_cast<double>(val);
            } else if (wt == WasmType::I64) {
              initVal = val;
            } else {
              initVal = static_cast<i32>(val);
            }
          } else if (varDef->initExpr && varDef->initExpr.kind == ExprKind::FLOAT) {
            double val = varDef->initExpr.as.floatLit->value;
            if (wt == WasmType::F32) {
              initVal = static_cast<float>(val);
            } else {
              initVal = val;
            }
          } else if (varDef->initExpr && varDef->initExpr.kind == ExprKind::STRING) {
            Buffer str = varDef->initExpr.as.stringLit->value;
            u32 addr = cg.getStringAddress(str);
            initVal = static_cast<i32>(addr);
          } else if (varDef->initExpr) {
            ConstEval eval = makeCgConstEval();
            auto result = eval.evaluate(varDef->initExpr);
            if (result && result->kind == ConstValue::INT) {
              if (wt == WasmType::I64) {
                initVal = result->intVal;
              } else {
                initVal = static_cast<i32>(result->intVal);
              }
            } else if (result && result->kind == ConstValue::FLOAT) {
              if (wt == WasmType::F32) {
                initVal = static_cast<float>(result->floatVal);
              } else {
                initVal = result->floatVal;
              }
            } else if (result && result->kind == ConstValue::ADDRESS) {
              initVal = static_cast<i32>(result->addrVal);
            } else {
              if (varDef->initExpr) {
                SrcLoc loc = varDef->initExpr.getLoc();
                fprintf(stderr, "%s:%u: warning: could not evaluate static initializer for '%s'; "
                        "defaulting to zero\n", loc.filename ? loc.filename->c_str() : "<unknown>",
                        loc.line, varDef->name ? varDef->name->c_str() : "<anonymous>");
              }
              goto static_local_zero_init;
            }
          } else {
          static_local_zero_init:
            if (wt == WasmType::I64) initVal = static_cast<i64>(0);
            else if (wt == WasmType::F32) initVal = 0.0f;
            else if (wt == WasmType::F64) initVal = 0.0;
            else initVal = static_cast<i32>(0);
          }
          u32 globalIdx = addWasmGlobal(initVal, true);
          cg.globalVarToWasmGlobalIdx[varDef] = globalIdx;
        }
      }
    }
  }

  // Emit function bodies
  for (const auto &unit : units) {
    for (DFunc *func : concat<DFunc *>(unit.definedFunctions, unit.staticFunctions)) {
      DFunc *fdef = func->definition;
      if (fdef != func) continue;  // non-canonical (e.g. duplicate inline)
      cg.emitFunctionBody(fdef);
    }
  }

  // Now that all code is generated, we know the total static data size.
  // Calculate memory requirements and emit data segment.
  u32 staticDataStart = cg.stackPages * 65536;
  u32 heapBase = (staticDataStart + cg.staticDataOffset + 7) & ~7u;  // 8-byte align

  // Round up to get minimum pages needed
  u32 minPages = (heapBase + 65535) / 65536;
  if (minPages < cg.stackPages) minPages = cg.stackPages;
  u32 memoryIdx = addWasmMemory(minPages);
  addWasmExport("memory", WasmExternKind::MEMORY, memoryIdx);
  addWasmExport("__indirect_function_table", WasmExternKind::TABLE, 0);

  // Emit data segment for static data (strings, etc.)
  if (!cg.staticData.empty()) {
    addDataSegment(staticDataStart, cg.staticData);
  }

  // Patch __heap_base global with actual value and export it
  patchWasmGlobalValue(cg.heapBaseGlobalIdx, static_cast<i32>(heapBase));
  addWasmExport("__heap_base", WasmExternKind::GLOBAL, cg.heapBaseGlobalIdx);

  return result;
}

// ====================
// main
// ====================

enum class Action {
  PARSE,
  LINK,
  RESOLVE,
  COMPILE,
  DUMP_STDLIB,
  LEX,
  DEBUG_TYPES,
  DEBUG_EXPR_TYPES,
};

void dumpAst(std::span<const TUnit> units, int indent = 0) {
  DumpContext ctx;
  for (const auto &unit : units) {
    std::cout << dumpTUnit(unit, ctx, indent) << "\n";
  }
}

// ====================
// JSON AST serialization (for -a resolve)
// ====================

static std::string jsonEscape(std::string_view s) {
  std::string ret;
  ret.reserve(s.size() + 2);
  ret += '"';
  for (char c : s) {
    switch (c) {
      case '"': ret += "\\\""; break;
      case '\\': ret += "\\\\"; break;
      case '\n': ret += "\\n"; break;
      case '\r': ret += "\\r"; break;
      case '\t': ret += "\\t"; break;
      default:
        if ((unsigned char)c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", (unsigned char)c);
          ret += buf;
        } else {
          ret += c;
        }
        break;
    }
  }
  ret += '"';
  return ret;
}

static std::string jsonExpr(const Expr &expr, DumpContext &ctx);
static std::string jsonStmt(const Stmt &stmt, DumpContext &ctx);
static std::string jsonDecl(const Decl &decl, DumpContext &ctx);

static std::string jsonExpr(const Expr &expr, DumpContext &ctx) {
  std::string ret = "{";
  ret += "\"kind\":" + jsonEscape(strExprKind(expr.kind));
  ret += ",\"type\":" + jsonEscape(expr.getType().toString());
  switch (expr.kind) {
    case ExprKind::IDENT:
      ret += ",\"name\":" + jsonEscape(*expr.as.ident->name);
      if (expr.as.ident->decl) {
        ret += ",\"decl\":" + jsonEscape(ctx.formatDeclId(expr.as.ident->decl));
        ret += ",\"defn\":" + jsonEscape(ctx.formatDeclIdOfDefinition(expr.as.ident->decl));
      }
      break;
    case ExprKind::INT:
      ret += ",\"value\":" + std::to_string(expr.as.intLit->value);
      break;
    case ExprKind::FLOAT:
      ret += ",\"value\":" + std::to_string(expr.as.floatLit->value);
      break;
    case ExprKind::STRING:
      ret += ",\"value\":" + jsonEscape(std::string_view(
          reinterpret_cast<const char *>(expr.as.stringLit->value.data()),
          expr.as.stringLit->value.size()));
      break;
    case ExprKind::BINARY:
      ret += ",\"op\":" + jsonEscape(strBop(expr.as.binary->op));
      ret += ",\"left\":" + jsonExpr(expr.as.binary->left, ctx);
      ret += ",\"right\":" + jsonExpr(expr.as.binary->right, ctx);
      break;
    case ExprKind::UNARY:
      ret += ",\"op\":" + jsonEscape(strUop(expr.as.unary->op));
      ret += ",\"operand\":" + jsonExpr(expr.as.unary->operand, ctx);
      break;
    case ExprKind::TERNARY:
      ret += ",\"condition\":" + jsonExpr(expr.as.ternary->condition, ctx);
      ret += ",\"then\":" + jsonExpr(expr.as.ternary->thenExpr, ctx);
      ret += ",\"else\":" + jsonExpr(expr.as.ternary->elseExpr, ctx);
      break;
    case ExprKind::CALL:
      ret += ",\"callee\":" + jsonExpr(expr.as.call->callee, ctx);
      ret += ",\"args\":[";
      for (size_t i = 0; i < expr.as.call->arguments.size(); ++i) {
        if (i) ret += ",";
        ret += jsonExpr(expr.as.call->arguments[i], ctx);
      }
      ret += "]";
      break;
    case ExprKind::SUBSCRIPT:
      ret += ",\"array\":" + jsonExpr(expr.as.subscript->array, ctx);
      ret += ",\"index\":" + jsonExpr(expr.as.subscript->index, ctx);
      break;
    case ExprKind::MEMBER:
      ret += ",\"member\":" + jsonEscape(expr.as.member->memberName ? *expr.as.member->memberName : "(anon)");
      ret += ",\"base\":" + jsonExpr(expr.as.member->base, ctx);
      break;
    case ExprKind::ARROW:
      ret += ",\"member\":" + jsonEscape(expr.as.arrow->memberName ? *expr.as.arrow->memberName : "(anon)");
      ret += ",\"base\":" + jsonExpr(expr.as.arrow->base, ctx);
      break;
    case ExprKind::CAST:
      ret += ",\"targetType\":" + jsonEscape(expr.as.cast->targetType.toString());
      ret += ",\"expr\":" + jsonExpr(expr.as.cast->expr, ctx);
      break;
    case ExprKind::SIZEOF_EXPR:
      ret += ",\"expr\":" + jsonExpr(expr.as.sizeofExpr->expr, ctx);
      break;
    case ExprKind::SIZEOF_TYPE:
      ret += ",\"operandType\":" + jsonEscape(expr.as.sizeofType->operandType.toString());
      break;
    case ExprKind::ALIGNOF_EXPR:
      ret += ",\"expr\":" + jsonExpr(expr.as.alignofExpr->expr, ctx);
      break;
    case ExprKind::ALIGNOF_TYPE:
      ret += ",\"operandType\":" + jsonEscape(expr.as.alignofType->operandType.toString());
      break;
    case ExprKind::COMMA:
      ret += ",\"exprs\":[";
      for (size_t i = 0; i < expr.as.comma->expressions.size(); ++i) {
        if (i) ret += ",";
        ret += jsonExpr(expr.as.comma->expressions[i], ctx);
      }
      ret += "]";
      break;
    case ExprKind::INIT_LIST:
      ret += ",\"elements\":[";
      for (size_t i = 0; i < expr.as.initList->elements.size(); ++i) {
        if (i) ret += ",";
        ret += jsonExpr(expr.as.initList->elements[i], ctx);
      }
      ret += "]";
      break;
    case ExprKind::INTRINSIC:
      ret += ",\"intrinsic\":" + jsonEscape(strIntrinsicKind(expr.as.intrinsic->kind));
      ret += ",\"args\":[";
      for (size_t i = 0; i < expr.as.intrinsic->args.size(); ++i) {
        if (i) ret += ",";
        ret += jsonExpr(expr.as.intrinsic->args[i], ctx);
      }
      ret += "]";
      break;
    case ExprKind::WASM:
      ret += ",\"bytesLen\":" + std::to_string(expr.as.wasm->bytes.size());
      ret += ",\"args\":[";
      for (size_t i = 0; i < expr.as.wasm->args.size(); ++i) {
        if (i) ret += ",";
        ret += jsonExpr(expr.as.wasm->args[i], ctx);
      }
      ret += "]";
      break;
    case ExprKind::COMPOUND_LITERAL:
      ret += ",\"initList\":" + jsonExpr(Expr(expr.as.compoundLiteral->initList), ctx);
      break;
    case ExprKind::IMPLICIT_CAST:
      ret += ",\"targetType\":" + jsonEscape(expr.as.implicitCast->type.toString());
      ret += ",\"expr\":" + jsonExpr(expr.as.implicitCast->expr, ctx);
      break;
    default:
      break;
  }
  ret += "}";
  return ret;
}

static std::string jsonStmt(const Stmt &stmt, DumpContext &ctx) {
  std::string ret = "{";
  ret += "\"kind\":" + jsonEscape(strStmtKind(stmt.kind));
  switch (stmt.kind) {
    case StmtKind::EXPR:
      ret += ",\"expr\":" + jsonExpr(stmt.as.exprStmt->expr, ctx);
      break;
    case StmtKind::RETURN:
      if (stmt.as.returnStmt->expr) {
        ret += ",\"expr\":" + jsonExpr(stmt.as.returnStmt->expr, ctx);
      }
      break;
    case StmtKind::DECL:
      ret += ",\"declarations\":[";
      for (size_t i = 0; i < stmt.as.declStmt->declarations.size(); ++i) {
        if (i) ret += ",";
        ret += jsonDecl(stmt.as.declStmt->declarations[i], ctx);
      }
      ret += "]";
      break;
    case StmtKind::COMPOUND:
      ret += ",\"body\":[";
      for (size_t i = 0; i < stmt.as.compound->statements.size(); ++i) {
        if (i) ret += ",";
        ret += jsonStmt(stmt.as.compound->statements[i], ctx);
      }
      ret += "]";
      break;
    case StmtKind::GOTO:
      ret += ",\"label\":" + jsonEscape(stmt.as.gotoStmt->label);
      break;
    case StmtKind::LABEL:
      ret += ",\"name\":" + jsonEscape(stmt.as.labelStmt->name);
      break;
    case StmtKind::IF:
      ret += ",\"condition\":" + jsonExpr(stmt.as.ifStmt->condition, ctx);
      ret += ",\"then\":" + jsonStmt(stmt.as.ifStmt->thenBranch, ctx);
      if (stmt.as.ifStmt->elseBranch) {
        ret += ",\"else\":" + jsonStmt(stmt.as.ifStmt->elseBranch, ctx);
      }
      break;
    case StmtKind::WHILE:
      ret += ",\"condition\":" + jsonExpr(stmt.as.whileStmt->condition, ctx);
      ret += ",\"body\":" + jsonStmt(stmt.as.whileStmt->body, ctx);
      break;
    case StmtKind::DO_WHILE:
      ret += ",\"body\":" + jsonStmt(stmt.as.doWhileStmt->body, ctx);
      ret += ",\"condition\":" + jsonExpr(stmt.as.doWhileStmt->condition, ctx);
      break;
    case StmtKind::FOR:
      if (stmt.as.forStmt->init) {
        ret += ",\"init\":" + jsonStmt(stmt.as.forStmt->init, ctx);
      }
      if (stmt.as.forStmt->condition) {
        ret += ",\"condition\":" + jsonExpr(stmt.as.forStmt->condition, ctx);
      }
      if (stmt.as.forStmt->increment) {
        ret += ",\"increment\":" + jsonExpr(stmt.as.forStmt->increment, ctx);
      }
      ret += ",\"body\":" + jsonStmt(stmt.as.forStmt->body, ctx);
      break;
    case StmtKind::SWITCH:
      ret += ",\"expr\":" + jsonExpr(stmt.as.switchStmt->expr, ctx);
      ret += ",\"cases\":[";
      for (size_t i = 0; i < stmt.as.switchStmt->cases.size(); ++i) {
        if (i) ret += ",";
        auto &c = stmt.as.switchStmt->cases[i];
        ret += "{";
        if (c.isDefault) {
          ret += "\"default\":true";
        } else {
          ret += "\"value\":" + std::to_string(c.value);
        }
        ret += ",\"stmtIndex\":" + std::to_string(c.stmtIndex);
        ret += "}";
      }
      ret += "]";
      ret += ",\"body\":" + jsonStmt(Stmt(stmt.as.switchStmt->body), ctx);
      break;
    case StmtKind::TRY_CATCH:
      ret += ",\"try\":" + jsonStmt(stmt.as.tryCatch->tryBody, ctx);
      ret += ",\"catches\":[";
      for (size_t i = 0; i < stmt.as.tryCatch->catches.size(); ++i) {
        if (i) ret += ",";
        auto &cc = stmt.as.tryCatch->catches[i];
        ret += "{";
        if (cc.tag) {
          ret += "\"tag\":" + jsonEscape(*cc.tag->name);
        } else {
          ret += "\"catchAll\":true";
        }
        ret += ",\"body\":" + jsonStmt(cc.body, ctx);
        ret += "}";
      }
      ret += "]";
      break;
    case StmtKind::THROW:
      ret += ",\"tag\":" + jsonEscape(*stmt.as.throwStmt->tag->name);
      ret += ",\"args\":[";
      for (size_t i = 0; i < stmt.as.throwStmt->args.size(); ++i) {
        if (i) ret += ",";
        ret += jsonExpr(stmt.as.throwStmt->args[i], ctx);
      }
      ret += "]";
      break;
    case StmtKind::EMPTY:
    case StmtKind::BREAK:
    case StmtKind::CONTINUE:
      break;
  }
  ret += "}";
  return ret;
}

static std::string jsonDecl(const Decl &decl, DumpContext &ctx) {
  std::string ret = "{";
  ret += "\"kind\":" + jsonEscape(strDeclKind(decl.kind));
  ret += ",\"id\":" + jsonEscape(ctx.formatDeclId(decl));
  auto defnStr = ctx.formatDeclIdOfDefinition(decl);
  if (defnStr != ctx.formatDeclId(decl)) {
    ret += ",\"defn\":" + jsonEscape(defnStr);
  }
  if (decl.kind == DeclKind::VAR) {
    auto *v = decl.as.var;
    ret += ",\"name\":" + jsonEscape(*v->name);
    ret += ",\"type\":" + jsonEscape(v->type.toString());
    if (v->storageClass != StorageClass::NONE) {
      ret += ",\"storage\":" + jsonEscape(strStorageClass(v->storageClass));
    }
    ret += ",\"alloc\":";
    ret += v->allocClass == AllocClass::REGISTER ? "\"register\"" : "\"memory\"";
    if (v->isBitField()) {
      ret += ",\"bitField\":{\"width\":" + std::to_string(v->bitWidth);
      ret += ",\"offset\":" + std::to_string(v->bitOffset) + "}";
    }
    if (v->requestedAlignment > 0) {
      ret += ",\"align\":" + std::to_string(v->requestedAlignment);
    }
    if (v->initExpr) {
      ret += ",\"init\":" + jsonExpr(v->initExpr, ctx);
    }
  } else if (decl.kind == DeclKind::FUNC) {
    auto *f = decl.as.func;
    ret += ",\"name\":" + jsonEscape(*f->name);
    ret += ",\"type\":" + jsonEscape(f->type.toString());
    if (f->storageClass != StorageClass::NONE) {
      ret += ",\"storage\":" + jsonEscape(strStorageClass(f->storageClass));
    }
    if (f->isInline) {
      ret += ",\"inline\":true";
    }
    ret += ",\"params\":[";
    for (size_t i = 0; i < f->parameters.size(); ++i) {
      if (i) ret += ",";
      ret += jsonDecl(f->parameters[i], ctx);
    }
    ret += "]";
    if (f->body) {
      ret += ",\"body\":" + jsonStmt(f->body, ctx);
    }
  } else if (decl.kind == DeclKind::TAG) {
    auto *t = decl.as.tag;
    ret += ",\"name\":" + jsonEscape(*t->name);
    ret += ",\"tagKind\":" + jsonEscape(strTagKind(t->tagKind));
    ret += ",\"complete\":" + std::string(t->isComplete ? "true" : "false");
    ret += ",\"members\":[";
    for (size_t i = 0; i < t->members.size(); ++i) {
      if (i) ret += ",";
      ret += jsonDecl(t->members[i], ctx);
    }
    ret += "]";
  } else if (decl.kind == DeclKind::ENUM_CONST) {
    auto *ec = decl.as.enumConst;
    ret += ",\"name\":" + jsonEscape(*ec->name);
    ret += ",\"value\":" + std::to_string(ec->value);
  }
  ret += "}";
  return ret;
}

static std::string jsonTUnit(const TUnit &unit, DumpContext &ctx) {
  std::string ret = "{";
  ret += "\"file\":" + jsonEscape(*unit.filename);
  auto showList = [&](const char *name, auto &list) {
    ret += std::string(",\"") + name + "\":[";
    for (size_t i = 0; i < list.size(); ++i) {
      if (i) ret += ",";
      ret += jsonDecl(Decl(list[i]), ctx);
    }
    ret += "]";
  };
  showList("importedFunctions", unit.importedFunctions);
  showList("definedFunctions", unit.definedFunctions);
  showList("staticFunctions", unit.staticFunctions);
  showList("declaredFunctions", unit.declaredFunctions);
  showList("localDeclaredFunctions", unit.localDeclaredFunctions);
  showList("definedVariables", unit.definedVariables);
  showList("externVariables", unit.externVariables);
  showList("localExternVariables", unit.localExternVariables);
  ret += "}";
  return ret;
}

static void dumpJsonAst(std::span<const TUnit> units) {
  DumpContext ctx;
  std::cout << "[";
  for (size_t i = 0; i < units.size(); ++i) {
    if (i) std::cout << ",";
    std::cout << jsonTUnit(units[i], ctx);
  }
  std::cout << "]\n";
}

void debugTypes(std::span<const TUnit> units) {
  for (const auto &unit : units) {
    std::cout << "TU " << *unit.filename << "\n";
    auto showVar = [](const DVar *v) {
      std::cout << "VAR " << *v->name << " " << v->type.toString();
      if (v->storageClass != StorageClass::NONE) {
        std::cout << " (" << strStorageClass(v->storageClass) << ")";
      }
      std::cout << "\n";
    };
    auto showFunc = [](const DFunc *f) {
      std::cout << "FUNC " << *f->name << " " << f->type.toString();
      if (f->storageClass != StorageClass::NONE) {
        std::cout << " (" << strStorageClass(f->storageClass) << ")";
      }
      std::cout << "\n";
      for (const auto &param : f->parameters) {
        if (param.kind == DeclKind::VAR) {
          std::cout << "  PARAM " << *param.as.var->name << " " << param.as.var->type.toString()
                    << "\n";
        }
      }
    };
    for (auto *f : unit.importedFunctions) showFunc(f);
    for (auto *f : unit.definedFunctions) showFunc(f);
    for (auto *f : unit.staticFunctions) showFunc(f);
    for (auto *f : unit.declaredFunctions) showFunc(f);
    for (auto *f : unit.localDeclaredFunctions) showFunc(f);
    for (auto *v : unit.definedVariables) showVar(v);
    for (auto *v : unit.externVariables) showVar(v);
    for (auto *v : unit.localExternVariables) showVar(v);
  }
}

void walkExprs(const Expr &expr, std::function<void(const Expr &)> visitor) {
  visitor(expr);
  switch (expr.kind) {
    case ExprKind::BINARY:
      walkExprs(expr.as.binary->left, visitor);
      walkExprs(expr.as.binary->right, visitor);
      break;
    case ExprKind::UNARY: walkExprs(expr.as.unary->operand, visitor); break;
    case ExprKind::TERNARY:
      walkExprs(expr.as.ternary->condition, visitor);
      walkExprs(expr.as.ternary->thenExpr, visitor);
      walkExprs(expr.as.ternary->elseExpr, visitor);
      break;
    case ExprKind::CALL:
      walkExprs(expr.as.call->callee, visitor);
      for (const auto &a : expr.as.call->arguments) walkExprs(a, visitor);
      break;
    case ExprKind::SUBSCRIPT:
      walkExprs(expr.as.subscript->array, visitor);
      walkExprs(expr.as.subscript->index, visitor);
      break;
    case ExprKind::MEMBER: walkExprs(expr.as.member->base, visitor); break;
    case ExprKind::ARROW: walkExprs(expr.as.arrow->base, visitor); break;
    case ExprKind::CAST: walkExprs(expr.as.cast->expr, visitor); break;
    case ExprKind::SIZEOF_EXPR: walkExprs(expr.as.sizeofExpr->expr, visitor); break;
    case ExprKind::ALIGNOF_EXPR: walkExprs(expr.as.alignofExpr->expr, visitor); break;
    case ExprKind::COMMA:
      for (const auto &e : expr.as.comma->expressions) walkExprs(e, visitor);
      break;
    case ExprKind::INIT_LIST:
      for (const auto &e : expr.as.initList->elements) walkExprs(e, visitor);
      break;
    case ExprKind::INTRINSIC:
      for (const auto &a : expr.as.intrinsic->args) walkExprs(a, visitor);
      break;
    case ExprKind::WASM:
      for (const auto &a : expr.as.wasm->args) walkExprs(a, visitor);
      break;
    case ExprKind::COMPOUND_LITERAL:
      walkExprs(Expr(expr.as.compoundLiteral->initList), visitor);
      break;
    case ExprKind::IMPLICIT_CAST:
      walkExprs(expr.as.implicitCast->expr, visitor);
      break;
    default: break;
  }
}

void walkStmtExprs(const Stmt &stmt, std::function<void(const Expr &)> visitor) {
  switch (stmt.kind) {
    case StmtKind::EXPR: walkExprs(stmt.as.exprStmt->expr, visitor); break;
    case StmtKind::RETURN:
      if (stmt.as.returnStmt->expr) walkExprs(stmt.as.returnStmt->expr, visitor);
      break;
    case StmtKind::DECL:
      for (const auto &d : stmt.as.declStmt->declarations) {
        if (d.kind == DeclKind::VAR && d.as.var->initExpr)
          walkExprs(d.as.var->initExpr, visitor);
      }
      break;
    case StmtKind::COMPOUND:
      for (const auto &s : stmt.as.compound->statements) walkStmtExprs(s, visitor);
      break;
    case StmtKind::IF:
      walkExprs(stmt.as.ifStmt->condition, visitor);
      walkStmtExprs(stmt.as.ifStmt->thenBranch, visitor);
      if (stmt.as.ifStmt->elseBranch) walkStmtExprs(stmt.as.ifStmt->elseBranch, visitor);
      break;
    case StmtKind::WHILE:
      walkExprs(stmt.as.whileStmt->condition, visitor);
      walkStmtExprs(stmt.as.whileStmt->body, visitor);
      break;
    case StmtKind::DO_WHILE:
      walkStmtExprs(stmt.as.doWhileStmt->body, visitor);
      walkExprs(stmt.as.doWhileStmt->condition, visitor);
      break;
    case StmtKind::FOR:
      if (stmt.as.forStmt->init) walkStmtExprs(stmt.as.forStmt->init, visitor);
      if (stmt.as.forStmt->condition) walkExprs(stmt.as.forStmt->condition, visitor);
      if (stmt.as.forStmt->increment) walkExprs(stmt.as.forStmt->increment, visitor);
      walkStmtExprs(stmt.as.forStmt->body, visitor);
      break;
    case StmtKind::SWITCH:
      walkExprs(stmt.as.switchStmt->expr, visitor);
      walkStmtExprs(Stmt(stmt.as.switchStmt->body), visitor);
      break;
    case StmtKind::TRY_CATCH:
      walkStmtExprs(stmt.as.tryCatch->tryBody, visitor);
      for (const auto &cc : stmt.as.tryCatch->catches) walkStmtExprs(cc.body, visitor);
      break;
    case StmtKind::THROW:
      for (const auto &a : stmt.as.throwStmt->args) walkExprs(a, visitor);
      break;
    default: break;
  }
}

void debugExprTypes(std::span<const TUnit> units) {
  for (const auto &unit : units) {
    std::cout << "TU " << *unit.filename << "\n";
    auto processFuncs = [](const std::vector<DFunc *> &funcs) {
      for (auto *f : funcs) {
        if (!f->body) continue;
        std::cout << "FUNC " << *f->name << "\n";
        walkStmtExprs(f->body, [](const Expr &e) {
          std::cout << "  " << strExprKind(e.kind) << " " << e.getType().toString() << "\n";
        });
      }
    };
    processFuncs(unit.definedFunctions);
    processFuncs(unit.staticFunctions);
  }
}

// ── Implicit Cast Annotation Pass ──────────────────────────────────────
// Inserts EImplicitCast nodes into the AST for all implicit type conversions
// (usual arithmetic conversions, integer promotions, assignment conversions).
// Run after linking and before code generation.

static void wrapImplicitCast(Expr &expr, Type targetType) {
  targetType = targetType.removeQualifiers();
  Type srcType = expr.getType().removeQualifiers();
  if (srcType == targetType) return;
  if (targetType.isVoid() || srcType.isVoid()) return;
  expr = Expr(new EImplicitCast{expr.getLoc(), targetType, expr});
}

static void annotateExpr(Expr &expr);
static void annotateStmt(Stmt &stmt, Type returnType);

static void annotateExpr(Expr &expr) {
  switch (expr.kind) {
    case ExprKind::BINARY: {
      EBinary *eb = expr.as.binary;
      annotateExpr(eb->left);
      annotateExpr(eb->right);

      // Skip assignment ops (handled in codegen's emitAssignment)
      if (eb->op >= Bop::ASSIGN && eb->op <= Bop::SHR_ASSIGN) break;
      // Skip logical ops (use emitBoolNormalize, not emitConversion)
      if (eb->op == Bop::LAND || eb->op == Bop::LOR) break;

      Type leftType = eb->left.getType();
      Type rightType = eb->right.getType();

      // Skip pointer/array arithmetic
      if ((eb->op == Bop::ADD || eb->op == Bop::SUB) &&
          (leftType.isPointer() || rightType.isPointer() ||
           leftType.isArray() || rightType.isArray())) {
        break;
      }

      bool isComparison = eb->op >= Bop::EQ && eb->op <= Bop::GE;
      Type opType = isComparison ? usualArithmeticConversions(leftType, rightType) : eb->type;
      wrapImplicitCast(eb->left, opType);
      wrapImplicitCast(eb->right, opType);
      break;
    }
    case ExprKind::CALL: {
      ECall *ec = expr.as.call;
      annotateExpr(ec->callee);
      for (auto &arg : ec->arguments) annotateExpr(arg);

      // Resolve function type
      Type calleeType = ec->callee.getType().decay();
      if (calleeType.isPointer()) calleeType = calleeType.getPointee();
      if (!calleeType.isFunction()) break;

      auto paramTypes = calleeType.getParamTypes();

      if (calleeType.isVarArg()) {
        // Fixed params
        for (size_t i = 0; i < paramTypes.size() && i < ec->arguments.size(); i++) {
          wrapImplicitCast(ec->arguments[i], paramTypes[i]);
        }
        // Varargs: default argument promotion (float→double)
        for (size_t i = paramTypes.size(); i < ec->arguments.size(); i++) {
          Type argType = ec->arguments[i].getType();
          if (argType.removeQualifiers() == TFLOAT) {
            wrapImplicitCast(ec->arguments[i], TDOUBLE);
          }
        }
      } else {
        // Non-variadic: convert each arg to param type
        for (size_t i = 0; i < ec->arguments.size() && i < paramTypes.size(); i++) {
          wrapImplicitCast(ec->arguments[i], paramTypes[i]);
        }
      }
      break;
    }
    case ExprKind::TERNARY: {
      ETernary *et = expr.as.ternary;
      annotateExpr(et->condition);
      annotateExpr(et->thenExpr);
      annotateExpr(et->elseExpr);
      wrapImplicitCast(et->thenExpr, et->type);
      wrapImplicitCast(et->elseExpr, et->type);
      break;
    }
    case ExprKind::UNARY:
      annotateExpr(expr.as.unary->operand);
      break;
    case ExprKind::SUBSCRIPT:
      annotateExpr(expr.as.subscript->array);
      annotateExpr(expr.as.subscript->index);
      break;
    case ExprKind::MEMBER:
      annotateExpr(expr.as.member->base);
      break;
    case ExprKind::ARROW:
      annotateExpr(expr.as.arrow->base);
      break;
    case ExprKind::CAST:
      annotateExpr(expr.as.cast->expr);
      break;
    case ExprKind::COMMA:
      for (auto &e : expr.as.comma->expressions) annotateExpr(e);
      break;
    case ExprKind::INIT_LIST:
      for (auto &e : expr.as.initList->elements) annotateExpr(e);
      break;
    case ExprKind::INTRINSIC:
      for (auto &arg : expr.as.intrinsic->args) annotateExpr(arg);
      break;
    case ExprKind::WASM:
      for (auto &arg : expr.as.wasm->args) annotateExpr(arg);
      break;
    case ExprKind::COMPOUND_LITERAL:
      for (auto &e : expr.as.compoundLiteral->initList->elements) annotateExpr(e);
      break;
    case ExprKind::SIZEOF_EXPR:
      annotateExpr(expr.as.sizeofExpr->expr);
      break;
    case ExprKind::ALIGNOF_EXPR:
      annotateExpr(expr.as.alignofExpr->expr);
      break;
    case ExprKind::IMPLICIT_CAST:
      annotateExpr(expr.as.implicitCast->expr);
      break;
    default:
      break;  // INT, FLOAT, STRING, IDENT, SIZEOF_TYPE, ALIGNOF_TYPE — leaf nodes
  }
}

static void annotateStmt(Stmt &stmt, Type returnType) {
  switch (stmt.kind) {
    case StmtKind::EXPR:
      annotateExpr(stmt.as.exprStmt->expr);
      break;
    case StmtKind::RETURN:
      if (stmt.as.returnStmt->expr) {
        annotateExpr(stmt.as.returnStmt->expr);
        wrapImplicitCast(stmt.as.returnStmt->expr, returnType);
      }
      break;
    case StmtKind::DECL:
      for (auto &decl : stmt.as.declStmt->declarations) {
        if (decl.kind == DeclKind::VAR && decl.as.var->initExpr) {
          annotateExpr(decl.as.var->initExpr);
          // Only annotate scalar init (not aggregate/array/struct init lists)
          if (!decl.as.var->type.isAggregate() &&
              decl.as.var->initExpr.kind != ExprKind::INIT_LIST) {
            wrapImplicitCast(decl.as.var->initExpr, decl.as.var->type);
          }
        }
      }
      break;
    case StmtKind::COMPOUND:
      for (auto &s : stmt.as.compound->statements) annotateStmt(s, returnType);
      break;
    case StmtKind::IF:
      annotateExpr(stmt.as.ifStmt->condition);
      annotateStmt(stmt.as.ifStmt->thenBranch, returnType);
      if (stmt.as.ifStmt->elseBranch) annotateStmt(stmt.as.ifStmt->elseBranch, returnType);
      break;
    case StmtKind::WHILE:
      annotateExpr(stmt.as.whileStmt->condition);
      annotateStmt(stmt.as.whileStmt->body, returnType);
      break;
    case StmtKind::DO_WHILE:
      annotateStmt(stmt.as.doWhileStmt->body, returnType);
      annotateExpr(stmt.as.doWhileStmt->condition);
      break;
    case StmtKind::FOR:
      if (stmt.as.forStmt->init) annotateStmt(stmt.as.forStmt->init, returnType);
      if (stmt.as.forStmt->condition) annotateExpr(stmt.as.forStmt->condition);
      if (stmt.as.forStmt->increment) annotateExpr(stmt.as.forStmt->increment);
      annotateStmt(stmt.as.forStmt->body, returnType);
      break;
    case StmtKind::SWITCH: {
      annotateExpr(stmt.as.switchStmt->expr);
      Stmt bodyStmt(stmt.as.switchStmt->body);
      annotateStmt(bodyStmt, returnType);
      break;
    }
    case StmtKind::TRY_CATCH:
      annotateStmt(stmt.as.tryCatch->tryBody, returnType);
      for (auto &cc : stmt.as.tryCatch->catches) annotateStmt(cc.body, returnType);
      break;
    case StmtKind::THROW: {
      SThrow *st = stmt.as.throwStmt;
      for (auto &arg : st->args) annotateExpr(arg);
      for (size_t i = 0; i < st->args.size(); i++) {
        wrapImplicitCast(st->args[i], st->tag->paramTypes[i]);
      }
      break;
    }
    default:
      break;
  }
}

// =====================================================
// setjmp/longjmp lowering pass
// =====================================================
// Transforms setjmp/longjmp patterns into WASM exception handling:
//   - longjmp(buf, val) → __throw __LongJump(buf[0], val)
//   - if (setjmp(buf) == 0) { Y } else { X } → buf[0]=id; try { Y } catch { rethrow-or X }
//   - if (setjmp(buf)) { X } <rest> → buf[0]=id; try { <rest> } catch { rethrow-or X }


// Check if an expression is a call to a function named 'name'
static ECall *getNamedCall(Expr &expr, const char *name) {
  if (expr.kind != ExprKind::CALL) return nullptr;
  ECall *call = expr.as.call;
  if (call->funcDecl && call->funcDecl->name && *call->funcDecl->name == name) return call;
  return nullptr;
}

// Extract the setjmp call from an if-condition, returning the call and whether the
// condition tests for the zero (normal) path.
// Returns {call, zeroIsTrue} where:
//   - if (setjmp(buf) == 0) → {call, true}   (then=try, else=catch)
//   - if (setjmp(buf))      → {call, false}   (then=catch, rest=try)
static std::pair<ECall *, bool> extractSetjmpCall(Expr &cond) {
  // Pattern: setjmp(buf) == 0 or 0 == setjmp(buf)
  if (cond.kind == ExprKind::BINARY) {
    EBinary *bin = cond.as.binary;
    if (bin->op == Bop::EQ) {
      ECall *call = getNamedCall(bin->left, "setjmp");
      if (call && bin->right.kind == ExprKind::INT && bin->right.as.intLit->value == 0)
        return {call, true};
      call = getNamedCall(bin->right, "setjmp");
      if (call && bin->left.kind == ExprKind::INT && bin->left.as.intLit->value == 0)
        return {call, true};
    }
    // Pattern: setjmp(buf) != 0 or 0 != setjmp(buf)
    if (bin->op == Bop::NE) {
      ECall *call = getNamedCall(bin->left, "setjmp");
      if (call && bin->right.kind == ExprKind::INT && bin->right.as.intLit->value == 0)
        return {call, false};
      call = getNamedCall(bin->right, "setjmp");
      if (call && bin->left.kind == ExprKind::INT && bin->left.as.intLit->value == 0)
        return {call, false};
    }
  }
  // Pattern: setjmp(buf) used directly as condition (truthy = longjmp fired)
  ECall *call = getNamedCall(cond, "setjmp");
  if (call) return {call, false};
  // Pattern: !setjmp(buf)
  if (cond.kind == ExprKind::UNARY && cond.as.unary->op == Uop::OP_LNOT) {
    call = getNamedCall(cond.as.unary->operand, "setjmp");
    if (call) return {call, true};
  }
  return {nullptr, false};
}

// Build an expression: buf[0]  (subscript into jmp_buf to access the site ID)
static Expr makeBufIdExpr(Expr bufExpr, SrcLoc loc) {
  return new ESubscript{
      loc,
      Type::getInt(),
      bufExpr,
      Expr(new EInt{loc, Type::getInt(), 0}),
  };
}

// Build: buf[0] = ++__setjmp_id_counter
static Stmt makeSetBufIdStmt(Expr bufExpr, DVar *counterVar, SrcLoc loc) {
  Expr lhs = makeBufIdExpr(bufExpr, loc);
  Expr counterRef(new EIdent{loc, Type::getInt(), counterVar->name, Decl(counterVar)});
  Expr rhs(new EUnary{loc, Type::getInt(), Uop::OP_PRE_INC, counterRef});
  Expr assign(new EBinary{loc, Type::getInt(), Bop::ASSIGN, lhs, rhs});
  return Stmt(new SExpr{loc, assign});
}

// Build: __throw __LongJump(idExpr, valExpr);
static Stmt makeThrowLongJump(ExceptionTag *tag, Expr idExpr, Expr valExpr, SrcLoc loc) {
  return Stmt(new SThrow{loc, tag, {idExpr, valExpr}});
}

// Build catch body: { if (id != buf[0]) rethrow; <userBody> }
static Stmt makeCatchBody(ExceptionTag *tag, DVar *idVar, DVar *valVar, Expr bufExpr,
                          Stmt userBody, SrcLoc loc) {
  // Build: if (__caught_id != buf[0]) __throw __LongJump(__caught_id, __caught_val);
  Expr idRef(new EIdent{loc, Type::getInt(), idVar->name, Decl(idVar)});
  Expr myIdExpr = makeBufIdExpr(bufExpr, loc);
  Expr cond(new EBinary{loc, Type::getInt(), Bop::NE, idRef, myIdExpr});

  Expr idRef2(new EIdent{loc, Type::getInt(), idVar->name, Decl(idVar)});
  Expr valRef(new EIdent{loc, Type::getInt(), valVar->name, Decl(valVar)});
  Stmt rethrow = makeThrowLongJump(tag, idRef2, valRef, loc);

  Stmt rethrowIf(new SIf{loc, cond, rethrow, nullptr});

  SCompound *body = new SCompound{loc, {rethrowIf, userBody}, {}};
  return Stmt(body);
}

// Transform longjmp calls in a statement tree into __throw __LongJump(buf[0], val)
static void lowerLongjmpInStmt(Stmt &stmt, ExceptionTag *tag);

static void lowerLongjmpInExpr(Expr &expr, ExceptionTag *tag) {
  // Walk sub-expressions looking for longjmp calls.
  // longjmp as an expression statement is handled by lowerLongjmpInStmt.
  // Here we just recurse into sub-expressions (there shouldn't be longjmp
  // calls nested in expressions since longjmp is _Noreturn void, but be safe).
  (void)expr;
  (void)tag;
}

static void lowerLongjmpInStmt(Stmt &stmt, ExceptionTag *tag) {
  switch (stmt.kind) {
    case StmtKind::EXPR: {
      // Check if this is a longjmp(buf, val) call
      ECall *call = getNamedCall(stmt.as.exprStmt->expr, "longjmp");
      if (call && call->arguments.size() == 2) {
        SrcLoc loc = call->loc;
        Expr idExpr = makeBufIdExpr(call->arguments[0], loc);
        Expr valExpr = call->arguments[1];
        stmt = makeThrowLongJump(tag, idExpr, valExpr, loc);
      }
      break;
    }
    case StmtKind::COMPOUND:
      for (auto &s : stmt.as.compound->statements) lowerLongjmpInStmt(s, tag);
      break;
    case StmtKind::IF:
      lowerLongjmpInStmt(stmt.as.ifStmt->thenBranch, tag);
      if (stmt.as.ifStmt->elseBranch) lowerLongjmpInStmt(stmt.as.ifStmt->elseBranch, tag);
      break;
    case StmtKind::WHILE:
      lowerLongjmpInStmt(stmt.as.whileStmt->body, tag);
      break;
    case StmtKind::DO_WHILE:
      lowerLongjmpInStmt(stmt.as.doWhileStmt->body, tag);
      break;
    case StmtKind::FOR:
      if (stmt.as.forStmt->init) lowerLongjmpInStmt(stmt.as.forStmt->init, tag);
      lowerLongjmpInStmt(stmt.as.forStmt->body, tag);
      break;
    case StmtKind::SWITCH:
    {
      Stmt switchBody(stmt.as.switchStmt->body);
      lowerLongjmpInStmt(switchBody, tag);
      break;
    }
    case StmtKind::TRY_CATCH:
      lowerLongjmpInStmt(stmt.as.tryCatch->tryBody, tag);
      for (auto &cc : stmt.as.tryCatch->catches) lowerLongjmpInStmt(cc.body, tag);
      break;
    default:
      break;
  }
}

// Lower setjmp patterns in a compound statement's children.
// This modifies the compound's statements vector in-place.
static void lowerSetjmpInCompound(SCompound *compound, ExceptionTag *tag, DVar *counterVar) {
  auto &stmts = compound->statements;

  for (size_t i = 0; i < stmts.size(); i++) {
    Stmt &stmt = stmts[i];

    // Recurse into nested compounds first
    switch (stmt.kind) {
      case StmtKind::COMPOUND:
        lowerSetjmpInCompound(stmt.as.compound, tag, counterVar);
        break;
      case StmtKind::IF:
        // Don't recurse into the if we're about to transform — check first
        break;
      case StmtKind::WHILE:
        if (stmt.as.whileStmt->body.kind == StmtKind::COMPOUND)
          lowerSetjmpInCompound(stmt.as.whileStmt->body.as.compound, tag, counterVar);
        break;
      case StmtKind::DO_WHILE:
        if (stmt.as.doWhileStmt->body.kind == StmtKind::COMPOUND)
          lowerSetjmpInCompound(stmt.as.doWhileStmt->body.as.compound, tag, counterVar);
        break;
      case StmtKind::FOR:
        if (stmt.as.forStmt->body.kind == StmtKind::COMPOUND)
          lowerSetjmpInCompound(stmt.as.forStmt->body.as.compound, tag, counterVar);
        break;
      case StmtKind::SWITCH:
        lowerSetjmpInCompound(stmt.as.switchStmt->body, tag, counterVar);
        break;
      case StmtKind::LABEL:
        // Labels are just markers; the labeled statement follows in the compound
        break;
      case StmtKind::TRY_CATCH:
        if (stmt.as.tryCatch->tryBody.kind == StmtKind::COMPOUND)
          lowerSetjmpInCompound(stmt.as.tryCatch->tryBody.as.compound, tag, counterVar);
        for (auto &cc : stmt.as.tryCatch->catches)
          if (cc.body.kind == StmtKind::COMPOUND)
            lowerSetjmpInCompound(cc.body.as.compound, tag, counterVar);
        break;
      default:
        break;
    }

    // Now check if this is an if-statement with setjmp in the condition
    if (stmt.kind != StmtKind::IF) continue;

    SIf *sif = stmt.as.ifStmt;
    auto [setjmpCall, zeroIsTrue] = extractSetjmpCall(sif->condition);
    if (!setjmpCall) {
      // Not a setjmp if — but still recurse into its branches
      if (sif->thenBranch.kind == StmtKind::COMPOUND)
        lowerSetjmpInCompound(sif->thenBranch.as.compound, tag, counterVar);
      if (sif->elseBranch && sif->elseBranch.kind == StmtKind::COMPOUND)
        lowerSetjmpInCompound(sif->elseBranch.as.compound, tag, counterVar);
      continue;
    }

    // Found a setjmp pattern! Transform it.
    SrcLoc loc = sif->loc;

    // Extract buf argument from setjmp(buf)
    Expr bufExpr = setjmpCall->arguments[0];

    // Create catch binding variables
    Symbol idName = intern("__setjmp_caught_id");
    Symbol valName = intern("__setjmp_caught_val");
    DVar *idVar = new DVar{loc, idName, Type::getInt(), StorageClass::NONE};
    idVar->definition = idVar;
    DVar *valVar = new DVar{loc, valName, Type::getInt(), StorageClass::NONE};
    valVar->definition = valVar;

    // Determine try-body and catch-body based on pattern
    Stmt tryBody, catchUserBody;

    if (zeroIsTrue) {
      // Pattern A: if (setjmp(buf) == 0) { Y } else { X }
      // or: if (!setjmp(buf)) { Y }
      tryBody = sif->thenBranch;
      catchUserBody = sif->elseBranch ? sif->elseBranch : Stmt::empty();
    } else {
      // Pattern B: if (setjmp(buf)) { X }  <remaining stmts>
      catchUserBody = sif->thenBranch;

      if (sif->elseBranch) {
        // if (setjmp(buf)) { X } else { Y } — Y is the try body
        tryBody = sif->elseBranch;
      } else {
        // Gather remaining statements from the compound as the try body
        std::vector<Stmt> remaining(stmts.begin() + i + 1, stmts.end());
        if (remaining.empty()) {
          tryBody = Stmt::empty();
        } else {
          tryBody = Stmt(new SCompound{loc, std::move(remaining), {}});
        }
        // Remove the gathered statements from the compound
        stmts.erase(stmts.begin() + i + 1, stmts.end());
      }
    }

    // Recurse into the try body and catch body
    if (tryBody.kind == StmtKind::COMPOUND)
      lowerSetjmpInCompound(tryBody.as.compound, tag, counterVar);
    if (catchUserBody.kind == StmtKind::COMPOUND)
      lowerSetjmpInCompound(catchUserBody.as.compound, tag, counterVar);

    // Build the catch body with rethrow logic
    Stmt fullCatchBody = makeCatchBody(tag, idVar, valVar, bufExpr, catchUserBody, loc);

    // Build the catch clause
    CatchClause cc{loc, tag, {idName, valName}, {idVar, valVar}, fullCatchBody};

    // Build the STryCatch
    auto *tryCatch = new STryCatch{loc, tryBody, {std::move(cc)}};

    // Build: buf[0] = ++__setjmp_id_counter; try { ... } catch { ... }
    Stmt setBufStmt = makeSetBufIdStmt(bufExpr, counterVar, loc);

    // Replace the if-statement with setBuf + tryCatch
    stmts[i] = setBufStmt;
    stmts.insert(stmts.begin() + i + 1, Stmt(tryCatch));

    // Skip the tryCatch we just inserted
    i++;
  }
}

static void lowerSetjmpLongjmp(TUnit &unit) {
  // Check if this unit uses setjmp.h by looking for setjmp/longjmp imports
  bool hasSetjmp = false;
  for (auto *f : unit.importedFunctions) {
    if (f->name && (*f->name == "setjmp" || *f->name == "longjmp")) {
      hasSetjmp = true;
      break;
    }
  }
  if (!hasSetjmp) return;

  // Look up __LongJump tag (declared via __exception in setjmp.h, parsed into global map)
  auto tagIt = exceptionTags.find(intern("__LongJump"));
  if (tagIt == exceptionTags.end()) panicf("__LongJump exception tag not found");
  ExceptionTag *tag = tagIt->second;

  // Remove setjmp/longjmp from importedFunctions so they don't become WASM imports
  std::erase_if(unit.importedFunctions, [](DFunc *f) {
    return f->name && (*f->name == "setjmp" || *f->name == "longjmp");
  });

  // Look up __setjmp_id_counter (declared extern in setjmp.h, defined in __setjmp.c)
  DVar *counterVar = nullptr;
  Symbol counterName = intern("__setjmp_id_counter");
  for (auto *v : unit.externVariables) {
    if (v->name == counterName) { counterVar = v; break; }
  }
  if (!counterVar) panicf("__setjmp_id_counter not found in externVariables");

  // Mark counterVar as used so filterUnusedDeclarations doesn't remove it
  unit.globalUsedSymbols.insert(Decl(counterVar));

  // Lower all function bodies
  auto lowerFunc = [&](DFunc *func) {
    if (!func->body) return;
    if (func->body.kind == StmtKind::COMPOUND) {
      lowerSetjmpInCompound(func->body.as.compound, tag, counterVar);
    }
    lowerLongjmpInStmt(func->body, tag);
  };
  for (auto *f : unit.definedFunctions) lowerFunc(f);
  for (auto *f : unit.staticFunctions) lowerFunc(f);
}

static void annotateImplicitCasts(TUnit &unit) {
  auto annotateFunc = [](DFunc *func) {
    if (!func->body) return;
    Type retType = func->type.getReturnType();
    annotateStmt(func->body, retType);
  };
  for (auto *f : unit.definedFunctions) annotateFunc(f);
  for (auto *f : unit.staticFunctions) annotateFunc(f);
}

void printUsage(const char *programName) {
  std::cerr << "Usage: " << programName << " [options] <input files...>\n";
  std::cerr << "Options:\n";
  std::cerr << "  -a <action>   Action to perform: parse, link, resolve, compile (default: "
               "compile)\n";
  std::cerr << "  -o <file>     Output file (default: a.wasm)\n";
  std::cerr << "  -D<name>[=val] Define a preprocessor macro\n";
  std::cerr << "  -I<path>      Add include search path\n";
  std::cerr << "  -W<warning>   Enable warning (e.g. -Wcircular-dependency)\n";
  std::cerr << "  -Wno-<warning> Disable warning (e.g. -Wno-circular-dependency)\n";
  std::cerr
      << "  --no-undefined Disable unused-declaration filtering (error on all undefined symbols)\n";
  std::cerr << "  --gc-sections  Eliminate unreachable functions and variables after linking\n";
  std::cerr << "  --allow-empty-params  Treat f() as compatible with any parameter list\n";
  std::cerr << "  -h, --help    Show this help message\n";
}

int main(int argc, char *argv[]) {
  Action action = Action::COMPILE;
  std::vector<Symbol> inputFileNames;
  std::string outputFilename = "a.wasm";
  bool explicitOutputGiven = false;
  u32 stackPages = 0;  // 0 = use default
  bool dumpFunctions = false;
  PPRegistry ppRegistry;
  ppRegistry.defines[intern("__MTOTS__")] = "1";
  ppRegistry.defines[intern("__STDC__")] = "1";
  ppRegistry.defines[intern("__STDC_VERSION__")] = "201112L";
  ppRegistry.defines[intern("__STDC_NO_ATOMICS__")] = "1";
  ppRegistry.defines[intern("__STDC_NO_COMPLEX__")] = "1";
  ppRegistry.defines[intern("__STDC_NO_THREADS__")] = "1";
  ppRegistry.defines[intern("__STDC_NO_VLA__")] = "1";
  // Target identification
  ppRegistry.defines[intern("__wasm__")] = "1";
  ppRegistry.defines[intern("__wasm32__")] = "1";
  // Data model (ILP32: int=32, long=32, pointer=32)
  ppRegistry.defines[intern("__ILP32__")] = "1";
  // Byte order (WASM is little-endian)
  ppRegistry.defines[intern("__ORDER_LITTLE_ENDIAN__")] = "1234";
  ppRegistry.defines[intern("__ORDER_BIG_ENDIAN__")] = "4321";
  ppRegistry.defines[intern("__BYTE_ORDER__")] = "__ORDER_LITTLE_ENDIAN__";
  ppRegistry.defines[intern("__LITTLE_ENDIAN__")] = "1";  // BSD/macOS style
  // Type sizes (GCC/Clang compatibility)
  ppRegistry.defines[intern("__SIZEOF_SHORT__")] = "2";
  ppRegistry.defines[intern("__SIZEOF_INT__")] = "4";
  ppRegistry.defines[intern("__SIZEOF_LONG__")] = "4";
  ppRegistry.defines[intern("__SIZEOF_LONG_LONG__")] = "8";
  ppRegistry.defines[intern("__SIZEOF_FLOAT__")] = "4";
  ppRegistry.defines[intern("__SIZEOF_DOUBLE__")] = "8";
  ppRegistry.defines[intern("__SIZEOF_POINTER__")] = "4";
  ppRegistry.defines[intern("__SIZEOF_SIZE_T__")] = "4";
  ppRegistry.defines[intern("__SIZEOF_PTRDIFF_T__")] = "4";

  // Parse command-line arguments
  for (int i = 1; i < argc; ++i) {
    std::string_view arg = argv[i];

    if (arg == "-h" || arg == "--help") {
      printUsage(argv[0]);
      return 0;
    } else if (arg == "-a") {
      if (i + 1 >= argc) {
        std::cerr << "Error: -a requires an argument\n";
        return 1;
      }
      std::string_view actionStr = argv[++i];
      if (actionStr == "parse") {
        action = Action::PARSE;
      } else if (actionStr == "link") {
        action = Action::LINK;
      } else if (actionStr == "resolve") {
        action = Action::RESOLVE;
      } else if (actionStr == "compile") {
        action = Action::COMPILE;
      } else if (actionStr == "dump-stdlib") {
        action = Action::DUMP_STDLIB;
      } else if (actionStr == "lex") {
        action = Action::LEX;
      } else if (actionStr == "debugTypes") {
        action = Action::DEBUG_TYPES;
      } else if (actionStr == "debugExprTypes") {
        action = Action::DEBUG_EXPR_TYPES;
      } else {
        std::cerr << "Error: Unknown action '" << actionStr << "'\n";
        std::cerr << "Valid actions: parse, link, resolve, compile, dump-stdlib, lex, debugTypes, debugExprTypes\n";
        return 1;
      }
    } else if (arg == "-o") {
      if (i + 1 >= argc) {
        std::cerr << "Error: -o requires an argument\n";
        return 1;
      }
      if (explicitOutputGiven) {
        std::cerr << "Error: -o specified multiple times\n";
        return 1;
      }
      outputFilename = argv[++i];
      explicitOutputGiven = true;
    } else if (arg.starts_with("-D")) {
      std::string_view def = arg.substr(2);
      size_t eqPos = def.find('=');
      if (eqPos == std::string_view::npos) {
        ppRegistry.defines[intern(def)] = "1";
      } else {
        ppRegistry.defines[intern(def.substr(0, eqPos))] = std::string(def.substr(eqPos + 1));
      }
    } else if (arg.starts_with("-I")) {
      std::string_view path = arg.substr(2);
      ppRegistry.includePaths.push_back(std::string(path));
    } else if (arg.starts_with("-Wno-")) {
      std::string_view name = arg.substr(5);
      if (name == "circular-dependency") {
        warningFlags.circularDependency = false;
      } else if (name == "pointer-decay") {
        warningFlags.pointerDecay = false;
      } else {
        std::cerr << "Error: Unknown warning '" << name << "'\n";
        return 1;
      }
    } else if (arg.starts_with("-W")) {
      std::string_view name = arg.substr(2);
      if (name == "circular-dependency") {
        warningFlags.circularDependency = true;
      } else if (name == "pointer-decay") {
        warningFlags.pointerDecay = true;
      } else {
        std::cerr << "Error: Unknown warning '" << name << "'\n";
        return 1;
      }
    } else if (arg == "--stack-pages") {
      if (i + 1 >= argc) {
        std::cerr << "Error: --stack-pages requires an argument\n";
        return 1;
      }
      stackPages = std::stoi(argv[++i]);
    } else if (arg == "--dump-functions") {
      dumpFunctions = true;
    } else if (arg == "--no-undefined") {
      compilerOptions.noUndefined = true;
    } else if (arg == "--gc-sections") {
      compilerOptions.gcSections = true;
    } else if (arg == "--compiler-debug-switch") {
      compilerOptions.compilerDebugSwitch = true;
    } else if (arg == "--allow-implicit-int") {
      compilerOptions.allowImplicitInt = true;
    } else if (arg == "--allow-empty-params") {
      compilerOptions.allowEmptyParams = true;
    } else if (arg == "--allow-knr-definitions") {
      compilerOptions.allowKnRDefinitions = true;
    } else if (arg == "--allow-implicit-function-decl") {
      compilerOptions.allowImplicitFunctionDecl = true;
    } else if (arg == "--allow-undefined") {
      compilerOptions.allowUndefined = true;
    } else if (arg == "--time-report") {
      compilerOptions.timeReport = true;
    } else if (arg == "--require-source") {
      if (i + 1 >= argc) {
        std::cerr << "Error: --require-source requires an argument\n";
        return 1;
      }
      compilerOptions.requireSources.push_back(argv[++i]);
    } else if (arg == "--allow-old-c") {
      compilerOptions.allowImplicitInt = true;
      compilerOptions.allowEmptyParams = true;
      compilerOptions.allowKnRDefinitions = true;
      compilerOptions.allowImplicitFunctionDecl = true;
    } else if (arg.starts_with("-")) {
      std::cerr << "Error: Unknown option '" << arg << "'\n";
      printUsage(argv[0]);
      return 1;
    } else {
      inputFileNames.push_back(intern(arg));
    }
  }

  if (action == Action::DUMP_STDLIB) {
    namespace fs = std::filesystem;
    fs::path dir(explicitOutputGiven ? outputFilename : "stdlib");
    auto writeFile = [&](std::string_view name, std::string_view content) {
      fs::path filePath = dir / name;
      fs::create_directories(filePath.parent_path());
      FILE *f = fopen(filePath.c_str(), "w");
      if (!f) {
        std::cerr << "Error: failed to open " << filePath << "\n";
        return false;
      }
      fwrite(content.data(), 1, content.size(), f);
      fclose(f);
      return true;
    };
    for (const auto &[name, content] : standardLibraryHeaderFiles) {
      if (!writeFile(name, content)) return 1;
    }
    for (const auto &[name, content] : standardLibrarySourceFiles) {
      if (!writeFile(name, content)) return 1;
    }
    return 0;
  }

  if (action == Action::LEX) {
    if (inputFileNames.empty()) {
      std::cerr << "Error: No input files specified\n";
      return 1;
    }
    auto escapeJsonString = [](std::string_view sv) -> std::string {
      std::string out = "\"";
      for (char c : sv) {
        switch (c) {
          case '"': out += "\\\""; break;
          case '\\': out += "\\\\"; break;
          case '\n': out += "\\n"; break;
          case '\r': out += "\\r"; break;
          case '\t': out += "\\t"; break;
          case '\b': out += "\\b"; break;
          case '\f': out += "\\f"; break;
          default:
            if (static_cast<unsigned char>(c) < 0x20) {
              char buf[8];
              snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
              out += buf;
            } else {
              out += c;
            }
        }
      }
      out += '"';
      return out;
    };
    auto getStringPrefixName = [](StringPrefix p) -> std::string_view {
      switch (p) {
        case StringPrefix::PREFIX_L: return "L";
        case StringPrefix::PREFIX_u: return "u";
        case StringPrefix::PREFIX_U: return "U";
        case StringPrefix::PREFIX_u8: return "u8";
        default: return "";
      }
    };
    for (auto inputFileName : inputFileNames) {
      auto source = readFile(*inputFileName);
      ppRegistry.onceGuards.clear();
      auto result = tokenize(inputFileName, source, ppRegistry);
      if (!result.errors.empty()) {
        for (const auto &err : result.errors) {
          std::cerr << *err.filename << ":" << err.line << ": error: " << err.message << "\n";
        }
        return 1;
      }
      for (const auto &t : result.tokens) {
        if (t.kind == TokenKind::EOS) continue;
        std::cout << *t.filename << ":" << t.line << ":" << t.column
                  << " " << getTokenKindName(t.kind)
                  << " " << escapeJsonString(t.text);
        if (t.kind == TokenKind::INT) {
          std::cout << " " << t.value.integer;
          if (t.flags.isUnsigned) std::cout << "u";
          if (t.flags.isLongLong) std::cout << "ll";
          else if (t.flags.isLong) std::cout << "l";
        } else if (t.kind == TokenKind::FLOAT) {
          // Print float as hex bytes for exact comparison
          u8 bytes[8];
          std::memcpy(bytes, &t.value.floating, 8);
          char hex[17];
          for (int b = 0; b < 8; b++)
            snprintf(hex + b * 2, 3, "%02x", bytes[b]);
          std::cout << " " << hex;
          if (t.flags.isFloat) std::cout << "f";
          else if (t.flags.isLong) std::cout << "l";
        } else if (t.kind == TokenKind::KEYWORD) {
          std::cout << " " << getKeywordName(t.value.keyword);
        } else if (t.kind == TokenKind::STRING) {
          auto pfx = getStringPrefixName(t.flags.stringPrefix);
          if (!pfx.empty()) std::cout << " prefix=" << pfx;
        }
        std::cout << "\n";
      }
    }
    return 0;
  }

  if (inputFileNames.empty()) {
    std::cerr << "Error: No input files specified\n";
    printUsage(argv[0]);
    return 1;
  }

  // Timing support
  using Clock = std::chrono::high_resolution_clock;
  using Duration = std::chrono::duration<double, std::milli>;
  auto now = []() { return Clock::now(); };
  double lexMs = 0, parseMs = 0, linkMs = 0, codegenMs = 0, emitMs = 0, writeMs = 0;

  // Parse all input files
  std::vector<TUnit> units;
  std::set<Symbol> requiredSources;
  std::deque<Symbol> pendingRequiredSources;
  bool hasErrors = false;

  for (auto autoRequiredSource : std::vector<std::string_view>({"__alloca.c"})) {
    Symbol req = intern(autoRequiredSource);
    requiredSources.insert(req);
    pendingRequiredSources.push_back(req);
  }
  for (auto src : compilerOptions.requireSources) {
    Symbol req = intern(src);
    if (requiredSources.insert(req).second) {
      pendingRequiredSources.push_back(req);
    }
  }

  auto processSource = [&](Symbol filename, const std::string &source) {
    // Clear per-TU preprocessor state
    ppRegistry.onceGuards.clear();
    ppRegistry.customSections.clear();

    // Lex + preprocess
    auto tLex = now();
    auto lexResult = tokenize(filename, source, ppRegistry);
    lexMs += Duration(now() - tLex).count();

    if (!lexResult.errors.empty()) {
      hasErrors = true;
      std::cerr << "Got " << lexResult.errors.size() << " lex errors in " << *filename << ".\n";
      for (const auto &error : lexResult.errors) {
        std::cerr << *error.filename << ":" << error.line << ": error: " << error.message << "\n";
      }
      return;
    }

    // Parse tokens
    auto tParse = now();
    auto parseResult = parseTokens(lexResult.tokens);
    parseResult.translationUnit.customSections = std::move(ppRegistry.customSections);

    for (Symbol req : parseResult.translationUnit.requiredSources) {
      if (!requiredSources.count(req)) {
        requiredSources.insert(req);
        pendingRequiredSources.push_back(req);
      }
    }

    // Per-TU passes (before linking)
    lowerSetjmpLongjmp(parseResult.translationUnit);
    annotateImplicitCasts(parseResult.translationUnit);
    filterUnusedDeclarations(parseResult.translationUnit);
    parseMs += Duration(now() - tParse).count();

    parseResult.warnings.insert(parseResult.warnings.begin(),
        std::make_move_iterator(lexResult.warnings.begin()),
        std::make_move_iterator(lexResult.warnings.end()));

    units.push_back(std::move(parseResult.translationUnit));

    if (!parseResult.errors.empty()) {
      hasErrors = true;
      std::cerr << "Got " << parseResult.errors.size() << " parse errors in " << *filename << ".\n";
      for (const auto &error : parseResult.errors) {
        std::cerr << *error.filename << ":" << error.line << ": error: " << error.message << "\n";
      }
    }

    for (const auto &warning : parseResult.warnings) {
      std::cerr << *warning.filename << ":" << warning.line << ": warning: " << warning.message
                << "\n";
    }
  };

  // First pass: user sources
  for (auto inputFileName : inputFileNames) {
    processSource(inputFileName, readFile(*inputFileName));
  }

  // Second pass: required stdlib sources
  while (!pendingRequiredSources.empty()) {
    Symbol name = pendingRequiredSources.front();
    pendingRequiredSources.pop_front();

    auto it = standardLibrarySourceFiles.find(*name);
    if (it == standardLibrarySourceFiles.end()) {
      std::cerr << "Unknown stdlib source: " << *name << "\n";
      hasErrors = true;
      continue;
    }
    processSource(name, std::string(it->second));
  }

  if (hasErrors) {
    if (action != Action::COMPILE && action != Action::RESOLVE) {
      dumpAst(units);
    }
    return 1;
  }

  if (action == Action::PARSE) {
    dumpAst(units);
    return 0;
  }

  if (action == Action::DEBUG_TYPES) {
    debugTypes(units);
    return 0;
  }

  if (action == Action::DEBUG_EXPR_TYPES) {
    debugExprTypes(units);
    return 0;
  }

  // Link translation units
  auto t0 = now();
  auto linkResult = linkTranslationUnits(units);
  linkMs = Duration(now() - t0).count();
  if (!linkResult.errors.empty()) {
    std::cerr << "Got " << linkResult.errors.size() << " link errors.\n";
    for (const auto &error : linkResult.errors) {
      std::cerr << "Link error: " << error.message << "\n";
      for (const auto &loc : error.locations) {
        std::cerr << "  at " << *loc.filename << ":" << loc.line << "\n";
      }
    }
    return 1;
  }

  if (action == Action::LINK) {
    dumpAst(units);
    return 0;
  }

  // After linking with --allow-undefined, move promoted extern functions
  // from declaredFunctions to importedFunctions so codegen emits wasm imports.
  if (compilerOptions.allowUndefined) {
    for (auto &unit : units) {
      for (auto it = unit.declaredFunctions.begin(); it != unit.declaredFunctions.end();) {
        if ((*it)->storageClass == StorageClass::IMPORT) {
          unit.importedFunctions.push_back(*it);
          it = unit.declaredFunctions.erase(it);
        } else {
          ++it;
        }
      }
    }
  }

  if (compilerOptions.gcSections) {
    gcSections(units);
  }

  if (action == Action::RESOLVE) {
    dumpJsonAst(units);
    return 0;
  }

  // Generate code
  t0 = now();
  generateCode(units, stackPages, dumpFunctions);
  codegenMs = Duration(now() - t0).count();

  t0 = now();
  Buffer out;
  emit(out);
  emitMs = Duration(now() - t0).count();

  t0 = now();
  FILE *f = fopen(outputFilename.c_str(), "wb");
  if (!f) {
    panicf("failed to open output file: %s\n", outputFilename.c_str());
  }
  fwrite(out.data(), 1, out.size(), f);
  fclose(f);
  writeMs = Duration(now() - t0).count();

  if (compilerOptions.timeReport) {
    double totalMs = lexMs + parseMs + linkMs + codegenMs + emitMs + writeMs;
    std::cerr << std::format(
        "===== Time Report =====\n"
        "  Lex:     {:8.1f} ms ({:5.1f}%)\n"
        "  Parse:   {:8.1f} ms ({:5.1f}%)\n"
        "  Link:    {:8.1f} ms ({:5.1f}%)\n"
        "  Codegen: {:8.1f} ms ({:5.1f}%)\n"
        "  Emit:    {:8.1f} ms ({:5.1f}%)\n"
        "  Write:   {:8.1f} ms ({:5.1f}%)\n"
        "  Total:   {:8.1f} ms\n",
        lexMs, lexMs / totalMs * 100,
        parseMs, parseMs / totalMs * 100,
        linkMs, linkMs / totalMs * 100,
        codegenMs, codegenMs / totalMs * 100,
        emitMs, emitMs / totalMs * 100,
        writeMs, writeMs / totalMs * 100,
        totalMs);
  }

  return 0;
}
