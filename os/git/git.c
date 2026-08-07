/* git — the gucOS git CLI over vendored libgit2.
 *
 *   git [-C <path>] <command> [args...]
 *
 * Read set:  log, diff, show, status, rev-list, rev-parse, cat-file, ls-tree.
 * Write set: init, add, commit, branch, checkout, config (#475 — the point
 * of this CLI: an agent inside gucOS can now RECORD work, not just read it).
 * config is here because commit is unusable without an identity and telling
 * a user to hand-edit .git/config is not an interface.
 *
 * A repo written by this CLI must be a repo REAL git accepts — `git fsck`
 * on the host is the acceptance oracle (tests/kernel/test_git_e2e.js
 * extracts a gucOS-authored repo and fscks it with host git).
 *
 * Commit identity resolves like git's: GIT_AUTHOR_NAME/EMAIL/DATE and
 * GIT_COMMITTER_* env first, then user.name/user.email from config; no
 * identity is a loud fatal naming the `git config` fix. GIT_*_DATE takes
 * the raw "[@]<unix-seconds> [+-HHMM]" form, which is what makes commits
 * reproducible in tests and scripts.
 *
 * A real git verb this build does not implement (merge, tag, reset, ...) is
 * answered by saying exactly that, and a typo is answered differently — see
 * the command dispatch at the bottom of this file. Delete a verb from that
 * list as it is implemented.
 *
 * REPO DISCOVERY (the other half of feeling like git). The repository is
 * found by walking UP from the current directory, the way real git does —
 * there is no repo-path argument. `-C <path>` chdirs first, the same
 * spelling and the same semantics as git's own `-C`, so a caller that
 * cannot chdir (a test harness, a script) still has one. Discovery is
 * deliberately GIT_REPOSITORY_OPEN_CROSS_FS: gucOS mounts the sealed /usr
 * and the writable root as separate BlockFS volumes (MountFS), so a
 * st_dev change inside gucOS is an artifact of the mount table, not a user
 * crossing a filesystem the way the upstream default assumes.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <git2.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define GUCOS_GIT_VERSION "0.2"

static char oidbuf[GIT_OID_SHA1_HEXSIZE + 1];

/* ---- helpers ---- */

/* Open the repository containing the CURRENT directory, searching upward.
   The failure message is git's, verbatim, because that string is what a
   human or an agent greps for. */
static int open_repo(git_repository **repo) {
    int r = git_repository_open_ext(repo, ".", GIT_REPOSITORY_OPEN_CROSS_FS, NULL);
    if (r < 0) {
        fprintf(stderr,
                "fatal: not a git repository (or any of the parent directories): .git\n");
    }
    return r;
}

static void usage(FILE *out) {
    fprintf(out,
        "usage: git [-C <path>] <command> [<args>]\n"
        "\n"
        "The gucOS git CLI. The repository is discovered by searching up\n"
        "from the current directory, as in git.\n"
        "\n"
        "   init [-q] [--bare] [-b <name>] [<dir>]   create a repository\n"
        "   add [-A|-u] [--] <path>...               stage changes\n"
        "   commit -m <msg> [-a] [--allow-empty]     record a commit\n"
        "   branch [<name> [<start>] | -d|-D <name>] list/create/delete branches\n"
        "   checkout <branch> | -b <name> [<start>]  switch branches\n"
        "   checkout [<rev>] -- <path>...            restore paths\n"
        "   config [--global] <key> [<value>]        get or set an option\n"
        "\n"
        "   log [-n <count>]          show commit history\n"
        "   show <rev>                show a commit, tree or blob\n"
        "   diff <from> <to>          list the files that differ\n"
        "   status                    show the working-tree state\n"
        "   rev-list [-n <n>] [<rev>] list commit ids\n"
        "   rev-parse <rev>           resolve a revision to an object id\n"
        "   cat-file -p <object>      print an object\n"
        "   ls-tree [-r] [<rev>]      list a tree\n"
        "\n"
        "   -C <path>                 run as if started in <path>\n"
        "   --version                 print the version\n"
        "   --help                    print this message\n"
        "\n"
        "merge, tag, reset and the network commands are not implemented yet.\n");
}

/* ---- log ---- */
static int cmd_log(git_repository *repo, int argc, char **argv) {
    int limit = 10;
    for (int i = 0; i < argc; i++) {
        if (!strcmp(argv[i], "-n") && i + 1 < argc) {
            limit = atoi(argv[++i]);
        }
    }
    git_revwalk *walk = NULL;
    if (git_revwalk_new(&walk, repo) < 0) return 1;
    if (git_revwalk_push_head(walk) < 0) { git_revwalk_free(walk); return 1; }
    git_revwalk_sorting(walk, GIT_SORT_TOPOLOGICAL | GIT_SORT_TIME);

    git_oid oid;
    int count = 0;
    while (count < limit && git_revwalk_next(&oid, walk) == 0) {
        count++;
        git_commit *commit = NULL;
        if (git_commit_lookup(&commit, repo, &oid) == 0) {
            git_oid_tostr(oidbuf, sizeof(oidbuf), &oid);
            printf("commit %s\n", oidbuf);

            const git_signature *a = git_commit_author(commit);
            if (a) {
                printf("Author: %s <%s>\n", a->name, a->email);
                /* git shows timestamp as seconds + timezone offset */
                printf("Date:   %lld %+05d\n",
                       (long long)a->when.time,
                       a->when.offset / 60 * 100 + (a->when.offset % 60));
            }

            /* tree */
            printf("tree %s\n", git_oid_tostr(oidbuf, sizeof(oidbuf),
                                              git_commit_tree_id(commit)));

            /* parents */
            unsigned int nparents = git_commit_parentcount(commit);
            for (unsigned int p = 0; p < nparents; p++) {
                printf("parent %s\n",
                       git_oid_tostr(oidbuf, sizeof(oidbuf),
                                     git_commit_parent_id(commit, p)));
            }

            printf("\n    %s\n\n", git_commit_message(commit));
            git_commit_free(commit);
        }
    }
    git_revwalk_free(walk);
    return 0;
}

/* ---- diff ---- */
static int cmd_diff(git_repository *repo, int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: git diff <from> <to>\n");
        return 1;
    }
    git_commit *oc = NULL, *nc = NULL;
    git_object *obj = NULL;

    if (git_revparse_single(&obj, repo, argv[0]) < 0) {
        fprintf(stderr, "git: bad revision '%s'\n", argv[0]);
        return 1;
    }
    git_oid oid_a = *git_object_id(obj);
    git_object_free(obj);

    if (git_revparse_single(&obj, repo, argv[1]) < 0) {
        fprintf(stderr, "git: bad revision '%s'\n", argv[1]);
        return 1;
    }
    git_oid oid_b = *git_object_id(obj);
    git_object_free(obj);

    if (git_commit_lookup(&oc, repo, &oid_a) < 0 ||
        git_commit_lookup(&nc, repo, &oid_b) < 0) {
        if (oc) git_commit_free(oc);
        if (nc) git_commit_free(nc);
        return 1;
    }

    git_tree *ot = NULL, *nt = NULL;
    if (git_commit_tree(&ot, oc) < 0 || git_commit_tree(&nt, nc) < 0) {
        if (ot) git_tree_free(ot);
        if (nt) git_tree_free(nt);
        git_commit_free(oc); git_commit_free(nc);
        return 1;
    }

    git_diff *diff = NULL;
    git_diff_options opts = GIT_DIFF_OPTIONS_INIT;
    if (git_diff_tree_to_tree(&diff, repo, ot, nt, &opts) < 0) {
        git_tree_free(ot); git_tree_free(nt);
        git_commit_free(oc); git_commit_free(nc);
        return 1;
    }

    /* Print file change list instead of full patches (patch generation
       overflows WASM memory on large files like compiler.js) */
    size_t nd = git_diff_num_deltas(diff);
    for (size_t i = 0; i < nd; i++) {
        const git_diff_delta *delta = git_diff_get_delta(diff, i);
        const char *status_str =
            delta->status == GIT_DELTA_ADDED ? "A" :
            delta->status == GIT_DELTA_DELETED ? "D" :
            delta->status == GIT_DELTA_MODIFIED ? "M" :
            delta->status == GIT_DELTA_RENAMED ? "R" :
            delta->status == GIT_DELTA_COPIED ? "C" : "?";
        const char *oldf = delta->old_file.path;
        const char *newf = delta->new_file.path;
        printf("%s\t%s", status_str, oldf ? oldf : "/dev/null");
        if (newf && oldf && strcmp(newf, oldf))
            printf(" -> %s", newf);
        printf("\n");
    }

    git_diff_free(diff);
    git_tree_free(ot); git_tree_free(nt);
    git_commit_free(oc); git_commit_free(nc);
    return 0;
}

/* ---- show ---- */
static int cmd_show(git_repository *repo, int argc, char **argv) {
    if (argc < 1) {
        fprintf(stderr, "Usage: git show <rev>\n");
        return 1;
    }
    git_object *obj = NULL;
    if (git_revparse_single(&obj, repo, argv[0]) < 0) {
        fprintf(stderr, "git: bad revision '%s'\n", argv[0]);
        return 1;
    }

    if (git_object_type(obj) == GIT_OBJECT_COMMIT) {
        git_commit *commit = (git_commit *)obj;
        git_oid_tostr(oidbuf, sizeof(oidbuf), git_commit_id(commit));
        printf("commit %s\n", oidbuf);

        const git_signature *a = git_commit_author(commit);
        if (a) printf("Author: %s <%s>\n", a->name, a->email);
        const git_signature *c = git_commit_committer(commit);
        if (c) printf("Date:   %lld %+05d\n", (long long)c->when.time,
                      c->when.offset / 60 * 100 + (c->when.offset % 60));

        printf("\n    %s\n", git_commit_message(commit));

        /* Diff against parent(s) */
        unsigned int np = git_commit_parentcount(commit);
        if (np > 0) {
            git_commit *parent = NULL;
            git_commit_parent(&parent, commit, 0);
            if (parent) {
                git_tree *ot = NULL, *nt = NULL;
                if (git_commit_tree(&ot, parent) == 0 &&
                    git_commit_tree(&nt, commit) == 0) {
                    git_diff *diff = NULL;
                    git_diff_options opts = GIT_DIFF_OPTIONS_INIT;
                    if (git_diff_tree_to_tree(&diff, repo, ot, nt, &opts) == 0) {
                        size_t nd = git_diff_num_deltas(diff);
                        printf("\n%zu file(s) changed:\n", nd);
                        for (size_t i = 0; i < nd; i++) {
                            const git_diff_delta *delta = git_diff_get_delta(diff, i);
                            const char *status_str =
                                delta->status == GIT_DELTA_ADDED ? "A" :
                                delta->status == GIT_DELTA_DELETED ? "D" :
                                delta->status == GIT_DELTA_MODIFIED ? "M" :
                                delta->status == GIT_DELTA_RENAMED ? "R" :
                                delta->status == GIT_DELTA_COPIED ? "C" : "?";
                            const char *f = delta->new_file.path;
                            if (!f) f = delta->old_file.path;
                            printf("  %s\t%s\n", status_str, f ? f : "?");
                        }
                        git_diff_free(diff);
                    }
                }
                if (ot) git_tree_free(ot);
                if (nt) git_tree_free(nt);
                git_commit_free(parent);
            }
        }
    } else if (git_object_type(obj) == GIT_OBJECT_TREE) {
        git_tree *tree = (git_tree *)obj;
        size_t n = git_tree_entrycount(tree);
        for (size_t i = 0; i < n; i++) {
            const git_tree_entry *te = git_tree_entry_byindex(tree, i);
            int mode = git_tree_entry_filemode(te);
            git_oid_tostr(oidbuf, sizeof(oidbuf), git_tree_entry_id(te));
            printf("%06o %s %s\t%s\n", mode,
                   mode == GIT_FILEMODE_TREE ? "tree" :
                   mode == GIT_FILEMODE_BLOB ? "blob" :
                   mode == GIT_FILEMODE_BLOB_EXECUTABLE ? "blob" :
                   mode == GIT_FILEMODE_LINK ? "commit" : "?",
                   oidbuf,
                   git_tree_entry_name(te));
        }
    } else if (git_object_type(obj) == GIT_OBJECT_BLOB) {
        git_blob *blob = (git_blob *)obj;
        fwrite(git_blob_rawcontent(blob), 1, git_blob_rawsize(blob), stdout);
    }

    git_object_free(obj);
    return 0;
}

/* ---- status ---- */
static int cmd_status(git_repository *repo) {
    git_status_list *status = NULL;
    git_status_options opts = GIT_STATUS_OPTIONS_INIT;
    opts.flags = GIT_STATUS_OPT_INCLUDE_UNTRACKED |
                 GIT_STATUS_OPT_RENAMES_HEAD_TO_INDEX;
    if (git_status_list_new(&status, repo, &opts) < 0) return 1;

    size_t n = git_status_list_entrycount(status);
    for (size_t i = 0; i < n; i++) {
        const git_status_entry *e = git_status_byindex(status, i);
        /* Map status to git-style status codes */
        const char *istr = " ", *wstr = " ";
        if (e->status & GIT_STATUS_INDEX_NEW) istr = "A";
        else if (e->status & GIT_STATUS_INDEX_MODIFIED) istr = "M";
        else if (e->status & GIT_STATUS_INDEX_DELETED) istr = "D";
        else if (e->status & GIT_STATUS_INDEX_RENAMED) istr = "R";
        else if (e->status & GIT_STATUS_INDEX_TYPECHANGE) istr = "T";

        if (e->status & GIT_STATUS_WT_NEW) { istr = "?"; wstr = "?"; }
        else if (e->status & GIT_STATUS_WT_MODIFIED) wstr = "M";
        else if (e->status & GIT_STATUS_WT_DELETED) wstr = "D";
        else if (e->status & GIT_STATUS_WT_RENAMED) wstr = "R";
        else if (e->status & GIT_STATUS_WT_TYPECHANGE) wstr = "T";

        const char *path = e->index_to_workdir ?
            e->index_to_workdir->new_file.path :
            e->head_to_index ?
            e->head_to_index->new_file.path : "?";

        printf(" %c%c %s\n", istr[0], wstr[0], path);
    }
    git_status_list_free(status);
    return 0;
}

/* ---- rev-list ---- */
static int cmd_rev_list(git_repository *repo, int argc, char **argv) {
    int limit = -1;
    const char *ref = "HEAD";
    for (int i = 0; i < argc; i++) {
        if (!strcmp(argv[i], "-n") && i + 1 < argc) {
            limit = atoi(argv[++i]);
        } else {
            ref = argv[i];
        }
    }

    git_revwalk *walk = NULL;
    if (git_revwalk_new(&walk, repo) < 0) return 1;
    git_object *obj = NULL;
    if (git_revparse_single(&obj, repo, ref) >= 0) {
        git_revwalk_push(walk, git_object_id(obj));
        git_object_free(obj);
    } else {
        git_revwalk_free(walk);
        return 1;
    }
    git_revwalk_sorting(walk, GIT_SORT_TOPOLOGICAL | GIT_SORT_TIME);

    git_oid oid;
    int count = 0;
    while ((limit < 0 || count < limit) && git_revwalk_next(&oid, walk) == 0) {
        count++;
        printf("%s\n", git_oid_tostr(oidbuf, sizeof(oidbuf), &oid));
    }
    git_revwalk_free(walk);
    return 0;
}

/* ---- rev-parse ---- */
static int cmd_rev_parse(git_repository *repo, int argc, char **argv) {
    if (argc < 1) {
        fprintf(stderr, "Usage: git rev-parse <rev>\n");
        return 1;
    }
    git_object *obj = NULL;
    if (git_revparse_single(&obj, repo, argv[0]) < 0) {
        fprintf(stderr, "%s\n", argv[0]);
        fprintf(stderr, "fatal: ambiguous argument '%s': unknown revision\n", argv[0]);
        return 1;
    }
    printf("%s\n", git_oid_tostr(oidbuf, sizeof(oidbuf), git_object_id(obj)));
    git_object_free(obj);
    return 0;
}

/* ---- cat-file ---- */
static int cmd_cat_file(git_repository *repo, int argc, char **argv) {
    if (argc < 2 || strcmp(argv[0], "-p")) {
        fprintf(stderr, "Usage: git cat-file -p <object>\n");
        return 1;
    }
    git_object *obj = NULL;
    if (git_revparse_single(&obj, repo, argv[1]) < 0) {
        fprintf(stderr, "fatal: not a valid object name %s\n", argv[1]);
        return 1;
    }

    if (git_object_type(obj) == GIT_OBJECT_BLOB) {
        git_blob *blob = (git_blob *)obj;
        fwrite(git_blob_rawcontent(blob), 1, git_blob_rawsize(blob), stdout);
    } else if (git_object_type(obj) == GIT_OBJECT_COMMIT) {
        git_commit *commit = (git_commit *)obj;
        printf("tree %s\n", git_oid_tostr(oidbuf, sizeof(oidbuf),
                                          git_commit_tree_id(commit)));
        unsigned int np = git_commit_parentcount(commit);
        for (unsigned int p = 0; p < np; p++) {
            printf("parent %s\n",
                   git_oid_tostr(oidbuf, sizeof(oidbuf),
                                 git_commit_parent_id(commit, p)));
        }
        const git_signature *a = git_commit_author(commit);
        printf("author %s <%s> %lld %+05d\n",
               a->name, a->email, (long long)a->when.time,
               a->when.offset / 60 * 100 + (a->when.offset % 60));
        const git_signature *c = git_commit_committer(commit);
        printf("committer %s <%s> %lld %+05d\n",
               c->name, c->email, (long long)c->when.time,
               c->when.offset / 60 * 100 + (c->when.offset % 60));
        printf("\n%s\n", git_commit_message(commit));
    } else if (git_object_type(obj) == GIT_OBJECT_TREE) {
        git_tree *tree = (git_tree *)obj;
        size_t n = git_tree_entrycount(tree);
        for (size_t i = 0; i < n; i++) {
            const git_tree_entry *te = git_tree_entry_byindex(tree, i);
            int mode = git_tree_entry_filemode(te);
            git_oid_tostr(oidbuf, sizeof(oidbuf), git_tree_entry_id(te));
            printf("%06o %s %s\t%s\n", mode,
                   mode == GIT_FILEMODE_TREE ? "tree" : "blob",
                   oidbuf, git_tree_entry_name(te));
        }
    }

    git_object_free(obj);
    return 0;
}

/* ---- ls-tree ---- */
static int cmd_ls_tree(git_repository *repo, int argc, char **argv) {
    /* Flags first, positionals second — real git accepts `ls-tree -r HEAD`
       and `ls-tree HEAD -r` alike, so the flag scan must run BEFORE the rev
       is picked, never after it (#571: revparsing argv[0] blindly rejected
       `-r HEAD` with "bad revision '-r'"). A handler that takes flags AND a
       rev must use this shape — split argv in one pass, then revparse; see
       cmd_rev_list, which interleaves the same split with its `-n <count>`
       value flag. An unrecognized option is a loud usage error, never a
       revision candidate and never silently ignored. */
    int recursive = 0;
    const char *ref = NULL;
    for (int i = 0; i < argc; i++) {
        if (!strcmp(argv[i], "-r")) {
            recursive = 1;
        } else if (argv[i][0] == '-' && argv[i][1] != '\0') {
            fprintf(stderr, "git: unknown option '%s'\n", argv[i]);
            fprintf(stderr, "usage: git ls-tree [-r] [<rev>]\n");
            return 1;
        } else if (!ref) {
            ref = argv[i];
        }
        /* Further positionals would be pathspecs; not implemented (#474
           scope) — the first positional is the rev, as before. */
    }
    if (!ref) ref = "HEAD";
    git_object *obj = NULL;
    if (git_revparse_single(&obj, repo, ref) < 0) {
        fprintf(stderr, "git: bad revision '%s'\n", ref);
        return 1;
    }
    if (git_object_type(obj) != GIT_OBJECT_COMMIT &&
        git_object_type(obj) != GIT_OBJECT_TREE) {
        fprintf(stderr, "git: '%s' is not a tree-ish\n", ref);
        git_object_free(obj);
        return 1;
    }
    git_tree *tree = NULL;
    if (git_object_type(obj) == GIT_OBJECT_COMMIT) {
        git_commit_tree(&tree, (git_commit *)obj);
    } else {
        tree = (git_tree *)obj;
        obj = NULL;
    }

    if (tree) {
        size_t n = git_tree_entrycount(tree);
        for (size_t i = 0; i < n; i++) {
            const git_tree_entry *te = git_tree_entry_byindex(tree, i);
            int mode = git_tree_entry_filemode(te);
            git_oid_tostr(oidbuf, sizeof(oidbuf), git_tree_entry_id(te));
            printf("%06o %s %s\t%s\n", mode,
                   mode == GIT_FILEMODE_TREE ? "tree" : "blob",
                   oidbuf, git_tree_entry_name(te));

            if (recursive && mode == GIT_FILEMODE_TREE) {
                /* recurse into subtree */
                git_object *sub = NULL;
                if (git_tree_entry_to_object(&sub, repo, te) == 0) {
                    /* print subtree entries prefixed with dir/ */
                    const char *prefix = git_tree_entry_name(te);
                    size_t plen = strlen(prefix);
                    git_tree *st = (git_tree *)sub;
                    size_t sn = git_tree_entrycount(st);
                    for (size_t j = 0; j < sn; j++) {
                        const git_tree_entry *st2 = git_tree_entry_byindex(st, j);
                        int m2 = git_tree_entry_filemode(st2);
                        git_oid_tostr(oidbuf, sizeof(oidbuf), git_tree_entry_id(st2));
                        printf("%06o %s %s\t%s/%s\n", m2,
                               m2 == GIT_FILEMODE_TREE ? "tree" : "blob",
                               oidbuf, prefix, git_tree_entry_name(st2));
                    }
                    git_object_free(sub);
                }
            }
        }
        git_tree_free(tree);
    }
    if (obj) git_object_free(obj);
    return 0;
}

/* ================= the write set (#475) =================
 *
 * Every handler here parses argv the cmd_ls_tree way: ONE pass that splits
 * flags from positionals BEFORE anything is revparsed, and an unrecognized
 * option is a LOUD usage error — never a revision candidate, never silently
 * ignored (the cmd_rev_list shape, where `rev-list -r HEAD` silently
 * ignores -r and `rev-list HEAD -r` fails without a message, is the defect
 * this discipline exists to keep out — #574). */

/* Print libgit2's own last-error message, prefixed the way git prefixes
   its errors, so a failure names its cause instead of just a verb. */
static void print_giterr(const char *what) {
    const git_error *e = git_error_last();
    fprintf(stderr, "error: %s: %s\n", what,
            (e && e->message) ? e->message : "(no message)");
}

/* Parse the raw git date form "[@]<unix-seconds> [+-HHMM]" (what
   GIT_AUTHOR_DATE/GIT_COMMITTER_DATE carry in scripts). Returns 0 on
   success. Anything unparseable is refused loudly by the caller rather
   than silently becoming "now". */
static int parse_git_date(const char *s, git_time_t *time_out, int *offset_out) {
    if (!s || !*s) return -1;
    if (*s == '@') s++;
    char *end = NULL;
    long long secs = strtoll(s, &end, 10);
    if (end == s) return -1;
    int offset = 0;
    while (*end == ' ') end++;
    if (*end == '+' || *end == '-') {
        int sign = (*end == '-') ? -1 : 1;
        end++;
        if (strlen(end) < 4) return -1;
        char hh[3] = { end[0], end[1], 0 };
        char mm[3] = { end[2], end[3], 0 };
        offset = sign * (atoi(hh) * 60 + atoi(mm));
        end += 4;
    }
    if (*end != '\0') return -1;
    *time_out = (git_time_t)secs;
    *offset_out = offset;
    return 0;
}

/* Build a signature the way git does: GIT_*_NAME/EMAIL/DATE env first,
   then user.name/user.email from the repo's config chain. Missing identity
   is a fatal that names the fix. */
static int make_signature(git_signature **out, git_repository *repo,
                          const char *name_env, const char *email_env,
                          const char *date_env) {
    const char *name = getenv(name_env);
    const char *email = getenv(email_env);
    git_config *cfg = NULL;
    git_buf nbuf = {0}, ebuf = {0};
    int rc = -1;

    if ((!name || !email) && git_repository_config_snapshot(&cfg, repo) == 0) {
        if (!name && git_config_get_string_buf(&nbuf, cfg, "user.name") == 0)
            name = nbuf.ptr;
        if (!email && git_config_get_string_buf(&ebuf, cfg, "user.email") == 0)
            email = ebuf.ptr;
    }
    if (!name || !*name || !email || !*email) {
        fprintf(stderr,
            "fatal: unable to auto-detect committer identity\n"
            "hint: set it once with\n"
            "hint:   git config user.email \"you@example.com\"\n"
            "hint:   git config user.name \"Your Name\"\n"
            "hint: (or export GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL)\n");
        goto done;
    }

    const char *date = getenv(date_env);
    if (date && *date) {
        git_time_t t; int off;
        if (parse_git_date(date, &t, &off) != 0) {
            fprintf(stderr, "fatal: bad %s: '%s' "
                    "(expected \"[@]<unix-seconds> [+-HHMM]\")\n", date_env, date);
            goto done;
        }
        rc = git_signature_new(out, name, email, t, off);
    } else {
        rc = git_signature_now(out, name, email);
    }
    if (rc < 0) print_giterr("signature");

done:
    git_buf_dispose(&nbuf);
    git_buf_dispose(&ebuf);
    if (cfg) git_config_free(cfg);
    return rc;
}

/* Translate a command-line path (relative to the CWD, git's contract) into
   a WORKDIR-relative pathspec (libgit2's contract). Lexical: joins the cwd,
   collapses "." and "..", requires the result to stay inside the work tree.
   An empty result ("git add ." at the root) means "everything". */
static int workdir_rel(git_repository *repo, const char *arg,
                       char *out, size_t outsz) {
    const char *wd = git_repository_workdir(repo);
    if (!wd) {
        fprintf(stderr, "fatal: this operation must be run in a work tree\n");
        return -1;
    }
    char abs[PATH_MAX];
    if (arg[0] == '/') {
        snprintf(abs, sizeof(abs), "%s", arg);
    } else {
        char cwd[PATH_MAX];
        if (!getcwd(cwd, sizeof(cwd))) return -1;
        snprintf(abs, sizeof(abs), "%s/%s", cwd, arg);
    }
    /* Lexical normalize into components. */
    char norm[PATH_MAX];
    size_t nlen = 0;
    const char *p = abs;
    while (*p) {
        while (*p == '/') p++;
        if (!*p) break;
        const char *seg = p;
        while (*p && *p != '/') p++;
        size_t slen = (size_t)(p - seg);
        if (slen == 1 && seg[0] == '.') continue;
        if (slen == 2 && seg[0] == '.' && seg[1] == '.') {
            while (nlen > 0 && norm[nlen - 1] != '/') nlen--;
            if (nlen > 0) nlen--;              /* drop the slash too */
            continue;
        }
        if (nlen + 1 + slen + 1 >= sizeof(norm)) return -1;
        norm[nlen++] = '/';
        memcpy(norm + nlen, seg, slen);
        nlen += slen;
    }
    norm[nlen] = '\0';

    size_t wlen = strlen(wd);               /* wd has a trailing '/' */
    while (wlen > 1 && wd[wlen - 1] == '/') wlen--;
    if (strncmp(norm, wd, wlen) != 0 ||
        (norm[wlen] != '\0' && norm[wlen] != '/')) {
        fprintf(stderr, "fatal: '%s' is outside repository\n", arg);
        return -1;
    }
    const char *rel = norm + wlen;
    while (*rel == '/') rel++;
    snprintf(out, outsz, "%s", rel);
    return 0;
}

/* ---- init ---- */
static int cmd_init(int argc, char **argv) {
    int quiet = 0, bare = 0;
    const char *branch = NULL;
    const char *dir = NULL;
    for (int i = 0; i < argc; i++) {
        if (!strcmp(argv[i], "-q") || !strcmp(argv[i], "--quiet")) {
            quiet = 1;
        } else if (!strcmp(argv[i], "--bare")) {
            bare = 1;
        } else if (!strcmp(argv[i], "-b") || !strcmp(argv[i], "--initial-branch")) {
            if (i + 1 >= argc) {
                fprintf(stderr, "git: %s needs a branch name\n", argv[i]);
                return 1;
            }
            branch = argv[++i];
        } else if (!strncmp(argv[i], "--initial-branch=", 17)) {
            branch = argv[i] + 17;
        } else if (argv[i][0] == '-' && argv[i][1] != '\0') {
            fprintf(stderr, "git: unknown option '%s'\n", argv[i]);
            fprintf(stderr, "usage: git init [-q] [--bare] [-b <name>] [<directory>]\n");
            return 1;
        } else if (!dir) {
            dir = argv[i];
        } else {
            fprintf(stderr, "usage: git init [-q] [--bare] [-b <name>] [<directory>]\n");
            return 1;
        }
    }
    if (!dir) dir = ".";

    /* Reinit detection, git's own wording: an existing repo at the target
       is re-opened, never clobbered. */
    git_repository *pre = NULL;
    int existed = (git_repository_open_ext(&pre, dir,
                       GIT_REPOSITORY_OPEN_NO_SEARCH | GIT_REPOSITORY_OPEN_CROSS_FS,
                       NULL) == 0);
    if (pre) git_repository_free(pre);

    git_repository_init_options opts = GIT_REPOSITORY_INIT_OPTIONS_INIT;
    opts.flags = GIT_REPOSITORY_INIT_MKPATH;
    if (bare) opts.flags |= GIT_REPOSITORY_INIT_BARE;
    opts.initial_head = branch;             /* NULL -> libgit2's default */

    git_repository *repo = NULL;
    if (git_repository_init_ext(&repo, dir, &opts) < 0) {
        print_giterr("init");
        return 1;
    }
    if (!quiet)
        printf("%s Git repository in %s\n",
               existed ? "Reinitialized existing" : "Initialized empty",
               git_repository_path(repo));
    git_repository_free(repo);
    return 0;
}

/* ---- add ---- */
struct add_count { int n; };
static int add_count_cb(const char *path, const char *spec, void *payload) {
    (void)path; (void)spec;
    ((struct add_count *)payload)->n++;
    return 0;
}

static int cmd_add(git_repository *repo, int argc, char **argv) {
    int all = 0, update = 0, npaths = 0;
    const char **paths = calloc(argc ? (size_t)argc : 1, sizeof(char *));
    int dashdash = 0;
    for (int i = 0; i < argc; i++) {
        if (!dashdash && !strcmp(argv[i], "--")) {
            dashdash = 1;
        } else if (!dashdash && (!strcmp(argv[i], "-A") || !strcmp(argv[i], "--all"))) {
            all = 1;
        } else if (!dashdash && (!strcmp(argv[i], "-u") || !strcmp(argv[i], "--update"))) {
            update = 1;
        } else if (!dashdash && argv[i][0] == '-' && argv[i][1] != '\0') {
            fprintf(stderr, "git: unknown option '%s'\n", argv[i]);
            fprintf(stderr, "usage: git add [-A|-u] [--] <pathspec>...\n");
            free(paths);
            return 1;
        } else {
            paths[npaths++] = argv[i];
        }
    }
    if (!all && !update && npaths == 0) {
        fprintf(stderr, "Nothing specified, nothing added.\n"
                        "hint: Maybe you wanted to say 'git add .'?\n");
        free(paths);
        return 0;
    }

    git_index *idx = NULL;
    if (git_repository_index(&idx, repo) < 0) {
        print_giterr("add");
        free(paths);
        return 1;
    }

    int rc = 0;
    if (all || (update && npaths == 0)) {
        /* git_index_add_all IS `git add -A`: its index-to-workdir diff walk
           adds untracked, updates modified AND removes deleted entries
           (apply_each_file removes the entry when the workdir side has no
           GIT_DIFF_FLAG_EXISTS) — no separate update_all pass is needed.
           `-u` alone maps to update_all, which skips untracked files. */
        struct add_count c = {0};
        int r = all ? git_index_add_all(idx, NULL, GIT_INDEX_ADD_DEFAULT,
                                        add_count_cb, &c)
                    : git_index_update_all(idx, NULL, add_count_cb, &c);
        if (r < 0) { print_giterr("add"); rc = 1; }
    } else {
        /* git >= 2.0 semantics: `git add <pathspec>` stages creations,
           modifications AND deletions under the spec (add_all covers all
           three, see above). Per-spec so a spec that matches NOTHING is
           git's fatal, not a silent no-op. */
        for (int i = 0; i < npaths && rc == 0; i++) {
            char rel[PATH_MAX];
            if (workdir_rel(repo, paths[i], rel, sizeof(rel)) != 0) { rc = 1; break; }
            struct add_count c = {0};
            if (rel[0] == '\0') {
                int r = update ? git_index_update_all(idx, NULL, add_count_cb, &c)
                               : git_index_add_all(idx, NULL, GIT_INDEX_ADD_DEFAULT,
                                                   add_count_cb, &c);
                if (r < 0) { print_giterr("add"); rc = 1; break; }
            } else {
                char *specv[1] = { rel };
                git_strarray specs = { specv, 1 };
                int r = update ? git_index_update_all(idx, &specs, add_count_cb, &c)
                               : git_index_add_all(idx, &specs, GIT_INDEX_ADD_DEFAULT,
                                                   add_count_cb, &c);
                if (r < 0) { print_giterr("add"); rc = 1; break; }
                if (c.n == 0 && !git_index_get_bypath(idx, rel, 0)) {
                    int ignored = 0;
                    if (git_ignore_path_is_ignored(&ignored, repo, rel) == 0 && ignored) {
                        fprintf(stderr,
                            "The following paths are ignored by one of your .gitignore files:\n"
                            "%s\nhint: Use -f if you really want to add them.\n"
                            "hint: (-f is not implemented in this git)\n", paths[i]);
                    } else {
                        fprintf(stderr,
                            "fatal: pathspec '%s' did not match any files\n", paths[i]);
                    }
                    rc = 1;
                }
            }
        }
    }
    if (rc == 0 && git_index_write(idx) < 0) {
        print_giterr("add: index write");
        rc = 1;
    }
    git_index_free(idx);
    free(paths);
    return rc;
}

/* ---- commit ---- */
static int cmd_commit(git_repository *repo, int argc, char **argv) {
    int stage_all = 0, allow_empty = 0, quiet = 0;
    char msg[8192];
    size_t msglen = 0;
    int have_msg = 0;
    for (int i = 0; i < argc; i++) {
        if (!strcmp(argv[i], "-m") || !strcmp(argv[i], "--message")) {
            if (i + 1 >= argc) {
                fprintf(stderr, "git: -m needs a message\n");
                return 1;
            }
            const char *m = argv[++i];
            int n = snprintf(msg + msglen, sizeof(msg) - msglen,
                             "%s%s", have_msg ? "\n\n" : "", m);
            if (n < 0 || (size_t)n >= sizeof(msg) - msglen) {
                fprintf(stderr, "git: commit message too long\n");
                return 1;
            }
            msglen += (size_t)n;
            have_msg = 1;
        } else if (!strcmp(argv[i], "-a") || !strcmp(argv[i], "--all")) {
            stage_all = 1;
        } else if (!strcmp(argv[i], "--allow-empty")) {
            allow_empty = 1;
        } else if (!strcmp(argv[i], "-q") || !strcmp(argv[i], "--quiet")) {
            quiet = 1;
        } else if (!strcmp(argv[i], "-am") || !strcmp(argv[i], "-ma")) {
            /* the one bundled spelling everyone types */
            if (i + 1 >= argc) {
                fprintf(stderr, "git: -m needs a message\n");
                return 1;
            }
            stage_all = 1;
            const char *m = argv[++i];
            int n = snprintf(msg + msglen, sizeof(msg) - msglen,
                             "%s%s", have_msg ? "\n\n" : "", m);
            if (n < 0 || (size_t)n >= sizeof(msg) - msglen) {
                fprintf(stderr, "git: commit message too long\n");
                return 1;
            }
            msglen += (size_t)n;
            have_msg = 1;
        } else if (argv[i][0] == '-' && argv[i][1] != '\0') {
            fprintf(stderr, "git: unknown option '%s'\n", argv[i]);
            fprintf(stderr, "usage: git commit -m <msg> [-a] [-q] [--allow-empty]\n");
            return 1;
        } else {
            fprintf(stderr, "git: commit with paths is not supported by this git; "
                            "stage with 'git add' first\n");
            return 1;
        }
    }
    if (!have_msg) {
        fprintf(stderr, "fatal: no commit message given\n"
                        "hint: this git launches no editor; use git commit -m <msg>\n");
        return 1;
    }

    /* Identity first, so a missing user.email refuses BEFORE -a mutates the
       index. */
    git_signature *author = NULL, *committer = NULL;
    if (make_signature(&author, repo, "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
                       "GIT_AUTHOR_DATE") < 0)
        return 1;
    if (make_signature(&committer, repo, "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
                       "GIT_COMMITTER_DATE") < 0) {
        git_signature_free(author);
        return 1;
    }

    int rc = 1;
    git_index *idx = NULL;
    git_tree *tree = NULL;
    git_commit *parent = NULL;
    git_buf pretty = {0};

    if (git_repository_index(&idx, repo) < 0) { print_giterr("commit"); goto done; }
    if (stage_all && git_index_update_all(idx, NULL, NULL, NULL) < 0) {
        print_giterr("commit -a"); goto done;
    }

    git_oid tree_id;
    if (git_index_write_tree(&tree_id, idx) < 0) {
        print_giterr("commit: write-tree"); goto done;
    }
    if (stage_all && git_index_write(idx) < 0) {
        print_giterr("commit: index write"); goto done;
    }

    /* Parent = HEAD's commit; an unborn HEAD means a root commit. */
    {
        git_object *head = NULL;
        int hr = git_revparse_single(&head, repo, "HEAD");
        if (hr == 0) {
            if (git_object_peel((git_object **)&parent, head, GIT_OBJECT_COMMIT) < 0) {
                git_object_free(head);
                print_giterr("commit: HEAD"); goto done;
            }
            git_object_free(head);
        }
    }

    if (!allow_empty) {
        int empty;
        if (parent)
            empty = git_oid_equal(&tree_id, git_commit_tree_id(parent));
        else
            empty = (git_index_entrycount(idx) == 0);
        if (empty) {
            fprintf(stderr, "nothing to commit (use \"git add\" to stage changes, "
                            "or --allow-empty)\n");
            goto done;
        }
    }

    if (git_tree_lookup(&tree, repo, &tree_id) < 0) {
        print_giterr("commit: tree lookup"); goto done;
    }
    if (git_message_prettify(&pretty, msg, 0, '#') < 0) {
        print_giterr("commit: message"); goto done;
    }

    git_oid commit_id;
    const git_commit *parents[1] = { parent };
    if (git_commit_create(&commit_id, repo, "HEAD", author, committer, NULL,
                          pretty.ptr, tree, parent ? 1 : 0,
                          parent ? parents : NULL) < 0) {
        print_giterr("commit"); goto done;
    }
    rc = 0;

    if (!quiet) {
        /* "[<branch>[ (root-commit)] <short>] <subject>", git's summary. */
        const char *branch = "detached HEAD";
        git_reference *headref = NULL;
        if (!git_repository_head_detached(repo) &&
            git_repository_head(&headref, repo) == 0)
            branch = git_reference_shorthand(headref);

        git_object *cobj = NULL;
        git_buf shortid = {0};
        if (git_object_lookup(&cobj, repo, &commit_id, GIT_OBJECT_COMMIT) == 0)
            git_object_short_id(&shortid, cobj);

        char subject[256];
        size_t sl = 0;
        for (const char *pm = pretty.ptr; *pm && *pm != '\n' && sl + 1 < sizeof(subject); pm++)
            subject[sl++] = *pm;
        subject[sl] = '\0';

        printf("[%s%s %s] %s\n", branch, parent ? "" : " (root-commit)",
               shortid.ptr ? shortid.ptr : "???????", subject);

        git_buf_dispose(&shortid);
        if (cobj) git_object_free(cobj);
        if (headref) git_reference_free(headref);
    }

done:
    git_buf_dispose(&pretty);
    if (tree) git_tree_free(tree);
    if (parent) git_commit_free(parent);
    if (idx) git_index_free(idx);
    git_signature_free(author);
    git_signature_free(committer);
    return rc;
}

/* ---- branch ---- */
static int branch_name_cmp(const void *a, const void *b) {
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}

static int cmd_branch(git_repository *repo, int argc, char **argv) {
    int del = 0, force_del = 0;
    const char *name = NULL, *start = NULL;
    for (int i = 0; i < argc; i++) {
        if (!strcmp(argv[i], "-d") || !strcmp(argv[i], "--delete")) {
            del = 1;
        } else if (!strcmp(argv[i], "-D")) {
            del = 1; force_del = 1;
        } else if (argv[i][0] == '-' && argv[i][1] != '\0') {
            fprintf(stderr, "git: unknown option '%s'\n", argv[i]);
            fprintf(stderr, "usage: git branch [<name> [<start>] | -d|-D <name>]\n");
            return 1;
        } else if (!name) {
            name = argv[i];
        } else if (!start) {
            start = argv[i];
        } else {
            fprintf(stderr, "usage: git branch [<name> [<start>] | -d|-D <name>]\n");
            return 1;
        }
    }

    if (del) {
        if (!name || start) {
            fprintf(stderr, "usage: git branch -d|-D <name>\n");
            return 1;
        }
        git_reference *ref = NULL;
        if (git_branch_lookup(&ref, repo, name, GIT_BRANCH_LOCAL) < 0) {
            fprintf(stderr, "error: branch '%s' not found\n", name);
            return 1;
        }
        if (git_branch_is_head(ref) == 1) {
            fprintf(stderr, "error: cannot delete branch '%s' — it is the current "
                            "branch\n", name);
            git_reference_free(ref);
            return 1;
        }
        const git_oid *tip = git_reference_target(ref);
        if (!force_del) {
            /* -d refuses an unmerged branch: merged means the tip is HEAD
               itself or an ancestor of HEAD. */
            git_object *head = NULL;
            int merged = 0;
            if (git_revparse_single(&head, repo, "HEAD") == 0) {
                const git_oid *head_id = git_object_id(head);
                merged = git_oid_equal(tip, head_id) ||
                         git_graph_descendant_of(repo, head_id, tip) == 1;
                git_object_free(head);
            }
            if (!merged) {
                fprintf(stderr, "error: the branch '%s' is not fully merged\n"
                                "hint: use 'git branch -D %s' to delete it anyway\n",
                        name, name);
                git_reference_free(ref);
                return 1;
            }
        }
        char shortid[8] = "???????";
        if (tip) {
            char full[GIT_OID_SHA1_HEXSIZE + 1];
            git_oid_tostr(full, sizeof(full), tip);
            memcpy(shortid, full, 7);
            shortid[7] = '\0';
        }
        if (git_branch_delete(ref) < 0) {
            print_giterr("branch -d");
            git_reference_free(ref);
            return 1;
        }
        git_reference_free(ref);
        printf("Deleted branch %s (was %s).\n", name, shortid);
        return 0;
    }

    if (name) {
        /* create */
        git_object *target = NULL;
        if (git_revparse_single(&target, repo, start ? start : "HEAD") < 0) {
            fprintf(stderr, "fatal: not a valid object name: '%s'\n",
                    start ? start : "HEAD");
            return 1;
        }
        git_commit *commit = NULL;
        if (git_object_peel((git_object **)&commit, target, GIT_OBJECT_COMMIT) < 0) {
            fprintf(stderr, "fatal: '%s' is not a commit\n", start ? start : "HEAD");
            git_object_free(target);
            return 1;
        }
        git_object_free(target);
        git_reference *out = NULL;
        int cr = git_branch_create(&out, repo, name, commit, 0);
        git_commit_free(commit);
        if (cr < 0) {
            if (cr == GIT_EEXISTS)
                fprintf(stderr, "fatal: a branch named '%s' already exists\n", name);
            else
                print_giterr("branch");
            return 1;
        }
        git_reference_free(out);
        return 0;
    }

    /* list — collected and sorted so the output is deterministic (the refdb
       iteration order is directory order, which is not a contract). */
    {
        char *names[256];
        int n = 0, curhead = -1;
        if (git_repository_head_detached(repo) == 1) {
            git_object *head = NULL;
            char full[GIT_OID_SHA1_HEXSIZE + 1] = "???????";
            if (git_revparse_single(&head, repo, "HEAD") == 0) {
                git_oid_tostr(full, sizeof(full), git_object_id(head));
                git_object_free(head);
            }
            full[7] = '\0';
            printf("* (HEAD detached at %s)\n", full);
        }
        git_branch_iterator *it = NULL;
        if (git_branch_iterator_new(&it, repo, GIT_BRANCH_LOCAL) < 0) {
            print_giterr("branch");
            return 1;
        }
        git_reference *ref = NULL;
        git_branch_t type;
        while (n < 256 && git_branch_next(&ref, &type, it) == 0) {
            const char *bn = NULL;
            if (git_branch_name(&bn, ref) == 0 && bn)
                names[n] = strdup(bn);
            else
                names[n] = strdup("?");
            if (git_branch_is_head(ref) == 1) curhead = n;
            n++;
            git_reference_free(ref);
        }
        git_branch_iterator_free(it);
        /* remember the current branch by NAME across the sort */
        char *cur = (curhead >= 0) ? names[curhead] : NULL;
        qsort(names, (size_t)n, sizeof(char *), branch_name_cmp);
        for (int k = 0; k < n; k++) {
            printf("%s %s\n", (cur && names[k] == cur) ? "*" : " ", names[k]);
            free(names[k]);
        }
        return 0;
    }
}

/* ---- checkout ---- */
struct co_conflicts { int n; };
static int co_notify_cb(git_checkout_notify_t why, const char *path,
                        const git_diff_file *baseline, const git_diff_file *target,
                        const git_diff_file *workdir, void *payload) {
    (void)baseline; (void)target; (void)workdir;
    if (why == GIT_CHECKOUT_NOTIFY_CONFLICT) {
        struct co_conflicts *c = payload;
        if (c->n == 0)
            fprintf(stderr, "error: Your local changes to the following files "
                            "would be overwritten by checkout:\n");
        fprintf(stderr, "\t%s\n", path);
        c->n++;
    }
    return 0;
}

static int cmd_checkout(git_repository *repo, int argc, char **argv) {
    int create = 0, force = 0, quiet = 0, dashdash = -1;
    const char *pos[2] = { NULL, NULL };
    int npos = 0;
    for (int i = 0; i < argc; i++) {
        if (dashdash < 0 && !strcmp(argv[i], "--")) {
            dashdash = i;
            break;                                  /* everything after is paths */
        } else if (!strcmp(argv[i], "-b")) {
            create = 1;
        } else if (!strcmp(argv[i], "-f") || !strcmp(argv[i], "--force")) {
            force = 1;
        } else if (!strcmp(argv[i], "-q") || !strcmp(argv[i], "--quiet")) {
            quiet = 1;
        } else if (argv[i][0] == '-' && argv[i][1] != '\0') {
            fprintf(stderr, "git: unknown option '%s'\n", argv[i]);
            fprintf(stderr, "usage: git checkout <branch> | -b <name> [<start>] | "
                            "[<rev>] -- <path>...\n");
            return 1;
        } else if (npos < 2) {
            pos[npos++] = argv[i];
        } else {
            fprintf(stderr, "usage: git checkout <branch> | -b <name> [<start>] | "
                            "[<rev>] -- <path>...\n");
            return 1;
        }
    }

    /* ---- path-restore mode: checkout [<rev>] -- <path>... ---- */
    if (dashdash >= 0) {
        int npaths = argc - dashdash - 1;
        if (npaths <= 0) {
            fprintf(stderr, "usage: git checkout [<rev>] -- <path>...\n");
            return 1;
        }
        if (create) {
            fprintf(stderr, "git: -b cannot be combined with a path checkout\n");
            return 1;
        }
        char relbuf[64][PATH_MAX];
        char *specv[64];
        if (npaths > 64) {
            fprintf(stderr, "git: too many paths (max 64)\n");
            return 1;
        }
        for (int k = 0; k < npaths; k++) {
            if (workdir_rel(repo, argv[dashdash + 1 + k],
                            relbuf[k], sizeof(relbuf[k])) != 0)
                return 1;
            if (relbuf[k][0] == '\0') {
                fprintf(stderr, "fatal: empty pathspec after normalization: '%s'\n",
                        argv[dashdash + 1 + k]);
                return 1;
            }
            specv[k] = relbuf[k];
        }
        git_checkout_options opts = GIT_CHECKOUT_OPTIONS_INIT;
        opts.checkout_strategy = GIT_CHECKOUT_FORCE;
        opts.paths.strings = specv;
        opts.paths.count = (size_t)npaths;

        int r;
        if (pos[0]) {
            git_object *rev = NULL;
            if (git_revparse_single(&rev, repo, pos[0]) < 0) {
                fprintf(stderr, "git: bad revision '%s'\n", pos[0]);
                return 1;
            }
            r = git_checkout_tree(repo, rev, &opts);
            git_object_free(rev);
        } else {
            r = git_checkout_index(repo, NULL, &opts);
        }
        if (r < 0) { print_giterr("checkout"); return 1; }
        return 0;
    }

    /* ---- branch-switch mode ---- */
    const char *name = pos[0];
    if (create) {
        if (!name) {
            fprintf(stderr, "usage: git checkout -b <name> [<start>]\n");
            return 1;
        }
        /* Unborn HEAD with no start point: just repoint HEAD (git's
           behaviour before the first commit). */
        git_object *headobj = NULL;
        int have_head = (git_revparse_single(&headobj, repo, "HEAD") == 0);
        if (headobj) git_object_free(headobj);
        if (!have_head && !pos[1]) {
            char refname[512];
            snprintf(refname, sizeof(refname), "refs/heads/%s", name);
            if (git_repository_set_head(repo, refname) < 0) {
                print_giterr("checkout -b");
                return 1;
            }
            if (!quiet)
                fprintf(stderr, "Switched to a new branch '%s'\n", name);
            return 0;
        }
        git_object *target = NULL;
        if (git_revparse_single(&target, repo, pos[1] ? pos[1] : "HEAD") < 0) {
            fprintf(stderr, "fatal: not a valid object name: '%s'\n",
                    pos[1] ? pos[1] : "HEAD");
            return 1;
        }
        git_commit *commit = NULL;
        if (git_object_peel((git_object **)&commit, target, GIT_OBJECT_COMMIT) < 0) {
            fprintf(stderr, "fatal: '%s' is not a commit\n", pos[1] ? pos[1] : "HEAD");
            git_object_free(target);
            return 1;
        }
        git_object_free(target);
        git_reference *out = NULL;
        int cr = git_branch_create(&out, repo, name, commit, 0);
        git_commit_free(commit);
        if (cr < 0) {
            if (cr == GIT_EEXISTS)
                fprintf(stderr, "fatal: a branch named '%s' already exists\n", name);
            else
                print_giterr("checkout -b");
            return 1;
        }
        git_reference_free(out);
        /* fall through to switch to it */
    } else if (!name) {
        fprintf(stderr, "usage: git checkout <branch> | -b <name> [<start>] | "
                        "[<rev>] -- <path>...\n");
        return 1;
    }

    /* Is it a local branch? Otherwise a rev to detach onto; otherwise the
       caller probably meant a path and forgot the `--`. */
    git_reference *bref = NULL;
    int is_branch = (git_branch_lookup(&bref, repo, name, GIT_BRANCH_LOCAL) == 0);

    if (is_branch && !create) {
        git_reference *cur = NULL;
        if (git_repository_head_detached(repo) == 0 &&
            git_repository_head(&cur, repo) == 0) {
            const char *curname = git_reference_shorthand(cur);
            if (curname && !strcmp(curname, name)) {
                fprintf(stderr, "Already on '%s'\n", name);
                git_reference_free(cur);
                git_reference_free(bref);
                return 0;
            }
        }
        if (cur) git_reference_free(cur);
    }

    git_object *treeish = NULL;
    if (is_branch) {
        if (git_object_lookup(&treeish, repo, git_reference_target(bref),
                              GIT_OBJECT_COMMIT) < 0) {
            print_giterr("checkout");
            git_reference_free(bref);
            return 1;
        }
    } else {
        if (git_revparse_single(&treeish, repo, name) < 0) {
            fprintf(stderr, "error: pathspec '%s' did not match any file(s) "
                            "known to git\n"
                            "hint: to restore a file, use git checkout -- <path>\n",
                    name);
            return 1;
        }
    }

    git_checkout_options opts = GIT_CHECKOUT_OPTIONS_INIT;
    opts.checkout_strategy = force ? GIT_CHECKOUT_FORCE : GIT_CHECKOUT_SAFE;
    struct co_conflicts conflicts = {0};
    opts.notify_flags = GIT_CHECKOUT_NOTIFY_CONFLICT;
    opts.notify_cb = co_notify_cb;
    opts.notify_payload = &conflicts;

    if (git_checkout_tree(repo, treeish, &opts) < 0) {
        if (conflicts.n > 0)
            fprintf(stderr, "Please commit your changes or stash them before "
                            "you switch branches.\nAborting\n");
        else
            print_giterr("checkout");
        git_object_free(treeish);
        if (bref) git_reference_free(bref);
        return 1;
    }

    int rc = 0;
    if (is_branch) {
        char refname[512];
        snprintf(refname, sizeof(refname), "refs/heads/%s", name);
        if (git_repository_set_head(repo, refname) < 0) {
            print_giterr("checkout");
            rc = 1;
        } else if (!quiet) {
            fprintf(stderr, "Switched to %sbranch '%s'\n",
                    create ? "a new " : "", name);
        }
    } else {
        const git_oid *oid = git_object_id(treeish);
        git_object *commit = NULL;
        if (git_object_peel(&commit, treeish, GIT_OBJECT_COMMIT) < 0 ||
            git_repository_set_head_detached(repo, git_object_id(commit)) < 0) {
            print_giterr("checkout: detach");
            rc = 1;
        } else if (!quiet) {
            char full[GIT_OID_SHA1_HEXSIZE + 1];
            git_oid_tostr(full, sizeof(full), oid);
            full[7] = '\0';
            fprintf(stderr, "Note: switching to '%s' detaches HEAD\n"
                            "HEAD is now at %s\n", name, full);
        }
        if (commit) git_object_free(commit);
    }
    git_object_free(treeish);
    if (bref) git_reference_free(bref);
    return rc;
}

/* ---- config ---- */
static int cmd_config(int argc, char **argv) {
    int global = 0;
    const char *key = NULL, *value = NULL;
    for (int i = 0; i < argc; i++) {
        if (!strcmp(argv[i], "--global")) {
            global = 1;
        } else if (argv[i][0] == '-' && argv[i][1] != '\0') {
            fprintf(stderr, "git: unknown option '%s'\n", argv[i]);
            fprintf(stderr, "usage: git config [--global] <key> [<value>]\n");
            return 1;
        } else if (!key) {
            key = argv[i];
        } else if (!value) {
            value = argv[i];
        } else {
            fprintf(stderr, "usage: git config [--global] <key> [<value>]\n");
            return 1;
        }
    }
    if (!key) {
        fprintf(stderr, "usage: git config [--global] <key> [<value>]\n");
        return 1;
    }

    git_config *cfg = NULL;
    git_repository *repo = NULL;
    if (global) {
        const char *home = getenv("HOME");
        char path[PATH_MAX];
        snprintf(path, sizeof(path), "%s/.gitconfig", home ? home : "/root");
        if (git_config_open_ondisk(&cfg, path) < 0) {
            print_giterr("config");
            return 1;
        }
    } else {
        if (open_repo(&repo) < 0) return 1;
        if (git_repository_config(&cfg, repo) < 0) {
            print_giterr("config");
            git_repository_free(repo);
            return 1;
        }
    }

    int rc = 0;
    if (value) {
        if (git_config_set_string(cfg, key, value) < 0) {
            print_giterr("config");
            rc = 1;
        }
    } else {
        git_buf buf = {0};
        git_config *snap = NULL;
        /* reads need a snapshot (a live config refuses get_string) */
        if (git_config_snapshot(&snap, cfg) == 0 &&
            git_config_get_string_buf(&buf, snap, key) == 0) {
            printf("%s\n", buf.ptr);
        } else {
            rc = 1;                     /* git: silent exit 1 on a missing key */
        }
        git_buf_dispose(&buf);
        if (snap) git_config_free(snap);
    }
    git_config_free(cfg);
    if (repo) git_repository_free(repo);
    return rc;
}

/* ---- main ---- */

int main(int argc, char **argv) {
    /* Global options, git's own spelling. Everything before the command
       word is consumed here; the first non-option argument is the command. */
    int i = 1;
    for (; i < argc; i++) {
        const char *a = argv[i];
        if (!strcmp(a, "-C")) {
            if (i + 1 >= argc) {
                fprintf(stderr, "fatal: no directory given for -C\n");
                return 1;
            }
            const char *dir = argv[++i];
            if (chdir(dir) != 0) {
                fprintf(stderr, "fatal: cannot change to '%s'\n", dir);
                return 1;
            }
        } else if (!strcmp(a, "--version") || !strcmp(a, "version")) {
            printf("git version %s (libgit2 %s)\n",
                   GUCOS_GIT_VERSION, LIBGIT2_VERSION);
            return 0;
        } else if (!strcmp(a, "--help") || !strcmp(a, "-h") || !strcmp(a, "help")) {
            usage(stdout);
            return 0;
        } else if (a[0] == '-' && a[1] != '\0') {
            fprintf(stderr, "fatal: unknown option '%s'\n", a);
            usage(stderr);
            return 1;
        } else {
            break;                          /* the command word */
        }
    }

    if (i >= argc) {
        usage(stderr);
        return 1;
    }

    git_libgit2_init();

    char *cmd = argv[i];
    int cmd_argc = argc - i - 1;
    char **cmd_argv = argv + i + 1;

    /* init and config create or find their own repository — everything
       else runs inside the discovered one. */
    if (!strcmp(cmd, "init")) {
        int rc0 = cmd_init(cmd_argc, cmd_argv);
        git_libgit2_shutdown();
        return rc0;
    }
    if (!strcmp(cmd, "config")) {
        int rc0 = cmd_config(cmd_argc, cmd_argv);
        git_libgit2_shutdown();
        return rc0;
    }

    git_repository *repo = NULL;
    if (open_repo(&repo) < 0) return 1;

    int rc = 0;
    if (!strcmp(cmd, "log"))           rc = cmd_log(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "diff"))     rc = cmd_diff(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "show"))     rc = cmd_show(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "status"))   rc = cmd_status(repo);
    else if (!strcmp(cmd, "rev-list")) rc = cmd_rev_list(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "rev-parse")) rc = cmd_rev_parse(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "cat-file")) rc = cmd_cat_file(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "ls-tree"))  rc = cmd_ls_tree(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "add"))      rc = cmd_add(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "commit"))   rc = cmd_commit(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "branch"))   rc = cmd_branch(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "checkout")) rc = cmd_checkout(repo, cmd_argc, cmd_argv);
    else {
        /* Tell a real git command apart from a typo. Answering `merge`
           with a bare "unknown command" is what makes a caller conclude
           git is BROKEN rather than deliberately partial — name the
           limitation instead, and name it in the one place the caller is
           already looking. */
        static const char *const unimplemented[] = {
            "am", "apply", "bisect", "blame",
            "cherry-pick", "clean", "clone", "describe",
            "fetch", "grep", "merge", "mv", "pull", "push", "rebase",
            "reflog", "remote", "reset", "restore", "revert", "rm", "stash",
            "submodule", "switch", "tag", "worktree", NULL,
        };
        int known = 0;
        for (int k = 0; unimplemented[k]; k++)
            if (!strcmp(cmd, unimplemented[k])) { known = 1; break; }
        if (known)
            fprintf(stderr, "git: '%s' is a git command, but this build "
                            "does not implement it yet.\n"
                            "See 'git --help' for what is available.\n", cmd);
        else
            fprintf(stderr, "git: '%s' is not a git command. "
                            "See 'git --help'.\n", cmd);
        rc = 1;
    }

    git_repository_free(repo);
    git_libgit2_shutdown();
    return rc;
}
