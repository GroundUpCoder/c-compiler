// BUG: indirect variadic calls must preserve the named float parameter type.
// C11: 6.5.2.2p7, default argument promotions apply after the last declared parameter.
// EXPECT: 3.75
#include <stdarg.h>
#include <stdio.h>
double sum(float first, int count, ...) {
  va_list ap; va_start(ap,count); double second=va_arg(ap,double);
  va_end(ap); return first+second;
}
double (*volatile call)(float,int,...)=sum;
int main(void) { printf("%.2f\n",call(1.25f,1,2.5f)); return 0; }
