#include <stdio.h>

// === Basic #elif: first branch taken ===
#if 1
#define T1 "first"
#elif 1
#define T1 "second"
#else
#define T1 "else"
#endif

// === Basic #elif: second branch taken ===
#if 0
#define T2 "first"
#elif 1
#define T2 "second"
#else
#define T2 "else"
#endif

// === Basic #elif: else branch taken ===
#if 0
#define T3 "first"
#elif 0
#define T3 "second"
#else
#define T3 "else"
#endif

// === Multiple #elif: first true ===
#if 1
#define T4 "first"
#elif 1
#define T4 "second"
#elif 1
#define T4 "third"
#else
#define T4 "else"
#endif

// === Multiple #elif: middle true ===
#if 0
#define T5 "first"
#elif 0
#define T5 "second"
#elif 1
#define T5 "third"
#else
#define T5 "else"
#endif

// === Multiple #elif: last true ===
#if 0
#define T6 "first"
#elif 0
#define T6 "second"
#elif 0
#define T6 "third"
#else
#define T6 "else"
#endif

// === #elif with expressions ===
#define VAL 2
#if VAL == 1
#define T7 "one"
#elif VAL == 2
#define T7 "two"
#elif VAL == 3
#define T7 "three"
#else
#define T7 "other"
#endif

// === #elif with defined() ===
#define FEATURE_B
#if defined(FEATURE_A)
#define T8 "a"
#elif defined(FEATURE_B)
#define T8 "b"
#elif defined(FEATURE_C)
#define T8 "c"
#else
#define T8 "none"
#endif

// === #ifdef followed by #elif ===
#ifdef NONEXISTENT
#define T9 "ifdef"
#elif 1
#define T9 "elif"
#else
#define T9 "else"
#endif

// === #ifndef followed by #elif ===
#ifndef NONEXISTENT
#define T10 "ifndef"
#elif 1
#define T10 "elif"
#else
#define T10 "else"
#endif

// === Undefined macros compare equal (both are 0) ===
#if UNDEF_A == UNDEF_B
#define T11 "equal"
#elif 1
#define T11 "elif"
#else
#define T11 "else"
#endif

// === The DOOM pattern: __BYTE_ORDER__ style ===
// When none of these are defined, UNDEF==UNDEF is 0==0 -> true
#if ( UNDEF_X == UNDEF_Y )
#define T12 "first"
#elif ( UNDEF_X == UNDEF_Z )
#define T12 "second"
#else
#define T12 "unknown"
#endif

// === Nested #if inside #elif ===
#if 0
#define T13 "outer_if"
#elif 1
  #if 1
  #define T13 "nested_if"
  #else
  #define T13 "nested_else"
  #endif
#else
#define T13 "outer_else"
#endif

// === Nested #if/#elif inside inactive block ===
#if 0
  #if 1
  #define T14_INNER "should_not_exist"
  #elif 1
  #define T14_INNER "also_should_not"
  #endif
#define T14 "should_not_exist"
#elif 1
#define T14 "correct"
#endif

// === #elif doesn't activate when earlier elif was true ===
#if 0
#define T15 "first"
#elif 1
#define T15 "second"
#elif 1
#define T15 "third"
#else
#define T15 "else"
#endif

// === Variables/functions gated by #elif ===
#define MODE 2
#if MODE == 1
int get_mode(void) { return 1; }
#elif MODE == 2
int get_mode(void) { return 2; }
#elif MODE == 3
int get_mode(void) { return 3; }
#else
int get_mode(void) { return 0; }
#endif

int main() {
    printf("T1 (if true, elif true): %s\n", T1);
    printf("T2 (if false, elif true): %s\n", T2);
    printf("T3 (if false, elif false): %s\n", T3);
    printf("T4 (multi elif, first true): %s\n", T4);
    printf("T5 (multi elif, middle true): %s\n", T5);
    printf("T6 (multi elif, none true): %s\n", T6);
    printf("T7 (elif with expr): %s\n", T7);
    printf("T8 (elif with defined): %s\n", T8);
    printf("T9 (ifdef then elif): %s\n", T9);
    printf("T10 (ifndef then elif): %s\n", T10);
    printf("T11 (undef == undef): %s\n", T11);
    printf("T12 (DOOM pattern): %s\n", T12);
    printf("T13 (nested if in elif): %s\n", T13);
    printf("T14 (nested elif in inactive): %s\n", T14);
#ifdef T14_INNER
    printf("BUG: T14_INNER should not be defined\n");
#endif
    printf("T15 (elif stops after first match): %s\n", T15);
    printf("get_mode(): %d\n", get_mode());
    return 0;
}
