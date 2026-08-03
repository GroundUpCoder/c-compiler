/* NetSurf charset-chain probe (investigation, not a shipped test).
 *
 * Both routes by which NetSurf can learn a document's encoding — the HTTP
 * Content-Type charset parameter and hubbub's <meta charset> prescan —
 * funnel through ONE chokepoint: parserutils_charset_mibenum_from_name().
 * If that lookup fails, every page silently falls back to Windows-1252 and
 * UTF-8 bytes render as "EspaÃ±ol". This probe exercises the chain end to
 * end, in-OS, so we can see exactly which link breaks.
 */
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <ctype.h>
#include <stdlib.h>

#include <parserutils/charset/mibenum.h>
#include <parserutils/charset/codec.h>
#include <parserutils/input/inputstream.h>

#include <parserutils/charset/utf8.h>

#include "charset/detect.h"

static int fails = 0;

static int intcmp(const void *a, const void *b)
{
	return *(const int *)a - *(const int *)b;
}

static void okf(const char *what, int cond, const char *detail)
{
	printf("  %-46s %s%s%s\n", what, cond ? "ok" : "FAIL",
	       detail ? "   " : "", detail ? detail : "");
	if (!cond) fails++;
}

int main(void)
{
	char buf[128];

	printf("== libc primitives the alias bsearch depends on\n");
	okf("tolower('A') == 'a'", tolower('A') == 'a', NULL);
	okf("tolower('-') == '-'", tolower('-') == '-', NULL);
	{
		/* bsearch over a tiny sorted table, same shape as aliases.c */
		static const int tab[] = { 1, 3, 5, 7, 9, 11 };
		int key = 7;
		const int *hit = bsearch(&key, tab, 6, sizeof(int), intcmp);
		snprintf(buf, sizeof buf, "got %s", hit ? "hit" : "NULL");
		okf("bsearch finds a present key", hit && *hit == 7, buf);
	}

	printf("\n== parserutils_charset_mibenum_from_name (THE chokepoint)\n");
	static const struct { const char *name; uint16_t want; } names[] = {
		{ "UTF-8",        106 },
		{ "utf-8",        106 },
		{ "utf8",         106 },
		{ "UTF8",         106 },
		{ "ISO-8859-1",     4 },
		{ "windows-1252",2252 },
		{ "US-ASCII",       3 },
	};
	for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
		uint16_t got = parserutils_charset_mibenum_from_name(
			names[i].name, strlen(names[i].name));
		snprintf(buf, sizeof buf, "want %u got %u", names[i].want, got);
		char label[80];
		snprintf(label, sizeof label, "mibenum_from_name(\"%s\")", names[i].name);
		okf(label, got == names[i].want, buf);
	}

	{
		const char *back = parserutils_charset_mibenum_to_name(106);
		snprintf(buf, sizeof buf, "got \"%s\"", back ? back : "(null)");
		okf("mibenum_to_name(106) == \"UTF-8\"",
		    back && strcmp(back, "UTF-8") == 0, buf);
	}

	printf("\n== codec: can we actually build a UTF-8 codec?\n");
	{
		parserutils_charset_codec *codec = NULL;
		parserutils_error e = parserutils_charset_codec_create("UTF-8",
			&codec);
		snprintf(buf, sizeof buf, "err %d", (int)e);
		okf("codec_create(\"UTF-8\")", e == PARSERUTILS_OK && codec, buf);
		if (codec) parserutils_charset_codec_destroy(codec);
	}

	printf("\n== hubbub_charset_extract: the <meta charset> prescan\n");
	{
		/* Exactly what Google/Facebook send in the first bytes. */
		static const char doc[] =
			"<!DOCTYPE html><html><head>"
			"<meta charset=\"utf-8\">"
			"<title>x</title></head><body>Espa\xc3\xb1ol</body></html>";
		uint16_t mibenum = 0;
		uint32_t source = 0;
		parserutils_error e = hubbub_charset_extract(
			(const uint8_t *)doc, sizeof doc - 1, &mibenum, &source);
		const char *nm = parserutils_charset_mibenum_to_name(mibenum);
		snprintf(buf, sizeof buf, "err %d mibenum %u (%s) source %u",
			 (int)e, mibenum, nm ? nm : "?", source);
		okf("extract finds UTF-8 from <meta charset>",
		    e == PARSERUTILS_OK && mibenum == 106, buf);
	}
	{
		/* The older http-equiv spelling, also very common. */
		static const char doc[] =
			"<!DOCTYPE html><html><head>"
			"<meta http-equiv=\"Content-Type\" "
			"content=\"text/html; charset=UTF-8\">"
			"</head><body>x</body></html>";
		uint16_t mibenum = 0;
		uint32_t source = 0;
		parserutils_error e = hubbub_charset_extract(
			(const uint8_t *)doc, sizeof doc - 1, &mibenum, &source);
		const char *nm = parserutils_charset_mibenum_to_name(mibenum);
		snprintf(buf, sizeof buf, "err %d mibenum %u (%s) source %u",
			 (int)e, mibenum, nm ? nm : "?", source);
		okf("extract finds UTF-8 from http-equiv",
		    e == PARSERUTILS_OK && mibenum == 106, buf);
	}

	printf("\n== inputstream: UTF-8 bytes in, correct codepoints out?\n");
	{
		parserutils_inputstream *stream = NULL;
		parserutils_error e = parserutils_inputstream_create(
			"UTF-8", 0, NULL, &stream);
		snprintf(buf, sizeof buf, "err %d", (int)e);
		okf("inputstream_create(\"UTF-8\")", e == PARSERUTILS_OK && stream, buf);
		if (stream) {
			/* "Español" = 45 73 70 61 C3 B1 6F 6C */
			static const uint8_t in[] = { 0x45,0x73,0x70,0x61,0xC3,0xB1,0x6F,0x6C };
			parserutils_inputstream_append(stream, in, sizeof in);
			parserutils_inputstream_append(stream, NULL, 0);   /* EOF */
			uint32_t cps[16]; size_t n = 0;
			for (;;) {
				const uint8_t *cp; size_t clen;
				e = parserutils_inputstream_peek(stream, 0, &cp, &clen);
				if (e != PARSERUTILS_OK) break;
				/* the stream hands back UTF-8; decode the lead byte */
				uint32_t u = cp[0];
				if ((cp[0] & 0xE0) == 0xC0 && clen >= 2)
					u = ((cp[0] & 0x1Fu) << 6) | (cp[1] & 0x3Fu);
				if (n < 16) cps[n++] = u;
				parserutils_inputstream_advance(stream, clen);
			}
			snprintf(buf, sizeof buf, "%zu codepoints, [4]=U+%04X (want U+00F1)",
				 n, n > 4 ? cps[4] : 0);
			okf("\"Espa\\xc3\\xb1ol\" -> 7 cps, [4]==U+00F1",
			    n == 7 && cps[4] == 0x00F1, buf);
			parserutils_inputstream_destroy(stream);
		}
	}

	printf("\n== the PLOTTER's decode: utf8_to_ucs4 / utf8_next\n");
	{
		/* Exactly what gucos_plot_text() walks. If utf8_next advances
		 * one byte at a time and utf8_to_ucs4 hands back the raw lead
		 * byte, correctly-decoded UTF-8 renders as byte-wise Latin-1 —
		 * which is visually identical to a charset misdetect. */
		static const char s[] = "Espa\xc3\xb1ol";
		size_t len = sizeof s - 1;      /* 8 bytes, 7 characters */
		uint32_t cps[16];
		size_t n = 0, nxt = 0;
		while (nxt < len && n < 16) {
			uint32_t u = 0; size_t clen = 0;
			parserutils_error e1 = parserutils_charset_utf8_to_ucs4(
				(const uint8_t *)s + nxt, len - nxt, &u, &clen);
			uint32_t after = 0;
			parserutils_error e2 = parserutils_charset_utf8_next(
				(const uint8_t *)s, len, nxt, &after);
			if (e1 != PARSERUTILS_OK || e2 != PARSERUTILS_OK) {
				snprintf(buf, sizeof buf, "err at %zu: %d/%d",
					 nxt, (int)e1, (int)e2);
				okf("utf8 walk errored", 0, buf);
				break;
			}
			cps[n++] = u;
			nxt = after;
		}
		snprintf(buf, sizeof buf, "%zu chars from 8 bytes, [4]=U+%04X",
			 n, n > 4 ? cps[4] : 0);
		okf("plotter walk: 8 bytes -> 7 chars, [4]==U+00F1",
		    n == 7 && cps[4] == 0x00F1, buf);

		/* And a 3-byte sequence, as in Tiếng (U+1EBF). */
		static const char s3[] = "Ti\xe1\xba\xbfng";
		size_t l3 = sizeof s3 - 1;      /* 7 bytes, 5 characters */
		n = 0; nxt = 0;
		while (nxt < l3 && n < 16) {
			uint32_t u = 0; size_t clen = 0; uint32_t after = 0;
			if (parserutils_charset_utf8_to_ucs4((const uint8_t *)s3 + nxt,
					l3 - nxt, &u, &clen) != PARSERUTILS_OK) break;
			if (parserutils_charset_utf8_next((const uint8_t *)s3, l3, nxt,
					&after) != PARSERUTILS_OK) break;
			cps[n++] = u;
			nxt = after;
		}
		snprintf(buf, sizeof buf, "%zu chars from 7 bytes, [2]=U+%04X",
			 n, n > 2 ? cps[2] : 0);
		okf("plotter walk: \"Ti\\u1EBFng\" -> 5 chars, [2]==U+1EBF",
		    n == 5 && cps[2] == 0x1EBF, buf);
	}

	printf("\n%s (%d failure%s)\n", fails ? "PROBE FAILED" : "PROBE CLEAN",
	       fails, fails == 1 ? "" : "s");
	return fails ? 1 : 0;
}
