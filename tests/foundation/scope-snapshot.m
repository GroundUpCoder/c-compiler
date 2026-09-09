/* Permanent regression adapted from independent reviewer 01a0834a's probes. */
#include <Foundation/Foundation.h>
#include <stdio.h>
struct Value { int n; double d; };
static struct Value value = {11, 2.5};
static int deaths;
@interface Mutator : NSObject
- (void)dealloc;
- (struct Value)snapshot;
@end
@implementation Mutator
- (void)dealloc { deaths++; value.n = 99; value.d = 8.5; [super dealloc]; }
- (struct Value)snapshot {
    @autoreleasepool { [[Mutator new] autorelease]; return value; }
}
@end
static struct Value snapshot(void) {
    @autoreleasepool { [[Mutator new] autorelease]; return value; }
}
int main(void) {
    struct Value a = snapshot();
    if (a.n != 11 || a.d != 2.5 || deaths != 1 || value.n != 99) return 1;
    value.n = 11; value.d = 2.5;
    Mutator *receiver = [Mutator new];
    struct Value b = [receiver snapshot];
    if (b.n != 11 || b.d != 2.5 || deaths != 2 || value.n != 99) return 2;
    [receiver release];
    if (deaths != 3) return 3;
    puts("FOUNDATION aggregate snapshot PASS"); return 0;
}
