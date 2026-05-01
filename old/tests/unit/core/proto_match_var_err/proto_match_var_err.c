// Mismatched variable types within one TU
extern int x;
extern double x;  // conflict!

int main(void) {
    return 0;
}
