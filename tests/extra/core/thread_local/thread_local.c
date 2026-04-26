#include <stdio.h>
#include <threads.h>

_Thread_local int x = 10;
static _Thread_local int y = 20;
thread_local int z = 30;

int main(void) {
    _Thread_local int local = 40;
    printf("%d %d %d %d\n", x, y, z, local);
    return 0;
}
