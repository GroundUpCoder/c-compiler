#include "array-cross.h"
int visitArray(NSArray *array) {int count=0;for(NSString *s in array){if(![s isEqualToString:@"cross😀"])return -1;count++;}return count;}
