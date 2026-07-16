// Internal linkage is per-TU: this TU's `w` must NOT satisfy another TU's
// `extern int w;`.
static int w = 5;
int usew(void) { return w; }
