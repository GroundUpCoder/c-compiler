// C11 6.7.5p2: "_Alignas shall not be specified in a declaration of ... a parameter"
void f(_Alignas(16) int x) {
    (void)x;
}

int main(void) {
    f(42);
    return 0;
}
