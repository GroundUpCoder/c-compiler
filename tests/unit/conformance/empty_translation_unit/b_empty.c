// Everything here is behind an off feature switch — the shape of an upstream
// source file that this target's configuration compiles away entirely.
#ifdef SOME_FEATURE_THAT_IS_OFF
int feature_entry_point(void) { return 1; }
#endif
