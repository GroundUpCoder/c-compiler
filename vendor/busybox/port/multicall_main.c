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
 *
 * Since todos/0035 the multicall links the vfork-on-__spawn shim
 * (port/vfork_spawn.c) — the spawn-capable applets (find -exec, xargs,
 * awk via popen/system, tar's seamless .gz, env-exec) journal their
 * "vfork children" exactly like hush does. The former PV_NO_INTERCEPT
 * define is gone with the no-spawn era: this TU compiles under the
 * intercept macros like every applet TU (they pass straight through to
 * the real calls outside journaling mode).
 */
#include "libbb.h"

int awk_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int baseNUM_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int basename_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int cat_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int diff_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int find_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int gunzip_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int gzip_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int less_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int tar_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int xargs_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int cksum_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int cmp_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int comm_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int cp_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int cut_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int date_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int dd_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int dirname_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int du_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int echo_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int env_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int expr_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int false_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int fold_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int grep_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int head_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int kill_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int ln_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int ls_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int md5_sha1_sum_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int mkdir_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int mktemp_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int mv_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int nl_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int od_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int paste_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int printf_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int pwd_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int readlink_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int realpath_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int rm_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int rmdir_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int sed_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int seq_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int sort_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int split_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int stat_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int sync_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int tac_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int tail_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int tee_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int test_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int touch_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int tr_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int true_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int truncate_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int uname_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int uniq_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int unlink_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int usleep_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int vi_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int wc_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int which_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;
int yes_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;

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

/* whoami/id/hostname: hand-rolled single-user stubs (todos/0034) — the
 * upstream applets drag in libpwdgrp (id) or the network stack
 * (hostname) to answer questions this OS answers by construction:
 * everyone is root (uid 0), the host is localhost. Matches the
 * FEATURE_LS_USERNAME-off philosophy. */
static int whoami_main(int argc, char **argv)
{
	(void)argc; (void)argv;
	puts("root");
	return 0;
}

static int id_main(int argc, char **argv)
{
	/* -u/-g/-G print the id (0), adding -n prints the name (root);
	 * bare `id` prints the full uid=0(root) line. Other flags are
	 * accepted and ignored — there is only one answer here. */
	int i, sel = 0, names = 0;
	for (i = 1; i < argc; i++) {
		const char *a = argv[i];
		if (a[0] != '-') continue;
		for (a++; *a; a++) {
			if (*a == 'u' || *a == 'g' || *a == 'G') sel = 1;
			if (*a == 'n') names = 1;
		}
	}
	if (sel)
		puts(names ? "root" : "0");
	else
		puts("uid=0(root) gid=0(root) groups=0(root)");
	return 0;
}

static int hostname_main(int argc, char **argv)
{
	(void)argc; (void)argv;
	puts("localhost");
	return 0;
}

static const struct applet {
	const char *name;
	int (*mainfn)(int argc, char **argv);
} applets[] = {
	{ "[",        test_main },
	{ "awk",      awk_main },
	{ "base64",   baseNUM_main },
	{ "basename", basename_main },
	{ "cat",      cat_main },
	{ "cksum",    cksum_main },
	{ "cmp",      cmp_main },
	{ "comm",     comm_main },
	{ "cp",       cp_main },
	{ "cut",      cut_main },
	{ "date",     date_main },
	{ "dd",       dd_main },
	{ "diff",     diff_main },
	{ "dirname",  dirname_main },
	{ "du",       du_main },
	{ "echo",     echo_main },
	{ "egrep",    grep_main },
	{ "env",      env_main },
	{ "expr",     expr_main },
	{ "false",    false_main },
	{ "fgrep",    grep_main },
	{ "find",     find_main },
	{ "fold",     fold_main },
	{ "grep",     grep_main },
	{ "gunzip",   gunzip_main },
	{ "gzip",     gzip_main },
	{ "head",     head_main },
	{ "hostname", hostname_main },
	{ "id",       id_main },
	{ "kill",     kill_main },
	{ "less",     less_main },
	{ "ln",       ln_main },
	{ "ls",       ls_main },
	{ "md5sum",   md5_sha1_sum_main },
	{ "mkdir",    mkdir_main },
	{ "mktemp",   mktemp_main },
	{ "mv",       mv_main },
	{ "nl",       nl_main },
	{ "od",       od_main },
	{ "paste",    paste_main },
	{ "printf",   printf_main },
	{ "pwd",      pwd_main },
	{ "readlink", readlink_main },
	{ "realpath", realpath_main },
	{ "rm",       rm_main },
	{ "rmdir",    rmdir_main },
	{ "sed",      sed_main },
	{ "seq",      seq_main },
	{ "sha1sum",  md5_sha1_sum_main },
	{ "sha256sum", md5_sha1_sum_main },
	{ "sleep",    sleep_main },
	{ "sort",     sort_main },
	{ "split",    split_main },
	{ "stat",     stat_main },
	{ "sync",     sync_main },
	{ "tac",      tac_main },
	{ "tail",     tail_main },
	{ "tar",      tar_main },
	{ "tee",      tee_main },
	{ "test",     test_main },
	{ "touch",    touch_main },
	{ "tr",       tr_main },
	{ "true",     true_main },
	{ "truncate", truncate_main },
	{ "uname",    uname_main },
	{ "uniq",     uniq_main },
	{ "unlink",   unlink_main },
	{ "usleep",   usleep_main },
	{ "vi",       vi_main },
	{ "wc",       wc_main },
	{ "which",    which_main },
	{ "whoami",   whoami_main },
	{ "xargs",    xargs_main },
	{ "yes",      yes_main },
	{ "zcat",     gunzip_main },
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
