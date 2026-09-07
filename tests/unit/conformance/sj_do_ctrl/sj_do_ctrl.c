// BUG: #432 rejected setjmp in do-while controlling expressions.
// C11: 7.13.1.1p4 covers all iteration statements.
// EXPECT: first-iteration break/continue, nested targets and longjmp resume correctly.
#include <setjmp.h>
#include <stdio.h>
static jmp_buf b;
static int n, after, first, k;
int main(void) {
  n=0;
  do { n++; break; } while (setjmp(b)==0);
  printf("first-break=%d\n",n);
  n=0;
  do { n++; if(n==1) continue; longjmp(b,2); } while (setjmp(b)<2);
  printf("continue-jump=%d\n",n);
  n=0;
  do {
    n++;
    for(k=0;k<2;k++) { if(!k) continue; break; }
    switch(n) { case 1: break; default: longjmp(b,3); }
  } while(setjmp(b)!=3);
  printf("nested=%d\n",n);
  n=after=0;
  do { n++; } while(setjmp(b)==2);
  if(!after) { after=1; longjmp(b,2); }
  printf("after-loop=%d\n",n);
  // No arm has occurred in the initial do body: the older environment wins.
  first=0;
  if(setjmp(b)==0) {
    do { first++; longjmp(b,5); } while(setjmp(b)==0);
  }
  printf("old-environment=%d\n",first);
  return 0;
}
