/*
 * main.c -- a minimal zip/unzip tool built on zlib
 *
 * Usage:
 *   <prog> create <zipfile> <file1> [file2] ...
 *   <prog> extract <zipfile>
 *
 * Supports STORE (method 0) and DEFLATE (method 8).
 * File paths are stored as given on the command line.
 * Extraction writes files relative to the current directory.
 */

#include "zlib.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>

/* ---------- ZIP format constants ---------- */

#define ZIP_LOCAL_SIG   0x04034b50
#define ZIP_CENTRAL_SIG 0x02014b50
#define ZIP_EOCD_SIG    0x06054b50

#define METHOD_STORE    0
#define METHOD_DEFLATE  8

/* Fixed DOS timestamp: 2025-01-01 00:00:00 */
#define DOS_TIME  0
#define DOS_DATE  0x5A21

/* Unix "version made by": OS=Unix(3), ZIP spec 2.0 */
#define VER_MADE  ((3 << 8) | 20)
#define VER_NEED  20

/* External attrs: regular file 0644 in upper 16 bits */
#define EXT_ATTRS ((unsigned long)0x81A40000)

#define MAX_ENTRIES 1024

/* ---------- little-endian helpers ---------- */

static void put16(unsigned char *b, unsigned int v) {
    b[0] = v & 0xff;
    b[1] = (v >> 8) & 0xff;
}

static void put32(unsigned char *b, unsigned long v) {
    b[0] = v & 0xff;
    b[1] = (v >> 8) & 0xff;
    b[2] = (v >> 16) & 0xff;
    b[3] = (v >> 24) & 0xff;
}

static unsigned int get16(const unsigned char *b) {
    return (unsigned int)b[0] | ((unsigned int)b[1] << 8);
}

static unsigned long get32(const unsigned char *b) {
    return (unsigned long)b[0] | ((unsigned long)b[1] << 8) |
           ((unsigned long)b[2] << 16) | ((unsigned long)b[3] << 24);
}

/* ---------- file I/O helpers ---------- */

static unsigned char *read_entire_file(const char *path, long *out_size) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        fprintf(stderr, "error: cannot open '%s' for reading\n", path);
        return NULL;
    }
    long size = lseek(fd, 0, SEEK_END);
    lseek(fd, 0, SEEK_SET);
    unsigned char *buf = (unsigned char *)malloc(size ? size : 1);
    if (!buf) {
        fprintf(stderr, "error: malloc failed (%ld bytes)\n", size);
        close(fd);
        return NULL;
    }
    if (size > 0) {
        long total = 0;
        while (total < size) {
            long n = read(fd, buf + total, size - total);
            if (n <= 0) break;
            total += n;
        }
    }
    close(fd);
    *out_size = size;
    return buf;
}

static int write_all(int fd, const unsigned char *buf, long size) {
    long total = 0;
    while (total < size) {
        long n = write(fd, buf + total, size - total);
        if (n <= 0) return -1;
        total += n;
    }
    return 0;
}

/* ---------- zip entry bookkeeping ---------- */

struct entry {
    char name[256];
    unsigned long crc;
    unsigned long comp_size;
    unsigned long uncomp_size;
    unsigned long local_offset;
    unsigned short method;
};

/* ---------- create command ---------- */

static int do_create(const char *zippath, int nfiles, char **files) {
    if (nfiles > MAX_ENTRIES) {
        fprintf(stderr, "error: too many files (max %d)\n", MAX_ENTRIES);
        return 1;
    }

    struct entry *entries = (struct entry *)calloc(nfiles, sizeof(struct entry));
    if (!entries) { fprintf(stderr, "error: malloc failed\n"); return 1; }

    int zfd = open(zippath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (zfd < 0) {
        fprintf(stderr, "error: cannot create '%s'\n", zippath);
        free(entries);
        return 1;
    }

    for (int i = 0; i < nfiles; i++) {
        /* Read source file */
        long fsize;
        unsigned char *fdata = read_entire_file(files[i], &fsize);
        if (!fdata) { close(zfd); free(entries); return 1; }

        /* CRC-32 */
        unsigned long fcrc = crc32(0L, Z_NULL, 0);
        if (fsize > 0)
            fcrc = crc32(fcrc, fdata, fsize);

        /* Compress with raw deflate (-15 = no zlib/gzip header) */
        unsigned long bound = deflateBound(NULL, fsize) + 256;
        unsigned char *cdata = (unsigned char *)malloc(bound);
        if (!cdata) {
            fprintf(stderr, "error: malloc failed\n");
            free(fdata); close(zfd); free(entries);
            return 1;
        }

        z_stream strm;
        memset(&strm, 0, sizeof(strm));
        deflateInit2(&strm, Z_DEFAULT_COMPRESSION, Z_DEFLATED,
                     -15, 8, Z_DEFAULT_STRATEGY);
        strm.next_in = fdata;
        strm.avail_in = fsize;
        strm.next_out = cdata;
        strm.avail_out = bound;
        deflate(&strm, Z_FINISH);
        unsigned long csize = strm.total_out;
        deflateEnd(&strm);

        /* Pick STORE vs DEFLATE */
        unsigned short method = METHOD_DEFLATE;
        const unsigned char *wdata = cdata;
        unsigned long wsize = csize;
        if (csize >= (unsigned long)fsize) {
            method = METHOD_STORE;
            wdata = fdata;
            wsize = fsize;
        }

        /* Record entry */
        unsigned int nlen = strlen(files[i]);
        if (nlen > 255) nlen = 255;
        memcpy(entries[i].name, files[i], nlen);
        entries[i].name[nlen] = 0;
        entries[i].crc = fcrc;
        entries[i].comp_size = wsize;
        entries[i].uncomp_size = fsize;
        entries[i].local_offset = lseek(zfd, 0, SEEK_CUR);
        entries[i].method = method;

        /* Write local file header (30 bytes + name) */
        unsigned char lh[30];
        put32(lh + 0,  ZIP_LOCAL_SIG);
        put16(lh + 4,  VER_NEED);
        put16(lh + 6,  0);              /* flags */
        put16(lh + 8,  method);
        put16(lh + 10, DOS_TIME);
        put16(lh + 12, DOS_DATE);
        put32(lh + 14, fcrc);
        put32(lh + 18, wsize);
        put32(lh + 22, fsize);
        put16(lh + 26, nlen);
        put16(lh + 28, 0);              /* extra length */
        write_all(zfd, lh, 30);
        write_all(zfd, (const unsigned char *)files[i], nlen);

        /* Write file data */
        write_all(zfd, wdata, wsize);

        printf("  added: %s (%ld -> %lu, %s)\n",
               files[i], fsize, wsize,
               method == METHOD_STORE ? "stored" : "deflated");

        free(cdata);
        free(fdata);
    }

    /* ---- Central directory ---- */
    unsigned long cd_off = lseek(zfd, 0, SEEK_CUR);

    for (int i = 0; i < nfiles; i++) {
        unsigned int nlen = strlen(entries[i].name);
        unsigned char ch[46];
        put32(ch + 0,  ZIP_CENTRAL_SIG);
        put16(ch + 4,  VER_MADE);
        put16(ch + 6,  VER_NEED);
        put16(ch + 8,  0);              /* flags */
        put16(ch + 10, entries[i].method);
        put16(ch + 12, DOS_TIME);
        put16(ch + 14, DOS_DATE);
        put32(ch + 16, entries[i].crc);
        put32(ch + 20, entries[i].comp_size);
        put32(ch + 24, entries[i].uncomp_size);
        put16(ch + 28, nlen);
        put16(ch + 30, 0);              /* extra length */
        put16(ch + 32, 0);              /* comment length */
        put16(ch + 34, 0);              /* disk number */
        put16(ch + 36, 0);              /* internal attrs */
        put32(ch + 38, EXT_ATTRS);
        put32(ch + 42, entries[i].local_offset);
        write_all(zfd, ch, 46);
        write_all(zfd, (const unsigned char *)entries[i].name, nlen);
    }

    unsigned long cd_size = lseek(zfd, 0, SEEK_CUR) - cd_off;

    /* ---- End of central directory (22 bytes) ---- */
    unsigned char eocd[22];
    put32(eocd + 0,  ZIP_EOCD_SIG);
    put16(eocd + 4,  0);                /* disk number */
    put16(eocd + 6,  0);                /* disk with CD */
    put16(eocd + 8,  nfiles);
    put16(eocd + 10, nfiles);
    put32(eocd + 12, cd_size);
    put32(eocd + 16, cd_off);
    put16(eocd + 20, 0);                /* comment length */
    write_all(zfd, eocd, 22);

    close(zfd);
    free(entries);
    printf("created %s (%d file%s)\n", zippath, nfiles, nfiles == 1 ? "" : "s");
    return 0;
}

/* ---------- extract command ---------- */

static int do_extract(const char *zippath) {
    long zsize;
    unsigned char *zdata = read_entire_file(zippath, &zsize);
    if (!zdata) return 1;

    /* Find EOCD (scan backwards) */
    long eocd_pos = -1;
    for (long i = zsize - 22; i >= 0; i--) {
        if (get32(zdata + i) == ZIP_EOCD_SIG) {
            eocd_pos = i;
            break;
        }
    }
    if (eocd_pos < 0) {
        fprintf(stderr, "error: not a valid ZIP file\n");
        free(zdata);
        return 1;
    }

    unsigned int nentries = get16(zdata + eocd_pos + 10);
    unsigned long cd_off  = get32(zdata + eocd_pos + 16);
    int errors = 0;

    /* Walk the central directory */
    unsigned long pos = cd_off;
    for (unsigned int i = 0; i < nentries; i++) {
        if (pos + 46 > (unsigned long)zsize ||
            get32(zdata + pos) != ZIP_CENTRAL_SIG) {
            fprintf(stderr, "error: corrupt central directory at entry %u\n", i);
            free(zdata);
            return 1;
        }

        unsigned short method     = get16(zdata + pos + 10);
        unsigned long  exp_crc    = get32(zdata + pos + 16);
        unsigned long  comp_size  = get32(zdata + pos + 20);
        unsigned long  uncomp_sz  = get32(zdata + pos + 24);
        unsigned int   name_len   = get16(zdata + pos + 28);
        unsigned int   extra_len  = get16(zdata + pos + 30);
        unsigned int   comm_len   = get16(zdata + pos + 32);
        unsigned long  local_off  = get32(zdata + pos + 42);

        char name[256];
        unsigned int clen = name_len < 255 ? name_len : 255;
        memcpy(name, zdata + pos + 46, clen);
        name[clen] = 0;

        pos += 46 + name_len + extra_len + comm_len;

        /* Skip directories */
        if (name_len > 0 && name[name_len - 1] == '/') continue;

        /* Locate file data via local header */
        if (local_off + 30 > (unsigned long)zsize ||
            get32(zdata + local_off) != ZIP_LOCAL_SIG) {
            fprintf(stderr, "error: bad local header for '%s'\n", name);
            errors++;
            continue;
        }
        unsigned int lh_nlen  = get16(zdata + local_off + 26);
        unsigned int lh_extra = get16(zdata + local_off + 28);
        unsigned long data_off = local_off + 30 + lh_nlen + lh_extra;

        if (data_off + comp_size > (unsigned long)zsize) {
            fprintf(stderr, "error: truncated data for '%s'\n", name);
            errors++;
            continue;
        }

        /* Decompress */
        unsigned char *out_buf;
        if (method == METHOD_STORE) {
            out_buf = zdata + data_off;
        } else if (method == METHOD_DEFLATE) {
            out_buf = (unsigned char *)malloc(uncomp_sz ? uncomp_sz : 1);
            if (!out_buf) {
                fprintf(stderr, "error: malloc failed for '%s'\n", name);
                errors++;
                continue;
            }
            z_stream strm;
            memset(&strm, 0, sizeof(strm));
            inflateInit2(&strm, -15);   /* raw inflate */
            strm.next_in   = zdata + data_off;
            strm.avail_in  = comp_size;
            strm.next_out  = out_buf;
            strm.avail_out = uncomp_sz;
            int ret = inflate(&strm, Z_FINISH);
            inflateEnd(&strm);
            if (ret != Z_STREAM_END) {
                fprintf(stderr, "error: inflate failed for '%s' (ret=%d)\n",
                        name, ret);
                free(out_buf);
                errors++;
                continue;
            }
        } else {
            fprintf(stderr, "warning: unsupported method %d for '%s', skipping\n",
                    method, name);
            continue;
        }

        /* CRC check */
        unsigned long got_crc = crc32(0L, Z_NULL, 0);
        if (uncomp_sz > 0)
            got_crc = crc32(got_crc, out_buf, uncomp_sz);
        if (got_crc != exp_crc) {
            fprintf(stderr, "warning: CRC mismatch for '%s' "
                    "(expected %08lx, got %08lx)\n", name, exp_crc, got_crc);
        }

        /* Write output file */
        int ofd = open(name, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (ofd < 0) {
            fprintf(stderr, "error: cannot create '%s'\n", name);
            if (method == METHOD_DEFLATE) free(out_buf);
            errors++;
            continue;
        }
        if (uncomp_sz > 0)
            write_all(ofd, out_buf, uncomp_sz);
        close(ofd);

        printf("  extracted: %s (%lu bytes)\n", name, uncomp_sz);
        if (method == METHOD_DEFLATE) free(out_buf);
    }

    free(zdata);
    if (errors) {
        fprintf(stderr, "%d error(s) during extraction\n", errors);
        return 1;
    }
    printf("extracted %u file%s from %s\n",
           nentries, nentries == 1 ? "" : "s", zippath);
    return 0;
}

/* ---------- main ---------- */

static void usage(const char *prog) {
    fprintf(stderr, "usage:\n");
    fprintf(stderr, "  %s create <zipfile> <file1> [file2 ...]\n", prog);
    fprintf(stderr, "  %s extract <zipfile>\n", prog);
}

int main(int argc, char **argv) {
    if (argc < 3) {
        usage(argv[0]);
        return 1;
    }

    if (strcmp(argv[1], "create") == 0) {
        if (argc < 4) {
            fprintf(stderr, "error: create needs at least one input file\n");
            return 1;
        }
        return do_create(argv[2], argc - 3, argv + 3);
    }

    if (strcmp(argv[1], "extract") == 0) {
        return do_extract(argv[2]);
    }

    fprintf(stderr, "error: unknown command '%s'\n", argv[1]);
    usage(argv[0]);
    return 1;
}
