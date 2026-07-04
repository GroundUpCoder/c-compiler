// BUG: excess initializers for a fixed-size array are silently accepted (and can clobber adjacent data).
// C11: 6.7.9p2 -- no initializer shall attempt to provide a value for an object not contained within the entity being initialized (constraint).
// EXPECT: three initializers for int[2] is a constraint violation -> compiler exits 1 with a diagnostic.
int a[2] = { 1, 2, 3 };
int main(void) { return 0; }
