// samples/03.c - Tests for function-style macros

#include <stdio.h>

// === Basic Function Macros ===

#define ADD(a, b) ((a) + (b))
#define SUB(a, b) ((a) - (b))
#define MUL(x, y) ((x) * (y))
#define DIV(x, y) ((x) / (y))
#define MOD(x, y) ((x) % (y))

// === Macros with Single Argument ===

#define SQUARE(x) ((x) * (x))
#define CUBE(x) ((x) * (x) * (x))
#define DOUBLE(x) ((x) + (x))
#define NEGATE(x) (-(x))
#define ABS(x) ((x) < 0 ? -(x) : (x))

// === Macros Using Other Macros ===

#define SUM3(a, b, c) ADD(ADD(a, b), c)
#define SUM4(a, b, c, d) ADD(SUM3(a, b, c), d)
#define DIFF_OF_SQUARES(a, b) SUB(SQUARE(a), SQUARE(b))

// === Conditional/Ternary Macros ===

#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define CLAMP(x, lo, hi) (MIN(MAX(x, lo), hi))
#define IS_POSITIVE(x) ((x) > 0)
#define IS_EVEN(x) (((x) % 2) == 0)
#define IS_ODD(x) (((x) % 2) != 0)

// === Logical Macros ===

#define AND(a, b) ((a) && (b))
#define OR(a, b) ((a) || (b))
#define NOT(a) (!(a))
#define XOR(a, b) (((a) && !(b)) || (!(a) && (b)))

// === Bitwise Macros ===

#define BIT_AND(a, b) ((a) & (b))
#define BIT_OR(a, b) ((a) | (b))
#define BIT_XOR(a, b) ((a) ^ (b))
#define BIT_NOT(a) (~(a))
#define LEFT_SHIFT(a, n) ((a) << (n))
#define RIGHT_SHIFT(a, n) ((a) >> (n))

// === Comparison Macros ===

#define EQ(a, b) ((a) == (b))
#define NE(a, b) ((a) != (b))
#define LT(a, b) ((a) < (b))
#define LE(a, b) ((a) <= (b))
#define GT(a, b) ((a) > (b))
#define GE(a, b) ((a) >= (b))

// === Deeply Nested Macros ===

#define NEST1(x) ADD(x, 1)
#define NEST2(x) NEST1(NEST1(x))
#define NEST3(x) NEST2(NEST1(x))
#define NEST4(x) NEST2(NEST2(x))

// === Macros with Complex Expressions as Arguments ===

#define APPLY_TWICE(f, x) f(f(x))

// === Object-like macro mixed with function-like ===

#define TEN 10
#define ADD_TEN(x) ADD(x, TEN)

// === Zero-argument function macro ===

#define ZERO() 0
#define ONE() 1
#define FORTY_TWO() 42

// === Macro that uses its argument multiple times ===

#define USE_THRICE(x) ((x) + (x) + (x))

int main() {
  printf("%s\n", "=== Basic Arithmetic Macros ===");
  printf("%d\n", ADD(3, 5));      // 8
  printf("%d\n", SUB(10, 4));     // 6
  printf("%d\n", MUL(6, 7));      // 42
  printf("%d\n", DIV(20, 4));     // 5
  printf("%d\n", MOD(17, 5));     // 2

  printf("%s\n", "=== Single Argument Macros ===");
  printf("%d\n", SQUARE(5));      // 25
  printf("%d\n", CUBE(3));        // 27
  printf("%d\n", DOUBLE(8));      // 16
  printf("%d\n", NEGATE(7));      // -7
  printf("%d\n", ABS(-15));       // 15
  printf("%d\n", ABS(20));        // 20

  printf("%s\n", "=== Expression Arguments (tests proper parenthesization) ===");
  printf("%d\n", SQUARE(2 + 3));  // 25, not 11
  printf("%d\n", DOUBLE(3 * 4));  // 24, not 18
  printf("%d\n", ADD(1 + 2, 3 + 4)); // 10

  printf("%s\n", "=== Nested Macro Calls ===");
  printf("%d\n", SUM3(1, 2, 3));  // 6
  printf("%d\n", SUM4(1, 2, 3, 4)); // 10
  printf("%d\n", ADD(MUL(2, 3), MUL(4, 5))); // 26
  printf("%d\n", DIFF_OF_SQUARES(5, 3)); // 25 - 9 = 16
  printf("%d\n", MUL(ADD(1, 2), SUB(10, 6))); // 3 * 4 = 12

  printf("%s\n", "=== Ternary/Conditional Macros ===");
  printf("%d\n", MAX(10, 20));    // 20
  printf("%d\n", MAX(30, 15));    // 30
  printf("%d\n", MIN(10, 20));    // 10
  printf("%d\n", MIN(30, 15));    // 15
  printf("%d\n", CLAMP(5, 0, 10));   // 5
  printf("%d\n", CLAMP(-5, 0, 10));  // 0
  printf("%d\n", CLAMP(15, 0, 10));  // 10
  printf("%d\n", IS_POSITIVE(5));    // 1
  printf("%d\n", IS_POSITIVE(-5));   // 0
  printf("%d\n", IS_EVEN(4));     // 1
  printf("%d\n", IS_EVEN(7));     // 0
  printf("%d\n", IS_ODD(4));      // 0
  printf("%d\n", IS_ODD(7));      // 1

  printf("%s\n", "=== Logical Macros ===");
  printf("%d\n", AND(1, 1));      // 1
  printf("%d\n", AND(1, 0));      // 0
  printf("%d\n", OR(0, 0));       // 0
  printf("%d\n", OR(0, 1));       // 1
  printf("%d\n", NOT(0));         // 1
  printf("%d\n", NOT(1));         // 0
  printf("%d\n", XOR(1, 0));      // 1
  printf("%d\n", XOR(1, 1));      // 0

  printf("%s\n", "=== Bitwise Macros ===");
  printf("%d\n", BIT_AND(0xF0, 0x0F));  // 0
  printf("%d\n", BIT_OR(0xF0, 0x0F));   // 255
  printf("%d\n", BIT_XOR(0xFF, 0x0F)); // 240
  printf("%d\n", LEFT_SHIFT(1, 4));    // 16
  printf("%d\n", RIGHT_SHIFT(64, 3));  // 8

  printf("%s\n", "=== Comparison Macros ===");
  printf("%d\n", EQ(5, 5));       // 1
  printf("%d\n", EQ(5, 6));       // 0
  printf("%d\n", NE(5, 6));       // 1
  printf("%d\n", LT(3, 5));       // 1
  printf("%d\n", LE(5, 5));       // 1
  printf("%d\n", GT(7, 4));       // 1
  printf("%d\n", GE(4, 4));       // 1

  printf("%s\n", "=== Deeply Nested Macros ===");
  printf("%d\n", NEST1(0));       // 1
  printf("%d\n", NEST2(0));       // 2
  printf("%d\n", NEST3(0));       // 3
  printf("%d\n", NEST4(0));       // 4

  printf("%s\n", "=== Apply Twice Pattern ===");
  printf("%d\n", APPLY_TWICE(SQUARE, 2));  // SQUARE(SQUARE(2)) = SQUARE(4) = 16
  printf("%d\n", APPLY_TWICE(DOUBLE, 3));  // DOUBLE(DOUBLE(3)) = DOUBLE(6) = 12

  printf("%s\n", "=== Mixed Object-like and Function-like ===");
  printf("%d\n", ADD_TEN(5));     // 15
  printf("%d\n", MUL(TEN, TEN));  // 100

  printf("%s\n", "=== Zero-argument Macros ===");
  printf("%d\n", ZERO());         // 0
  printf("%d\n", ONE());          // 1
  printf("%d\n", FORTY_TWO());    // 42
  printf("%d\n", ADD(ZERO(), ONE())); // 1

  printf("%s\n", "=== Multiple Uses of Argument ===");
  printf("%d\n", USE_THRICE(7));  // 21

  printf("%s\n", "=== Variables as Arguments ===");
  int x = 10;
  int y = 3;
  printf("%d\n", ADD(x, y));      // 13
  printf("%d\n", MUL(x, y));      // 30
  printf("%d\n", MAX(x, y));      // 10
  printf("%d\n", SQUARE(x));      // 100

  printf("%s\n", "=== Complex Nested Expressions ===");
  printf("%d\n", MAX(ADD(1, 2), MUL(1, 2)));  // MAX(3, 2) = 3
  printf("%d\n", ADD(MAX(5, 3), MIN(5, 3))); // 5 + 3 = 8
  printf("%d\n", SQUARE(ADD(1, 1)));  // SQUARE(2) = 4
  printf("%d\n", ADD(SQUARE(2), SQUARE(3))); // 4 + 9 = 13

  printf("%s\n", "=== Macros with Array Access ===");
  int arr[5];
  arr[0] = 10;
  arr[1] = 20;
  arr[2] = 30;
  printf("%d\n", ADD(arr[0], arr[1]));  // 30
  printf("%d\n", MAX(arr[1], arr[2]));  // 30

  printf("%s\n", "=== Macros with Pointer Dereference ===");
  int val[1];
  val[0] = 42;
  int *ptr = val;
  printf("%d\n", DOUBLE(*ptr));   // 84

  printf("%s\n", "=== Macros in Control Flow ===");
  int sum = 0;
  for (int i = 0; i < 5; i = ADD(i, 1)) {
    sum = ADD(sum, SQUARE(i));
  }
  printf("%d\n", sum);  // 0 + 1 + 4 + 9 + 16 = 30

  if (IS_EVEN(10)) {
    printf("%d\n", 1);  // 1
  }

  int result = IS_POSITIVE(x) ? SQUARE(x) : NEGATE(x);
  printf("%d\n", result);  // 100

  printf("%s\n", "=== Floating Point with Macros ===");
  double a = 3.5;
  double b = 2.0;
  printf("%f\n", a + b);  // 5.5 (can't use ADD directly due to int cast issues)

  printf("%s\n", "=== All tests passed! ===");
  return 0;
}
