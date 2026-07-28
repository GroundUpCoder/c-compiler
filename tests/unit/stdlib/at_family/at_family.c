// todos/0325 Group B + todos/0382 gaps 7-8 — the *at() family.
// BEHAVIOUR: each call must really act on the file, and the dirfd rules must
// be POSIX-correct, INCLUDING the error cases.
//
// Why the dirfd cases matter here: no file descriptor on this platform can
// refer to a directory (BlockFS.open answers EISDIR; there is no
// O_DIRECTORY; opendir returns a DIR* from a separate handle namespace).
// So case 3 of POSIX resolution — resolve against the fd's directory —
// cannot arise, and the correct answers are EBADF for a closed fd and
// ENOTDIR for a live non-directory one. Those are asserted below rather
// than left untested, because "returns the right errno" is the whole
// difference between a real limit and a silent wrong answer.
// Directory fds are todos/0400; when they land, only __at_ok changes.
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <errno.h>
#include <string.h>

static void wr(const char *p, const char *s) {
  int fd = open(p, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  write(fd, s, strlen(s));
  close(fd);
}
static int exists(const char *p) { struct stat st; return stat(p, &st) == 0; }

int main(void) {
  umask(0);
  mkdir("/atd", 0755);
  wr("/atd/f1", "hello");

  // ---- AT_FDCWD: exactly the plain call ----
  struct stat st;
  printf("fstatat_cwd=%d size=%lld\n",
         fstatat(AT_FDCWD, "/atd/f1", &st, 0), (long long)st.st_size);

  int fd = openat(AT_FDCWD, "/atd/f1", O_RDONLY);
  char buf[16] = {0};
  long n = read(fd, buf, sizeof buf - 1);
  close(fd);
  printf("openat_cwd fd_ok=%d read=[%s]\n", n == 5, buf);

  printf("mkdirat=%d exists=%d\n", mkdirat(AT_FDCWD, "/atd/sub", 0700), exists("/atd/sub"));
  struct stat ds;
  stat("/atd/sub", &ds);
  printf("mkdirat_mode=%03o\n", (unsigned)(ds.st_mode & 0777));

  // faccessat / renameat / unlinkat
  printf("faccessat=%d\n", faccessat(AT_FDCWD, "/atd/f1", F_OK, 0));
  printf("renameat=%d moved=%d gone=%d\n",
         renameat(AT_FDCWD, "/atd/f1", AT_FDCWD, "/atd/f2"),
         exists("/atd/f2"), !exists("/atd/f1"));
  printf("unlinkat=%d gone=%d\n", unlinkat(AT_FDCWD, "/atd/f2", 0), !exists("/atd/f2"));

  // AT_REMOVEDIR routes to rmdir; without it, unlinking a dir must FAIL
  mkdir("/atd/rd", 0755);
  errno = 0;
  int bad = unlinkat(AT_FDCWD, "/atd/rd", 0);
  printf("unlinkat_dir_without_flag=%d still=%d\n", bad, exists("/atd/rd"));
  printf("unlinkat_removedir=%d gone=%d\n",
         unlinkat(AT_FDCWD, "/atd/rd", AT_REMOVEDIR), !exists("/atd/rd"));

  // symlinkat / readlinkat / fstatat AT_SYMLINK_NOFOLLOW
  wr("/atd/target", "xyz");
  printf("symlinkat=%d\n", symlinkat("/atd/target", AT_FDCWD, "/atd/link"));
  char lb[64] = {0};
  long ln = readlinkat(AT_FDCWD, "/atd/link", lb, sizeof lb - 1);
  printf("readlinkat len=%d body=[%s]\n", (int)ln, lb);
  struct stat fs_, ls_;
  fstatat(AT_FDCWD, "/atd/link", &fs_, 0);
  fstatat(AT_FDCWD, "/atd/link", &ls_, AT_SYMLINK_NOFOLLOW);
  printf("follow_is_reg=%d nofollow_is_lnk=%d\n",
         S_ISREG(fs_.st_mode) != 0, S_ISLNK(ls_.st_mode) != 0);

  // linkat, and AT_SYMLINK_FOLLOW resolving the source symlink
  printf("linkat=%d\n", linkat(AT_FDCWD, "/atd/target", AT_FDCWD, "/atd/hard", 0));
  struct stat hs;
  stat("/atd/hard", &hs);
  printf("linkat_same_inode=%d nlink=%d\n",
         hs.st_ino == fs_.st_ino, (int)hs.st_nlink);
  printf("linkat_follow=%d\n",
         linkat(AT_FDCWD, "/atd/link", AT_FDCWD, "/atd/hard2", AT_SYMLINK_FOLLOW));
  struct stat h2;
  lstat("/atd/hard2", &h2);
  printf("follow_made_hardlink_not_symlink=%d\n", S_ISREG(h2.st_mode) != 0);

  // fchmodat
  fchmodat(AT_FDCWD, "/atd/target", 0640, 0);
  stat("/atd/target", &st);
  printf("fchmodat=%03o\n", (unsigned)(st.st_mode & 0777));
  // AT_SYMLINK_NOFOLLOW on fchmodat asks to change the LINK's own mode.
  // Linux answers ENOTSUP (symlinks carry no mode there, as here); the BSDs
  // and macOS really do support it and return 0. We follow Linux, like the
  // rest of this runtime — so this is the ONE line of this test that differs
  // from clang-on-macOS; the other 21 are byte-identical to it.
  errno = 0;
  int nf = fchmodat(AT_FDCWD, "/atd/link", 0600, AT_SYMLINK_NOFOLLOW);
  printf("fchmodat_nofollow=%d enotsup=%d\n", nf, errno == ENOTSUP);

  // ---- absolute paths ignore dirfd entirely, even a nonsense one ----
  printf("abs_ignores_dirfd=%d\n", fstatat(-999, "/atd/target", &st, 0));

  // ---- a RELATIVE path with a non-AT_FDCWD dirfd ----
  int filefd = open("/atd/target", O_RDONLY);      // a live, valid, NON-dir fd
  errno = 0;
  printf("relative_on_filefd=%d enotdir=%d\n",
         fstatat(filefd, "target", &st, 0), errno == ENOTDIR);
  errno = 0;
  printf("openat_on_filefd=%d enotdir=%d\n",
         openat(filefd, "target", O_RDONLY), errno == ENOTDIR);
  close(filefd);
  errno = 0;
  printf("relative_on_closed_fd=%d ebadf=%d\n",
         fstatat(filefd, "target", &st, 0), errno == EBADF);

  // ---- truncate / posix_fallocate / posix_fadvise ----
  wr("/atd/tr", "0123456789");
  printf("truncate=%d ", truncate("/atd/tr", 4));
  stat("/atd/tr", &st);
  printf("size=%lld\n", (long long)st.st_size);

  int afd = open("/atd/tr", O_RDWR);
  printf("fallocate=%d ", posix_fallocate(afd, 0, 100));
  fstat(afd, &st);
  printf("size=%lld\n", (long long)st.st_size);
  printf("fallocate_noshrink=%d ", posix_fallocate(afd, 0, 10));
  fstat(afd, &st);
  printf("size=%lld\n", (long long)st.st_size);
  printf("fallocate_einval=%d\n", posix_fallocate(afd, -1, 10) == EINVAL);
  printf("fadvise_ok=%d fadvise_badadvice=%d\n",
         posix_fadvise(afd, 0, 0, POSIX_FADV_SEQUENTIAL),
         posix_fadvise(afd, 0, 0, 99) == EINVAL);
  close(afd);
  printf("fadvise_badfd=%d fallocate_badfd=%d\n",
         posix_fadvise(afd, 0, 0, POSIX_FADV_NORMAL) == EBADF,
         posix_fallocate(afd, 0, 10) != 0);
  return 0;
}
