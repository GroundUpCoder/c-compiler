/* Replicates the two loops in vendor/netsurf/gucos/httpfetch.c's
 * fetch_gucos_http_process_status(), verbatim, over a realistic kernel
 * header blob — to show how many FETCH_HEADER messages actually get emitted.
 *
 * The kernel PREPENDS "x-guc-final-url: <url>\n" to the blob. Loop 1 finds
 * that line and does `*nl = 0` to terminate the VALUE. Loop 2 then re-walks
 * the SAME buffer from the start... over a blob whose first newline is now
 * a NUL.
 */
#include <stdio.h>
#include <string.h>
#include <strings.h>

#define FINAL_URL_KEY "x-guc-final-url:"

/* Exactly what google.com/search returns, in the kernel's flattened shape. */
static char blob[] =
	"x-guc-final-url: https://www.google.com/search?q=espa%C3%B1ol\n"
	"content-type: text/html; charset=UTF-8\n"
	"date: Sat, 02 Aug 2026 01:00:00 GMT\n"
	"cache-control: private, max-age=0\n"
	"server: gws\n";

int main(void)
{
	char *p, *final_url = NULL;
	int emitted = 0;

	printf("blob has %d header lines before the walk\n\n", 5);

	/* ---- loop 1: pull out the synthetic final-url line ---- */
	for (p = blob; p != NULL && *p != 0; ) {
		char *nl = strchr(p, '\n');
		if (strncasecmp(p, FINAL_URL_KEY, sizeof(FINAL_URL_KEY) - 1) == 0) {
			final_url = p + sizeof(FINAL_URL_KEY) - 1;
			while (*final_url == ' ' || *final_url == '\t')
				final_url++;
			if (nl != NULL)
				*nl = 0;        /* <-- terminates the VALUE ... and the BLOB */
			p = nl ? nl + 1 : NULL;
			break;
		}
		p = nl ? nl + 1 : NULL;
	}
	printf("loop 1 extracted final_url = \"%s\"\n\n", final_url ? final_url : "(none)");

	/* ---- loop 2: emit one FETCH_HEADER per remaining line ---- */
	for (p = blob; p != NULL && *p != 0; ) {
		char *nl = strchr(p, '\n');
		size_t ll = nl ? (size_t)(nl - p) : strlen(p);
		if (ll > 0 &&
		    strncasecmp(p, FINAL_URL_KEY, sizeof(FINAL_URL_KEY) - 1) != 0) {
			printf("  FETCH_HEADER: %.*s\n", (int)ll, p);
			emitted++;
		}
		p = nl ? nl + 1 : NULL;
	}

	printf("\nFETCH_HEADER messages emitted: %d\n", emitted);
	printf("content-type reached NetSurf: %s\n", emitted ? "yes" : "NO");
	return emitted == 0 ? 1 : 0;
}
