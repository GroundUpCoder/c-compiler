// C11 6.7.5p2: "_Alignas shall not be specified in a declaration of ...
// an object declared with the register storage-class specifier"
int main(void) {
    register _Alignas(16) int x = 42;
    (void)x;
    return 0;
}
