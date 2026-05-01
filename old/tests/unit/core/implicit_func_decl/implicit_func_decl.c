/* Verify that implicit function declarations are rejected by default */
int main(void) {
    int x = undeclared_func(42);
    return x;
}
