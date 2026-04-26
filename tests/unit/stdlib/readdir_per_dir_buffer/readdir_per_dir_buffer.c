/*
 * Test: readdir buffers should be per-DIR*, not globally shared
 *
 * Bug: The C wrapper uses a single global `static struct dirent __dirent_buf`
 * for ALL readdir calls. POSIX says the buffer may be overwritten by
 * "another call to readdir() on the same directory stream" — but NOT
 * by calls on a different stream.
 *
 * This means interleaving readdir on two DIR*s corrupts results.
 * The fix would be to embed the dirent buffer inside the DIR struct.
 */
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <dirent.h>
#include <fcntl.h>

int main(void) {
  mkdir("__test_per_dir", 0755);
  chdir("__test_per_dir");

  /* Create two directories with distinct files */
  mkdir("dir_a", 0755);
  mkdir("dir_b", 0755);
  int fa = open("dir_a/alpha.txt", O_CREAT | O_WRONLY, 0644);
  close(fa);
  int fb = open("dir_b/beta.txt", O_CREAT | O_WRONLY, 0644);
  close(fb);

  /* Open both directories */
  DIR *da = opendir("dir_a");
  DIR *db = opendir("dir_b");

  /* Read one entry from dir_a (skip . and ..) */
  struct dirent *ea = readdir(da);
  while (ea && (strcmp(ea->d_name, ".") == 0 || strcmp(ea->d_name, "..") == 0))
    ea = readdir(da);

  if (!ea) {
    printf("FAIL: no entries in dir_a\n");
    goto cleanup;
  }

  /* Save what ea->d_name was */
  char saved_a[256];
  strcpy(saved_a, ea->d_name);

  /* Now read from dir_b — this should NOT affect ea */
  struct dirent *eb = readdir(db);
  while (eb && (strcmp(eb->d_name, ".") == 0 || strcmp(eb->d_name, "..") == 0))
    eb = readdir(db);

  if (!eb) {
    printf("FAIL: no entries in dir_b\n");
    goto cleanup;
  }

  /* Check if reading from db corrupted ea's d_name */
  int name_preserved = (strcmp(ea->d_name, saved_a) == 0);
  printf("ea->d_name after readdir(db): %s (expected %s)\n",
         ea->d_name, saved_a);
  printf("buffer independent: %d\n", name_preserved);

cleanup:
  closedir(da);
  closedir(db);

  unlink("dir_a/alpha.txt");
  unlink("dir_b/beta.txt");
  rmdir("dir_a");
  rmdir("dir_b");
  chdir("..");
  rmdir("__test_per_dir");

  return 0;
}
