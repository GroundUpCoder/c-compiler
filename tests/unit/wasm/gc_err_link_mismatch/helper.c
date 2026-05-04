__struct Foo { double x; };  // shape mismatch with main.c
int read_x(__struct Foo p) { return (int)p.x; }
