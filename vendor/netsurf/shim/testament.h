/* Revision testament for the vendored NetSurf tree (gucOS).
 *
 * Upstream generates this per-build with utils/git-testament.pl; the
 * vendored build commits ONE deterministic testament pinned to the
 * vendored upstream revision (see vendor/netsurf/UPSTREAM.json — keep
 * WT_REVID in sync when update.sh moves the pin).  Consumed by
 * desktop/version.c and content/fetchers/about/testament.c (via its
 * atestament.h wrapper).
 */
#ifndef NETSURF_REVISION_TESTAMENT
#define NETSURF_REVISION_TESTAMENT "gucos-vendored"

/* Revision testament: */
#define USERNAME "gucos"
#define GECOS "gucOS vendor tree"
#define WT_ROOT "vendor/netsurf/netsurf/"
#define WT_HOSTNAME "gucos"
#define WT_COMPILEDATE "vendored"
#define WT_BRANCHPATH "master"
#define WT_BRANCHISMASTER 1
#define WT_REVID "39da3c3a40af4566d86500ff3052dfdc7f9a0378"
#define WT_MODIFIED 0
#define WT_MODIFICATIONS {\
 \
}

#endif
