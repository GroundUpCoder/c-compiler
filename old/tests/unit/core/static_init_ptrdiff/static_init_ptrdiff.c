#include <stdio.h>

int arr[10];
int diff = &arr[7] - &arr[2];

int main(void) {
    printf("%d\n", diff);
    return 0;
}
