// samples/01.c - Demonstrates the edge of what this compiler supports
// Everything here compiles and runs.

#include <stdio.h>

// === Global Variables ===

int g_counter = 100;
int g_multiplier = 3;
long long g_big = 1000000LL;
double g_pi = 3.14159;

int get_counter() { return g_counter; }

void increment_counter() { g_counter = g_counter + 1; }

int use_multiplier(int x) { return x * g_multiplier; }

// === Global Arrays ===

int g_arr[5];
char g_msg[10];

int sum_array(int *arr, int len) {
  int sum = 0;
  for (int i = 0; i < len; i++) {
    sum += arr[i];
  }
  return sum;
}

// Function with local array (uses stack allocation)
int local_array_sum() {
  int arr[4];
  arr[0] = 10;
  arr[1] = 20;
  arr[2] = 30;
  arr[3] = 40;
  int sum = 0;
  for (int i = 0; i < 4; i++) {
    sum += arr[i];
  }
  return sum;
}

// === Basic Functions ===

int add(int a, int b) { return a + b; }

int max(int a, int b) {
  if (a > b) {
    return a;
  } else {
    return b;
  }
}

int abs_val(int x) {
  if (x < 0) {
    return -x;
  }
  return x;
}

// === Recursion ===

int factorial(int n) {
  if (n <= 1) {
    return 1;
  }
  return n * factorial(n - 1);
}

int fib(int n) {
  if (n <= 1) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}

long long fib64(long long n) {
  if (n <= 1LL) {
    return n;
  }
  return fib64(n - 1LL) + fib64(n - 2LL);
}

// === Nested Conditions ===

int clamp(int x, int lo, int hi) {
  if (x < lo) {
    return lo;
  }
  if (x > hi) {
    return hi;
  }
  return x;
}

int sign(int x) {
  if (x > 0) {
    return 1;
  } else if (x < 0) {
    return -1;
  } else {
    return 0;
  }
}

// === Floating Point ===

float float_abs(float x) {
  if (x < 0.0f) {
    return -x;
  }
  return x;
}

double newton_sqrt(double x) {
  // Newton's method for square root (fixed iterations, no loops yet)
  double guess = x / 2.0;
  guess = (guess + x / guess) / 2.0;
  guess = (guess + x / guess) / 2.0;
  guess = (guess + x / guess) / 2.0;
  guess = (guess + x / guess) / 2.0;
  guess = (guess + x / guess) / 2.0;
  guess = (guess + x / guess) / 2.0;
  guess = (guess + x / guess) / 2.0;
  guess = (guess + x / guess) / 2.0;
  return guess;
}

// === Bitwise Operations ===

int count_bits_8(int n) {
  // Count set bits in lowest 8 bits (no loops, manually unrolled)
  int count = 0;
  if (n & 1) count = count + 1;
  if (n & 2) count = count + 1;
  if (n & 4) count = count + 1;
  if (n & 8) count = count + 1;
  if (n & 16) count = count + 1;
  if (n & 32) count = count + 1;
  if (n & 64) count = count + 1;
  if (n & 128) count = count + 1;
  return count;
}

int is_power_of_two(int n) {
  if (n <= 0) {
    return 0;
  }
  return (n & (n - 1)) == 0;
}

// === Loops ===

int sum_to_n(int n) {
  int sum = 0;
  for (int i = 1; i <= n; i++) {
    sum = sum + i;
  }
  return sum;
}

int factorial_iter(int n) {
  int result = 1;
  for (int i = 2; i <= n; i++) {
    result = result * i;
  }
  return result;
}

int fib_iter(int n) {
  if (n <= 1) return n;
  int a = 0;
  int b = 1;
  for (int i = 2; i <= n; i++) {
    int tmp = a + b;
    a = b;
    b = tmp;
  }
  return b;
}

int gcd(int a, int b) {
  // Euclidean algorithm with modulo
  while (b != 0) {
    int tmp = b;
    b = a % b;
    a = tmp;
  }
  return a;
}

int is_prime(int n) {
  if (n < 2) return 0;
  if (n == 2) return 1;
  if (n % 2 == 0) return 0;
  for (int i = 3; i * i <= n; i += 2) {
    if (n % i == 0) return 0;
  }
  return 1;
}

int count_digits(int n) {
  if (n < 0) n = -n;
  int count = 0;
  do {
    count++;
    n = n / 10;
  } while (n > 0);
  return count;
}

int sum_matrix(int rows, int cols) {
  int sum = 0;
  for (int i = 0; i < rows; i++) {
    for (int j = 0; j < cols; j++) {
      sum += i * cols + j;
    }
  }
  return sum;
}

// === Break and Continue ===

int find_first_divisor(int n) {
  for (int i = 2; i < n; i++) {
    if (n % i == 0) {
      return i;  // Could also use break here
    }
  }
  return n;  // n is prime
}

int sum_non_divisible(int n, int d) {
  int sum = 0;
  for (int i = 1; i <= n; i++) {
    if (i % d == 0) continue;
    sum += i;
  }
  return sum;
}

int find_pair_sum(int target, int max) {
  for (int i = 1; i <= max; i++) {
    for (int j = i; j <= max; j++) {
      if (i + j == target) {
        return i * 1000 + j;  // Encode both values
      }
      if (i + j > target) break;  // No point continuing inner loop
    }
  }
  return -1;
}

// === Switch Statements ===

int day_type(int day) {
  switch (day) {
    case 0:
    case 6:
      return 0;  // Weekend
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
      return 1;  // Weekday
    default:
      return -1;  // Invalid
  }
}

int month_days(int month, int is_leap) {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      if (is_leap) return 29;
      return 28;
    default:
      return -1;
  }
}

int fall_through_sum(int n) {
  int result = 0;
  switch (n) {
    case 5:
      result += 5;
    case 4:
      result += 4;
    case 3:
      result += 3;
    case 2:
      result += 2;
    case 1:
      result += 1;
    default:
      break;
  }
  return result;
}

int main() {
  // Basic arithmetic
  printf("%d\n", add(100, 23));  // 123
  printf("%d\n", max(10, 20));   // 20
  printf("%d\n", max(30, 5));    // 30
  printf("%d\n", abs_val(-42));  // 42

  // Recursion
  printf("%d\n", factorial(5));   // 120
  printf("%d\n", factorial(10));  // 3628800
  printf("%d\n", fib(10));        // 55
  printf("%d\n", fib(20));        // 6765
  printf("%lld\n", fib64(30LL));    // 832040

  // Nested conditions
  printf("%d\n", clamp(5, 0, 10));   // 5
  printf("%d\n", clamp(-5, 0, 10));  // 0
  printf("%d\n", clamp(15, 0, 10));  // 10
  printf("%d\n", sign(42));          // 1
  printf("%d\n", sign(-42));         // -1
  printf("%d\n", sign(0));           // 0

  // Floating point
  printf("%f\n", (double)float_abs(-3.14f));   // 3.14
  printf("%f\n", newton_sqrt(2.0));    // ~1.414...
  printf("%f\n", newton_sqrt(100.0));  // 10.0

  // Bitwise
  printf("%d\n", count_bits_8(0xFF));   // 8
  printf("%d\n", count_bits_8(0x55));   // 4
  printf("%d\n", count_bits_8(0));      // 0
  printf("%d\n", is_power_of_two(16));  // 1
  printf("%d\n", is_power_of_two(15));  // 0

  // Loops (while, for, do-while)
  printf("%d\n", sum_to_n(10));         // 55
  printf("%d\n", sum_to_n(100));        // 5050
  printf("%d\n", factorial_iter(10));   // 3628800
  printf("%d\n", fib_iter(30));         // 832040
  printf("%d\n", gcd(48, 18));          // 6
  printf("%d\n", gcd(100, 35));         // 5
  printf("%d\n", is_prime(17));         // 1
  printf("%d\n", is_prime(18));         // 0
  printf("%d\n", is_prime(997));        // 1
  printf("%d\n", count_digits(12345));  // 5
  printf("%d\n", sum_matrix(3, 4));     // 66

  // Break and continue
  printf("%d\n", find_first_divisor(15));    // 3
  printf("%d\n", find_first_divisor(17));    // 17 (prime)
  printf("%d\n", sum_non_divisible(10, 3));  // 1+2+4+5+7+8+10 = 37
  printf("%d\n", find_pair_sum(10, 5));      // 5005 (5+5)

  // Switch statements
  printf("%d\n", day_type(0));          // 0 (weekend)
  printf("%d\n", day_type(3));          // 1 (weekday)
  printf("%d\n", day_type(7));          // -1 (invalid)
  printf("%d\n", month_days(1, 0));     // 31
  printf("%d\n", month_days(2, 0));     // 28
  printf("%d\n", month_days(2, 1));     // 29
  printf("%d\n", fall_through_sum(5));  // 15
  printf("%d\n", fall_through_sum(3));  // 6

  // Global variables
  printf("%d\n", g_counter);      // 100
  printf("%d\n", get_counter());  // 100
  increment_counter();
  printf("%d\n", g_counter);          // 101
  printf("%d\n", use_multiplier(7));  // 21
  g_counter += 50;
  printf("%d\n", g_counter);  // 151
  printf("%lld\n", g_big);      // 1000000
  printf("%f\n", g_pi);       // 3.14159

  // String literals and concatenation
  printf("%s\n", "Hello from string literal!");
  printf("%s\n",
      "Concat"
      "enation "
      "works!");
  const char *msg = "Testing pointers";
  printf("%s\n", msg);
  const char *same1 = "Dedupe";
  const char *same2 = "Dedupe";
  printf("%d\n", same1 == same2);  // 1 (string deduplication)

  // Char literals
  printf("%d\n", 'A');        // 65
  printf("%d\n", 'z' - 'a');  // 25
  printf("%d\n", '\n');       // 10

  // Global arrays
  g_arr[0] = 10;
  g_arr[1] = 20;
  g_arr[2] = 30;
  g_arr[3] = 40;
  g_arr[4] = 50;
  printf("%d\n", g_arr[0]);             // 10
  printf("%d\n", g_arr[4]);             // 50
  printf("%d\n", sum_array(g_arr, 5));  // 150
  g_arr[2] += 100;
  printf("%d\n", g_arr[2]);  // 130

  // Char array as string
  g_msg[0] = 'O';
  g_msg[1] = 'K';
  g_msg[2] = 0;
  printf("%s\n", g_msg);  // "OK"

  // Local arrays (stack allocated)
  printf("%d\n", local_array_sum());  // 100
  int local_arr[3];
  local_arr[0] = 5;
  local_arr[1] = 6;
  local_arr[2] = 7;
  printf("%d\n", local_arr[0] + local_arr[1] + local_arr[2]);  // 18

  // sizeof operator
  printf("%d\n", sizeof(int));        // 4
  printf("%d\n", sizeof(char));       // 1
  printf("%d\n", sizeof(long long));  // 8
  printf("%d\n", sizeof(double));     // 8
  int sizeof_test = 42;
  printf("%d\n", sizeof(sizeof_test));  // 4

  // Type casts
  int cast_int = 10;
  printf("%f\n", (double)(float)cast_int);    // 10.0
  printf("%f\n", (double)cast_int);   // 10.0
  float cast_float = 3.7f;
  printf("%d\n", (int)cast_float);    // 3 (truncation)
  double cast_double = 9.9;
  printf("%d\n", (int)cast_double);   // 9 (truncation)
  printf("%f\n", (double)cast_float); // 3.7
  long long cast_i64 = (long long)cast_int;
  printf("%lld\n", cast_i64);           // 10

  // Ternary operator
  int ta = 5;
  int tb = 10;
  int tmax = ta > tb ? ta : tb;
  printf("%d\n", tmax);               // 10
  int tmin = ta < tb ? ta : tb;
  printf("%d\n", tmin);               // 5
  int tcond = 1;
  int tresult = tcond ? 100 : 200;
  printf("%d\n", tresult);            // 100
  // Nested ternary (sign function)
  int tval = -42;
  int tsign = tval > 0 ? 1 : (tval < 0 ? -1 : 0);
  printf("%d\n", tsign);              // -1

  return 0;
}

/*
 * INTENTIONAL LIMITATIONS (by design, not bugs):
 *
 * 1. Address-of scalar variables is not supported:
 *      int x = 42;
 *      int *p = &x;  // ERROR
 *
 *    Workaround: use a single-element array instead:
 *      int x[1];
 *      x[0] = 42;
 *      int *p = x;   // OK - array decays to pointer
 *      int *p = &x[0]; // Also OK
 *
 *    This keeps the compiler simpler while still allowing addressable storage.
 */
