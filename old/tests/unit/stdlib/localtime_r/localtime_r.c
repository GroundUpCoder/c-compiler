#include <stdio.h>
#include <time.h>

int main(void) {
    time_t now = time(0);
    struct tm result;
    struct tm *r = localtime_r(&now, &result);
    printf("r_ok: %d\n", r == &result);
    printf("year_ok: %d\n", result.tm_year > 100); /* > 2000 */
    printf("gmtoff_type: %d\n", result.tm_gmtoff != 0 || result.tm_gmtoff == 0);
    return 0;
}
