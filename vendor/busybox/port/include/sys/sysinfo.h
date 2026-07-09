/* sys/sysinfo.h — WASM PORT (todos/0043).
 *
 * Linux's sysinfo(2) surface for the procps applets (uptime, free). The
 * implementation (port/libbb_stubs.c) reads the kernel's synthetic /proc —
 * uptime, loadavg, meminfo — and reports zeros gracefully when /proc isn't
 * mounted (standalone runs outside the OS).
 */
#ifndef WASM_PORT_SYS_SYSINFO_H
#define WASM_PORT_SYS_SYSINFO_H 1

struct sysinfo {
	long uptime;                  /* seconds since boot */
	unsigned long loads[3];       /* 1/5/15-min load, fixed point 1<<16 */
	unsigned long totalram;       /* in mem_unit units */
	unsigned long freeram;
	unsigned long sharedram;
	unsigned long bufferram;
	unsigned long totalswap;
	unsigned long freeswap;
	unsigned short procs;         /* process count */
	unsigned short pad;
	unsigned long totalhigh;
	unsigned long freehigh;
	unsigned int mem_unit;        /* bytes per unit (1024 here: kB values) */
	char _f[8];                   /* libc-compat padding */
};

int sysinfo(struct sysinfo *info);

#endif
