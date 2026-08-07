/* git — the gucOS git CLI, a read-only porcelain over vendored libgit2.
 *
 *   git [-C <path>] <command> [args...]
 *
 * Commands: log, diff, show, status, rev-list, rev-parse, cat-file, ls-tree.
 *
 * READ-ONLY TODAY. Nothing here writes an object, a ref or the index yet —
 * the write set (init/add/commit/branch/checkout) is ticket #475, approved
 * and already queued behind this one, which is why the command is called
 * `git` rather than something hedged (#474's naming question was coupled to
 * that approval and resolved by it).
 *
 * The hazard the name carries is real and is handled HERE rather than by
 * the name: an agent that types `git commit` and reads "unknown command"
 * concludes git is BROKEN. So a real git verb that this build does not
 * implement is answered by saying exactly that, and a typo is answered
 * differently — see the command dispatch at the bottom of this file. Delete
 * a verb from that list as #475 implements it.
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
#include <git2.h>

#define GUCOS_GIT_VERSION "0.1"

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
        "The gucOS git CLI (read-only). The repository is discovered by\n"
        "searching up from the current directory, as in git.\n"
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
        "Writing commands (add, commit, checkout, ...) are not implemented.\n");
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

    git_repository *repo = NULL;
    if (open_repo(&repo) < 0) return 1;

    char *cmd = argv[i];
    int cmd_argc = argc - i - 1;
    char **cmd_argv = argv + i + 1;

    int rc = 0;
    if (!strcmp(cmd, "log"))           rc = cmd_log(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "diff"))     rc = cmd_diff(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "show"))     rc = cmd_show(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "status"))   rc = cmd_status(repo);
    else if (!strcmp(cmd, "rev-list")) rc = cmd_rev_list(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "rev-parse")) rc = cmd_rev_parse(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "cat-file")) rc = cmd_cat_file(repo, cmd_argc, cmd_argv);
    else if (!strcmp(cmd, "ls-tree"))  rc = cmd_ls_tree(repo, cmd_argc, cmd_argv);
    else {
        /* Tell a real git command apart from a typo. Answering `commit`
           with a bare "unknown command" is what makes a caller conclude
           git is BROKEN rather than deliberately partial — name the
           limitation instead, and name it in the one place the caller is
           already looking. */
        static const char *const unimplemented[] = {
            "add", "am", "apply", "bisect", "blame", "branch", "checkout",
            "cherry-pick", "clean", "clone", "commit", "config", "describe",
            "fetch", "grep", "init", "merge", "mv", "pull", "push", "rebase",
            "reflog", "remote", "reset", "restore", "revert", "rm", "stash",
            "submodule", "switch", "tag", "worktree", NULL,
        };
        int known = 0;
        for (int k = 0; unimplemented[k]; k++)
            if (!strcmp(cmd, unimplemented[k])) { known = 1; break; }
        if (known)
            fprintf(stderr, "git: '%s' is a git command, but this build is "
                            "read-only and does not implement it yet.\n"
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
