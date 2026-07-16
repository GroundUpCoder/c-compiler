// BUG: an unknown directive (`#frobnicate`) was silently ignored. Only
// ACTIVE groups diagnose — unknown directives inside a skipped
// conditional block are ignored per C11 6.10p6 (pinned green in
// pp_unknown_directive_skipped), and GNU `# 1 "file.c"` line markers +
// the null directive stay accepted. Bug-hunt G22 (todos/0227).
// C11: 6.10p1 — the directive grammar admits no such form; clang errors
// "invalid preprocessing directive".
// EXPECT: compile error (exit 1).
#frobnicate

int main(void) {
    return 0;
}
