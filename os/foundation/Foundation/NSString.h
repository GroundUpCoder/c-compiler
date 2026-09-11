#ifndef GUC_FOUNDATION_NSSTRING_H
#define GUC_FOUNDATION_NSSTRING_H
#include <Foundation/NSObject.h>
__require_source("foundation/NSString.m");
typedef unsigned short unichar;
typedef NSUInteger NSStringEncoding;
enum { NSASCIIStringEncoding=1, NSUTF8StringEncoding=4 };
@interface NSString : NSObject
+ (id)alloc;
+ (id)string;
+ (id)stringWithUTF8String:(const char *)bytes;
+ (id)stringWithCharacters:(const unichar *)characters length:(NSUInteger)length;
+ (id)stringWithString:(NSString *)string;
- (id)init;
- (id)initWithUTF8String:(const char *)bytes;
- (id)initWithBytes:(const void *)bytes length:(NSUInteger)length encoding:(NSStringEncoding)encoding;
- (id)initWithCharacters:(const unichar *)characters length:(NSUInteger)length;
- (id)initWithString:(NSString *)string;
- (NSUInteger)length;
- (unichar)characterAtIndex:(NSUInteger)index;
- (const char *)UTF8String;
- (NSUInteger)lengthOfBytesUsingEncoding:(NSStringEncoding)encoding;
- (BOOL)isEqualToString:(NSString *)string;
- (BOOL)isEqual:(id)object;
- (NSUInteger)hash;
- (NSString *)description;
@end
/* Compiler literal ABI: isa plus five wasm32 fields; NSString adds no ivars. */
@interface NSConstantString : NSString {
@private
  unsigned int _flags, _length, _byteSize, _hash;
  const void *_data;
}
- (id)init;
- (id)initWithCharacters:(const unichar *)characters length:(NSUInteger)length;
- (NSUInteger)length;
- (unichar)characterAtIndex:(NSUInteger)index;
@end
#endif
