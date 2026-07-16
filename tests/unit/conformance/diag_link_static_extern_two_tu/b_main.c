// BUG-GUARD (companion to link_static_extern_redecl): C11 6.2.2p2 — the
// static `w` in a_static.c has internal linkage, so this TU's `extern int w;`
// denotes a DIFFERENT (undefined) object. The program must FAIL to link.
extern int w;
int usew(void);
int main(void) { return w + usew(); }
