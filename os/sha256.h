/* sha256.h — FIPS 180-4 SHA-256, ONE implementation in ONE place.
 *
 * Header-only by design (the fileops.h / openwith.h / sounds.h precedent):
 * os/gucman/gucman.c (payload verification before extraction) and
 * os/deskdefaults.c (the seed reconcile's per-file checksums, gucman `seed`
 * design §3.4) share these static functions by textual inclusion, so the
 * hash a package's install RECORDS and the hash its remove COMPARES can
 * never drift.
 *
 * The block/update/hex core moved here verbatim out of gucman.c (where it
 * was self-contained); sha256_path() is the new shared file/symlink hasher
 * the `seed` resource kind needs: a symlink hashes its TARGET STRING (never
 * dereferenced — a dangling or re-pointed link stays honestly comparable),
 * everything else hashes its bytes.
 */
#ifndef SHA256_H
#define SHA256_H

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct {
    uint32_t h[8];
    uint64_t len;
    uint8_t buf[64];
    int fill;
} sha256_ctx;

static const uint32_t sha256_k[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

#define SHA256_ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_block(sha256_ctx *c, const uint8_t *p) {
    uint32_t w[64], a, b, d, e, f, g, hh, t1, t2, hcur;
    int i;
    for (i = 0; i < 16; i++)
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
               ((uint32_t)p[i * 4 + 2] << 8) | p[i * 4 + 3];
    for (i = 16; i < 64; i++) {
        uint32_t s0 = SHA256_ROR(w[i - 15], 7) ^ SHA256_ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = SHA256_ROR(w[i - 2], 17) ^ SHA256_ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    a = c->h[0]; b = c->h[1]; hcur = c->h[2]; d = c->h[3];
    e = c->h[4]; f = c->h[5]; g = c->h[6]; hh = c->h[7];
    for (i = 0; i < 64; i++) {
        uint32_t s1 = SHA256_ROR(e, 6) ^ SHA256_ROR(e, 11) ^ SHA256_ROR(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        t1 = hh + s1 + ch + sha256_k[i] + w[i];
        uint32_t s0 = SHA256_ROR(a, 2) ^ SHA256_ROR(a, 13) ^ SHA256_ROR(a, 22);
        uint32_t mj = (a & b) ^ (a & hcur) ^ (b & hcur);
        t2 = s0 + mj;
        hh = g; g = f; f = e; e = d + t1;
        d = hcur; hcur = b; b = a; a = t1 + t2;
    }
    c->h[0] += a; c->h[1] += b; c->h[2] += hcur; c->h[3] += d;
    c->h[4] += e; c->h[5] += f; c->h[6] += g; c->h[7] += hh;
}

static void sha256_init(sha256_ctx *c) {
    static const uint32_t iv[8] = {
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
    };
    memcpy(c->h, iv, sizeof iv);
    c->len = 0;
    c->fill = 0;
}

static void sha256_update(sha256_ctx *c, const void *data, size_t n) {
    const uint8_t *p = (const uint8_t *)data;
    c->len += n;
    while (n) {
        size_t take = 64 - (size_t)c->fill;
        if (take > n) take = n;
        memcpy(c->buf + c->fill, p, take);
        c->fill += (int)take;
        p += take;
        n -= take;
        if (c->fill == 64) { sha256_block(c, c->buf); c->fill = 0; }
    }
}

static void sha256_hex(sha256_ctx *c, char out[65]) {
    uint64_t bits = c->len * 8;
    uint8_t pad = 0x80;
    sha256_update(c, &pad, 1);
    uint8_t z = 0;
    while (c->fill != 56) sha256_update(c, &z, 1);
    uint8_t lb[8];
    for (int i = 0; i < 8; i++) lb[i] = (uint8_t)(bits >> (56 - 8 * i));
    sha256_update(c, lb, 8);
    static const char hexd[] = "0123456789abcdef";
    for (int i = 0; i < 8; i++)
        for (int j = 0; j < 4; j++) {
            uint8_t byte = (uint8_t)(c->h[i] >> (24 - 8 * j));
            out[i * 8 + j * 2] = hexd[byte >> 4];
            out[i * 8 + j * 2 + 1] = hexd[byte & 15];
        }
    out[64] = 0;
}

static void sha256_of(const void *data, size_t n, char out[65]) {
    sha256_ctx c;
    sha256_init(&c);
    sha256_update(&c, data, n);
    sha256_hex(&c, out);
}

/* Hash the thing AT `path` — a planted seed's identity (design §2.3).
 * A SYMLINK hashes its target string (lstat/readlink, never dereferenced:
 * the link IS the content, and a dangling target must not make the hash
 * unreadable); anything else hashes its bytes. 0 on success, -1 with errno
 * set (the caller's "unreadable -> keep it" branch). */
static int sha256_path(const char *path, char out[65]) {
    struct stat st;
    if (lstat(path, &st) != 0) return -1;
    if (S_ISLNK(st.st_mode)) {
        char tgt[1024];
        ssize_t n = readlink(path, tgt, sizeof tgt - 1);
        if (n < 0) return -1;
        tgt[n] = 0;
        sha256_of(tgt, (size_t)n, out);
        return 0;
    }
    if (S_ISDIR(st.st_mode)) { errno = EISDIR; return -1; }
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    sha256_ctx c;
    sha256_init(&c);
    static char buf[32768];                      /* the wasm stack is 64KB */
    for (;;) {
        ssize_t r = read(fd, buf, sizeof buf);
        if (r < 0) { int e = errno; close(fd); errno = e; return -1; }
        if (r == 0) break;
        sha256_update(&c, buf, (size_t)r);
    }
    close(fd);
    sha256_hex(&c, out);
    return 0;
}

#endif /* SHA256_H */
