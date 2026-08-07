/* keybind_registry_probe.c — the CHUNK 2 acceptance probe for os/keys.h's
 * named-action registry, override resolution, and chord parse/format
 * (todos/KEYBINDING-OVERRIDE-SYSTEM.md §2/§5). Pure host-C: keys.h is
 * SDL-header-free POSIX, so this compiles + runs natively (clang), no boot.
 *
 * Compiled + run by tests/kernel/test_keybind_registry.js. Emits `ok`/`FAIL`
 * lines and, for the JS-side scancode twin, one `SCANCODE ...` line; exits
 * with the failure count (clamped). Config-dependent scenarios (key_action /
 * ks_action_binding read the 1 Hz-cached store) each run in a FORKED child
 * with its own $HOME, so every child's first ks_cached() read is fresh.
 *
 * Run directly:  cc -I <repo-root> keybind_registry_probe.c -o probe && ./probe
 */
#include <sys/wait.h>
#include "os/keys.h"

static int fails = 0;
#define CHECK(name, cond) do { \
    if (cond) printf("  ok   %s\n", name); \
    else { printf("  FAIL %s\n", name); fails++; } } while (0)

/* child-local variant: bumps a passed counter, not the global */
#define LCHECK(lf, name, cond) do { \
    if (cond) printf("  ok   %s\n", name); \
    else { printf("  FAIL %s\n", name); (lf)++; } } while (0)

static int chord_is(KsChord c, int mods, int key) {
    return c.mods == mods && c.key == key;
}

/* ---- pure: the registry resolves each action to its scheme default ---- */
static void test_registry_defaults(void) {
    KsChord d[2];
    /* system — snaps: windows GUI+arrow, macos relocated Ctrl+Alt+arrow */
    CHECK("snap-left windows = gui+left",
        ks_action_default(KSA_SNAP_LEFT, KS_WINDOWS, d) == 1 && chord_is(d[0], KM_GUI, KK_LEFT));
    CHECK("snap-left macos = ctrl+alt+left",
        ks_action_default(KSA_SNAP_LEFT, KS_MACOS, d) == 1 && chord_is(d[0], KM_CTRL | KM_ALT, KK_LEFT));
    CHECK("snap-right windows = gui+right",
        ks_action_default(KSA_SNAP_RIGHT, KS_WINDOWS, d) == 1 && chord_is(d[0], KM_GUI, KK_RIGHT));
    CHECK("snap-right macos = ctrl+alt+right",
        ks_action_default(KSA_SNAP_RIGHT, KS_MACOS, d) == 1 && chord_is(d[0], KM_CTRL | KM_ALT, KK_RIGHT));
    CHECK("snap-up macos = ctrl+alt+up",
        ks_action_default(KSA_SNAP_UP, KS_MACOS, d) == 1 && chord_is(d[0], KM_CTRL | KM_ALT, KK_UP));
    CHECK("snap-down macos = ctrl+alt+down",
        ks_action_default(KSA_SNAP_DOWN, KS_MACOS, d) == 1 && chord_is(d[0], KM_CTRL | KM_ALT, KK_DOWN));
    /* cycle: DUAL default (Ctrl+Alt+Tab AND bare Alt+Tab), both schemes */
    CHECK("cycle windows dual = ctrl+alt+tab, alt+tab",
        ks_action_default(KSA_CYCLE, KS_WINDOWS, d) == 2 &&
        chord_is(d[0], KM_CTRL | KM_ALT, KK_TAB) && chord_is(d[1], KM_ALT, KK_TAB));
    CHECK("cycle macos dual = same",
        ks_action_default(KSA_CYCLE, KS_MACOS, d) == 2 &&
        chord_is(d[0], KM_CTRL | KM_ALT, KK_TAB) && chord_is(d[1], KM_ALT, KK_TAB));
    /* start-menu / sysmenu: scheme-invariant */
    CHECK("start-menu = ctrl+esc both schemes",
        ks_action_default(KSA_START_MENU, KS_WINDOWS, d) == 1 && chord_is(d[0], KM_CTRL, KK_ESC) &&
        ks_action_default(KSA_START_MENU, KS_MACOS, d) == 1 && chord_is(d[0], KM_CTRL, KK_ESC));
    CHECK("sysmenu = alt+space both schemes",
        ks_action_default(KSA_SYSMENU, KS_WINDOWS, d) == 1 && chord_is(d[0], KM_ALT, KK_SPACE) &&
        ks_action_default(KSA_SYSMENU, KS_MACOS, d) == 1 && chord_is(d[0], KM_ALT, KK_SPACE));
    /* overview: Ctrl+Alt+E both schemes (the decided Exposé trigger, todos/
     * EXPOSE — scheme-independent; F3 was rejected as a macOS host-collision) */
    CHECK("overview = ctrl+alt+e both schemes",
        ks_action_default(KSA_OVERVIEW, KS_WINDOWS, d) == 1 && chord_is(d[0], KM_CTRL | KM_ALT, 'e') &&
        ks_action_default(KSA_OVERVIEW, KS_MACOS, d) == 1 && chord_is(d[0], KM_CTRL | KM_ALT, 'e'));
    /* close (#395): windows Alt+F4, macos Ctrl+Alt+W — deliberately not ⌘W
     * (host-eaten until the ⌘-passthrough spike; rebindable via bind.wm.close) */
    CHECK("close windows = alt+f4",
        ks_action_default(KSA_CLOSE, KS_WINDOWS, d) == 1 && chord_is(d[0], KM_ALT, KK_F1 + 3));
    CHECK("close macos = ctrl+alt+w",
        ks_action_default(KSA_CLOSE, KS_MACOS, d) == 1 && chord_is(d[0], KM_CTRL | KM_ALT, 'w'));

    /* app — defaults derived from the KS_TABLE rows by (scheme, KA_*, ctx) */
    CHECK("edit.copy windows = ctrl+c",
        ks_action_default(KSA_COPY, KS_WINDOWS, d) == 1 && chord_is(d[0], KM_CTRL, 'c'));
    CHECK("edit.copy macos = gui+c",
        ks_action_default(KSA_COPY, KS_MACOS, d) == 1 && chord_is(d[0], KM_GUI, 'c'));
    CHECK("edit.select-all windows = ctrl+a",
        ks_action_default(KSA_SELECT_ALL, KS_WINDOWS, d) == 1 && chord_is(d[0], KM_CTRL, 'a'));
    /* term.copy DIVERGES from edit.copy in windows (the separate-action reason) */
    CHECK("term.copy windows = ctrl+shift+c",
        ks_action_default(KSA_TERM_COPY, KS_WINDOWS, d) == 1 && chord_is(d[0], KM_CTRL | KM_SHIFT, 'c'));
    CHECK("term.copy macos = gui+c (shares the EDIT|TERM row)",
        ks_action_default(KSA_TERM_COPY, KS_MACOS, d) == 1 && chord_is(d[0], KM_GUI, 'c'));
    CHECK("edit.word-left macos = alt+left",
        ks_action_default(KSA_WORD_LEFT, KS_MACOS, d) == 1 && chord_is(d[0], KM_ALT, KK_LEFT));
    /* the jku-decided macos rows: ⌘←/→ line, ⌘↑/↓ doc */
    CHECK("edit.line-start macos = gui+left",
        ks_action_default(KSA_LINE_START, KS_MACOS, d) == 1 && chord_is(d[0], KM_GUI, KK_LEFT));
    CHECK("edit.line-end macos = gui+right",
        ks_action_default(KSA_LINE_END, KS_MACOS, d) == 1 && chord_is(d[0], KM_GUI, KK_RIGHT));
    CHECK("edit.doc-start macos = gui+up",
        ks_action_default(KSA_DOC_START, KS_MACOS, d) == 1 && chord_is(d[0], KM_GUI, KK_UP));
    CHECK("edit.doc-end macos = gui+down",
        ks_action_default(KSA_DOC_END, KS_MACOS, d) == 1 && chord_is(d[0], KM_GUI, KK_DOWN));
    /* doc nav in WINDOWS is Ctrl+Home/End (the existing rows) */
    CHECK("edit.doc-start windows = ctrl+home",
        ks_action_default(KSA_DOC_START, KS_WINDOWS, d) == 1 && chord_is(d[0], KM_CTRL, KK_HOME));
    /* an action with NO default chord in a scheme is still in the registry
     * (bindable) — line nav in windows is native Home/End, not a table row */
    CHECK("edit.line-start windows = no default (bindable)",
        ks_action_default(KSA_LINE_START, KS_WINDOWS, d) == 0);
}

/* ---- pure: the registry is internally consistent ---- */
static void test_registry_shape(void) {
    CHECK("KS_ACTIONS count == KSA_COUNT",
        (int)(sizeof KS_ACTIONS / sizeof KS_ACTIONS[0]) == KSA_COUNT);
    /* index self-consistency (the enum id IS the array index) */
    CHECK("KSA_OVERVIEW is a system action w/ its token",
        KS_ACTIONS[KSA_OVERVIEW].kind == KAK_SYS && KS_ACTIONS[KSA_OVERVIEW].token == KTOK_OVERVIEW);
    CHECK("KSA_CLOSE is a system action w/ its token (and the LAST system row: "
          "the SS7.3 tie-break must give a collided chord to any other system action)",
        KS_ACTIONS[KSA_CLOSE].kind == KAK_SYS && KS_ACTIONS[KSA_CLOSE].token == KTOK_CLOSE &&
        KS_ACTIONS[KSA_CLOSE + 1].kind == KAK_APP);
    CHECK("KSA_COPY is an EDIT+LIST app action mapping KA_COPY",
        KS_ACTIONS[KSA_COPY].kind == KAK_APP &&
        KS_ACTIONS[KSA_COPY].ctx == (KCTX_EDIT | KCTX_LIST) &&   /* 0398 */
        KS_ACTIONS[KSA_COPY].token == KA_COPY);
    CHECK("KSA_TERM_COPY is a TERM app action mapping KA_COPY",
        KS_ACTIONS[KSA_TERM_COPY].kind == KAK_APP && KS_ACTIONS[KSA_TERM_COPY].ctx == KCTX_TERM &&
        KS_ACTIONS[KSA_TERM_COPY].token == KA_COPY);
    CHECK("the system block precedes the app block",
        KS_ACTIONS[KSA_SNAP_LEFT].kind == KAK_SYS && KS_ACTIONS[KSA_SYSMENU].kind == KAK_SYS &&
        KS_ACTIONS[KSA_SELECT_ALL].kind == KAK_APP);
}

/* ---- pure: chord parse / format round-trip ---- */
static void test_parse_format(void) {
    struct { const char *in; int mods; int key; const char *canon; } t[] = {
        { "ctrl+shift+e",    KM_CTRL | KM_SHIFT, 'e',        "ctrl+shift+e" },
        { "cmd+left",        KM_GUI,             KK_LEFT,    "gui+left" },
        { "f3",              0,                  KK_F1 + 2,  "f3" },
        { "CTRL+C",          KM_CTRL,            'c',        "ctrl+c" },       /* case-insensitive */
        { "option+right",    KM_ALT,             KK_RIGHT,   "alt+right" },    /* option == alt */
        { "win+space",       KM_GUI,             KK_SPACE,   "gui+space" },    /* win == gui */
        { "meta+f12",        KM_GUI,             KK_F1 + 11, "gui+f12" },      /* meta == gui */
        { "alt+tab",         KM_ALT,             KK_TAB,     "alt+tab" },
        { "ctrl+alt+delete", KM_CTRL | KM_ALT,   KK_DELETE,  "ctrl+alt+delete" },
        { "gui+up",          KM_GUI,             KK_UP,      "gui+up" },
    };
    for (size_t i = 0; i < sizeof t / sizeof t[0]; i++) {
        int m = -1, k = -1;
        char buf[64], name[96];
        int ok = ks_parse_chord(t[i].in, &m, &k) == 0;
        snprintf(name, sizeof name, "parse \"%s\" -> {%d,%d}", t[i].in, t[i].mods, t[i].key);
        CHECK(name, ok && m == t[i].mods && k == t[i].key);
        ks_chord_str(t[i].mods, t[i].key, buf, sizeof buf);
        snprintf(name, sizeof name, "format {%s} -> canonical \"%s\"", t[i].in, t[i].canon);
        CHECK(name, strcmp(buf, t[i].canon) == 0);
        /* round-trip: parse(format(x)) == x */
        int m2 = -1, k2 = -1;
        snprintf(name, sizeof name, "round-trip \"%s\"", t[i].canon);
        CHECK(name, ks_parse_chord(buf, &m2, &k2) == 0 && m2 == t[i].mods && k2 == t[i].key);
    }
    /* malformed values are rejected (never silently accepted) */
    int m, k;
    CHECK("parse rejects modifier-only \"ctrl\"", ks_parse_chord("ctrl", &m, &k) != 0);
    CHECK("parse rejects \"ctrl+shift\" (no key)", ks_parse_chord("ctrl+shift", &m, &k) != 0);
    CHECK("parse rejects two keys \"a+b\"", ks_parse_chord("a+b", &m, &k) != 0);
    CHECK("parse rejects unknown key \"ctrl+frob\"", ks_parse_chord("ctrl+frob", &m, &k) != 0);
    CHECK("parse rejects empty string", ks_parse_chord("", &m, &k) != 0);
}

/* ---- pure: canonical key -> SDL scancode (twin of the kernel's) ---- */
static void test_scancode(void) {
    CHECK("sc 'a' = 4",  ks_chord_scancode('a') == 4);
    CHECK("sc 'c' = 6",  ks_chord_scancode('c') == 6);
    CHECK("sc 'v' = 25", ks_chord_scancode('v') == 25);
    CHECK("sc '1' = 30", ks_chord_scancode('1') == 30);
    CHECK("sc '0' = 39", ks_chord_scancode('0') == 39);
    CHECK("sc F3 = 60",  ks_chord_scancode(KK_F1 + 2) == 60);
    CHECK("sc home = 74", ks_chord_scancode(KK_HOME) == 74);
    CHECK("sc end = 77",  ks_chord_scancode(KK_END) == 77);
    CHECK("sc unknown key = -1", ks_chord_scancode(0x9999) == -1);
    /* the JS-side twin cross-checks these against kernel.js WM_DEFAULT_GRABS */
    printf("SCANCODE tab=%d esc=%d space=%d left=%d right=%d down=%d up=%d\n",
        ks_chord_scancode(KK_TAB), ks_chord_scancode(KK_ESC), ks_chord_scancode(KK_SPACE),
        ks_chord_scancode(KK_LEFT), ks_chord_scancode(KK_RIGHT),
        ks_chord_scancode(KK_DOWN), ks_chord_scancode(KK_UP));
}

/* ---- forked config scenarios (each child: own $HOME, fresh cache) ---- */
static void mkconfig(const char *home, const char *content) {
    char dir[300], path[300];
    snprintf(dir, sizeof dir, "%s/.config", home);
    mkdir(home, 0755);
    mkdir(dir, 0755);
    snprintf(path, sizeof path, "%s/keys", dir);
    FILE *f = fopen(path, "w");
    if (f) { fputs(content, f); fclose(f); }
}

static int run_forked(const char *content, int (*body)(void)) {
    static int seq = 0;
    char home[256];
    snprintf(home, sizeof home, "/tmp/kbreg-%d-%d", (int)getpid(), seq++);
    mkconfig(home, content);
    fflush(stdout);
    pid_t pid = fork();
    if (pid == 0) {
        setenv("HOME", home, 1);
        int lf = body();
        fflush(stdout);
        _exit(lf > 250 ? 250 : lf);
    }
    int st = 0;
    waitpid(pid, &st, 0);
    return WIFEXITED(st) ? WEXITSTATUS(st) : 99;
}

/* macos + a spread of overrides: rebind (moves), unbind (none), an app
 * rebind that must leave the readline row alone, and system-action binds. */
static int body_macos_overrides(void) {
    int lf = 0;
    KsChord c[2];
    const int F5 = KK_F1 + 4, F6 = KK_F1 + 5;
    /* rebind: the new chord is live, the old scheme chord is DEAD (moved) */
    LCHECK(lf, "macos: rebound edit.copy -> F5 fires copy",
        key_action(KCTX_EDIT, 0, F5) == KA_COPY);
    LCHECK(lf, "macos: rebind MOVED edit.copy (old gui+c is dead)",
        key_action(KCTX_EDIT, KM_GUI, 'c') == KA_NONE);
    /* unbind: none suppresses the default, binds nothing */
    LCHECK(lf, "macos: unbound edit.cut (gui+x dead, nothing else)",
        key_action(KCTX_EDIT, KM_GUI, 'x') == KA_NONE);
    /* an untouched action keeps its default */
    LCHECK(lf, "macos: edit.paste untouched (gui+v still pastes)",
        key_action(KCTX_EDIT, KM_GUI, 'v') == KA_PASTE);
    /* rebinding edit.line-start moves the ⌘← default but the ^A readline row
     * is IMMUNE (governed by the readline key, not per-action binds) */
    LCHECK(lf, "macos: rebound edit.line-start -> F6 fires line-start",
        key_action(KCTX_EDIT, 0, F6) == KA_LINE_START);
    LCHECK(lf, "macos: edit.line-start rebind MOVED the gui+left default",
        key_action(KCTX_EDIT, KM_GUI, KK_LEFT) == KA_NONE);
    LCHECK(lf, "macos: readline ^A immune to edit.line-start rebind",
        key_action(KCTX_EDIT, KM_CTRL, 'a') == KA_LINE_START);
    /* term.copy is a SEPARATE action: rebinding edit.copy must not disturb it
     * (its gui+c shares the KS_TABLE row but the ctx split protects it) */
    LCHECK(lf, "macos: term.copy (gui+c in TERM) survives edit.copy rebind",
        key_action(KCTX_TERM, KM_GUI, 'c') == KA_COPY);
    /* ks_action_binding: the effective chord for wm.c / ctlpanel */
    LCHECK(lf, "macos: ks_action_binding(edit.copy) = the F5 override",
        ks_action_binding(KSA_COPY, c) == 1 && chord_is(c[0], 0, F5));
    LCHECK(lf, "macos: ks_action_binding(wm.overview) = ctrl+alt+e override",
        ks_action_binding(KSA_OVERVIEW, c) == 1 && chord_is(c[0], KM_CTRL | KM_ALT, 'e'));
    LCHECK(lf, "macos: ks_action_binding(wm.snap-left) = none -> 0 chords",
        ks_action_binding(KSA_SNAP_LEFT, c) == 0);
    LCHECK(lf, "macos: ks_action_binding(wm.snap-right) = macos default (unoverridden)",
        ks_action_binding(KSA_SNAP_RIGHT, c) == 1 && chord_is(c[0], KM_CTRL | KM_ALT, KK_RIGHT));
    LCHECK(lf, "macos: ks_action_binding(wm.cycle) = the dual default (2 chords)",
        ks_action_binding(KSA_CYCLE, c) == 2);
    /* wm.close (#395) resolves through the same bind.<action> machinery as
     * every other system action: the F9 override is the ONE effective chord
     * (count 1 == the ctrl+alt+w default moved, not aliased). */
    LCHECK(lf, "macos: ks_action_binding(wm.close) = the F9 override (moved)",
        ks_action_binding(KSA_CLOSE, c) == 1 && chord_is(c[0], 0, KK_F1 + 8));
    return lf;
}

/* windows + the SAME edit.copy override: overrides are scheme-INDEPENDENT */
static int body_windows_override(void) {
    int lf = 0;
    const int F5 = KK_F1 + 4;
    LCHECK(lf, "windows: the edit.copy->F5 override applies here too (scheme-independent)",
        key_action(KCTX_EDIT, 0, F5) == KA_COPY);
    LCHECK(lf, "windows: rebind MOVED edit.copy (old ctrl+c is dead)",
        key_action(KCTX_EDIT, KM_CTRL, 'c') == KA_NONE);
    LCHECK(lf, "windows: edit.paste untouched (ctrl+v still pastes)",
        key_action(KCTX_EDIT, KM_CTRL, 'v') == KA_PASTE);
    return lf;
}

/* the `default` sentinel restores the scheme default (line-absent-equivalent) */
static int body_default_sentinel(void) {
    int lf = 0;
    LCHECK(lf, "macos: bind.edit.copy=default restores gui+c",
        key_action(KCTX_EDIT, KM_GUI, 'c') == KA_COPY);
    return lf;
}

/* a malformed override value falls back to the default (loudly, on stderr) */
static int body_malformed(void) {
    int lf = 0;
    LCHECK(lf, "macos: malformed bind value falls back to gui+c default",
        key_action(KCTX_EDIT, KM_GUI, 'c') == KA_COPY);
    return lf;
}

/* no config at all: pure scheme defaults, no overrides */
static int body_no_config(void) {
    int lf = 0;
    LCHECK(lf, "no config: windows default ctrl+c copies",
        key_action(KCTX_EDIT, KM_CTRL, 'c') == KA_COPY);
    LCHECK(lf, "no config: no override on gui+c",
        key_action(KCTX_EDIT, KM_GUI, 'c') == KA_NONE);
    return lf;
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);   /* unbuffered — clean across fork() */

    printf("-- registry defaults --\n");
    test_registry_defaults();
    printf("-- registry shape --\n");
    test_registry_shape();
    printf("-- chord parse/format --\n");
    test_parse_format();
    printf("-- scancode map --\n");
    test_scancode();

    printf("-- override: macos spread --\n");
    fails += run_forked(
        "scheme\tmacos\n"
        "bind.edit.copy\tf5\n"
        "bind.edit.cut\tnone\n"
        "bind.edit.line-start\tf6\n"
        "bind.wm.overview\tctrl+alt+e\n"
        "bind.wm.close\tf9\n"
        "bind.wm.snap-left\tnone\n", body_macos_overrides);
    printf("-- override: windows scheme-independence --\n");
    fails += run_forked("scheme\twindows\nbind.edit.copy\tf5\n", body_windows_override);
    printf("-- override: default sentinel --\n");
    fails += run_forked("scheme\tmacos\nbind.edit.copy\tdefault\n", body_default_sentinel);
    printf("-- override: malformed value --\n");
    fails += run_forked("scheme\tmacos\nbind.edit.copy\tnot+a+chord+here\n", body_malformed);
    printf("-- override: no config --\n");
    fails += run_forked("", body_no_config);

    printf(fails ? "\nkeybind_registry: %d FAILED\n" : "\nkeybind_registry: all passed\n", fails);
    return fails ? 1 : 0;
}
