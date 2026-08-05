/* A second all-preprocessed-away TU in the same link, via literal #if 0 —
   the other common spelling of the same shape. Zero tokens after
   preprocessing; must contribute nothing. */
#if 0
int never_compiled = 1;
int also_never(void) { return never_compiled; }
#endif
