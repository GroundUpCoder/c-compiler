#include <stdio.h>
#include <string.h>

int main(void) {
    const char *date = __DATE__;
    const char *time = __TIME__;

    // __DATE__ format: "Mmm dd yyyy" (11 chars)
    printf("date len: %d\n", (int)strlen(date));
    // __TIME__ format: "hh:mm:ss" (8 chars)
    printf("time len: %d\n", (int)strlen(time));

    // Verify separators in __TIME__
    printf("time colon1: %d\n", time[2] == ':');
    printf("time colon2: %d\n", time[5] == ':');

    // Verify space in __DATE__ between month and day, day and year
    printf("date space: %d\n", date[3] == ' ');

    // Verify year is 4 digits
    printf("date year4: %d\n", date[7] >= '0' && date[10] >= '0');

    printf("ok\n");
    return 0;
}
