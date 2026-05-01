// Matching function prototypes should work fine
#include <stdio.h>

int add(int a, int b);
int add(int a, int b);  // duplicate prototype, same type — OK

int add(int a, int b) {
    return a + b;
}

int main(void) {
    printf("%d\n", add(3, 4));
    return 0;
}
