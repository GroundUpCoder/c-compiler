#include <Foundation/NSString.h>
#include <Foundation/NSAutoreleasePool.h>
#include <Foundation/NSException.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <limits.h>

@interface _GUCUTF16String : NSString {
  unichar *_units;
  NSUInteger _count;
}
- (id)initWithCharacters:(const unichar *)characters length:(NSUInteger)length;
- (NSUInteger)length;
- (unichar)characterAtIndex:(NSUInteger)index;
- (void)dealloc;
@end
@interface _GUCStringBytes : NSObject { @public char *bytes; }
- (void)dealloc;
@end
@implementation _GUCStringBytes
- (void)dealloc { free(bytes); [super dealloc]; }
@end

static void stringRaise(NSString *name, NSString *reason) {
  NSException *exception=[[NSException alloc] initWithName:name reason:reason userInfo:nil];
  if(!exception) {
    /* Reporting exhaustion must not recursively allocate another exception. */
    fprintf(stderr,"NSString: cannot allocate exception\n");abort();
  }
  @try { [exception raise]; }
  @finally { [exception release]; }
}
static void stringError(NSString *reason) {
  stringRaise(NSInvalidArgumentException,reason);
}
static void stringBoundsError(void) {
  stringRaise(NSRangeException,@"characterAtIndex: index out of bounds");
}
static unichar *allocateUnits(NSUInteger n) {
  if(n>UINT_MAX/sizeof(unichar)) return NULL;
  return malloc(n ? n*sizeof(unichar) : sizeof(unichar));
}
/* Strict, length-delimited decoding. No replacement, NUL special case or
 * normalization. A UTF8 byte-stream signature is consumed only at offset 0. */
static BOOL decode(const unsigned char *bytes, NSUInteger n, NSStringEncoding encoding,
                   unichar *units, NSUInteger *count) {
  NSUInteger i=0,k=0;
  if(encoding==NSUTF8StringEncoding && n>=3 && bytes[0]==0xef && bytes[1]==0xbb && bytes[2]==0xbf) i=3;
  while(i<n) {
    unsigned c=bytes[i++], need=0,minimum=0;
    if(encoding==NSASCIIStringEncoding) { if(c>127) return NO; }
    else if(c>=128) {
      if(c>=0xc2 && c<=0xdf) {need=1;minimum=0x80;c&=31;}
      else if(c>=0xe0 && c<=0xef) {need=2;minimum=0x800;c&=15;}
      else if(c>=0xf0 && c<=0xf4) {need=3;minimum=0x10000;c&=7;}
      else return NO;
      if(need>n-i) return NO;
      while(need--) {unsigned next=bytes[i++]; if((next&0xc0)!=0x80) return NO; c=(c<<6)|(next&63);}
      if(c<minimum || c>0x10ffff || (c>=0xd800 && c<=0xdfff)) return NO;
    }
    if(c>0xffff) {
      if(units) { units[k]=(unichar)(0xd800+((c-0x10000)>>10)); units[k+1]=(unichar)(0xdc00+((c-0x10000)&1023)); }
      k+=2;
    } else { if(units) units[k]=(unichar)c; k++; }
  }
  *count=k; return YES;
}
/* Generic access goes through the public subclass primitives. NULL output
 * measures first; the second pass runs on an immutable source. */
static BOOL encode(NSString *string, NSStringEncoding encoding, unsigned char *output, NSUInteger capacity, NSUInteger *size) {
  if(encoding!=NSUTF8StringEncoding && encoding!=NSASCIIStringEncoding) return NO;
  NSUInteger n=[string length], k=0;
  if(n>(NSUInteger)INT_MAX) return NO;
  for(NSUInteger i=0;i<n;i++) {
    unsigned c=[string characterAtIndex:i];
    if(encoding==NSASCIIStringEncoding) { if(c>127) return NO; }
    else if(c>=0xd800 && c<=0xdbff) {
      if(i+1>=n) return NO;
      unsigned low=[string characterAtIndex:++i];
      if(low<0xdc00 || low>0xdfff) return NO;
      c=0x10000+((c-0xd800)<<10)+(low-0xdc00);
    } else if(c>=0xdc00 && c<=0xdfff) return NO;
    unsigned width=c<0x80?1:c<0x800?2:c<0x10000?3:4;
    if(k>(NSUInteger)INT_MAX-width || (output && (k>capacity || width>capacity-k))) return NO;
    if(output) {
      if(width==1) output[k]=c;
      else {
        unsigned value=c;
        for(unsigned j=width-1;j>0;j--) {output[k+j]=0x80|(value&63);value>>=6;}
        output[k]=(width==2?0xc0:width==3?0xe0:0xf0)|value;
      }
    }
    k+=width;
  }
  *size=k; return YES;
}
@implementation NSString
+ (id)alloc { return guc_objc_alloc(self==NSString ? _GUCUTF16String : self); }
+ (id)string { return [[[self alloc] init] autorelease]; }
+ (id)stringWithUTF8String:(const char *)p { return [[[self alloc] initWithUTF8String:p] autorelease]; }
+ (id)stringWithCharacters:(const unichar *)p length:(NSUInteger)n { return [[[self alloc] initWithCharacters:p length:n] autorelease]; }
+ (id)stringWithString:(NSString *)s { return [[[self alloc] initWithString:s] autorelease]; }
- (id)init { return [super init]; }
- (id)initWithCharacters:(const unichar *)p length:(NSUInteger)n {
  @try { stringError(@"subclass must implement initWithCharacters:length:"); return nil; }
  @finally { [self release]; }
}
- (id)initWithBytes:(const void *)p length:(NSUInteger)n encoding:(NSStringEncoding)encoding {
  unichar *units=NULL;
  BOOL ownsReceiver=YES;
  @try {
    if(!n) {const unichar empty=0;ownsReceiver=NO;return [self initWithCharacters:&empty length:0];}
    if(!p) stringError(@"NULL byte buffer");
    if(encoding!=NSUTF8StringEncoding && encoding!=NSASCIIStringEncoding) return nil;
    NSUInteger count=0;
    if(!decode(p,n,encoding,NULL,&count)) return nil;
    units=allocateUnits(count);if(!units) return nil;
    decode(p,n,encoding,units,&count);
    /* Hand receiver ownership to the overridable initializer. After this
     * point only our temporary buffer remains ours to clean up. */
    ownsReceiver=NO;return [self initWithCharacters:units length:count];
  } @finally { free(units);if(ownsReceiver) [self release]; }
}
- (id)initWithUTF8String:(const char *)p {
  BOOL ownsReceiver=YES;
  @try {
    if(!p) stringError(@"NULL UTF8String");
    NSUInteger n=strlen(p);
    ownsReceiver=NO;return [self initWithBytes:p length:n encoding:NSUTF8StringEncoding];
  } @finally { if(ownsReceiver) [self release]; }
}
- (id)initWithString:(NSString *)s {
  unichar *units=NULL;
  BOOL ownsReceiver=YES;
  @try {
    if(!s) stringError(@"nil source string");
    NSUInteger n=[s length];units=allocateUnits(n);if(!units) return nil;
    for(NSUInteger i=0;i<n;i++) units[i]=[s characterAtIndex:i];
    ownsReceiver=NO;return [self initWithCharacters:units length:n];
  } @finally { free(units);if(ownsReceiver) [self release]; }
}
- (NSUInteger)length {stringError(@"subclass must implement length");return 0;}
- (unichar)characterAtIndex:(NSUInteger)i {stringError(@"subclass must implement characterAtIndex:");return 0;}
- (const char *)UTF8String {
  NSUInteger n;
  if(!encode(self,NSUTF8StringEncoding,NULL,0,&n)) return NULL;
  _GUCStringBytes *owner=[_GUCStringBytes new]; if(!owner) return NULL;
  owner->bytes=malloc(n+1);
  if(!owner->bytes) { [owner release];return NULL; }
  BOOL transferred=NO;
  @try {
    NSUInteger written;
    if(!encode(self,NSUTF8StringEncoding,(unsigned char *)owner->bytes,n,&written)) return NULL;
    owner->bytes[written]=0;
    const char *result=owner->bytes;
    [owner autorelease]; transferred=YES; return result;
  } @finally { if(!transferred) [owner release]; }
}
- (NSUInteger)lengthOfBytesUsingEncoding:(NSStringEncoding)encoding {
  NSUInteger n;return encode(self,encoding,NULL,0,&n)?n:0;
}
- (BOOL)isEqualToString:(NSString *)s {
  if(self==s) return YES;
  if(!s) return NO;
  NSUInteger n=[self length]; if(n!=[s length]) return NO;
  for(NSUInteger i=0;i<n;i++) if([self characterAtIndex:i]!=[s characterAtIndex:i]) return NO;
  return YES;
}
- (BOOL)isEqual:(id)object {
  if(!object) return NO;
  for(Class cls=*(Class *)object;cls;cls=cls->parent)
    if(cls==NSString) return [self isEqualToString:(NSString *)object];
  return NO;
}
- (NSUInteger)hash {
  NSUInteger h=2166136261U,n=[self length];
  for(NSUInteger i=0;i<n;i++) {h^=[self characterAtIndex:i];h*=16777619U;}
  return h;
}
- (NSString *)description {return self;}
@end
@implementation _GUCUTF16String
- (id)initWithCharacters:(const unichar *)p length:(NSUInteger)n {
  unichar *units=NULL;BOOL complete=NO;
  @try {
    if(!p && n) stringError(@"NULL character buffer");
    units=allocateUnits(n);if(!units) return nil;
    if(n) memcpy(units,p,n*sizeof(unichar));
    free(_units);_units=units;_count=n;complete=YES;return self;
  } @finally { if(!complete) {free(units);[self release];} }
}
- (NSUInteger)length {return _count;}
- (unichar)characterAtIndex:(NSUInteger)i {if(i>=_count) stringBoundsError();return _units[i];}
- (void)dealloc {free(_units);[super dealloc];}
@end
@implementation NSConstantString
- (id)init {const unichar empty=0; return [self initWithCharacters:&empty length:0];}
- (id)initWithCharacters:(const unichar *)p length:(NSUInteger)n {
  /* Unlike an arbitrary subclass receiver, this known placeholder is ours
   * to consume even when construction of its replacement throws. */
  @try { return [[NSString alloc] initWithCharacters:p length:n]; }
  @finally { [self release]; }
}
- (NSUInteger)length {return _length;}
- (unichar)characterAtIndex:(NSUInteger)i {
  if(i>=_length) stringBoundsError();
  return _flags==0 ? ((const unsigned char *)_data)[i] : ((const unichar *)_data)[i];
}
@end
