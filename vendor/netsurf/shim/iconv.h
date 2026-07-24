/* iconv(3) for the vendored NetSurf constellation (gucOS).
 *
 * The gucOS libc has no iconv; NetSurf's utils/utf8.c uses it
 * unconditionally.  This shim implements the POSIX surface on top of
 * libparserutils' OWN charset codecs (already linked into every NetSurf
 * binary): every charset parserutils can decode/encode — UTF-8, UTF-16,
 * US-ASCII, the ISO-8859 family, the Ext8 family (Windows-125x, KOI8, …)
 * — works here, with full alias resolution from aliases.inc.
 * Implementation: shim/iconv.c.
 */
#ifndef GUCOS_NETSURF_ICONV_H
#define GUCOS_NETSURF_ICONV_H

#include <stddef.h>

typedef void *iconv_t;

iconv_t iconv_open(const char *tocode, const char *fromcode);
size_t iconv(iconv_t cd, char **inbuf, size_t *inbytesleft,
             char **outbuf, size_t *outbytesleft);
int iconv_close(iconv_t cd);

#endif
