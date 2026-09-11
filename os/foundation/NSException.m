#include <Foundation/NSException.h>
NSString * const NSInvalidArgumentException=@"NSInvalidArgumentException";
NSString * const NSRangeException=@"NSRangeException";
NSString * const NSGenericException=@"NSGenericException";
@implementation NSException
+ (id)exceptionWithName:(NSString *)name reason:(NSString *)reason userInfo:(NSDictionary *)info {
  return [[[self alloc] initWithName:name reason:reason userInfo:info] autorelease];
}
- (id)init { [self release]; return nil; }
- (id)initWithName:(NSString *)name reason:(NSString *)reason userInfo:(NSDictionary *)info {
  NSString *newName=nil,*newReason=nil;
  id newInfo=nil;
  BOOL complete=NO;
  @try {
    if(name) {newName=[[NSString alloc] initWithString:name];if(!newName)return nil;}
    if(reason) {newReason=[[NSString alloc] initWithString:reason];if(!newReason)return nil;}
    newInfo=[(id)info retain];
    [_name release]; [_reason release]; [(id)_userInfo release];
    _name=newName;_reason=newReason;_userInfo=(NSDictionary *)newInfo;
    complete=YES;return self;
  } @finally {
    if(!complete) { [newName release];[newReason release];[newInfo release];[self release]; }
  }
}
- (NSString *)name {return _name;}
- (NSString *)reason {return _reason;}
- (NSDictionary *)userInfo {return _userInfo;}
- (void)raise { @throw self; }
- (void)dealloc { [_name release];[_reason release];[(id)_userInfo release];[super dealloc]; }
@end
