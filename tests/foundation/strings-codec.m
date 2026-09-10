#include <Foundation/Foundation.h>
#include <stdio.h>
#include <string.h>
#define CHECK(x) do {if(!(x)){printf("codec check line %d\n",__LINE__);return 1;}}while(0)
int main(void) {
  /* Every individual UTF16 unit: exact storage, strict output, and byte-input
     roundtrip. FEFF is excluded from roundtrip because byte decoding consumes BOM. */
  for(unsigned base=0;base<65536;base+=256) { @autoreleasepool {
    for(unsigned v=base;v<base+256;v++) {
      unichar unit=(unichar)v;
      NSString *s=[[NSString alloc] initWithCharacters:&unit length:1];
      CHECK(s && [s length]==1 && [s characterAtIndex:0]==v);
      const char *u=[s UTF8String];
      if(v>=0xd800 && v<=0xdfff) CHECK(u==NULL);
      else {
        CHECK(u!=NULL); NSUInteger n=[s lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
        CHECK(n==(v<128?1:v<2048?2:3) && u[n]==0);
        NSString *back=[[NSString alloc] initWithBytes:u length:n encoding:NSUTF8StringEncoding];
        CHECK(back && (v==0xfeff ? [back length]==0 : [back isEqualToString:s])); [back release];
      }
      [s release];
    }
  }}
  /* Surrogate pair boundaries across all high surrogates and representative
     low values, including transitions and the largest Unicode scalar. */
  const unichar lows[]={0xdc00,0xdc01,0xddff,0xde00,0xdffe,0xdfff};
  for(unsigned high=0xd800;high<=0xdbff;high++) { @autoreleasepool {
    for(unsigned j=0;j<6;j++) {
      unichar pair[]={(unichar)high,lows[j]};
      NSString *s=[[NSString alloc] initWithCharacters:pair length:2];
      const char *u=[s UTF8String];CHECK(u && [s lengthOfBytesUsingEncoding:NSUTF8StringEncoding]==4);
      NSString *back=[[NSString alloc] initWithBytes:u length:4 encoding:NSUTF8StringEncoding];
      CHECK(back && [back isEqualToString:s]); [back release]; [s release];
    }
  }}
  puts("FOUNDATION exhaustive UTF16 codec PASS");return 0;
}
