__struct Foo { int x; };
extern int read_x(__struct Foo *p);
int main(void) { return read_x(__ref_null(__struct Foo *)); }
