#include <Foundation/NSException.h>
#include <Foundation/NSAutoreleasePool.h>
#include <stdio.h>
#define CHECK(x) do {if(!(x)){printf("exception check line %d\n",__LINE__);return 1;}}while(0)
@interface ExternalString : NSString { @public unichar value; }
- (NSUInteger)length;
- (unichar)characterAtIndex:(NSUInteger)i;
@end
@implementation ExternalString
- (NSUInteger)length {return 1;}
- (unichar)characterAtIndex:(NSUInteger)i {return value;}
@end
/* This object tests opaque MRC retention only; it is not a collection fixture. */
static unsigned infoDeaths;
@interface InfoOwner : NSObject
- (void)dealloc;
@end
@implementation InfoOwner
- (void)dealloc {infoDeaths++;[super dealloc];}
@end
int main(void) { @autoreleasepool {
  CHECK([NSException new]==nil);
  NSException *e=[[NSException alloc] initWithName:nil reason:nil userInfo:nil];
  CHECK(e && [e name]==nil && [e reason]==nil && [e userInfo]==nil);[e release];
  ExternalString *name=[ExternalString new],*reason=[ExternalString new];
  name->value='N';reason->value='R'; InfoOwner *info=[InfoOwner new];
  e=[[NSException alloc] initWithName:name reason:reason userInfo:(NSDictionary *)info];
  name->value='X';reason->value='Y';[name release];[reason release];[info release];
  CHECK(e && [[e name] isEqualToString:@"N"] && [[e reason] isEqualToString:@"R"]);
  CHECK([e userInfo]==(NSDictionary *)info && infoDeaths==0);
  unsigned caught=0;
  @try { [e raise]; }
  @catch(NSException *caughtException) {CHECK(caughtException==e);caught++;}
  CHECK(caught==1); [e release]; CHECK(infoDeaths==1);
  e=[NSException exceptionWithName:@"test" reason:nil userInfo:nil];
  @try { @try {[e raise];} @catch(NSException *x) {x=nil;@throw;} }
  @catch(NSException *x) {CHECK(x==e);caught++;}
  CHECK(caught==2);
  for(unsigned mode=0;mode<4;mode++) {
    NSString *receiver=[NSString alloc];
    @try {
      if(mode==0) [receiver initWithUTF8String:NULL];
      else if(mode==1) [receiver initWithString:nil];
      /* NULL/nonzero is a defensive extension outside valid pointer inputs;
       * current native Apple probes crash, rather than promise an exception. */
      else if(mode==2) [receiver initWithBytes:NULL length:1 encoding:NSUTF8StringEncoding];
      else [receiver initWithCharacters:NULL length:1];
      CHECK(0);
    } @catch(NSException *x) {
      CHECK([[x name] isEqualToString:NSInvalidArgumentException]);
      CHECK([[x reason] length]>0);caught++;
    }
  }
  CHECK(caught==6);
  puts("FOUNDATION real NSException PASS");
}return 0;}
