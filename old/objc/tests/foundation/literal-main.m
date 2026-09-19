#include "literal-provider.h"
#include <stdio.h>
int main(void) {
    id a = literal_a(), b = literal_b();
    if (inspect_literal(a) || inspect_literal(b) || inspect_literal((id)NSObject)
        || inspect_literal((id)NSObject->isa)) return 1;
    int local; static int global;
    if (__guc_objc_is_immortal((id)&local) || __guc_objc_is_immortal((id)&global)
        || __guc_objc_is_immortal((id)0x80000000U)
        || __guc_objc_is_immortal((id)__builtin(heap_base))) return 2;
    id heap = [NSConstantString new];
    if (!heap || __guc_objc_is_immortal(heap) || (unsigned long)heap % 8
        || [heap retainCount] != 1) return 3;
    [heap release];
    puts("FOUNDATION cross-TU literal provenance PASS"); return 0;
}
