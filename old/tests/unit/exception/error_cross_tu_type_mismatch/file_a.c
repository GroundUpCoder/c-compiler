__exception Mismatch(int);

void do_throw(void) {
    __throw Mismatch(1);
}
