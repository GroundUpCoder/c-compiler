// Corner cases for pointer arithmetic codegen scaling.
// Exercises every scaling site in the codegen helper:
//   - emitLValue ESubscript    (a[i] as lvalue)
//   - _addressOf ESubscript    (&a[i])
//   - emitCompoundAssign       (p += i, p -= i)
//   - emitBinary ADD           (p + i, i + p, arr + i)
//   - emitBinary SUB ptr-ptr   (p1 - p2)
//   - emitBinary SUB ptr-int   (p - i)
//   - emitExpr ESubscript      (a[i] as rvalue)

#include <stdio.h>

struct S16 { int a; int b; int c; int d; };  // 16 bytes

int main(void) {
  // --- elemSize == 1: char arrays exercise the "skip i32Const" branch ---
  char cbuf[8] = {'a','b','c','d','e','f','g','h'};
  char *cp = cbuf;
  printf("char rvalue subscript: %c\n", cbuf[3]);              // d
  printf("char lvalue subscript: ");
  cbuf[2] = 'Z'; printf("%c\n", cbuf[2]);                      // Z
  char *cp_addr = &cbuf[5];
  printf("char &subscript: %c\n", *cp_addr);                   // f
  cp += 2;
  printf("char += int: %c\n", *cp);                            // c
  cp -= 1;
  printf("char -= int: %c\n", *cp);                            // b
  printf("char p+i: %c\n", *(cbuf + 4));                       // e
  printf("char p-i: %c\n", *(cbuf + 7 - 3));                   // e
  char *cend = cbuf + 7;
  printf("char p1-p2: %d\n", (int)(cend - cbuf));              // 7

  // --- elemSize == 4: int arrays ---
  int iarr[6] = {10, 20, 30, 40, 50, 60};
  int *ip = iarr;
  printf("int rvalue: %d\n", iarr[2]);                         // 30
  iarr[3] = 999; printf("int lvalue: %d\n", iarr[3]);          // 999
  int *ip_addr = &iarr[4];
  printf("int &subscript: %d\n", *ip_addr);                    // 50
  ip += 2;
  printf("int += int: %d\n", *ip);                             // 30
  ip -= 1;
  printf("int -= int: %d\n", *ip);                             // 20
  int *iend = iarr + 5;
  printf("int p1-p2: %d\n", (int)(iend - iarr));               // 5

  // --- elemSize == 16: struct arrays exercise non-power-of-2 strides ---
  struct S16 sarr[4] = {{1,2,3,4},{5,6,7,8},{9,10,11,12},{13,14,15,16}};
  struct S16 *sp = sarr;
  printf("struct subscript: %d %d\n", sarr[2].a, sarr[2].d);   // 9 12
  struct S16 *sp_addr = &sarr[3];
  printf("struct &subscript: %d\n", sp_addr->a);               // 13
  sp += 2;
  printf("struct += int: %d\n", sp->a);                        // 9
  sp -= 1;
  printf("struct -= int: %d\n", sp->a);                        // 5
  struct S16 *send = sarr + 4;
  printf("struct p1-p2: %d\n", (int)(send - sarr));            // 4

  // --- i64 indices and i64 offsets exercise WRAP_I64 narrow ---
  long long lli = 2;
  printf("int[i64]: %d\n", iarr[lli]);                         // 30 (after lvalue write was 999)
  // restore
  iarr[3] = 40;
  printf("int + i64: %d\n", *(iarr + lli));                    // 30
  long long lloff = 3;
  int *ipi64 = iarr;
  ipi64 += lloff;
  printf("int += i64: %d\n", *ipi64);                          // 40
  ipi64 -= lloff;
  printf("int -= i64: %d\n", *ipi64);                          // 10
  printf("int - i64: %d\n", *(iarr + 5 - lloff));              // 30

  unsigned long long ulli = 1ULL;
  printf("int[u64]: %d\n", iarr[ulli]);                        // 20

  // --- i + p (commuted form) ---
  printf("i + p: %d\n", *(2 + iarr));                          // 30

  // --- struct array with i64 index ---
  long long si = 2LL;
  printf("struct[i64]: %d\n", sarr[si].a);                     // 9

  // --- i64 ptr-int diff (right side i64) ---
  int *itail = iarr + 5;
  long long step = 2LL;
  printf("int p - i64: %d\n", *(itail - step));                // 40

  printf("PASS\n");
  return 0;
}
