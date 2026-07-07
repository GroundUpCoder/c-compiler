/* multicall_main.c — the coreutils multicall entry point (todos/0010).
 *
 * One wasm binary carries all coreutils applets; /bin/ls, /bin/grep, …
 * are BlockFS symlinks to /bin/coreutils and the applet is chosen by
 * argv[0], busybox-style. Upstream's appletlib does this through
 * kbuild-generated applet tables + usage blobs; this table is hand-rolled
 * for exactly the applets we ship, so the appletlib stubs (libbb_stubs.c)
 * keep working unchanged.
 *
 * Why one binary and not per-applet builds: the OS compiles its userland
 * from source at first boot (os/image.json), and 27 separate builds cost
 * ~26s of seeding vs ~2s for this one — measured, not guessed. Size-wise
 * it's ~0.4MB once instead of ~65KB × 27.
 *
 * Invoked under an unknown name (or as plain "coreutils"), it falls back
 * to argv[1] as the applet name: `coreutils ls -l` works like busybox's
 * own `busybox ls -l`.
 */
#define PV_NO_INTERCEPT 1
#include "libbb.h"

int basename_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int cat_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int cp_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int dirname_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int echo_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int false_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int grep_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int head_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int kill_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int ln_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int ls_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int mkdir_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int mv_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int printf_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int pwd_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int rm_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int rmdir_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int sed_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int sort_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int tail_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int test_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int touch_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int true_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int vi_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int wc_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;

/* sleep: hand-rolled (upstream sleep.c wasn't vendored) — POSIX seconds
 * plus the busybox fractional extension (`sleep 0.5`); multiple args sum.
 * Wanted by shell scripts and the OS test harnesses (todos/0014). */
static int sleep_main(int argc, char **argv)
{
	double total = 0;
	int i;
	if (argc < 2) bb_show_usage();
	for (i = 1; i < argc; i++) {
		char *end;
		double v = strtod(argv[i], &end);
		if (end == argv[i] || *end != '\0' || v < 0) bb_show_usage();
		total += v;
	}
	struct timespec ts;
	ts.tv_sec = (time_t)total;
	ts.tv_nsec = (long)((total - (double)ts.tv_sec) * 1e9);
	while (nanosleep(&ts, &ts) != 0 && errno == EINTR)
		continue;
	return 0;
}

static const struct applet {
	const char *name;
	int (*mainfn)(int argc, char **argv);
} applets[] = {
	{ "[",        test_main },
	{ "basename", basename_main },
	{ "cat",      cat_main },
	{ "cp",       cp_main },
	{ "dirname",  dirname_main },
	{ "echo",     echo_main },
	{ "egrep",    grep_main },
	{ "false",    false_main },
	{ "fgrep",    grep_main },
	{ "grep",     grep_main },
	{ "head",     head_main },
	{ "kill",     kill_main },
	{ "ln",       ln_main },
	{ "ls",       ls_main },
	{ "mkdir",    mkdir_main },
	{ "mv",       mv_main },
	{ "printf",   printf_main },
	{ "pwd",      pwd_main },
	{ "rm",       rm_main },
	{ "rmdir",    rmdir_main },
	{ "sed",      sed_main },
	{ "sleep",    sleep_main },
	{ "sort",     sort_main },
	{ "tail",     tail_main },
	{ "test",     test_main },
	{ "touch",    touch_main },
	{ "true",     true_main },
	{ "vi",       vi_main },
	{ "wc",       wc_main },
};

static const struct applet *find_applet(const char *name)
{
	unsigned i;
	for (i = 0; i < ARRAY_SIZE(applets); i++)
		if (strcmp(name, applets[i].name) == 0)
			return &applets[i];
	return NULL;
}

static const char *base_name(const char *path)
{
	const char *s = strrchr(path, '/');
	return s ? s + 1 : path;
}

int main(int argc, char **argv)
{
	const struct applet *a = find_applet(base_name(argv[0]));
	if (!a && argc > 1) {           /* `coreutils ls -l` form */
		argv++;
		argc--;
		a = find_applet(base_name(argv[0]));
	}
	if (!a) {
		unsigned i;
		fputs("usage: <applet> [ARGS]  (as a /bin symlink or `coreutils <applet>`)\napplets:", stderr);
		for (i = 0; i < ARRAY_SIZE(applets); i++) {
			fputc(' ', stderr);
			fputs(applets[i].name, stderr);
		}
		fputc('\n', stderr);
		return 127;
	}
	applet_name = a->name;
	return a->mainfn(argc, argv);
}
