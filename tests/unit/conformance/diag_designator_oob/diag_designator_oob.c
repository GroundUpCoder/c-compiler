// BUG: an array designator index beyond the declared bound is accepted and writes out of bounds (corrupts adjacent objects).
// C11: 6.7.9p2 -- no initializer shall attempt to provide a value for an object not contained within the entity being initialized (constraint).
// EXPECT: [5] in int[2] is a constraint violation -> compiler exits 1 with a diagnostic.
int a[2] = { [5] = 77 };
int main(void) { return 0; }
