/* libbb_stubs.c — the few appletlib.c symbols the hush build references,
 * without dragging in the whole busybox applet framework (usage strings,
 * applet tables, the multicall main). hush is a standalone binary here;
 * /bin/sh IS the program.
 */
#define PV_NO_INTERCEPT 1
#include "libbb.h"

/* appletlib.c: usage message for builtins that hit bad args. The applet
 * usage-string machinery is compiled out; a generic message keeps the
 * exit-status semantics (die with 1). */
void FAST_FUNC bb_show_usage(void)
{
    bb_simple_error_msg_and_die("invalid usage");
}

/* appletlib.c: NULL-terminated string-array length. */
unsigned FAST_FUNC string_array_len(char **argv)
{
    unsigned n = 0;
    while (argv[n]) n++;
    return n;
}

/* sysconf.c replacement: our libc's sysconf is a -1 stub and lacks
 * _SC_CLK_TCK; the value only feeds `times` output scaling. */
unsigned FAST_FUNC bb_clk_tck(void)
{
    return 100;
}

/* appletlib.c globals. Each binary IS its applet: hush by default, or
 * whatever the per-applet bin.json defines (todos/0010). */
#ifndef PORT_APPLET_NAME
#define PORT_APPLET_NAME "hush"
#endif
const char *applet_name = PORT_APPLET_NAME;
uint8_t xfunc_error_retval = EXIT_FAILURE;

/* bb_getgroups.c replacement: single-user system — root, one group. */
gid_t* FAST_FUNC bb_getgroups(int *ngroups, gid_t *group_array)
{
    if (!group_array) group_array = xzalloc(sizeof(gid_t));
    group_array[0] = 0;
    if (ngroups) *ngroups = 1;
    return group_array;
}

/* bb_pwd.c replacement (todos/0035): tar create stamps uname/gname into
 * every header — on a single-user system the answer is fixed, so these
 * skip libpwdgrp entirely (the FEATURE_LS_USERNAME-off philosophy). */
const char* FAST_FUNC get_cached_username(uid_t uid)
{
    (void)uid;
    return "root";
}
const char* FAST_FUNC get_cached_groupname(gid_t gid)
{
    (void)gid;
    return "root";
}
/* libbb/procps.c's cache is compiled out with the two stubs above
 * (todos/0043) — nothing cached, nothing to clear. */
void FAST_FUNC clear_username_cache(void)
{
}

/* sysinfo(2) replacement (todos/0043): uptime/free want the Linux syscall;
 * here it's a read of the kernel's synthetic /proc (uptime, loadavg,
 * meminfo — Linux formats by construction). Values are in mem_unit=1024
 * units, i.e. meminfo's kB numbers verbatim; missing /proc (standalone
 * runs outside the OS) reports zeros instead of failing. */
#include <sys/sysinfo.h>

static long pv_sysinfo_read(const char *path, char *buf, int cap)
{
    int fd = open(path, O_RDONLY);
    long n = -1;
    if (fd >= 0) {
        n = read(fd, buf, cap - 1);
        close(fd);
    }
    buf[n > 0 ? n : 0] = '\0';
    return n;
}

int sysinfo(struct sysinfo *info)
{
    char buf[1024];
    memset(info, 0, sizeof(*info));
    info->mem_unit = 1024;

    if (pv_sysinfo_read("/proc/uptime", buf, sizeof(buf)) > 0)
        info->uptime = (long)strtoul(buf, NULL, 10);

    if (pv_sysinfo_read("/proc/loadavg", buf, sizeof(buf)) > 0) {
        /* "L1.LL L5.LL L15.LL running/total lastpid" -> 1<<16 fixed point */
        char *p = buf;
        int i;
        for (i = 0; i < 3; i++) {
            unsigned long whole = strtoul(p, &p, 10);
            unsigned long frac = 0;
            if (*p == '.') frac = strtoul(p + 1, &p, 10); /* two digits */
            info->loads[i] = (whole << 16) + (frac << 16) / 100;
            while (*p == ' ') p++;
        }
        strtoul(p, &p, 10);              /* running */
        if (*p == '/') info->procs = (unsigned short)strtoul(p + 1, &p, 10);
    }

    if (pv_sysinfo_read("/proc/meminfo", buf, sizeof(buf)) > 0) {
        /* "Field:   NNN kB" lines; values land in kB = mem_unit units. */
        static const struct { const char *name; unsigned char off; } fields[] = {
            { "MemTotal:",  offsetof(struct sysinfo, totalram)  },
            { "MemFree:",   offsetof(struct sysinfo, freeram)   },
            { "Shmem:",     offsetof(struct sysinfo, sharedram) },
            { "Buffers:",   offsetof(struct sysinfo, bufferram) },
            { "SwapTotal:", offsetof(struct sysinfo, totalswap) },
            { "SwapFree:",  offsetof(struct sysinfo, freeswap)  },
        };
        char *line = buf;
        while (line && *line) {
            unsigned i;
            for (i = 0; i < sizeof(fields) / sizeof(fields[0]); i++) {
                const char *tp = is_prefixed_with(line, fields[i].name);
                if (tp) {
                    *(unsigned long *)((char *)info + fields[i].off) =
                        strtoul(tp, NULL, 10);
                    break;
                }
            }
            line = strchr(line, '\n');
            if (line) line++;
        }
    }
    return 0;
}
