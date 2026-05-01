#include <stdio.h>

void greet(void) {
    extern int get_value(void);
    printf("%d\n", get_value());
}

int main() {
    greet();
    return 0;
}
