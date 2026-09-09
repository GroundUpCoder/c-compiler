#include "cross.h"
void later(id object) { [object autorelease]; }
void finish(id pool) { [(NSAutoreleasePool *)pool drain]; }
