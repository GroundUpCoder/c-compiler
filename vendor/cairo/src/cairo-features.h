/* Hand-written cairo-features.h (replaces meson's generated one).
 * Backends: image surface (the shm/window pixel buffer) + recording +
 * user/toy fonts + FreeType fonts + PNG read/write (vendored libpng). */
#ifndef CAIRO_FEATURES_H
#define CAIRO_FEATURES_H

#define CAIRO_HAS_IMAGE_SURFACE 1
#define CAIRO_HAS_RECORDING_SURFACE 1
#define CAIRO_HAS_OBSERVER_SURFACE 1
#define CAIRO_HAS_MIME_SURFACE 1
#define CAIRO_HAS_USER_FONT 1
#define CAIRO_HAS_FT_FONT 1
#define CAIRO_HAS_PNG_FUNCTIONS 1

#endif /* CAIRO_FEATURES_H */
