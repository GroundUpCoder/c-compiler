#include <Foundation/Foundation.h>
#include <stdio.h>
#define CHECK(x) do{if(!(x)){printf("array-enumeration failure %d\n",__LINE__);return __LINE__;}}while(0)
static int evaluations,lvalues,cleanup,collectionRetains;
static id slot;
static id *destination(void){lvalues++;return &slot;}
static id once(id value){evaluations++;return value;}
@interface Batch : NSObject <NSFastEnumeration> { @public id items[3];unsigned long generation; }
- (id)retain;
- (NSUInteger)countByEnumeratingWithState:(NSFastEnumerationState *)state objects:(id *)buffer count:(NSUInteger)length;
@end
@implementation Batch
- (id)retain {collectionRetains++;return [super retain];}
- (NSUInteger)countByEnumeratingWithState:(NSFastEnumerationState *)s objects:(id *)b count:(NSUInteger)n {
 (void)b;(void)n;s->mutationsPtr=&generation;
 if(s->state==3)return 0;s->itemsPtr=items+s->state;s->state++;return 1;
}
@end
static int transfers(NSArray *a,int mode) {
 for(id x in a) {
  @autoreleasepool { @try {
    if(mode==0)continue;if(mode==1)break;if(mode==2)return 2;if(mode==3)goto out;
    @throw @"transfer";
   } @finally {cleanup++;} }
 }
 return 7;
 out:return 8;
}
static int override(NSArray *a,int mode) {
 int n=0;
 for(id x in a) {
  @try { if(mode==0)continue;if(mode==1)break;return 10; }
  @finally {n++;if(mode==0)break;if(mode==1)continue;return 11;}
 }
 return n;
}
int main(void) {
 @autoreleasepool {
  NSMutableArray *a=[NSMutableArray array];for(int i=0;i<35;i++)[a addObject:@"x"];
  int n=0;for(id x in once(a)){CHECK([x isEqual:@"x"]);n++;if(n%2)continue;}
  CHECK(n==35 && evaluations==1);
  n=0;for(*destination() in a){n++;if(n==2)break;}CHECK(lvalues==2 && [slot isEqual:@"x"]);
  lvalues=0;n=0;for(*destination() in a)n++;CHECK(n==35 && lvalues==36 && !slot);
  slot=@"previous";lvalues=0;for(*destination() in nil)CHECK(0);CHECK(!slot && lvalues==1);
  slot=@"previous";lvalues=0;for(*destination() in [NSArray array])CHECK(0);CHECK(!slot && lvalues==1);
  int nested=0;for(id x in a) {for(id y in [NSArray arrayWithObject:x]){nested++;break;}switch(1){case 1:break;} }
  CHECK(nested==35);
  Batch *b=[Batch new];b->items[0]=@"a";b->items[1]=@"b";b->items[2]=@"c";
  n=0;for(id x in b){CHECK(x==b->items[n]);n++;}CHECK(n==3);
  int caught=0;@try {for(id x in b){b->generation++;}}
  @catch(NSException *e){CHECK([[e name] isEqual:NSGenericException]);caught++;}CHECK(caught==1 && collectionRetains==0);[b release];
  @try {n=0;for(id x in a){n++;if(n==16)[a replaceObjectAtIndex:20 withObject:@"same count"];}}
  @catch(NSException *e){CHECK([[e name] isEqual:NSGenericException] && [[e reason] isEqual:@"Collection mutated during fast enumeration"]);caught++;}
  CHECK(caught==2 && n==16 && [a count]==35);
  @try {for(id x in a){[a removeAllObjects];}}
  @catch(NSException *e){caught++;}CHECK(caught==3 && ![a count]);
  [a addObject:@"one"];for(id x in a){[a addObject:@"two"];break;}CHECK([a count]==2);
  cleanup=0;CHECK(transfers(a,0)==7 && cleanup==2);
  cleanup=0;CHECK(transfers(a,1)==7 && cleanup==1);
  cleanup=0;CHECK(transfers(a,2)==2 && cleanup==1);
  cleanup=0;CHECK(transfers(a,3)==8 && cleanup==1);
  cleanup=0;@try {transfers(a,4);} @catch(id e){CHECK([e isEqual:@"transfer"] && cleanup==1);}
  CHECK(override(a,0)==1 && override(a,1)==2 && override(a,2)==11);
  /* 'in' stays an ordinary C identifier outside the contextual delimiter. */
  int in=0;for(in=0;in<3;in++){}CHECK(in==3);
 }
 puts("FOUNDATION array-enumeration PASS");return 0;
}
