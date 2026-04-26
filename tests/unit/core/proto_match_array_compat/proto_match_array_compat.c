// Incomplete array + complete array should be compatible
#include <stdio.h>

extern int arr[];
int arr[3] = {10, 20, 30};

int main(void) {
    printf("%d %d %d\n", arr[0], arr[1], arr[2]);
    return 0;
}
