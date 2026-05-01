// Cross-TU: declaration here says int, definition in helper says double
extern int foo(int a);

int main(void) {
    return foo(1);
}
