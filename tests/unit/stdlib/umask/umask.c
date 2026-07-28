// todos/0382 gap 1 — umask(2).
//
// This asserts BEHAVIOUR, not linkage, deliberately: the ticket's own warning
// is that "an umask that links and returns 0 unconditionally is worse than an
// absent one, because it silences the probe that would have caught it". So
// every check below reads a mode back off the filesystem after a creation.

#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

static int perm(const char *path) {
  struct stat st;
  if (stat(path, &st) != 0) return -1;
  return (int)(st.st_mode & 0777);
}

int main(void) {
  // --- the mask register itself: umask() returns the PREVIOUS mask ---
  printf("initial=%03o\n", umask(022));   // starts at the conventional 022
  printf("after022=%03o\n", umask(077));  // returns the 022 we just set
  printf("after077=%03o\n", umask(0));    // returns the 077 we just set

  // Only the permission bits are maskable. POSIX: "Only the file permission
  // bits of cmask are used; the meaning of other bits is implementation-
  // defined" — so what a umask() READS BACK after being handed 07777 is a
  // real fork in the road, and the platforms disagree:
  //   Linux  — the syscall does `mask & S_IRWXUGO`, so this reads 0777
  //   macOS  — retains the extra bits, so this reads 7777 (verified)
  // We follow LINUX, like the rest of this runtime (errno numbering, /proc
  // formats, the *at flag values). This line is the pin on that choice; the
  // other twelve are byte-identical to macOS/clang.
  umask(07777);
  printf("masked_bits=%04o\n", umask(0));

  // --- open(O_CREAT): the mask really clears bits ---
  umask(077);
  int fd = open("/um_a", O_WRONLY | O_CREAT | O_TRUNC, 0666);
  close(fd);
  printf("open_0666_umask077=%03o\n", perm("/um_a"));   // 0600

  umask(022);
  fd = open("/um_b", O_WRONLY | O_CREAT | O_TRUNC, 0666);
  close(fd);
  printf("open_0666_umask022=%03o\n", perm("/um_b"));   // 0644

  // A zero mask must leave the requested mode completely alone — this is the
  // check that would fail if umask were applied but wired backwards.
  umask(0);
  fd = open("/um_c", O_WRONLY | O_CREAT | O_TRUNC, 0666);
  close(fd);
  printf("open_0666_umask000=%03o\n", perm("/um_c"));   // 0666

  // --- mkdir ---
  umask(022);
  mkdir("/um_d1", 0777);
  printf("mkdir_0777_umask022=%03o\n", perm("/um_d1"));  // 0755

  umask(027);
  mkdir("/um_d2", 0777);
  printf("mkdir_0777_umask027=%03o\n", perm("/um_d2"));  // 0750

  // --- creat() takes the same path ---
  umask(077);
  fd = creat("/um_e", 0666);
  close(fd);
  printf("creat_0666_umask077=%03o\n", perm("/um_e"));   // 0600

  // --- fopen() goes through open(), so it is masked too (POSIX requires it:
  //     fopen creates with 0666 & ~umask) ---
  umask(027);
  FILE *f = fopen("/um_f", "w");
  fclose(f);
  printf("fopen_umask027=%03o\n", perm("/um_f"));        // 0640

  // --- the mask must NOT touch an open() that does not create ---
  umask(0);
  fd = open("/um_c", O_WRONLY | O_CREAT | O_TRUNC, 0666);
  close(fd);
  umask(077);
  fd = open("/um_c", O_RDONLY);   // no O_CREAT: mode is not consulted
  close(fd);
  printf("existing_unchanged=%03o\n", perm("/um_c"));    // still 0666

  // --- chmod is NOT masked (POSIX: only creation is) ---
  umask(077);
  chmod("/um_c", 0666);
  printf("chmod_unmasked=%03o\n", perm("/um_c"));        // 0666

  return 0;
}
