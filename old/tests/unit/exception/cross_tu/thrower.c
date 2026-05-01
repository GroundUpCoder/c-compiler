__exception CrossErr(int);

void do_throw(int x) {
    __throw CrossErr(x);
}
