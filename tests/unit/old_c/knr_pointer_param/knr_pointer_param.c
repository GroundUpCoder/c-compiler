#include <stdio.h>
#include <string.h>

/* Struct pointer param */
struct Point { int x, y; };

void print_point(p)
struct Point *p;
{
    printf("(%d,%d)\n", p->x, p->y);
}

/* Array param (decays to pointer) */
int sum_array(arr, n)
int *arr;
int n;
{
    int s = 0;
    int i;
    for (i = 0; i < n; i++) s += arr[i];
    return s;
}

/* String param */
int my_strlen(s)
char *s;
{
    return (int)strlen(s);
}

int main(void) {
    struct Point p = {3, 4};
    print_point(&p);

    int arr[] = {10, 20, 30};
    printf("%d\n", sum_array(arr, 3));

    printf("%d\n", my_strlen("hello"));
    printf("PASS\n");
    return 0;
}
