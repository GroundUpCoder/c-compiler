#include "array-cross.h"
NSArray *makeArray(void) {
 NSMutableArray *a=[NSMutableArray array];
 for(int i=0;i<33;i++)[a addObject:[NSString stringWithUTF8String:"cross😀"]];
 return a;
}
