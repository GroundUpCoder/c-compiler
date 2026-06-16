#include <stdio.h>
#include <sys/sysmacros.h>

int main(void) {
    unsigned long dev = makedev(8, 3);
    printf("dev=%lu maj=%d min=%d\n", dev, major(dev), minor(dev));
    /* classic 8-bit encoding truncates a >255 major: documents the behavior */
    printf("maj259=%d min5=%d\n", major(makedev(259, 5)), minor(makedev(259, 5)));
    return 0;
}
