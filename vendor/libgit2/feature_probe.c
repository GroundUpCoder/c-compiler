/* Scratch: exercise a spread of libgit2 features to see what works on the
   c-compiler/WASM target. Each step logs to stderr (unbuffered) so that if a
   step traps the WASM, the last line printed tells us exactly where. */
#include <stdio.h>
#include <string.h>
#include <git2.h>

/* The 1 MB shadow stack libgit2's file I/O needs is set by __minstack in
   missing_stubs.c (compiled into every libgit2 target), so this TU needs none. */

#define LOG(...) do { fprintf(stderr, __VA_ARGS__); fprintf(stderr, "\n"); } while (0)

static const char *lasterr(void) {
    const git_error *e = git_error_last();
    return (e && e->message) ? e->message : "(no message)";
}
#define CHECK(e, what) do { \
    int _r = (e); \
    if (_r < 0) { LOG("  FAIL  %s: rc=%d err=%s", what, _r, lasterr()); } \
    else        { LOG("  ok    %s", what); } \
} while (0)

int main(void) {
    git_libgit2_init();

    int maj=0, min=0, rev=0;
    git_libgit2_version(&maj, &min, &rev);
    LOG("== libgit2 %d.%d.%d ==", maj, min, rev);

    /* ---- 1. OID parse/format (pure, no FS) ---- */
    LOG("[1] oid parse/format");
    git_oid oid;
    CHECK(git_oid_fromstr(&oid, "0123456789abcdef0123456789abcdef01234567"), "git_oid_fromstr");
    char oidstr[GIT_OID_SHA1_HEXSIZE+1] = {0};
    git_oid_tostr(oidstr, sizeof(oidstr), &oid);
    LOG("       roundtrip -> %s", oidstr);

    /* ---- 2. hash a buffer (sha1 over data) ---- */
    LOG("[2] hash buffer");
    git_oid bhash;
    CHECK(git_odb_hash(&bhash, "hello\n", 6, GIT_OBJECT_BLOB), "git_odb_hash(blob)");
    git_oid_tostr(oidstr, sizeof(oidstr), &bhash);
    LOG("       sha1(blob 'hello\\n') -> %s  (git expects ce013625...)", oidstr);

    /* ---- 3. repository init ---- */
    LOG("[3] repository init/open");
    git_repository *repo = NULL;
    CHECK(git_repository_init(&repo, "/tmp/probe_repo", 0), "git_repository_init");
    if (!repo) { LOG("  no repo, stopping"); return 1; }

    /* ---- 4. config read/write ---- */
    LOG("[4] config");
    git_config *cfg = NULL;
    CHECK(git_repository_config(&cfg, repo), "git_repository_config");
    if (cfg) {
        CHECK(git_config_set_string(cfg, "user.name", "Probe Tester"), "config_set_string");
        git_buf gb = {0};
        CHECK(git_config_get_string_buf(&gb, cfg, "user.name"), "config_get_string");
        LOG("       user.name -> %s", gb.ptr ? gb.ptr : "(null)");
        git_buf_dispose(&gb);
    }

    /* ---- 5. blob create + lookup + read ---- */
    LOG("[5] blob create/lookup");
    git_oid blobid;
    CHECK(git_blob_create_from_buffer(&blobid, repo, "hello\n", 6), "git_blob_create_from_buffer");
    git_blob *blob = NULL;
    CHECK(git_blob_lookup(&blob, repo, &blobid), "git_blob_lookup");
    if (blob) {
        git_object_size_t sz = git_blob_rawsize(blob);
        const char *content = (const char*)git_blob_rawcontent(blob);
        LOG("       blob size=%llu content=%.*s", (unsigned long long)sz, (int)sz, content ? content : "");
    }
    git_oid_tostr(oidstr, sizeof(oidstr), &blobid);
    LOG("       blob oid -> %s", oidstr);

    /* ---- 6. treebuilder: tree with one blob ---- */
    LOG("[6] treebuilder");
    git_treebuilder *bld = NULL;
    CHECK(git_treebuilder_new(&bld, repo, NULL), "git_treebuilder_new");
    git_oid treeid;
    int havetree = 0;
    if (bld) {
        CHECK(git_treebuilder_insert(NULL, bld, "hello.txt", &blobid, GIT_FILEMODE_BLOB), "treebuilder_insert");
        CHECK(git_treebuilder_write(&treeid, bld), "treebuilder_write");
        havetree = 1;
    }

    /* ---- 7. tree lookup + iterate ---- */
    git_tree *tree = NULL;
    if (havetree) {
        LOG("[7] tree lookup/iterate");
        CHECK(git_tree_lookup(&tree, repo, &treeid), "git_tree_lookup");
        if (tree) {
            size_t n = git_tree_entrycount(tree);
            LOG("       tree has %zu entries", n);
            for (size_t i = 0; i < n; i++) {
                const git_tree_entry *te = git_tree_entry_byindex(tree, i);
                LOG("       entry[%zu] = %s", i, git_tree_entry_name(te));
            }
        }
    }

    /* ---- 8. signature + commit create ---- */
    LOG("[8] signature + commit");
    git_signature *sig = NULL;
    CHECK(git_signature_new(&sig, "Probe", "probe@example.com", 1700000000, 0), "git_signature_new");
    git_oid commitid;
    int havecommit = 0;
    if (sig && tree) {
        CHECK(git_commit_create(&commitid, repo, "HEAD", sig, sig, NULL,
                                "first commit\n", tree, 0, NULL), "git_commit_create");
        havecommit = 1;
    }

    /* ---- 9. commit lookup + read ---- */
    if (havecommit) {
        LOG("[9] commit lookup");
        git_commit *commit = NULL;
        CHECK(git_commit_lookup(&commit, repo, &commitid), "git_commit_lookup");
        if (commit) {
            LOG("       message: %s", git_commit_message(commit));
            const git_signature *a = git_commit_author(commit);
            LOG("       author: %s <%s>", a ? a->name : "?", a ? a->email : "?");
        }
        git_oid_tostr(oidstr, sizeof(oidstr), &commitid);
        LOG("       commit oid -> %s", oidstr);
        if (commit) git_commit_free(commit);
    }

    /* ---- 10. revparse HEAD ---- */
    LOG("[10] revparse HEAD");
    git_object *obj = NULL;
    CHECK(git_revparse_single(&obj, repo, "HEAD"), "git_revparse_single(HEAD)");
    if (obj) {
        git_oid_tostr(oidstr, sizeof(oidstr), git_object_id(obj));
        LOG("       HEAD -> %s", oidstr);
        git_object_free(obj);
    }

    /* ---- 11. revwalk ---- */
    LOG("[11] revwalk");
    git_revwalk *walk = NULL;
    CHECK(git_revwalk_new(&walk, repo), "git_revwalk_new");
    if (walk) {
        CHECK(git_revwalk_push_head(walk), "git_revwalk_push_head");
        git_oid wid;
        int count = 0;
        while (git_revwalk_next(&wid, walk) == 0) count++;
        LOG("       walked %d commit(s)", count);
        git_revwalk_free(walk);
    }

    /* ---- 12. status ---- */
    LOG("[12] status");
    git_status_list *status = NULL;
    CHECK(git_status_list_new(&status, repo, NULL), "git_status_list_new");
    if (status) {
        size_t n = git_status_list_entrycount(status);
        LOG("       %zu status entries", n);
        git_status_list_free(status);
    }

    LOG("== probe complete ==");
    if (sig) git_signature_free(sig);
    if (tree) git_tree_free(tree);
    if (blob) git_blob_free(blob);
    if (bld) git_treebuilder_free(bld);
    if (cfg) git_config_free(cfg);
    git_repository_free(repo);
    git_libgit2_shutdown();
    return 0;
}
