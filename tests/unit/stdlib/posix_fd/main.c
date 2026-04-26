#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

int main(void) {
  const char *path = "/tmp/__posix_fd_test.txt";
  const char *msg = "Hello, POSIX fd!\n";
  long len = strlen(msg);

  /* Write to a file */
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    printf("open for write failed\n");
    return 1;
  }
  long nw = write(fd, msg, len);
  printf("wrote %ld bytes\n", nw);
  close(fd);

  /* Read it back */
  fd = open(path, O_RDONLY);
  if (fd < 0) {
    printf("open for read failed\n");
    return 1;
  }
  char buf[64];
  long nr = read(fd, buf, 63);
  buf[nr] = '\0';
  printf("read %ld bytes: %s", nr, buf);

  /* Test lseek SEEK_SET */
  long pos = lseek(fd, 0, SEEK_SET);
  printf("lseek SET 0 -> %ld\n", pos);

  /* Read first 5 bytes after seeking */
  nr = read(fd, buf, 5);
  buf[nr] = '\0';
  printf("after SET read: %s\n", buf);

  /* Test lseek SEEK_CUR */
  pos = lseek(fd, 2, SEEK_CUR);
  printf("lseek CUR 2 -> %ld\n", pos);

  /* Test lseek SEEK_END */
  pos = lseek(fd, 0, SEEK_END);
  printf("lseek END 0 -> %ld\n", pos);

  close(fd);

  /* Test write to STDOUT_FILENO */
  const char *direct = "direct write ok\n";
  write(STDOUT_FILENO, direct, strlen(direct));

  /* Test errno: open nonexistent file */
  errno = 0;
  int bad = open("/tmp/__nonexistent_file_12345.txt", O_RDONLY);
  printf("open nonexistent -> %d\n", bad);
  printf("errno = %d (ENOENT = %d)\n", errno, ENOENT);

  /* Test errno: close bad fd */
  errno = 0;
  int ret = close(999);
  printf("close bad fd -> %d\n", ret);
  printf("errno = %d (EBADF = %d)\n", errno, EBADF);

  return 0;
}
