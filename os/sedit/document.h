#ifndef SEDIT_DOCUMENT_H
#define SEDIT_DOCUMENT_H
#include <stddef.h>
#include <stdint.h>
#include <sys/stat.h>
#include <sys/types.h>

#define SEDIT_MAX_FILE (8u * 1024u * 1024u)
enum SeditEol { SEDIT_EOL_LF, SEDIT_EOL_CRLF, SEDIT_EOL_CR, SEDIT_EOL_MIXED };
enum SeditSaveResult { SEDIT_SAVE_OK=0, SEDIT_SAVE_ERROR=-1,
    SEDIT_SAVE_CONFLICT=-2, SEDIT_SAVE_HARDLINK=-3 };
typedef struct {
    char *text; size_t len;
    char user_path[1024], target_path[1024];
    char opened_hash[65]; struct stat opened_stat;
    enum SeditEol eol; int bom, dirty, have_snapshot;
    char error[512];
} SeditDocument;

#ifdef SEDIT_TEST
typedef struct {
    int (*lstat_fn)(const char *, struct stat *); int (*stat_fn)(const char *, struct stat *);
    char *(*realpath_fn)(const char *, char *); int (*open_fn)(const char *, int, mode_t);
    ssize_t (*read_fn)(int, void *, size_t); ssize_t (*write_fn)(int, const void *, size_t);
    int (*close_fn)(int); int (*fchmod_fn)(int, mode_t); int (*fsync_fn)(int);
    int (*rename_fn)(const char *, const char *); int (*unlink_fn)(const char *);
    int (*sha256_path_fn)(const char *, char[65]);
} SeditIOOps;
void sedit_document_test_io(const SeditIOOps *ops);
#endif

void sedit_document_init(SeditDocument *d);
void sedit_document_free(SeditDocument *d);
int sedit_document_load(SeditDocument *d,const char *path);
int sedit_document_set_eol(SeditDocument *d,enum SeditEol eol);
int sedit_document_new(SeditDocument *d);
int sedit_document_location(const char *arg,char *path,size_t cap,uint32_t *line);
int sedit_document_diagnostic(const char *text,char *path,size_t cap,uint32_t *line);
int sedit_document_line_offset(const char *text,size_t len,uint32_t line,uint32_t *off,uint32_t *lines);
enum SeditSaveResult sedit_document_save(SeditDocument *d,const char *path,
    const char *lf_text,size_t len,int overwrite,int break_links);
#endif
