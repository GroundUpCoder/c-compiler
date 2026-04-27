/* zlib_demo.c -- zlib compress/decompress self-test */

#include "zlib.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static void test_simple(void) {
    const char *original = "Hello from zlib running in WebAssembly! "
                           "This string will be compressed and decompressed.";
    uLong srcLen = (uLong)strlen(original) + 1;

    uLong compLen = compressBound(srcLen);
    Byte *comp = (Byte *)malloc(compLen);
    Byte *out  = (Byte *)malloc(srcLen);
    if (!comp || !out) { printf("malloc failed\n"); exit(1); }

    int err = compress(comp, &compLen, (const Byte *)original, srcLen);
    if (err != Z_OK) { printf("compress error: %d\n", err); exit(1); }

    uLong outLen = srcLen;
    err = uncompress(out, &outLen, comp, compLen);
    if (err != Z_OK) { printf("uncompress error: %d\n", err); exit(1); }

    printf("simple: %s\n", strcmp((char *)out, original) == 0 ? "OK" : "FAIL");
    printf("original: %lu compressed: %lu\n", srcLen, compLen);

    free(comp);
    free(out);
}

static void test_streaming(void) {
    char input[1024];
    int pos = 0;
    for (int i = 0; i < 20 && pos < 1000; i++) {
        pos += sprintf(input + pos, "Line %d: the quick brown fox jumps. ", i);
    }
    uLong srcLen = (uLong)strlen(input) + 1;

    Byte comp[2048];
    Byte output[2048];
    z_stream strm;

    memset(&strm, 0, sizeof(strm));
    int err = deflateInit(&strm, Z_DEFAULT_COMPRESSION);
    if (err != Z_OK) { printf("deflateInit error: %d\n", err); exit(1); }

    strm.next_in   = (Byte *)input;
    strm.avail_in  = srcLen;
    strm.next_out  = comp;
    strm.avail_out = sizeof(comp);

    err = deflate(&strm, Z_FINISH);
    if (err != Z_STREAM_END) { printf("deflate error: %d\n", err); exit(1); }

    uLong compLen = strm.total_out;
    deflateEnd(&strm);

    memset(&strm, 0, sizeof(strm));
    err = inflateInit(&strm);
    if (err != Z_OK) { printf("inflateInit error: %d\n", err); exit(1); }

    strm.next_in   = comp;
    strm.avail_in  = compLen;
    strm.next_out  = output;
    strm.avail_out = sizeof(output);

    err = inflate(&strm, Z_FINISH);
    if (err != Z_STREAM_END) { printf("inflate error: %d\n", err); exit(1); }

    inflateEnd(&strm);

    printf("streaming: %s\n", strcmp((char *)output, input) == 0 ? "OK" : "FAIL");
    printf("original: %lu compressed: %lu\n", srcLen, compLen);
}

static void test_checksums(void) {
    const char *data = "Wikipedia";
    uLong len = (uLong)strlen(data);

    uLong a32 = adler32(0L, Z_NULL, 0);
    a32 = adler32(a32, (const Byte *)data, len);

    uLong c32 = crc32(0L, Z_NULL, 0);
    c32 = crc32(c32, (const Byte *)data, len);

    printf("adler32: 0x%08lx\n", a32);
    printf("crc32: 0x%08lx\n", c32);
}

int main(void) {
    test_simple();
    test_streaming();
    test_checksums();
    return 0;
}
