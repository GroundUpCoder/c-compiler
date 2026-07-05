/* /bin/cc — the C compiler as an OS binary. There is no wasm image to exec
 * (the compiler is compiler.js, living in the kernel worker), so this is a
 * thin shim over the __compile syscall: ship argv+cwd to the kernel's
 * compile hook, then write the returned stdout/stderr to our OWN fds — so
 * redirection and pipes apply to compiler output like any other program's.
 * Default output is ./a.out, immediately spawnable (`cc hello.c && ./a.out`).
 */
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static char buf[1 << 20];   /* exitcode + captured compiler stdout/stderr */

int main(int argc, char **argv) {
    (void)argc;
    char cwd[512];
    if (!getcwd(cwd, sizeof cwd)) strcpy(cwd, "/");
    int n = __compile(cwd, argv, buf, sizeof buf);
    if (n < 0) { perror("cc"); return 1; }
    int exit_code, out_len, err_len;
    memcpy(&exit_code, buf, 4);
    memcpy(&out_len, buf + 4, 4);
    memcpy(&err_len, buf + 8, 4);
    fwrite(buf + 12, 1, (size_t)out_len, stdout);
    fwrite(buf + 12 + out_len, 1, (size_t)err_len, stderr);
    return exit_code;
}
