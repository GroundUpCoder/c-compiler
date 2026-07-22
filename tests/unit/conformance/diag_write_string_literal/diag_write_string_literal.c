// BUG: a provable direct store through a string literal (read-only storage)
// was accepted silently — with literal dedup on, the UB write corrupted every
// same-spelling literal, invisibly (wasm linear memory has no page
// protection). todos/0228 turns dedup off by default (localizing the write)
// AND diagnoses the statically-provable write shapes loudly.
// C11: 6.4.5p7 — a program that modifies a string literal has undefined
// behavior; clang/gcc place literals in .rodata and the store faults.
// EXPECT: compile error (exit 1) — "assignment to read-only string literal".
int main(void) {
    "hello"[0] = 'J';         // subscript
    *"hello" = 'J';           // deref
    *("hello" + 1) = 'J';     // deref of pointer arithmetic
    return 0;
}
