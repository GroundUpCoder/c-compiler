/* Stub pwd.h for WASM */
#ifndef STUB_PWD_H
#define STUB_PWD_H
#include <sys/types.h>
#include <stddef.h>
struct passwd { char *pw_name; uid_t pw_uid; gid_t pw_gid; char *pw_dir; char *pw_shell; };
#include <errno.h>
static inline struct passwd *getpwuid(uid_t uid) { (void)uid; return NULL; }
static inline struct passwd *getpwnam(const char *name) { (void)name; return NULL; }
static inline int getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen, struct passwd **result) {
    (void)uid; (void)pwd; (void)buf; (void)buflen;
    *result = NULL;
    return 0;
}
#endif
