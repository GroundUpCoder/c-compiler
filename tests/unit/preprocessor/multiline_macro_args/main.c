#include <stdio.h>

#define ID(x) (x)
#define WRAP(x) (x)

int main() {
    // String concatenation inside a macro spanning multiple lines
    printf("%s\n", ID("hello "
                      "world"));

    // Multiple string fragments across lines
    printf("%s\n", WRAP("one "
                        "two "
                        "three"));

    // Non-string argument spanning multiple lines
    printf("%d\n", ID(1
                      + 2));

    // Nested macro with multiline args
    printf("%d\n", ID(ID(10
                         + 20)));

    return 0;
}
