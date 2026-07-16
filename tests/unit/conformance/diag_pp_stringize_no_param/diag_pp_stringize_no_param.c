// BUG: a '#' in a FUNCTION-LIKE macro body not followed by a macro
// parameter (here a trailing '#') was silently accepted and expanded as
// a literal '#'. Object-like macros keep '#' as an ordinary token
// (`#define HASH #` stays valid). Bug-hunt G22 (todos/0227).
// C11: 6.10.3.2p1 (constraint) — each # in the replacement list of a
// function-like macro shall be followed by a parameter.
// EXPECT: compile error (exit 1).
#define H(x) # x #

int main(void) {
    return 0;
}
