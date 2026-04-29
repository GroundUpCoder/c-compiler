#include "wasm.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void usage(const char *prog) {
    fprintf(stderr, "Usage: %s [options] file.wasm\n", prog);
    fprintf(stderr, "\nOptions:\n");
    fprintf(stderr, "  -h          Section headers\n");
    fprintf(stderr, "  -x          Section details\n");
    fprintf(stderr, "  -d          Disassemble code\n");
    fprintf(stderr, "  -s          Hex dump of sections\n");
    fprintf(stderr, "  -j <name>   Filter by section name\n");
    fprintf(stderr, "  --help      Show this help\n");
    exit(1);
}

int main(int argc, char **argv) {
    int show_headers = 0, show_details = 0, show_disasm = 0, show_hexdump = 0;
    const char *section_filter = NULL;
    const char *filename = NULL;
    FILE *f;
    long fsize;
    uint8_t *data;
    WasmModule mod;
    int i;

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-h") == 0) show_headers = 1;
        else if (strcmp(argv[i], "-x") == 0) show_details = 1;
        else if (strcmp(argv[i], "-d") == 0) show_disasm = 1;
        else if (strcmp(argv[i], "-s") == 0) show_hexdump = 1;
        else if (strcmp(argv[i], "-j") == 0) {
            if (++i >= argc) usage(argv[0]);
            section_filter = argv[i];
        }
        else if (strcmp(argv[i], "--help") == 0) usage(argv[0]);
        else if (argv[i][0] == '-') {
            fprintf(stderr, "disw: unknown option: %s\n", argv[i]);
            usage(argv[0]);
        }
        else filename = argv[i];
    }

    if (!filename) usage(argv[0]);
    if (!show_headers && !show_details && !show_disasm && !show_hexdump)
        show_headers = 1;

    f = fopen(filename, "rb");
    if (!f) {
        fprintf(stderr, "disw: cannot open '%s'\n", filename);
        return 1;
    }
    fseek(f, 0, SEEK_END);
    fsize = ftell(f);
    fseek(f, 0, SEEK_SET);
    data = malloc(fsize);
    fread(data, 1, fsize, f);
    fclose(f);

    if (wasm_parse(&mod, data, fsize) != 0)
        return 1;

    printf("\n%s:\tfile format wasm 0x%x\n", filename, mod.version);

    if (show_headers) print_headers(&mod, section_filter);
    if (show_details) print_details(&mod, section_filter);
    if (show_disasm) print_disasm(&mod, section_filter);
    if (show_hexdump) print_hexdump(&mod, section_filter);

    wasm_free(&mod);
    free(data);
    return 0;
}
