#ifndef GUC_FOUNDATION_NSEXCEPTION_H
#define GUC_FOUNDATION_NSEXCEPTION_H
#include <Foundation/NSString.h>
__require_source("foundation/NSException.m");
@class NSDictionary;
extern NSString * const NSInvalidArgumentException;
extern NSString * const NSRangeException;
@interface NSException : NSObject {
  NSString *_name;
  NSString *_reason;
  NSDictionary *_userInfo;
}
+ (id)exceptionWithName:(NSString *)name reason:(NSString *)reason userInfo:(NSDictionary *)userInfo;
- (id)init;
- (id)initWithName:(NSString *)name reason:(NSString *)reason userInfo:(NSDictionary *)userInfo;
- (NSString *)name;
- (NSString *)reason;
- (NSDictionary *)userInfo;
- (void)raise;
- (void)dealloc;
@end
#endif
