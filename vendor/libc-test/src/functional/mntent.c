// SPDX-License-Identifier: MIT

#define _DEFAULT_SOURCE // for getmntent_r

#include <mntent.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>

#include "test.h"

#define ASSERT(x) do {				 \
		if (!(x)) {			 \
			t_error(#x " failed\n"); \
			exit(EXIT_FAILURE);	 \
		}				 \
	} while (0);

#define ERR(fmt, ...) do {					       \
		t_error(fmt ": %s\n", ##__VA_ARGS__, strerror(errno)); \
		exit(EXIT_FAILURE);				       \
	} while (0)

void test_getmntent_empty(void)
{
	char fstab[] = "\n";
	FILE *f = fmemopen((void *)fstab, sizeof fstab - 1, "r");
	if (!f) ERR("fmemopen");
	ASSERT(!getmntent(f));
	ASSERT(endmntent(f) == 1);
}

void test_getmntent(void)
{
	// Checks that the fifth and sixth fields default to 0.
	char fstab[] = "none /proc proc defaults\n";
	FILE *f = fmemopen((void *)fstab, sizeof fstab - 1, "r");
	if (!f) ERR("fmemopen");
	struct mntent *m = getmntent(f);
	ASSERT(m);
	ASSERT(!strcmp(m->mnt_fsname, "none"));
	ASSERT(!strcmp(m->mnt_dir, "/proc"));
	ASSERT(!strcmp(m->mnt_type, "proc"));
	ASSERT(!strcmp(m->mnt_opts, "defaults"));
	ASSERT(m->mnt_freq == 0);
	ASSERT(m->mnt_passno == 0);
	ASSERT(endmntent(f) == 1);
}

void test_getmntent_r(void)
{
	struct mntent m, *r;
	char fstab[] = "/dev/sda\t/\text4\trw,nosuid\t2\t1\n";
	char buf[sizeof(fstab)];

	FILE *f = fmemopen((void *)fstab, sizeof fstab - 1, "r");
	if (!f) ERR("fmemopen");

	r = getmntent_r(f, &m, buf, sizeof buf);
	ASSERT(r == &m);
	ASSERT(!strcmp(m.mnt_fsname, "/dev/sda"));
	ASSERT(!strcmp(m.mnt_dir, "/"));
	ASSERT(!strcmp(m.mnt_type, "ext4"));
	ASSERT(!strcmp(m.mnt_opts, "rw,nosuid"));
	ASSERT(m.mnt_freq == 2);
	ASSERT(m.mnt_passno == 1);
	ASSERT(endmntent(f) == 1);
}

int main(void)
{
	test_getmntent_empty();
	test_getmntent();
	test_getmntent_r();
}
