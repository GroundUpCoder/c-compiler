/* inet_aton/inet_pton for the vendored NetSurf build (gucOS) — address
 * PARSING only (no network stack; see arpa/inet.h).  urldb uses these to
 * classify host names as IP literals, so the parses are real: a v4
 * dotted-quad and a full RFC 4291 v6 parse (hex groups, one "::" gap,
 * optional embedded v4 tail), not a syntactic sniff — two distinct
 * literals must not collapse to the same address. */
#include <arpa/inet.h>

#include <stdlib.h>
#include <string.h>

int inet_aton(const char *cp, struct in_addr *inp)
{
	unsigned parts[4];
	int n = 0;
	const char *p = cp;

	while (n < 4) {
		char *end;
		unsigned long v;
		/* strtoul accepts "-1" and leading space; a quad digit is
		 * only ever a plain decimal run */
		if (*p < '0' || *p > '9')
			return 0;
		v = strtoul(p, &end, 10);
		if (end == p || v > 255)
			return 0;
		parts[n++] = (unsigned)v;
		if (*end == '\0')
			break;
		if (*end != '.')
			return 0;
		p = end + 1;
	}
	if (n != 4)
		return 0;
	inp->s_addr = (in_addr_t)((parts[3] << 24) | (parts[2] << 16) |
				  (parts[1] << 8) | parts[0]);
	return 1;
}

/* One hex group (1-4 digits); returns -1 on parse failure. */
static int v6_group(const char **pp)
{
	const char *p = *pp;
	int v = 0, n = 0;

	while (n < 4) {
		int d;
		if (*p >= '0' && *p <= '9') d = *p - '0';
		else if (*p >= 'a' && *p <= 'f') d = *p - 'a' + 10;
		else if (*p >= 'A' && *p <= 'F') d = *p - 'A' + 10;
		else break;
		v = (v << 4) | d;
		p++;
		n++;
	}
	if (n == 0)
		return -1;
	*pp = p;
	return v;
}

static int v6_parse(const char *src, uint8_t out[16])
{
	uint16_t groups[8];
	int ngroups = 0;      /* groups before/including the gap */
	int gap = -1;         /* index the "::" sits at, -1 = none */
	const char *p = src;

	if (p[0] == ':' ) {
		if (p[1] != ':')
			return 0;
		gap = 0;
		p += 2;
	}
	while (*p != '\0') {
		const char *mark = p;
		int g;

		if (ngroups == 8)
			return 0;
		g = v6_group(&p);
		if (g < 0)
			return 0;
		if (*p == '.') {
			/* embedded v4 tail: re-parse from the group start */
			struct in_addr a4;
			if (ngroups > 6 || !inet_aton(mark, &a4))
				return 0;
			groups[ngroups++] = (uint16_t)(((a4.s_addr & 0xff) << 8) |
						       ((a4.s_addr >> 8) & 0xff));
			groups[ngroups++] = (uint16_t)((((a4.s_addr >> 16) & 0xff) << 8) |
						       ((a4.s_addr >> 24) & 0xff));
			break;
		}
		groups[ngroups++] = (uint16_t)g;
		if (*p == '\0')
			break;
		if (*p != ':')
			return 0;
		p++;
		if (*p == ':') {
			if (gap >= 0)
				return 0;  /* at most one "::" */
			gap = ngroups;
			p++;
			if (*p == '\0')
				break;
		} else if (*p == '\0') {
			return 0;          /* trailing single ':' */
		}
	}

	if (gap < 0) {
		if (ngroups != 8)
			return 0;
	} else if (ngroups >= 8) {
		return 0;                  /* "::" must compress >= 1 group */
	}

	memset(out, 0, 16);
	{
		int i, tail = (gap < 0) ? 0 : ngroups - gap;
		for (i = 0; i < ((gap < 0) ? ngroups : gap); i++) {
			out[i * 2] = (uint8_t)(groups[i] >> 8);
			out[i * 2 + 1] = (uint8_t)groups[i];
		}
		for (i = 0; i < tail; i++) {
			int gi = gap + i, oi = 8 - tail + i;
			out[oi * 2] = (uint8_t)(groups[gi] >> 8);
			out[oi * 2 + 1] = (uint8_t)groups[gi];
		}
	}
	return 1;
}

int inet_pton(int af, const char *src, void *dst)
{
	if (af == AF_INET) {
		/* inet_pton is stricter than inet_aton (no shorthand quads),
		 * but inet_aton above already requires the full a.b.c.d form */
		return inet_aton(src, (struct in_addr *)dst);
	}
	if (af == AF_INET6)
		return v6_parse(src, (uint8_t *)dst);
	return -1;
}
