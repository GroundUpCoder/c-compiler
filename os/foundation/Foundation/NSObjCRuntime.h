#ifndef GUC_FOUNDATION_NSOBJCRUNTIME_H
#define GUC_FOUNDATION_NSOBJCRUNTIME_H
#ifndef __OBJC__
#error Foundation requires Objective-C (.m)
#endif
__require_source("foundation/NSObject.m");
__require_source("foundation/NSAutoreleasePool.m");
typedef unsigned int NSUInteger;
typedef int NSInteger;
typedef signed char BOOL;
#define YES ((BOOL)1)
#define NO ((BOOL)0)
#endif
