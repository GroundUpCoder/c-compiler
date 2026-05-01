#include <stdio.h>
int main() {
    printf("%d\n", 1.0 && 2.0);
    printf("%d\n", 0.0 && 1.0);
    printf("%d\n", 1.0 || 0.0);
    printf("%d\n", 0.0 || 0.0);
    return 0;
}
