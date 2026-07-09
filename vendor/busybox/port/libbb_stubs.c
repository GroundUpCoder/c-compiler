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
