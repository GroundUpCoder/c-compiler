#ifndef _LOCALE_IMPL_H
#define _LOCALE_IMPL_H

/*
 * Minimal stand-in for musl's internal locale_impl.h, just enough for the
 * vendored TRE/fnmatch sources. compiler.js is single-locale ("C"), so message
 * translation is the identity and MB_CUR_MAX comes from <stdlib.h>.
 */

#include <stdlib.h>   /* MB_CUR_MAX */

#define LCTRANS(msg, lc, loc) (msg)
#define LCTRANS_CUR(msg)      (msg)

#endif /* _LOCALE_IMPL_H */
