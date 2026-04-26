#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <dirent.h>
#include <fcntl.h>

int main(void) {
  /* --- getcwd --- */
  char cwd[512];
  if (getcwd(cwd, sizeof(cwd))) {
    printf("getcwd: ok\n");
  } else {
    printf("getcwd: FAIL\n");
  }

  /* --- mkdir + chdir --- */
  mkdir("__test_posix_dir", 0755);
  if (chdir("__test_posix_dir") == 0) {
    printf("chdir: ok\n");
  } else {
    printf("chdir: FAIL\n");
  }

  /* Create some test files */
  int fd1 = open("file_a.txt", O_CREAT | O_WRONLY, 0644);
  write(fd1, "hello", 5);
  close(fd1);

  int fd2 = open("file_b.txt", O_CREAT | O_WRONLY, 0644);
  write(fd2, "world", 5);
  close(fd2);

  mkdir("subdir", 0755);

  /* --- stat --- */
  struct stat st;
  if (stat("file_a.txt", &st) == 0) {
    printf("stat size: %lu\n", st.st_size);
    printf("stat isreg: %d\n", S_ISREG(st.st_mode));
    printf("stat isdir: %d\n", S_ISDIR(st.st_mode));
  } else {
    printf("stat: FAIL\n");
  }

  if (stat("subdir", &st) == 0) {
    printf("stat subdir isdir: %d\n", S_ISDIR(st.st_mode));
  } else {
    printf("stat subdir: FAIL\n");
  }

  /* --- access --- */
  printf("access file_a: %d\n", access("file_a.txt", F_OK));
  printf("access nofile: %d\n", access("no_such_file.txt", F_OK));

  /* --- opendir / readdir / closedir --- */
  DIR *dir = opendir(".");
  if (!dir) {
    printf("opendir: FAIL\n");
    return 1;
  }

  /* Collect names, sort for deterministic output */
  char names[16][256];
  int count = 0;
  struct dirent *ent;
  while ((ent = readdir(dir)) != 0) {
    /* Skip . and .. */
    if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0)
      continue;
    strcpy(names[count], ent->d_name);
    count++;
  }
  closedir(dir);

  /* Simple bubble sort */
  for (int i = 0; i < count - 1; i++) {
    for (int j = 0; j < count - 1 - i; j++) {
      if (strcmp(names[j], names[j + 1]) > 0) {
        char tmp[256];
        strcpy(tmp, names[j]);
        strcpy(names[j], names[j + 1]);
        strcpy(names[j + 1], tmp);
      }
    }
  }

  printf("readdir count: %d\n", count);
  for (int i = 0; i < count; i++) {
    printf("  %s\n", names[i]);
  }

  /* --- cleanup: unlink files, rmdir --- */
  unlink("file_a.txt");
  unlink("file_b.txt");
  rmdir("subdir");
  chdir("..");
  rmdir("__test_posix_dir");

  printf("done\n");
  return 0;
}
