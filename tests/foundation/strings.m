#include <Foundation/NSString.h>
#include <Foundation/NSAutoreleasePool.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>
#define CHECK(x) do { if(!(x)) { printf("string check failed line %d\n",__LINE__); return 1; } } while(0)
@interface PrimitiveString : NSString { unichar units[8]; NSUInteger count; }
- (id)initWithCharacters:(const unichar *)p length:(NSUInteger)n;
@end
@implementation PrimitiveString
- (id)initWithCharacters:(const unichar *)p length:(NSUInteger)n {
  self=[super init]; count=n; for(NSUInteger i=0;i<n;i++) units[i]=p[i]; return self;
}
- (NSUInteger)length {return count;}
- (unichar)characterAtIndex:(NSUInteger)i {return units[i];}
@end
static unsigned destroyed;
@interface ReplacementConstant : NSConstantString
- (void)dealloc;
@end
@implementation ReplacementConstant
- (void)dealloc {destroyed++;[super dealloc];}
@end
@interface FailingString : NSString
- (void)dealloc;
@end
@implementation FailingString
- (void)dealloc {destroyed++;[super dealloc];}
@end
@interface HugeString : NSString
- (NSUInteger)length;
- (unichar)characterAtIndex:(NSUInteger)i;
@end
@implementation HugeString
- (NSUInteger)length {return UINT_MAX;}
- (unichar)characterAtIndex:(NSUInteger)i {return 'a';}
@end
int main(void) { @autoreleasepool {
  NSString *empty=[NSString new]; CHECK(empty && [empty length]==0 && [empty retainCount]==1);
  CHECK([empty UTF8String] && [empty UTF8String][0]==0); [empty release];
  CHECK([[NSString string] length]==0);
  NSString *literal=@"A\0\u00e9\U0001f642";
  CHECK([literal length]==5 && [literal characterAtIndex:1]==0);
  CHECK([literal characterAtIndex:3]==0xd83d && [literal characterAtIndex:4]==0xde42);
  CHECK([literal retainCount]==UINT_MAX);
  CHECK([literal retain]==literal && [literal autorelease]==literal); [literal release];
  const unsigned char utf8[]={65,0,0xc3,0xa9,0xf0,0x9f,0x99,0x82};
  NSString *heap=[[NSString alloc] initWithBytes:utf8 length:sizeof utf8 encoding:NSUTF8StringEncoding];
  CHECK(heap && [heap isEqual:literal] && [heap hash]==[literal hash]);
  CHECK([heap lengthOfBytesUsingEncoding:NSUTF8StringEncoding]==sizeof utf8);
  const char *bytes=[heap UTF8String]; CHECK(bytes && !memcmp(bytes,utf8,sizeof utf8) && bytes[sizeof utf8]==0);
  CHECK(![heap isEqual:nil] && ![heap isEqual:[NSObject class]]);
  CHECK(![heap isEqualToString:nil] && [heap description]==heap);
  [heap release];
  CHECK(![@"\u00e9" isEqualToString:@"e\u0301"]);
  CHECK([@"ASCII" lengthOfBytesUsingEncoding:NSASCIIStringEncoding]==5);
  CHECK([@"\u00e9" lengthOfBytesUsingEncoding:NSASCIIStringEncoding]==0);
  unichar data[]={0xfeff,0,0xd83d,0xde42};
  heap=[[NSString alloc] initWithCharacters:data length:4]; data[0]=65;
  CHECK([heap characterAtIndex:0]==0xfeff); [heap release]; data[0]=0xfeff;
  PrimitiveString *custom=[[PrimitiveString alloc] initWithCharacters:data length:4];
  CHECK([custom class]==PrimitiveString && [custom length]==4);
  heap=[[NSString alloc] initWithString:custom];
  CHECK([heap isEqualToString:custom] && [heap hash]==[custom hash]);
  CHECK(!memcmp([heap UTF8String],[custom UTF8String],8));
  [heap release]; [custom release];
  custom=[[PrimitiveString alloc] initWithUTF8String:"hello"];
  CHECK([custom class]==PrimitiveString && [custom isEqualToString:@"hello"]); [custom release];
  const char *first=[@"\u00e9" UTF8String], *second=[@"\u4e2d" UTF8String];
  CHECK(!strcmp(first,"\xc3\xa9") && !strcmp(second,"\xe4\xb8\xad"));
  unichar lone[]={0xd800,0,0xdc00};
  heap=[[NSString alloc] initWithCharacters:lone length:3];
  CHECK(heap && [heap length]==3 && [heap characterAtIndex:0]==0xd800);
  CHECK([heap UTF8String]==NULL && [heap lengthOfBytesUsingEncoding:NSUTF8StringEncoding]==0); [heap release];
  unichar low=0xdc00; heap=[[NSString alloc] initWithCharacters:&low length:1];
  CHECK(heap && ![heap UTF8String]); [heap release];
  CHECK([@"\ufeff" characterAtIndex:0]==0xfeff);
  heap=[[NSString alloc] initWithUTF8String:"\xef\xbb\xbf\xef\xbb\xbfX"];
  CHECK([heap length]==2 && [heap characterAtIndex:0]==0xfeff); [heap release];
  heap=[[NSConstantString alloc] initWithUTF8String:"heap constant"];
  CHECK(heap && [heap retainCount]==1 && [heap isEqualToString:@"heap constant"]); [heap release];
  heap=[NSConstantString new]; CHECK(heap && [heap length]==0 && [heap retainCount]==1); [heap release];
  const unsigned char bad[][4]={{0x80},{0xc0,0x80},{0xe0,0x80,0x80},{0xed,0xa0,0x80},{0xf0,0x80,0x80,0x80},{0xf4,0x90,0x80,0x80},{0xf5,0x80,0x80,0x80},{0xc2},{0xe2,0x82},{0xf0,0x9f,0x99}};
  const unsigned lens[]={1,2,3,3,4,4,4,1,2,3};
  for(unsigned i=0;i<10;i++) CHECK([[NSString alloc] initWithBytes:bad[i] length:lens[i] encoding:NSUTF8StringEncoding]==nil);
  const unsigned char high=0x80; CHECK([[NSString alloc] initWithBytes:&high length:1 encoding:NSASCIIStringEncoding]==nil);
  heap=[[NSString alloc] initWithBytes:NULL length:0 encoding:NSUTF8StringEncoding]; CHECK(heap && ![heap length]); [heap release];
  CHECK([[NSString alloc] initWithCharacters:data length:UINT_MAX]==nil);
  heap=[[NSString alloc] initWithUTF8String:"\xef\xbf\xbf"]; CHECK(heap!=nil); [heap release];
  heap=[[NSString alloc] initWithCharacters:NULL length:0]; CHECK(heap && ![heap length]); [heap release];
  CHECK([[NSString alloc] initWithBytes:"a" length:1 encoding:999]==nil);
  heap=[[NSString alloc] initWithBytes:NULL length:0 encoding:999]; CHECK(heap && ![heap length]); [heap release];
  heap=[[ReplacementConstant alloc] initWithUTF8String:"replacement"];
  CHECK(heap && destroyed==1 && [heap isEqualToString:@"replacement"]); [heap release];
  CHECK([[FailingString alloc] initWithUTF8String:"\xc0\x80"]==nil && destroyed==2);
  heap=[HugeString new]; CHECK([heap lengthOfBytesUsingEncoding:NSUTF8StringEncoding]==0 && ![heap UTF8String]); [heap release];
  puts("FOUNDATION strings PASS");
} return 0; }
