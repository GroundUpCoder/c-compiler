// Mismatched function prototypes within one TU
int foo(int a);
int foo(double a);  // conflict!

int main(void) {
    return 0;
}
