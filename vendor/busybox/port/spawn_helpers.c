/* spawn_helpers.c — libbb's spawn()/xspawn()/spawn_and_wait() over the
 * vfork-on-__spawn shim (todos/0035).
 *
 * Upstream these live in libbb/vfork_daemon_rexec.c, which drags in the
 * kbuild applet tables (busybox.h, NUM_APPLETS.h) for its NOFORK/NOEXEC
 * shortcuts — machinery this port deliberately replaced with a hand-rolled
 * applet table (multicall_main.c). The callers (find -exec, xargs, tar's
 * seamless-.gz re-exec) only need the plain semantics: run argv, PATH
 * search, return the pid / wait for it. So: the same journaling-vfork
 * dance hush uses, spelled with explicit pv_* calls.
 *
 * Exec failure follows upstream's NOMMU shape: the "child" records errno
 * in a volatile and _exit(111)s (a synthetic pid, reaped here), so
 * spawn() returns -1 with errno just like the vfork original.
 */
#define PV_NO_INTERCEPT 1
#include "libbb.h"

pid_t FAST_FUNC spawn(char **argv)
{
	volatile int failed = 0;

	fflush_all();
	if (setjmp(pv_state.jmp) == 0) {
		pv_child_begin();
		pv_execvp(argv[0], argv);
		/* still here: the spawn failed */
		failed = errno;
		pv_exit(111);
	}
	if (failed) {
		pv_waitpid(pv_state.child_pid, NULL, 0);  /* reap the synth */
		errno = failed;
		return -1;
	}
	return pv_state.child_pid;
}

pid_t FAST_FUNC xspawn(char **argv)
{
	pid_t pid = spawn(argv);
	if (pid < 0)
		bb_simple_perror_msg_and_die(*argv);
	return pid;
}

int FAST_FUNC spawn_and_wait(char **argv)
{
	return wait4pid(spawn(argv));
}
