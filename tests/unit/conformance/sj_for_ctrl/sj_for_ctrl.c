// BUG: #432 rejected setjmp in for controlling expressions.
// C11: 7.13.1.1p4 covers all iteration statements.
// EXPECT: init once, continue runs increment, longjmp resumes condition without increment.
#include <setjmp.h>
#include <stdio.h>
static jmp_buf b;
static int n, inc, init, after, k;
int main(void) {
  n=inc=init=0;
  for(init++; setjmp(b)<3; inc++) {
    n++;
    if(n==1) continue;
    longjmp(b,3);
  }
  printf("round-trip=%d,%d,%d\n",init,n,inc);
  n=inc=0;
  for(;setjmp(b)==0;inc++) { n++; break; }
  printf("break=%d,%d\n",n,inc);
  n=inc=after=0;
  for(;setjmp(b)==2;inc++) {
    n++;
    for(k=0;k<2;k++) { if(!k) continue; break; }
    switch(n) { case 1: continue; default: break; }
  }
  if(!after) { after=1; longjmp(b,2); }
  printf("after-loop=%d,%d\n",n,inc);
  n=inc=0;
  for(;setjmp(b)==0;longjmp(b,1)) n++;
  printf("increment-jump=%d\n",n);
  return 0;
}
