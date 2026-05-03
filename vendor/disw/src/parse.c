#include "wasm.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void reader_init(Reader *r, const uint8_t *data, size_t size) {
    r->data = data;
    r->size = size;
    r->pos = 0;
}

int reader_eof(const Reader *r) {
    return r->pos >= r->size;
}

uint8_t read_byte(Reader *r) {
    if (r->pos >= r->size) {
        fprintf(stderr, "disw: unexpected end of data at 0x%zx\n", r->pos);
        exit(1);
    }
    return r->data[r->pos++];
}

uint32_t read_u32(Reader *r) {
    uint8_t a = read_byte(r);
    uint8_t b = read_byte(r);
    uint8_t c = read_byte(r);
    uint8_t d = read_byte(r);
    return a | ((uint32_t)b << 8) | ((uint32_t)c << 16) | ((uint32_t)d << 24);
}

uint32_t read_leb_u32(Reader *r) {
    uint32_t result = 0;
    int shift = 0;
    uint8_t b;
    do {
        b = read_byte(r);
        result |= (uint32_t)(b & 0x7F) << shift;
        shift += 7;
    } while (b & 0x80);
    return result;
}

int32_t read_leb_i32(Reader *r) {
    int32_t result = 0;
    int shift = 0;
    uint8_t b;
    do {
        b = read_byte(r);
        result |= (int32_t)(b & 0x7F) << shift;
        shift += 7;
    } while (b & 0x80);
    if (shift < 32 && (b & 0x40))
        result |= -(1 << shift);
    return result;
}

int64_t read_leb_i64(Reader *r) {
    int64_t result = 0;
    int shift = 0;
    uint8_t b;
    do {
        b = read_byte(r);
        result |= (int64_t)(b & 0x7F) << shift;
        shift += 7;
    } while (b & 0x80);
    if (shift < 64 && (b & 0x40))
        result |= -(1LL << shift);
    return result;
}

float read_f32(Reader *r) {
    union { uint32_t i; float f; } u;
    u.i = read_u32(r);
    return u.f;
}

double read_f64(Reader *r) {
    union { uint64_t i; double f; } u;
    uint32_t lo = read_u32(r);
    uint32_t hi = read_u32(r);
    u.i = (uint64_t)lo | ((uint64_t)hi << 32);
    return u.f;
}

char *read_name(Reader *r) {
    uint32_t len = read_leb_u32(r);
    char *s = malloc(len + 1);
    for (uint32_t i = 0; i < len; i++)
        s[i] = (char)read_byte(r);
    s[len] = '\0';
    return s;
}

void reader_skip(Reader *r, uint32_t n) {
    if (r->pos + n > r->size) {
        fprintf(stderr, "disw: unexpected end at 0x%zx (skip %u)\n", r->pos, n);
        exit(1);
    }
    r->pos += n;
}

void skip_init_expr(Reader *r) {
    while (1) {
        uint8_t op = read_byte(r);
        if (op == 0x0B) return;
        switch (op) {
        case 0x41: read_leb_i32(r); break;
        case 0x42: read_leb_i64(r); break;
        case 0x43: reader_skip(r, 4); break;
        case 0x44: reader_skip(r, 8); break;
        case 0x23: read_leb_u32(r); break;
        case 0xD0: read_byte(r); break;
        case 0xD2: read_leb_u32(r); break;
        default: break;
        }
    }
}

const char *wasm_valtype(uint8_t t) {
    switch (t) {
    case VAL_I32: return "i32";
    case VAL_I64: return "i64";
    case VAL_F32: return "f32";
    case VAL_F64: return "f64";
    case VAL_FUNCREF: return "funcref";
    case VAL_EXTERNREF: return "externref";
    default: return "?";
    }
}

const char *wasm_section_name(uint8_t id) {
    switch (id) {
    case 0: return "Custom";
    case 1: return "Type";
    case 2: return "Import";
    case 3: return "Function";
    case 4: return "Table";
    case 5: return "Memory";
    case 6: return "Global";
    case 7: return "Export";
    case 8: return "Start";
    case 9: return "Element";
    case 10: return "Code";
    case 11: return "Data";
    case 12: return "DataCount";
    default: return "Unknown";
    }
}

const char *wasm_kind_name(uint8_t kind) {
    switch (kind) {
    case 0: return "func";
    case 1: return "table";
    case 2: return "memory";
    case 3: return "global";
    default: return "?";
    }
}

const char *wasm_func_name(const WasmModule *mod, uint32_t idx) {
    uint32_t i;
    for (i = 0; i < mod->names.func_name_count; i++)
        if (mod->names.func_names[i].index == idx)
            return mod->names.func_names[i].name;
    for (i = 0; i < mod->export_count; i++)
        if (mod->exports[i].kind == EXT_FUNC && mod->exports[i].index == idx)
            return mod->exports[i].name;
    if (idx < mod->num_func_imports) {
        uint32_t fi = 0;
        for (i = 0; i < mod->import_count; i++) {
            if (mod->imports[i].kind == EXT_FUNC) {
                if (fi == idx) return mod->imports[i].name;
                fi++;
            }
        }
    }
    return NULL;
}

const char *wasm_local_name(const WasmModule *mod, uint32_t func_idx, uint32_t local_idx) {
    uint32_t i, j;
    for (i = 0; i < mod->names.local_name_count; i++) {
        if (mod->names.local_names[i].func_index == func_idx) {
            for (j = 0; j < mod->names.local_names[i].local_count; j++) {
                if (mod->names.local_names[i].locals[j].index == local_idx)
                    return mod->names.local_names[i].locals[j].name;
            }
            return NULL;
        }
    }
    return NULL;
}

const char *wasm_global_name(const WasmModule *mod, uint32_t idx) {
    uint32_t i;
    for (i = 0; i < mod->names.global_name_count; i++)
        if (mod->names.global_names[i].index == idx)
            return mod->names.global_names[i].name;
    for (i = 0; i < mod->export_count; i++)
        if (mod->exports[i].kind == EXT_GLOBAL && mod->exports[i].index == idx)
            return mod->exports[i].name;
    return NULL;
}

static void parse_limits(Reader *r, uint32_t *initial, uint32_t *maximum, int *has_max) {
    uint8_t flags = read_byte(r);
    *initial = read_leb_u32(r);
    *has_max = flags & 1;
    *maximum = *has_max ? read_leb_u32(r) : 0;
}

int wasm_parse(WasmModule *mod, const uint8_t *data, size_t size) {
    Reader r;
    uint32_t i, j, cap;

    memset(mod, 0, sizeof(*mod));
    mod->raw = data;
    mod->raw_size = size;
    reader_init(&r, data, size);

    if (size < 8) {
        fprintf(stderr, "disw: file too small\n");
        return -1;
    }

    if (read_u32(&r) != 0x6D736100) {
        fprintf(stderr, "disw: not a wasm file\n");
        return -1;
    }
    mod->version = read_u32(&r);

    /* First pass: scan sections */
    cap = 16;
    mod->sections = malloc(cap * sizeof(Section));
    while (!reader_eof(&r)) {
        Section *s;
        if (mod->section_count >= cap) {
            cap *= 2;
            mod->sections = realloc(mod->sections, cap * sizeof(Section));
        }
        s = &mod->sections[mod->section_count++];
        s->custom_name = NULL;
        s->id = read_byte(&r);
        s->size = read_leb_u32(&r);
        s->offset = (uint32_t)r.pos;
        if (s->id == SEC_CUSTOM) {
            s->custom_name = read_name(&r);
        }
        r.pos = s->offset + s->size;
    }

    /* Second pass: parse each section */
    for (i = 0; i < mod->section_count; i++) {
        Section *s = &mod->sections[i];
        r.pos = s->offset;

        switch (s->id) {
        case SEC_TYPE:
            mod->type_count = read_leb_u32(&r);
            mod->types = calloc(mod->type_count, sizeof(FuncType));
            for (j = 0; j < mod->type_count; j++) {
                FuncType *ft = &mod->types[j];
                read_byte(&r);
                ft->param_count = read_leb_u32(&r);
                ft->params = ft->param_count ? malloc(ft->param_count) : NULL;
                { uint32_t k; for (k = 0; k < ft->param_count; k++) ft->params[k] = read_byte(&r); }
                ft->result_count = read_leb_u32(&r);
                ft->results = ft->result_count ? malloc(ft->result_count) : NULL;
                { uint32_t k; for (k = 0; k < ft->result_count; k++) ft->results[k] = read_byte(&r); }
            }
            break;

        case SEC_IMPORT:
            mod->import_count = read_leb_u32(&r);
            mod->imports = calloc(mod->import_count, sizeof(Import));
            for (j = 0; j < mod->import_count; j++) {
                Import *im = &mod->imports[j];
                im->module = read_name(&r);
                im->name = read_name(&r);
                im->kind = read_byte(&r);
                switch (im->kind) {
                case EXT_FUNC:
                    im->func_type = read_leb_u32(&r);
                    mod->num_func_imports++;
                    break;
                case EXT_TABLE:
                    im->table.elem_type = read_byte(&r);
                    parse_limits(&r, &im->table.initial, &im->table.maximum, &im->table.has_max);
                    mod->num_table_imports++;
                    break;
                case EXT_MEMORY:
                    parse_limits(&r, &im->memory.initial, &im->memory.maximum, &im->memory.has_max);
                    mod->num_memory_imports++;
                    break;
                case EXT_GLOBAL:
                    im->global.val_type = read_byte(&r);
                    im->global.mutable_ = read_byte(&r);
                    mod->num_global_imports++;
                    break;
                }
            }
            break;

        case SEC_FUNCTION:
            mod->func_count = read_leb_u32(&r);
            mod->func_types = malloc(mod->func_count * sizeof(uint32_t));
            for (j = 0; j < mod->func_count; j++)
                mod->func_types[j] = read_leb_u32(&r);
            break;

        case SEC_TABLE:
            mod->table_count = read_leb_u32(&r);
            mod->tables = calloc(mod->table_count, sizeof(Table));
            for (j = 0; j < mod->table_count; j++) {
                mod->tables[j].elem_type = read_byte(&r);
                parse_limits(&r, &mod->tables[j].initial, &mod->tables[j].maximum, &mod->tables[j].has_max);
            }
            break;

        case SEC_MEMORY:
            mod->memory_count = read_leb_u32(&r);
            mod->memories = calloc(mod->memory_count, sizeof(Memory));
            for (j = 0; j < mod->memory_count; j++)
                parse_limits(&r, &mod->memories[j].initial, &mod->memories[j].maximum, &mod->memories[j].has_max);
            break;

        case SEC_GLOBAL:
            mod->global_count = read_leb_u32(&r);
            mod->globals = calloc(mod->global_count, sizeof(Global));
            for (j = 0; j < mod->global_count; j++) {
                mod->globals[j].val_type = read_byte(&r);
                mod->globals[j].mutable_ = read_byte(&r);
                mod->globals[j].init_offset = (uint32_t)r.pos;
                skip_init_expr(&r);
                mod->globals[j].init_size = (uint32_t)r.pos - mod->globals[j].init_offset;
            }
            break;

        case SEC_EXPORT:
            mod->export_count = read_leb_u32(&r);
            mod->exports = calloc(mod->export_count, sizeof(Export));
            for (j = 0; j < mod->export_count; j++) {
                mod->exports[j].name = read_name(&r);
                mod->exports[j].kind = read_byte(&r);
                mod->exports[j].index = read_leb_u32(&r);
            }
            break;

        case SEC_START:
            mod->has_start = 1;
            mod->start_func = read_leb_u32(&r);
            break;

        case SEC_CODE:
            mod->code_count = read_leb_u32(&r);
            mod->codes = calloc(mod->code_count, sizeof(Code));
            for (j = 0; j < mod->code_count; j++) {
                Code *c = &mod->codes[j];
                uint32_t body_size = read_leb_u32(&r);
                size_t body_start = r.pos;
                uint32_t k;
                c->func_offset = (uint32_t)body_start;
                c->local_decl_count = read_leb_u32(&r);
                c->locals = c->local_decl_count ? calloc(c->local_decl_count, sizeof(LocalDecl)) : NULL;
                c->total_locals = 0;
                for (k = 0; k < c->local_decl_count; k++) {
                    c->locals[k].count = read_leb_u32(&r);
                    c->locals[k].type = read_byte(&r);
                    c->total_locals += c->locals[k].count;
                }
                c->body_offset = (uint32_t)r.pos;
                c->body_size = (uint32_t)(body_start + body_size - r.pos);
                r.pos = body_start + body_size;
            }
            break;

        case SEC_ELEMENT:
            mod->elem_count = read_leb_u32(&r);
            break;

        case SEC_DATA: {
            mod->data_count = read_leb_u32(&r);
            mod->data_segment_count = mod->data_count;
            mod->data_segments = mod->data_count ? calloc(mod->data_count, sizeof(DataSegment)) : NULL;
            for (j = 0; j < mod->data_count; j++) {
                DataSegment *ds = &mod->data_segments[j];
                ds->flags = read_leb_u32(&r);
                if (ds->flags == 0) {
                    ds->init_offset = (uint32_t)r.pos;
                    /* Try to recognize i32.const N end (0x41 <leb> 0x0B) */
                    if (r.pos + 1 < r.size && r.data[r.pos] == 0x41) {
                        size_t saved = r.pos;
                        read_byte(&r);
                        ds->const_offset = read_leb_i32(&r);
                        if (r.pos < r.size && r.data[r.pos] == 0x0B) {
                            ds->has_const_offset = 1;
                            read_byte(&r);
                        } else {
                            r.pos = saved;
                            skip_init_expr(&r);
                        }
                    } else {
                        skip_init_expr(&r);
                    }
                    ds->init_size = (uint32_t)r.pos - ds->init_offset;
                    ds->data_size = read_leb_u32(&r);
                    ds->data_offset = (uint32_t)r.pos;
                    reader_skip(&r, ds->data_size);
                } else if (ds->flags == 1) {
                    ds->data_size = read_leb_u32(&r);
                    ds->data_offset = (uint32_t)r.pos;
                    reader_skip(&r, ds->data_size);
                } else if (ds->flags == 2) {
                    ds->mem_index = read_leb_u32(&r);
                    ds->init_offset = (uint32_t)r.pos;
                    if (r.pos + 1 < r.size && r.data[r.pos] == 0x41) {
                        size_t saved = r.pos;
                        read_byte(&r);
                        ds->const_offset = read_leb_i32(&r);
                        if (r.pos < r.size && r.data[r.pos] == 0x0B) {
                            ds->has_const_offset = 1;
                            read_byte(&r);
                        } else {
                            r.pos = saved;
                            skip_init_expr(&r);
                        }
                    } else {
                        skip_init_expr(&r);
                    }
                    ds->init_size = (uint32_t)r.pos - ds->init_offset;
                    ds->data_size = read_leb_u32(&r);
                    ds->data_offset = (uint32_t)r.pos;
                    reader_skip(&r, ds->data_size);
                } else {
                    /* unknown flag — bail on this section */
                    break;
                }
            }
            break;
        }

        case SEC_DATACOUNT:
            mod->data_count = read_leb_u32(&r);
            break;

        case SEC_CUSTOM:
            if (s->custom_name && strcmp(s->custom_name, "name") == 0) {
                uint32_t remaining;
                size_t end;
                read_name(&r);
                remaining = s->offset + s->size - (uint32_t)r.pos;
                end = r.pos + remaining;
                while (r.pos < end) {
                    uint8_t sub_id = read_byte(&r);
                    uint32_t sub_size = read_leb_u32(&r);
                    size_t sub_end = r.pos + sub_size;
                    if (sub_id == 0) {
                        mod->names.module_name = read_name(&r);
                    } else if (sub_id == 1) {
                        mod->names.func_name_count = read_leb_u32(&r);
                        mod->names.func_names = calloc(mod->names.func_name_count, sizeof(NameEntry));
                        for (j = 0; j < mod->names.func_name_count; j++) {
                            mod->names.func_names[j].index = read_leb_u32(&r);
                            mod->names.func_names[j].name = read_name(&r);
                        }
                    } else if (sub_id == 2) {
                        uint32_t fn_count = read_leb_u32(&r);
                        mod->names.local_name_count = fn_count;
                        mod->names.local_names = calloc(fn_count, sizeof(LocalNameGroup));
                        for (j = 0; j < fn_count; j++) {
                            uint32_t k;
                            mod->names.local_names[j].func_index = read_leb_u32(&r);
                            mod->names.local_names[j].local_count = read_leb_u32(&r);
                            mod->names.local_names[j].locals = calloc(mod->names.local_names[j].local_count, sizeof(NameEntry));
                            for (k = 0; k < mod->names.local_names[j].local_count; k++) {
                                mod->names.local_names[j].locals[k].index = read_leb_u32(&r);
                                mod->names.local_names[j].locals[k].name = read_name(&r);
                            }
                        }
                    } else if (sub_id == 7) {
                        mod->names.global_name_count = read_leb_u32(&r);
                        mod->names.global_names = calloc(mod->names.global_name_count, sizeof(NameEntry));
                        for (j = 0; j < mod->names.global_name_count; j++) {
                            mod->names.global_names[j].index = read_leb_u32(&r);
                            mod->names.global_names[j].name = read_name(&r);
                        }
                    }
                    r.pos = sub_end;
                }
            }
            break;
        }
    }

    return 0;
}

void wasm_free(WasmModule *mod) {
    uint32_t i;
    for (i = 0; i < mod->type_count; i++) {
        free(mod->types[i].params);
        free(mod->types[i].results);
    }
    free(mod->types);
    for (i = 0; i < mod->import_count; i++) {
        free(mod->imports[i].module);
        free(mod->imports[i].name);
    }
    free(mod->imports);
    free(mod->func_types);
    free(mod->tables);
    free(mod->memories);
    free(mod->globals);
    for (i = 0; i < mod->export_count; i++)
        free(mod->exports[i].name);
    free(mod->exports);
    for (i = 0; i < mod->code_count; i++)
        free(mod->codes[i].locals);
    free(mod->codes);
    free(mod->names.module_name);
    for (i = 0; i < mod->names.func_name_count; i++)
        free(mod->names.func_names[i].name);
    free(mod->names.func_names);
    for (i = 0; i < mod->names.local_name_count; i++) {
        uint32_t k;
        for (k = 0; k < mod->names.local_names[i].local_count; k++)
            free(mod->names.local_names[i].locals[k].name);
        free(mod->names.local_names[i].locals);
    }
    free(mod->names.local_names);
    for (i = 0; i < mod->names.global_name_count; i++)
        free(mod->names.global_names[i].name);
    free(mod->names.global_names);
    free(mod->data_segments);
    for (i = 0; i < mod->section_count; i++)
        free(mod->sections[i].custom_name);
    free(mod->sections);
}
