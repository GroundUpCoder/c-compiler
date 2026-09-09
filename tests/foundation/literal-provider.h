/* ABI-only provenance fixture, NOT the real NSString library funded by #778.
 * Adapted from independent reviewer 01a0834a's cross-TU controls. */
#include <Foundation/Foundation.h>
@interface NSString : NSObject @end
@interface NSConstantString : NSString {
    unsigned flags, length, bytes, hash;
    const void *data;
} @end
id literal_a(void); id literal_b(void); int inspect_literal(id object);
