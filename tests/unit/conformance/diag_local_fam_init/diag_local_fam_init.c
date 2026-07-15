// BUG: an automatic-storage struct-with-FAM initializer that provides FAM
// elements was ACCEPTED, and the element stores ran past the plain-sizeOf
// frame slot — silent frame corruption. gcc and clang reject it. Found in
// the 2026-07 fresh-eyes hunt (todos/0205).
// C11: 6.7.2.1 — a flexible array member is ignored by initialization; the
// gcc/clang extension permits FAM init only for static storage duration.
// EXPECT: compile error (exit 1).
struct FAM { int n; int data[]; };
int main(void) {
    struct FAM f = {1, {2, 3}};
    return f.n;
}
