// C11 6.7.5p2: "_Alignas shall not be specified in a declaration of ... a function"
_Alignas(16) void f(void) {}

int main(void) {
    return 0;
}
