#include <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <limits.h>
#define CHECK(x) do {if(!(x)){printf("array-cleanup failure %d\n",__LINE__);return __LINE__;}}while(0)
static id firstException=@"first",lastException=@"last",retainException=@"retain failure";
static int measuring;
static int releases,destructors,action,throwRetain;
static unsigned low=UINT_MAX,high;
static NSMutableArray *owner;
static id *external;
@interface Probe : NSObject { @public int code; }
- (id)retain;
- (void)release;
- (void)dealloc;
@end
@implementation Probe
- (id)retain {
 int a=action;action=0;
 if(a==1) {[owner removeAllObjects];for(int i=0;i<80;i++)[owner addObject:@"reallocated"];}
 if(a==2) [owner removeAllObjects];
 if(a==3) external[1]=nil;
 if(code==5 || throwRetain) @throw retainException;
 return [super retain];
}
- (void)release {
 volatile char marker[16];marker[0]=1;unsigned address=(unsigned)&marker[0];
 if(address<low)low=address;if(address>high)high=address;
 releases++;int c=code;
 if(measuring && (releases==1 || releases==65537)){printf("ARRAY-CLEANUP-FRAME-PROBE=%d\n",releases);fflush(stdout);}
 [super release];
 if(c==1) @throw firstException;
 if(c==2) @throw lastException;
 if(c==3) [owner addObject:@"survivor"];
 if(c==4) {
   if([owner count]) abort();
   @try {[owner addObject:@"forbidden"];} @catch(NSException *e) {
     if(![[e name] isEqual:NSInvalidArgumentException])abort();return;
   }
   abort();
 }
}
- (void)dealloc {destructors++;[super dealloc];}
@end
int main(void) {
 @autoreleasepool {
  Probe *p=[Probe new];id pair[2]={p,p};
  /* Mutating the original C pointer vector from retain cannot change input. */
  external=pair;action=3;NSArray *snapshot=[[NSArray alloc] initWithObjects:pair count:2];
  CHECK([snapshot count]==2 && [snapshot lastObject]==p);[snapshot release];[p release];CHECK(destructors==1);
  Probe *first=[Probe new],*last=[Probe new];id objects[2]={first,last};
  last->code=5;int before=releases;
  @try {[[NSArray alloc] initWithObjects:objects count:2];CHECK(0);}
  @catch(id e){CHECK(e==retainException && releases==before+1);}
  last->code=0;
  NSArray *valid=[[NSArray alloc] initWithObjects:objects count:2];
  [first release];[last release];first->code=1;last->code=2;
  before=destructors;int caught=0;
  @try {[valid release];} @catch(id e){CHECK(e==lastException);caught++;}
  CHECK(caught==1 && destructors==before+2);

  /* 65,537 real owning slots: force >16-bit count and non-power-of-two depth. */
  p=[Probe new];id *many=malloc(65537*sizeof(id));CHECK(many);
  for(unsigned i=0;i<65537;i++)many[i]=p;
  NSArray *large=[[NSArray alloc] initWithObjects:many count:65537];free(many);[p release];
  volatile char anchor[16];anchor[0]=1;unsigned stackTop=(unsigned)&anchor[0];
  releases=0;low=UINT_MAX;high=0;before=destructors;
  measuring=1;[large release];measuring=0;CHECK(releases==65537 && destructors==before+1);
  CHECK(low<stackTop && stackTop-low<49152);
  printf("ARRAY-CLEANUP-LINEAR-STACK-BYTES=%u leaf-span=%u slots=65537\n",stackTop-low,high-low);

  owner=[[NSMutableArray alloc] init];[owner addObject:@"old"];
  p=[Probe new];action=1;[owner replaceObjectAtIndex:0 withObject:p];
  CHECK([owner count]==80 && [owner firstObject]==p && [[owner lastObject] isEqual:@"reallocated"]);
  [p release];[owner removeAllObjects];
  [owner addObject:@"old"];p=[Probe new];action=1;
  [owner insertObject:p atIndex:1];CHECK([owner count]==81 && [owner objectAtIndex:1]==p);
  [p release];[owner removeAllObjects];
  [owner addObject:@"old"];p=[Probe new];action=2;before=destructors;
  @try {[owner replaceObjectAtIndex:0 withObject:p];CHECK(0);}
  @catch(NSException *e){CHECK([[e name] isEqual:NSRangeException]);}
  CHECK(![owner count]);[p release];CHECK(destructors==before+1);
  p=[Probe new];[owner addObject:p];[p release];p->code=3;
  [owner removeAllObjects];CHECK([owner count]==1 && [[owner firstObject] isEqual:@"survivor"]);
  [owner removeAllObjects];p=[Probe new];[owner addObject:p];[p release];p->code=4;
  before=destructors;[owner release];owner=nil;CHECK(destructors==before+1);
 }
 puts("FOUNDATION array-cleanup PASS");return 0;
}
