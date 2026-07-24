#include <stdio.h>
#include <string.h>
#include "iconv.h"

static void conv(const char *from, const char *to, const char *in, size_t inlen)
{
	iconv_t cd = iconv_open(to, from);
	char outbuf[256], *out = outbuf;
	char *inp = (char *)in;
	size_t outleft = sizeof(outbuf);
	if (cd == (iconv_t)-1) { printf("open %s->%s FAIL\n", from, to); return; }
	size_t r = iconv(cd, &inp, &inlen, &out, &outleft);
	printf("%s->%s r=%d left=%d out=[", from, to, (int)r, (int)inlen);
	for (char *p = outbuf; p < out; p++) printf("%02x", (unsigned char)*p);
	printf("]\n");
	iconv_close(cd);
}

int main(void)
{
	/* latin-1 "café" -> UTF-8 */
	conv("ISO-8859-1", "UTF-8", "caf\xe9", 4);
	/* UTF-8 "café" -> latin-1 */
	conv("UTF-8", "ISO-8859-1", "caf\xc3\xa9", 5);
	/* windows-1252 euro sign 0x80 -> UTF-8 (ext8 codec) */
	conv("Windows-1252", "UTF-8", "\x80", 1);
	/* UTF-8 -> UTF-16 */
	conv("UTF-8", "UTF-16LE", "hi", 2);
	/* alias resolution: latin1 */
	conv("latin1", "utf8", "\xe9", 1);
	/* unknown charset must fail cleanly */
	iconv_t cd = iconv_open("UTF-8", "KLINGON-1");
	printf("bogus open: %s\n", cd == (iconv_t)-1 ? "EINVAL ok" : "BAD");
	/* E2BIG path: 1-byte output buffer */
	{
		iconv_t c2 = iconv_open("UTF-8", "ISO-8859-1");
		char in[] = "\xe9\xe9", *ip = in, ob[1], *op = ob;
		size_t il = 2, ol = 1;
		size_t r = iconv(c2, &ip, &il, &op, &ol);
		printf("e2big: r=%d (want -1), then grow: ", (int)r);
		char ob2[8], *op2 = ob2; size_t ol2 = sizeof(ob2);
		r = iconv(c2, &ip, &il, &op2, &ol2);
		printf("r=%d out=[", (int)r);
		for (char *p = ob2; p < op2; p++) printf("%02x", (unsigned char)*p);
		printf("]\n");
		iconv_close(c2);
	}
	return 0;
}
