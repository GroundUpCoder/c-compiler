#include <stdio.h>

static int helper(void);
int helper(void) { return 7; } /* this TU's own internal helper */

int a_val(void);

int main(void)
{
	printf("%d %d\n", a_val(), helper());
	return 0;
}
