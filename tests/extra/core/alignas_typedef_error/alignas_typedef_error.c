// C11 6.7.5p2: "_Alignas shall not be specified in a declaration of a typedef"
_Alignas(16) typedef int aligned_int;

int main(void) {
    return 0;
}
