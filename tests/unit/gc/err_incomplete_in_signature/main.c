// Functions referencing an incomplete GC struct in their signature can't be
// encoded as WASM types. Reject at parse time, not as an internal crash.
__struct Foo;
__struct Foo *make(void) { return 0; }
int main(void) { return 0; }
