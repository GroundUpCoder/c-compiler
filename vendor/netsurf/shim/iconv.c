/* iconv(3) over libparserutils' charset codecs — see iconv.h.
 *
 * Pipeline per descriptor: from-codec DECODES source bytes to UCS-4
 * (host-endian uint32 units), to-codec ENCODES UCS-4 to the destination
 * charset.  Both codecs are streaming (they buffer partial sequences
 * internally and advance the caller's pointers only past what they
 * consumed/produced), so the POSIX chunked-call contract — advance
 * inbuf/outbuf, E2BIG when the output fills, call again with more room —
 * falls out of forwarding.  UCS-4 decoded but not yet encodable when the
 * output fills is kept in a per-descriptor carry buffer and flushed first
 * on the next call.
 *
 * Deviations from a full POSIX iconv (documented, deliberate):
 *  - Error mode is the codecs' default "loose": byte sequences invalid in
 *    the source charset become U+FFFD (and unrepresentable characters in
 *    the target become '?'/U+FFFD) instead of stopping with EILSEQ.  For
 *    a browser rendering damaged legacy pages this is the behaviour we
 *    want; nothing in NetSurf relies on strict EILSEQ stops.
 *  - An incomplete multi-byte sequence at the very end of the input is
 *    absorbed into the from-codec's internal state (pointers consumed)
 *    rather than reported as EINVAL; supplying the continuation bytes on
 *    the next call completes it, matching NetSurf's chunked use.
 *  - The return value on success is 0, not the non-reversible-conversion
 *    count (callers here only test for (size_t)-1).
 */
#include "iconv.h"

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <parserutils/charset/codec.h>

#define ICONV_CARRY_UNITS 64

struct gucos_iconv_cd {
	parserutils_charset_codec *from;   /* source charset -> UCS-4 */
	parserutils_charset_codec *to;     /* UCS-4 -> target charset */
	uint32_t carry[ICONV_CARRY_UNITS]; /* decoded, not yet encoded */
	size_t carry_len;                  /* units used in carry */
};

/* iconv_open charset names may carry glibc-style suffixes ("//TRANSLIT",
 * "//IGNORE"); the codecs' loose error mode already subsumes both, so the
 * suffix is stripped before alias resolution. */
static parserutils_charset_codec *open_codec(const char *name)
{
	parserutils_charset_codec *codec = NULL;
	char buf[64];
	const char *slash = strstr(name, "//");
	if (slash != NULL) {
		size_t n = (size_t)(slash - name);
		if (n >= sizeof(buf))
			return NULL;
		memcpy(buf, name, n);
		buf[n] = '\0';
		name = buf;
	}
	if (parserutils_charset_codec_create(name, &codec) != PARSERUTILS_OK)
		return NULL;
	return codec;
}

iconv_t iconv_open(const char *tocode, const char *fromcode)
{
	struct gucos_iconv_cd *cd = calloc(1, sizeof(*cd));
	if (cd == NULL) {
		errno = ENOMEM;
		return (iconv_t)-1;
	}
	cd->from = open_codec(fromcode);
	cd->to = open_codec(tocode);
	if (cd->from == NULL || cd->to == NULL) {
		if (cd->from != NULL)
			parserutils_charset_codec_destroy(cd->from);
		if (cd->to != NULL)
			parserutils_charset_codec_destroy(cd->to);
		free(cd);
		errno = EINVAL;
		return (iconv_t)-1;
	}
	return (iconv_t)cd;
}

int iconv_close(iconv_t handle)
{
	struct gucos_iconv_cd *cd = handle;
	if (cd == NULL || handle == (iconv_t)-1) {
		errno = EBADF;
		return -1;
	}
	parserutils_charset_codec_destroy(cd->from);
	parserutils_charset_codec_destroy(cd->to);
	free(cd);
	return 0;
}

/* Encode as much of the carry buffer as the output accepts.
 * Returns 0 when the carry drained, -1 (errno E2BIG/EILSEQ) otherwise. */
static int flush_carry(struct gucos_iconv_cd *cd,
		char **outbuf, size_t *outbytesleft)
{
	const uint8_t *src = (const uint8_t *)cd->carry;
	size_t srclen = cd->carry_len * sizeof(uint32_t);
	uint8_t *dst = (uint8_t *)*outbuf;
	size_t dstlen = *outbytesleft;
	parserutils_error err;

	if (cd->carry_len == 0)
		return 0;

	err = parserutils_charset_codec_encode(cd->to, &src, &srclen,
			&dst, &dstlen);

	*outbuf = (char *)dst;
	*outbytesleft = dstlen;
	/* keep whatever the encoder did not consume (srclen is bytes) */
	cd->carry_len = srclen / sizeof(uint32_t);
	memmove(cd->carry, src, srclen);

	if (err == PARSERUTILS_OK && cd->carry_len == 0)
		return 0;
	if (err == PARSERUTILS_NOMEM || cd->carry_len != 0) {
		errno = E2BIG;
		return -1;
	}
	errno = EILSEQ;
	return -1;
}

size_t iconv(iconv_t handle, char **inbuf, size_t *inbytesleft,
             char **outbuf, size_t *outbytesleft)
{
	struct gucos_iconv_cd *cd = handle;

	if (cd == NULL || handle == (iconv_t)-1) {
		errno = EBADF;
		return (size_t)-1;
	}

	/* POSIX reset form: iconv(cd, NULL, …) returns the descriptor to
	 * its initial shift state (nothing to emit for these codecs). */
	if (inbuf == NULL || *inbuf == NULL) {
		parserutils_charset_codec_reset(cd->from);
		parserutils_charset_codec_reset(cd->to);
		cd->carry_len = 0;
		return 0;
	}

	for (;;) {
		const uint8_t *src;
		size_t srclen;
		uint8_t *dst;
		size_t dstlen;
		parserutils_error err;

		if (flush_carry(cd, outbuf, outbytesleft) != 0)
			return (size_t)-1;
		if (*inbytesleft == 0)
			return 0;

		/* decode the next chunk of source into the carry buffer */
		src = (const uint8_t *)*inbuf;
		srclen = *inbytesleft;
		dst = (uint8_t *)cd->carry;
		dstlen = sizeof(cd->carry);
		err = parserutils_charset_codec_decode(cd->from, &src, &srclen,
				&dst, &dstlen);

		*inbuf = (char *)(uintptr_t)src;
		cd->carry_len = (sizeof(cd->carry) - dstlen) / sizeof(uint32_t);

		if (err != PARSERUTILS_OK && err != PARSERUTILS_NOMEM) {
			*inbytesleft = srclen;
			errno = EILSEQ;
			return (size_t)-1;
		}
		/* NOMEM just means the carry filled — the loop flushes it.
		 * A decode that consumed nothing and produced nothing would
		 * spin; the codecs always make progress on non-empty input
		 * (worst case they absorb a partial tail sequence), but
		 * guard anyway. */
		if (cd->carry_len == 0 && srclen == *inbytesleft && err == PARSERUTILS_OK) {
			*inbytesleft = srclen;
			return 0;
		}
		*inbytesleft = srclen;
	}
}
