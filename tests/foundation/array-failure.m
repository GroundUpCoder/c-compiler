#include <Foundation/Foundation.h>
#include <limits.h>
int main(int argc,char **argv) {
 @autoreleasepool {
  if(argc>1 && argv[1][0]=='c') [NSMutableArray arrayWithCapacity:UINT_MAX];
  else if(argc>1 && argv[1][0]=='a') [NSMutableArray arrayWithCapacity:100000000];
  else {NSMutableArray *a=[NSMutableArray arrayWithObject:@"x"];[a addObject:@"y"];for(id x in a)[a removeAllObjects];}
 }
 return 0;
}
