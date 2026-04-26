/* Declares foo with empty parens (K&R-style "unspecified parameters") */
void foo();

/* A function that calls foo via the empty-paren declaration */
int call_foo(void) {
    foo(10, 20);
    return 0;
}
