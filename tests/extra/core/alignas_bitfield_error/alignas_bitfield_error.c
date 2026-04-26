// C11 6.7.5p2: "_Alignas shall not be specified in a declaration of ... a bit-field"
struct S {
    _Alignas(8) int x : 4;
};

int main(void) {
    return 0;
}
