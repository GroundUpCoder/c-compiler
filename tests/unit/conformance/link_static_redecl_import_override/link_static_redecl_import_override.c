// BUG: none — this test PINS a judgment made while fixing todos/0321, so the
//      guard it removed is not re-added on a hunch.
//
//      The re-declaration-of-a-static drop (compiler.js, "C11 6.2.2p4 (via p5
//      ...)") was gated on THREE conditions, of which one — `specs.storageClass
//      !== STATIC` — excluded the commonest shape of all and rejected valid C
//      (todos/0321). It guarded nothing: the same repro fails identically on
//      the compiler.js immediately BEFORE todos/0219 introduced the block, so
//      the condition was that fix's stated scope boundary (extern-after-static
//      linkage inheritance), never a protection. It was removed, not narrowed.
//
//      The condition that DOES carry weight is `specs.storageClass !== IMPORT`:
//      an explicit `__import` re-declaration is meaningful and must take the
//      binding, turning the symbol into a real wasm import even though a static
//      definition of that name is visible. That is what this test observes at
//      runtime, so re-widening the guard back over IMPORT fails here.
// C11: extension territory — `__import` has no standard analogue (it is this
//      compiler's wasm-import storage class); the surrounding drop rule is
//      C11 6.2.2p4/p5. Not clang-comparable, hence no clang golden for the
//      first line; the second is plain C11 and matches clang.
// EXPECT: "import" — pick() resolves to the imported c.getpid (positive),
//         NOT the static definition (-1).
#include <stdio.h>

/* A static definition, then an `__import` re-declaration of the same name:
   the import wins the binding. c.getpid is host-provided and returns > 0. */
static int pick(void) { return -1; }
__import("c", "getpid") int pick(void);

/* And the converse ordering is untouched by todos/0321: a `static`
   declaration after an import keeps shadowing it, so this resolves to the
   local definition. */
__import("c", "getpid") int shadowed(void);
static int shadowed(void);
static int shadowed(void) { return -2; }

int main(void)
{
    printf("%s\n", pick() > 0 ? "import" : "static-def");
    printf("%d\n", shadowed());
    return 0;
}
