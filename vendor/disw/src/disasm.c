#include "wasm.h"
#include <stdio.h>
#include <string.h>

static int sec_match(const Section *s, const char *f) {
    if (!f) return 1;
    if (s->id == SEC_CUSTOM) {
        if (strcmp(f, "Custom") == 0) return 1;
        return s->custom_name && strcmp(s->custom_name, f) == 0;
    }
    return strcmp(wasm_section_name(s->id), f) == 0;
}

static void print_sig(const FuncType *ft) {
    uint32_t i;
    printf("(");
    for (i = 0; i < ft->param_count; i++) {
        if (i) printf(", ");
        printf("%s", wasm_valtype(ft->params[i]));
    }
    printf(") -> ");
    if (ft->result_count == 0) {
        printf("nil");
    } else {
        for (i = 0; i < ft->result_count; i++) {
            if (i) printf(", ");
            printf("%s", wasm_valtype(ft->results[i]));
        }
    }
}

/* Opcode immediate kinds */
enum { N, BT, IX, BR, CI, MA, I4, I8, F4, F8, MB, RT, ST };

typedef struct { const char *name; uint8_t imm; uint8_t align; } Op;

static const Op ops[256] = {
    /* control */
    [0x00] = {"unreachable", N, 0},
    [0x01] = {"nop", N, 0},
    [0x02] = {"block", BT, 0},
    [0x03] = {"loop", BT, 0},
    [0x04] = {"if", BT, 0},
    [0x05] = {"else", N, 0},
    [0x0B] = {"end", N, 0},
    [0x0C] = {"br", IX, 0},
    [0x0D] = {"br_if", IX, 0},
    [0x0E] = {"br_table", BR, 0},
    [0x0F] = {"return", N, 0},
    [0x10] = {"call", IX, 0},
    [0x11] = {"call_indirect", CI, 0},
    /* parametric */
    [0x1A] = {"drop", N, 0},
    [0x1B] = {"select", N, 0},
    [0x1C] = {"select", ST, 0},
    /* variable */
    [0x20] = {"local.get", IX, 0},
    [0x21] = {"local.set", IX, 0},
    [0x22] = {"local.tee", IX, 0},
    [0x23] = {"global.get", IX, 0},
    [0x24] = {"global.set", IX, 0},
    /* table */
    [0x25] = {"table.get", IX, 0},
    [0x26] = {"table.set", IX, 0},
    /* memory load */
    [0x28] = {"i32.load", MA, 2},
    [0x29] = {"i64.load", MA, 3},
    [0x2A] = {"f32.load", MA, 2},
    [0x2B] = {"f64.load", MA, 3},
    [0x2C] = {"i32.load8_s", MA, 0},
    [0x2D] = {"i32.load8_u", MA, 0},
    [0x2E] = {"i32.load16_s", MA, 1},
    [0x2F] = {"i32.load16_u", MA, 1},
    [0x30] = {"i64.load8_s", MA, 0},
    [0x31] = {"i64.load8_u", MA, 0},
    [0x32] = {"i64.load16_s", MA, 1},
    [0x33] = {"i64.load16_u", MA, 1},
    [0x34] = {"i64.load32_s", MA, 2},
    [0x35] = {"i64.load32_u", MA, 2},
    /* memory store */
    [0x36] = {"i32.store", MA, 2},
    [0x37] = {"i64.store", MA, 3},
    [0x38] = {"f32.store", MA, 2},
    [0x39] = {"f64.store", MA, 3},
    [0x3A] = {"i32.store8", MA, 0},
    [0x3B] = {"i32.store16", MA, 1},
    [0x3C] = {"i64.store8", MA, 0},
    [0x3D] = {"i64.store16", MA, 1},
    [0x3E] = {"i64.store32", MA, 2},
    /* memory */
    [0x3F] = {"memory.size", MB, 0},
    [0x40] = {"memory.grow", MB, 0},
    /* const */
    [0x41] = {"i32.const", I4, 0},
    [0x42] = {"i64.const", I8, 0},
    [0x43] = {"f32.const", F4, 0},
    [0x44] = {"f64.const", F8, 0},
    /* i32 comparison */
    [0x45] = {"i32.eqz", N, 0},
    [0x46] = {"i32.eq", N, 0},
    [0x47] = {"i32.ne", N, 0},
    [0x48] = {"i32.lt_s", N, 0},
    [0x49] = {"i32.lt_u", N, 0},
    [0x4A] = {"i32.gt_s", N, 0},
    [0x4B] = {"i32.gt_u", N, 0},
    [0x4C] = {"i32.le_s", N, 0},
    [0x4D] = {"i32.le_u", N, 0},
    [0x4E] = {"i32.ge_s", N, 0},
    [0x4F] = {"i32.ge_u", N, 0},
    /* i64 comparison */
    [0x50] = {"i64.eqz", N, 0},
    [0x51] = {"i64.eq", N, 0},
    [0x52] = {"i64.ne", N, 0},
    [0x53] = {"i64.lt_s", N, 0},
    [0x54] = {"i64.lt_u", N, 0},
    [0x55] = {"i64.gt_s", N, 0},
    [0x56] = {"i64.gt_u", N, 0},
    [0x57] = {"i64.le_s", N, 0},
    [0x58] = {"i64.le_u", N, 0},
    [0x59] = {"i64.ge_s", N, 0},
    [0x5A] = {"i64.ge_u", N, 0},
    /* f32 comparison */
    [0x5B] = {"f32.eq", N, 0},
    [0x5C] = {"f32.ne", N, 0},
    [0x5D] = {"f32.lt", N, 0},
    [0x5E] = {"f32.gt", N, 0},
    [0x5F] = {"f32.le", N, 0},
    [0x60] = {"f32.ge", N, 0},
    /* f64 comparison */
    [0x61] = {"f64.eq", N, 0},
    [0x62] = {"f64.ne", N, 0},
    [0x63] = {"f64.lt", N, 0},
    [0x64] = {"f64.gt", N, 0},
    [0x65] = {"f64.le", N, 0},
    [0x66] = {"f64.ge", N, 0},
    /* i32 arithmetic */
    [0x67] = {"i32.clz", N, 0},
    [0x68] = {"i32.ctz", N, 0},
    [0x69] = {"i32.popcnt", N, 0},
    [0x6A] = {"i32.add", N, 0},
    [0x6B] = {"i32.sub", N, 0},
    [0x6C] = {"i32.mul", N, 0},
    [0x6D] = {"i32.div_s", N, 0},
    [0x6E] = {"i32.div_u", N, 0},
    [0x6F] = {"i32.rem_s", N, 0},
    [0x70] = {"i32.rem_u", N, 0},
    [0x71] = {"i32.and", N, 0},
    [0x72] = {"i32.or", N, 0},
    [0x73] = {"i32.xor", N, 0},
    [0x74] = {"i32.shl", N, 0},
    [0x75] = {"i32.shr_s", N, 0},
    [0x76] = {"i32.shr_u", N, 0},
    [0x77] = {"i32.rotl", N, 0},
    [0x78] = {"i32.rotr", N, 0},
    /* i64 arithmetic */
    [0x79] = {"i64.clz", N, 0},
    [0x7A] = {"i64.ctz", N, 0},
    [0x7B] = {"i64.popcnt", N, 0},
    [0x7C] = {"i64.add", N, 0},
    [0x7D] = {"i64.sub", N, 0},
    [0x7E] = {"i64.mul", N, 0},
    [0x7F] = {"i64.div_s", N, 0},
    [0x80] = {"i64.div_u", N, 0},
    [0x81] = {"i64.rem_s", N, 0},
    [0x82] = {"i64.rem_u", N, 0},
    [0x83] = {"i64.and", N, 0},
    [0x84] = {"i64.or", N, 0},
    [0x85] = {"i64.xor", N, 0},
    [0x86] = {"i64.shl", N, 0},
    [0x87] = {"i64.shr_s", N, 0},
    [0x88] = {"i64.shr_u", N, 0},
    [0x89] = {"i64.rotl", N, 0},
    [0x8A] = {"i64.rotr", N, 0},
    /* f32 */
    [0x8B] = {"f32.abs", N, 0},
    [0x8C] = {"f32.neg", N, 0},
    [0x8D] = {"f32.ceil", N, 0},
    [0x8E] = {"f32.floor", N, 0},
    [0x8F] = {"f32.trunc", N, 0},
    [0x90] = {"f32.nearest", N, 0},
    [0x91] = {"f32.sqrt", N, 0},
    [0x92] = {"f32.add", N, 0},
    [0x93] = {"f32.sub", N, 0},
    [0x94] = {"f32.mul", N, 0},
    [0x95] = {"f32.div", N, 0},
    [0x96] = {"f32.min", N, 0},
    [0x97] = {"f32.max", N, 0},
    [0x98] = {"f32.copysign", N, 0},
    /* f64 */
    [0x99] = {"f64.abs", N, 0},
    [0x9A] = {"f64.neg", N, 0},
    [0x9B] = {"f64.ceil", N, 0},
    [0x9C] = {"f64.floor", N, 0},
    [0x9D] = {"f64.trunc", N, 0},
    [0x9E] = {"f64.nearest", N, 0},
    [0x9F] = {"f64.sqrt", N, 0},
    [0xA0] = {"f64.add", N, 0},
    [0xA1] = {"f64.sub", N, 0},
    [0xA2] = {"f64.mul", N, 0},
    [0xA3] = {"f64.div", N, 0},
    [0xA4] = {"f64.min", N, 0},
    [0xA5] = {"f64.max", N, 0},
    [0xA6] = {"f64.copysign", N, 0},
    /* conversions */
    [0xA7] = {"i32.wrap_i64", N, 0},
    [0xA8] = {"i32.trunc_f32_s", N, 0},
    [0xA9] = {"i32.trunc_f32_u", N, 0},
    [0xAA] = {"i32.trunc_f64_s", N, 0},
    [0xAB] = {"i32.trunc_f64_u", N, 0},
    [0xAC] = {"i64.extend_i32_s", N, 0},
    [0xAD] = {"i64.extend_i32_u", N, 0},
    [0xAE] = {"i64.trunc_f32_s", N, 0},
    [0xAF] = {"i64.trunc_f32_u", N, 0},
    [0xB0] = {"i64.trunc_f64_s", N, 0},
    [0xB1] = {"i64.trunc_f64_u", N, 0},
    [0xB2] = {"f32.convert_i32_s", N, 0},
    [0xB3] = {"f32.convert_i32_u", N, 0},
    [0xB4] = {"f32.convert_i64_s", N, 0},
    [0xB5] = {"f32.convert_i64_u", N, 0},
    [0xB6] = {"f32.demote_f64", N, 0},
    [0xB7] = {"f64.convert_i32_s", N, 0},
    [0xB8] = {"f64.convert_i32_u", N, 0},
    [0xB9] = {"f64.convert_i64_s", N, 0},
    [0xBA] = {"f64.convert_i64_u", N, 0},
    [0xBB] = {"f64.promote_f32", N, 0},
    [0xBC] = {"i32.reinterpret_f32", N, 0},
    [0xBD] = {"i64.reinterpret_f64", N, 0},
    [0xBE] = {"f32.reinterpret_i32", N, 0},
    [0xBF] = {"f64.reinterpret_i64", N, 0},
    /* sign extension */
    [0xC0] = {"i32.extend8_s", N, 0},
    [0xC1] = {"i32.extend16_s", N, 0},
    [0xC2] = {"i64.extend8_s", N, 0},
    [0xC3] = {"i64.extend16_s", N, 0},
    [0xC4] = {"i64.extend32_s", N, 0},
    /* reference types */
    [0xD0] = {"ref.null", RT, 0},
    [0xD1] = {"ref.is_null", N, 0},
    [0xD2] = {"ref.func", IX, 0},
};

static void dis_fc(const WasmModule *mod, Reader *r) {
    uint32_t sub = read_leb_u32(r);
    (void)mod;
    switch (sub) {
    case 0: printf("i32.trunc_sat_f32_s"); break;
    case 1: printf("i32.trunc_sat_f32_u"); break;
    case 2: printf("i32.trunc_sat_f64_s"); break;
    case 3: printf("i32.trunc_sat_f64_u"); break;
    case 4: printf("i64.trunc_sat_f32_s"); break;
    case 5: printf("i64.trunc_sat_f32_u"); break;
    case 6: printf("i64.trunc_sat_f64_s"); break;
    case 7: printf("i64.trunc_sat_f64_u"); break;
    case 8: {
        uint32_t seg = read_leb_u32(r);
        read_byte(r);
        printf("memory.init %u", seg);
        break;
    }
    case 9: printf("data.drop %u", read_leb_u32(r)); break;
    case 10: read_byte(r); read_byte(r); printf("memory.copy"); break;
    case 11: read_byte(r); printf("memory.fill"); break;
    case 12: {
        uint32_t seg = read_leb_u32(r);
        uint32_t tab = read_leb_u32(r);
        printf("table.init %u %u", seg, tab);
        break;
    }
    case 13: printf("elem.drop %u", read_leb_u32(r)); break;
    case 14: {
        uint32_t dst = read_leb_u32(r);
        uint32_t src = read_leb_u32(r);
        printf("table.copy %u %u", dst, src);
        break;
    }
    case 15: printf("table.grow %u", read_leb_u32(r)); break;
    case 16: printf("table.size %u", read_leb_u32(r)); break;
    case 17: printf("table.fill %u", read_leb_u32(r)); break;
    default: printf("<unknown 0xfc %u>", sub); break;
    }
}

static void dis_insn(const WasmModule *mod, Reader *r, uint8_t op) {
    const Op *o = &ops[op];
    if (!o->name) {
        printf("<unknown 0x%02x>", op);
        return;
    }
    printf("%s", o->name);
    switch (o->imm) {
    case N: break;
    case BT: {
        int32_t bt = read_leb_i32(r);
        if (bt >= 0)
            printf(" type[%d]", bt);
        else {
            uint8_t vt = (uint8_t)(bt & 0x7F);
            if (vt != 0x40)
                printf(" (result %s)", wasm_valtype(vt));
        }
        break;
    }
    case IX: {
        uint32_t idx = read_leb_u32(r);
        const char *name = NULL;
        if (op == 0x10 || op == 0xD2)
            name = wasm_func_name(mod, idx);
        else if (op == 0x23 || op == 0x24)
            name = wasm_global_name(mod, idx);
        if (name)
            printf(" %u <%s>", idx, name);
        else
            printf(" %u", idx);
        break;
    }
    case BR: {
        uint32_t count = read_leb_u32(r);
        uint32_t i;
        for (i = 0; i <= count; i++)
            printf(" %u", read_leb_u32(r));
        break;
    }
    case CI: {
        uint32_t type_idx = read_leb_u32(r);
        uint32_t table_idx = read_leb_u32(r);
        printf(" type[%u]", type_idx);
        if (table_idx != 0)
            printf(" table[%u]", table_idx);
        break;
    }
    case MA: {
        uint32_t align = read_leb_u32(r);
        uint32_t offset = read_leb_u32(r);
        if (align != o->align)
            printf(" align=%u", 1u << align);
        if (offset)
            printf(" offset=%u", offset);
        break;
    }
    case I4: printf(" %d", read_leb_i32(r)); break;
    case I8: printf(" %lld", (long long)read_leb_i64(r)); break;
    case F4: printf(" %g", (double)read_f32(r)); break;
    case F8: printf(" %g", read_f64(r)); break;
    case MB: read_byte(r); break;
    case RT: printf(" %s", wasm_valtype(read_byte(r))); break;
    case ST: {
        uint32_t count = read_leb_u32(r);
        uint32_t i;
        for (i = 0; i < count; i++)
            printf(" %s", wasm_valtype(read_byte(r)));
        break;
    }
    }
}

/* ---- print_headers ---- */

void print_headers(const WasmModule *mod, const char *filter) {
    uint32_t i;
    printf("\nSections:\n\n");
    for (i = 0; i < mod->section_count; i++) {
        const Section *s = &mod->sections[i];
        const char *name;
        uint32_t count = 0;
        int has_count = 1;
        if (!sec_match(s, filter)) continue;
        name = (s->id == SEC_CUSTOM && s->custom_name) ? s->custom_name : wasm_section_name(s->id);
        switch (s->id) {
        case SEC_TYPE: count = mod->type_count; break;
        case SEC_IMPORT: count = mod->import_count; break;
        case SEC_FUNCTION: count = mod->func_count; break;
        case SEC_TABLE: count = mod->table_count; break;
        case SEC_MEMORY: count = mod->memory_count; break;
        case SEC_GLOBAL: count = mod->global_count; break;
        case SEC_EXPORT: count = mod->export_count; break;
        case SEC_ELEMENT: count = mod->elem_count; break;
        case SEC_CODE: count = mod->code_count; break;
        case SEC_DATA: count = mod->data_count; break;
        default: has_count = 0; break;
        }
        printf("%10s start=0x%08x end=0x%08x (size=0x%08x)", name, s->offset, s->offset + s->size, s->size);
        if (has_count) printf(" count: %u", count);
        printf("\n");
    }
}

/* ---- print_details ---- */

void print_details(const WasmModule *mod, const char *filter) {
    uint32_t si, i;
    printf("\nSection Details:\n");

    for (si = 0; si < mod->section_count; si++) {
        const Section *sec = &mod->sections[si];
        if (!sec_match(sec, filter)) continue;

        switch (sec->id) {
        case SEC_TYPE:
            printf("\nType[%u]:\n", mod->type_count);
            for (i = 0; i < mod->type_count; i++) {
                printf(" - type[%u] ", i);
                print_sig(&mod->types[i]);
                printf("\n");
            }
            break;

        case SEC_IMPORT: {
            uint32_t fi = 0, ti = 0, mi = 0, gi = 0;
            printf("\nImport[%u]:\n", mod->import_count);
            for (i = 0; i < mod->import_count; i++) {
                const Import *im = &mod->imports[i];
                switch (im->kind) {
                case EXT_FUNC:
                    printf(" - func[%u] sig=%u <%s.%s>\n", fi++, im->func_type, im->module, im->name);
                    break;
                case EXT_TABLE:
                    printf(" - table[%u] type=%s initial=%u", ti++, wasm_valtype(im->table.elem_type), im->table.initial);
                    if (im->table.has_max) printf(" max=%u", im->table.maximum);
                    printf(" <- %s.%s\n", im->module, im->name);
                    break;
                case EXT_MEMORY:
                    printf(" - memory[%u] initial=%u", mi++, im->memory.initial);
                    if (im->memory.has_max) printf(" max=%u", im->memory.maximum);
                    printf(" <- %s.%s\n", im->module, im->name);
                    break;
                case EXT_GLOBAL:
                    printf(" - global[%u] %s %s <- %s.%s\n", gi++,
                           wasm_valtype(im->global.val_type),
                           im->global.mutable_ ? "mut" : "const",
                           im->module, im->name);
                    break;
                }
            }
            break;
        }

        case SEC_FUNCTION:
            printf("\nFunction[%u]:\n", mod->func_count);
            for (i = 0; i < mod->func_count; i++) {
                uint32_t fidx = mod->num_func_imports + i;
                const char *name = wasm_func_name(mod, fidx);
                printf(" - func[%u] sig=%u", fidx, mod->func_types[i]);
                if (name) printf(" <%s>", name);
                printf("\n");
            }
            break;

        case SEC_TABLE:
            printf("\nTable[%u]:\n", mod->table_count);
            for (i = 0; i < mod->table_count; i++) {
                uint32_t tidx = mod->num_table_imports + i;
                printf(" - table[%u] type=%s initial=%u", tidx, wasm_valtype(mod->tables[i].elem_type), mod->tables[i].initial);
                if (mod->tables[i].has_max) printf(" max=%u", mod->tables[i].maximum);
                printf("\n");
            }
            break;

        case SEC_MEMORY:
            printf("\nMemory[%u]:\n", mod->memory_count);
            for (i = 0; i < mod->memory_count; i++) {
                uint32_t midx = mod->num_memory_imports + i;
                printf(" - memory[%u] pages: initial=%u", midx, mod->memories[i].initial);
                if (mod->memories[i].has_max) printf(" max=%u", mod->memories[i].maximum);
                printf("\n");
            }
            break;

        case SEC_GLOBAL:
            printf("\nGlobal[%u]:\n", mod->global_count);
            for (i = 0; i < mod->global_count; i++) {
                uint32_t gidx = mod->num_global_imports + i;
                const char *gname = wasm_global_name(mod, gidx);
                printf(" - global[%u] %s %s", gidx,
                       wasm_valtype(mod->globals[i].val_type),
                       mod->globals[i].mutable_ ? "mut" : "const");
                if (gname) printf(" <%s>", gname);
                printf("\n");
            }
            break;

        case SEC_EXPORT:
            printf("\nExport[%u]:\n", mod->export_count);
            for (i = 0; i < mod->export_count; i++) {
                const Export *ex = &mod->exports[i];
                printf(" - %s[%u] -> \"%s\"\n", wasm_kind_name(ex->kind), ex->index, ex->name);
            }
            break;

        case SEC_START: {
            const char *name = wasm_func_name(mod, mod->start_func);
            printf("\nStart:\n");
            printf(" - func[%u]", mod->start_func);
            if (name) printf(" <%s>", name);
            printf("\n");
            break;
        }

        case SEC_ELEMENT: {
            Reader er;
            uint32_t count, j;
            reader_init(&er, mod->raw + sec->offset, sec->size);
            count = read_leb_u32(&er);
            printf("\nElement[%u]:\n", count);
            for (j = 0; j < count; j++) {
                uint32_t flags = read_leb_u32(&er);
                uint32_t elem_count, k;
                printf(" - segment[%u] ", j);
                switch (flags) {
                case 0:
                    skip_init_expr(&er);
                    elem_count = read_leb_u32(&er);
                    printf("active table=0 count=%u\n", elem_count);
                    for (k = 0; k < elem_count; k++) read_leb_u32(&er);
                    break;
                case 1:
                    read_byte(&er);
                    elem_count = read_leb_u32(&er);
                    printf("passive count=%u\n", elem_count);
                    for (k = 0; k < elem_count; k++) read_leb_u32(&er);
                    break;
                case 2: {
                    uint32_t tab = read_leb_u32(&er);
                    skip_init_expr(&er);
                    read_byte(&er);
                    elem_count = read_leb_u32(&er);
                    printf("active table=%u count=%u\n", tab, elem_count);
                    for (k = 0; k < elem_count; k++) read_leb_u32(&er);
                    break;
                }
                case 3:
                    read_byte(&er);
                    elem_count = read_leb_u32(&er);
                    printf("declarative count=%u\n", elem_count);
                    for (k = 0; k < elem_count; k++) read_leb_u32(&er);
                    break;
                case 4:
                    skip_init_expr(&er);
                    elem_count = read_leb_u32(&er);
                    printf("active table=0 count=%u\n", elem_count);
                    for (k = 0; k < elem_count; k++) skip_init_expr(&er);
                    break;
                case 5:
                    read_byte(&er);
                    elem_count = read_leb_u32(&er);
                    printf("passive count=%u\n", elem_count);
                    for (k = 0; k < elem_count; k++) skip_init_expr(&er);
                    break;
                case 6: {
                    uint32_t tab = read_leb_u32(&er);
                    skip_init_expr(&er);
                    read_byte(&er);
                    elem_count = read_leb_u32(&er);
                    printf("active table=%u count=%u\n", tab, elem_count);
                    for (k = 0; k < elem_count; k++) skip_init_expr(&er);
                    break;
                }
                case 7:
                    read_byte(&er);
                    elem_count = read_leb_u32(&er);
                    printf("declarative count=%u\n", elem_count);
                    for (k = 0; k < elem_count; k++) skip_init_expr(&er);
                    break;
                default:
                    printf("flags=0x%x\n", flags);
                    j = count;
                    break;
                }
            }
            break;
        }

        case SEC_DATA: {
            Reader dr;
            uint32_t count, j;
            reader_init(&dr, mod->raw + sec->offset, sec->size);
            count = read_leb_u32(&dr);
            printf("\nData[%u]:\n", count);
            for (j = 0; j < count; j++) {
                uint32_t flags = read_leb_u32(&dr);
                uint32_t sz;
                printf(" - segment[%u] ", j);
                if (flags == 0) {
                    skip_init_expr(&dr);
                    sz = read_leb_u32(&dr);
                    printf("memory=0 size=%u\n", sz);
                    reader_skip(&dr, sz);
                } else if (flags == 1) {
                    sz = read_leb_u32(&dr);
                    printf("passive size=%u\n", sz);
                    reader_skip(&dr, sz);
                } else if (flags == 2) {
                    uint32_t mem = read_leb_u32(&dr);
                    skip_init_expr(&dr);
                    sz = read_leb_u32(&dr);
                    printf("memory=%u size=%u\n", mem, sz);
                    reader_skip(&dr, sz);
                } else {
                    printf("flags=0x%x\n", flags);
                    break;
                }
            }
            break;
        }

        case SEC_DATACOUNT:
            printf("\nDataCount:\n");
            printf(" - count: %u\n", mod->data_count);
            break;

        case SEC_CUSTOM:
            printf("\nCustom \"%s\":\n", sec->custom_name ? sec->custom_name : "");
            printf(" - size: %u bytes\n", sec->size);
            if (sec->custom_name && strcmp(sec->custom_name, "name") == 0) {
                if (mod->names.module_name)
                    printf(" - module: \"%s\"\n", mod->names.module_name);
                if (mod->names.func_name_count)
                    printf(" - %u function names\n", mod->names.func_name_count);
                if (mod->names.global_name_count)
                    printf(" - %u global names\n", mod->names.global_name_count);
            }
            break;
        }
    }
}

/* ---- print_disasm ---- */

void print_disasm(const WasmModule *mod, const char *filter) {
    uint32_t i;

    if (filter && strcmp(filter, "Code") != 0) return;

    printf("\nCode Disassembly:\n");

    for (i = 0; i < mod->code_count; i++) {
        const Code *code = &mod->codes[i];
        uint32_t func_idx = mod->num_func_imports + i;
        const char *name = wasm_func_name(mod, func_idx);
        Reader dr;
        int indent = 1;

        printf("\n%06x func[%u]", code->func_offset, func_idx);
        if (name) printf(" <%s>", name);
        if (i < mod->func_count) {
            uint32_t ti = mod->func_types[i];
            if (ti < mod->type_count) {
                printf(" ");
                print_sig(&mod->types[ti]);
            }
        }
        printf(":\n");

        if (code->total_locals > 0) {
            uint32_t j, k;
            printf(" ; %u locals:", code->total_locals);
            for (j = 0; j < code->local_decl_count; j++)
                for (k = 0; k < code->locals[j].count; k++)
                    printf(" %s", wasm_valtype(code->locals[j].type));
            printf("\n");
        }

        reader_init(&dr, mod->raw + code->body_offset, code->body_size);
        while (!reader_eof(&dr)) {
            uint32_t off = code->body_offset + (uint32_t)dr.pos;
            uint8_t op = read_byte(&dr);

            if (op == 0xFD || op == 0xFE) {
                printf(" %06x: <0x%02x prefix not yet supported>\n", off, op);
                break;
            }

            if (op == 0x0B || op == 0x05) {
                if (indent > 1) indent--;
            }

            printf(" %06x:%*s", off, indent * 2, "");

            if (op == 0xFC) {
                dis_fc(mod, &dr);
            } else {
                dis_insn(mod, &dr, op);
            }
            printf("\n");

            if (op == 0x02 || op == 0x03 || op == 0x04 || op == 0x05) {
                indent++;
            }
        }
    }
}

/* ---- print_hexdump ---- */

static void hexdump(const uint8_t *data, uint32_t offset, uint32_t size) {
    uint32_t i, j, n;
    for (i = 0; i < size; i += 16) {
        n = size - i;
        if (n > 16) n = 16;
        printf("%08x: ", offset + i);
        for (j = 0; j < 16; j++) {
            if (j < n) printf("%02x", data[i + j]);
            else printf("  ");
            if (j % 2 == 1) printf(" ");
        }
        printf(" ");
        for (j = 0; j < n; j++) {
            uint8_t c = data[i + j];
            printf("%c", (c >= 0x20 && c < 0x7F) ? c : '.');
        }
        printf("\n");
    }
}

void print_hexdump(const WasmModule *mod, const char *filter) {
    uint32_t i;
    for (i = 0; i < mod->section_count; i++) {
        const Section *s = &mod->sections[i];
        const char *name;
        if (!sec_match(s, filter)) continue;
        name = (s->id == SEC_CUSTOM && s->custom_name) ? s->custom_name : wasm_section_name(s->id);
        printf("\nContents of section %s:\n", name);
        hexdump(mod->raw + s->offset, s->offset, s->size);
    }
}
