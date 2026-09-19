#include <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>
static unsigned destroyed;
@interface StringFailure : NSString
- (void)dealloc;
@end
@implementation StringFailure
- (void)dealloc {destroyed++;[super dealloc];}
@end
int main(void) {
  unichar units[4096]; for(unsigned i=0;i<4096;i++)units[i]='x';
  NSString *existing=[[NSString alloc] initWithCharacters:units length:4096];
  NSString *pending=[NSString alloc];
  StringFailure *custom=[StringFailure alloc];
  NSConstantString *constant=[NSConstantString alloc];
  void *spare=malloc(256);
  if(!existing || !pending || !custom || !constant || !spare)return 1;
  while(malloc(8)) {}
  if([NSString alloc]!=nil || [existing UTF8String]!=NULL)return 2;
  if([pending initWithCharacters:units length:4096]!=nil)return 3;
  if([custom initWithString:existing]!=nil || destroyed!=1)return 4;
  if([constant initWithCharacters:units length:4096]!=nil)return 5;
  free(spare);
  /* Enough for the temporary owner, not its 4097-byte output. Repetition
     exposes leaks on failure; the surviving string's backing stays intact. */
  for(unsigned i=0;i<100;i++) {
    if([existing UTF8String]!=NULL)return 6;
    void *available=malloc(128);if(!available)return 7;free(available);
  }
  if([existing length]!=4096 || [existing characterAtIndex:4095]!='x')return 8;
  [existing release];
  puts("FOUNDATION string allocation rollback PASS");return 0;
}
