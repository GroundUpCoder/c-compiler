#ifndef DISW_WASM_H
#define DISW_WASM_H

#include <stdint.h>
#include <stddef.h>

#define SEC_CUSTOM    0
#define SEC_TYPE      1
#define SEC_IMPORT    2
#define SEC_FUNCTION  3
#define SEC_TABLE     4
#define SEC_MEMORY    5
#define SEC_GLOBAL    6
#define SEC_EXPORT    7
#define SEC_START     8
#define SEC_ELEMENT   9
#define SEC_CODE      10
#define SEC_DATA      11
#define SEC_DATACOUNT 12

#define VAL_I32       0x7F
#define VAL_I64       0x7E
#define VAL_F32       0x7D
#define VAL_F64       0x7C
#define VAL_I8        0x78    /* packed (struct field / array elem only) */
#define VAL_I16       0x77    /* packed (struct field / array elem only) */
#define VAL_FUNCREF   0x70
#define VAL_EXTERNREF 0x6F
#define VAL_ANYREF    0x6E
#define VAL_EQREF     0x6D
#define VAL_I31REF    0x6C
#define VAL_STRUCTREF 0x6B
#define VAL_ARRAYREF  0x6A
#define VAL_NULLFUNCREF   0x73
#define VAL_NULLEXTERNREF 0x72
#define VAL_NULLREF       0x71
#define VAL_REF       0x64
#define VAL_REFNULL   0x63

#define EXT_FUNC   0
#define EXT_TABLE  1
#define EXT_MEMORY 2
#define EXT_GLOBAL 3

typedef struct {
    const uint8_t *data;
    size_t size;
    size_t pos;
} Reader;

typedef struct {
    uint8_t id;
    char *custom_name;
    uint32_t offset;
    uint32_t size;
} Section;

typedef struct {
    uint8_t *params;
    uint32_t param_count;
    uint8_t *results;
    uint32_t result_count;
} FuncType;

/* Storage type used for struct fields and array elements.
 * Same as a regular val_type except may also be packed: 0x78 (i8) or 0x77 (i16).
 * For ref/refnull (0x63/0x64) the heap_type s33 is captured; -1 otherwise. */
typedef struct {
    uint8_t code;
    int32_t heap_type;
    int mutable_;
} StorageType;

typedef struct {
    StorageType *fields;
    uint32_t field_count;
} StructType;

typedef struct {
    StorageType elem;
} ArrayType;

typedef enum { TY_FUNC = 0, TY_STRUCT = 1, TY_ARRAY = 2 } TypeKind;

typedef struct {
    TypeKind kind;
    int32_t parent_index;   /* -1 if no supertype */
    union {
        FuncType func;
        StructType struct_;
        ArrayType array;
    };
} WasmType;

typedef struct {
    char *module;
    char *name;
    uint8_t kind;
    union {
        uint32_t func_type;
        struct { uint8_t elem_type; uint32_t initial; uint32_t maximum; int has_max; } table;
        struct { uint32_t initial; uint32_t maximum; int has_max; } memory;
        struct { uint8_t val_type; int mutable_; } global;
    };
} Import;

typedef struct {
    char *name;
    uint8_t kind;
    uint32_t index;
} Export;

typedef struct {
    uint8_t elem_type;
    uint32_t initial;
    uint32_t maximum;
    int has_max;
} Table;

typedef struct {
    uint32_t initial;
    uint32_t maximum;
    int has_max;
} Memory;

typedef struct {
    uint8_t val_type;
    int mutable_;
    uint32_t init_offset;
    uint32_t init_size;
} Global;

typedef struct {
    uint32_t count;
    uint8_t type;
} LocalDecl;

typedef struct {
    uint32_t func_offset;
    uint32_t body_offset;
    uint32_t body_size;
    LocalDecl *locals;
    uint32_t local_decl_count;
    uint32_t total_locals;
} Code;

typedef struct {
    uint32_t flags;          /* 0=active mem 0, 1=passive, 2=active+memidx */
    uint32_t mem_index;      /* only valid when flags == 2 */
    uint32_t init_offset;    /* offset of init expr in raw bytes (active only) */
    uint32_t init_size;      /* size of init expr in raw bytes (active only) */
    int has_const_offset;    /* 1 if init expr was a single i32.const */
    int32_t const_offset;    /* the constant value, if has_const_offset */
    uint32_t data_offset;    /* offset of payload bytes in raw */
    uint32_t data_size;      /* number of payload bytes */
} DataSegment;

typedef struct {
    uint32_t index;
    char *name;
} NameEntry;

typedef struct {
    uint32_t func_index;
    NameEntry *locals;
    uint32_t local_count;
} LocalNameGroup;

typedef struct {
    uint32_t type_index;
    NameEntry *fields;
    uint32_t field_count;
} FieldNameGroup;

typedef struct {
    char *module_name;
    NameEntry *func_names;
    uint32_t func_name_count;
    LocalNameGroup *local_names;
    uint32_t local_name_count;
    NameEntry *global_names;
    uint32_t global_name_count;
    NameEntry *type_names;
    uint32_t type_name_count;
    FieldNameGroup *field_name_groups;
    uint32_t field_name_group_count;
} NameSection;

typedef struct {
    const uint8_t *raw;
    size_t raw_size;
    uint32_t version;

    Section *sections;
    uint32_t section_count;

    WasmType *types;
    uint32_t type_count;

    Import *imports;
    uint32_t import_count;
    uint32_t num_func_imports;
    uint32_t num_table_imports;
    uint32_t num_memory_imports;
    uint32_t num_global_imports;

    uint32_t *func_types;
    uint32_t func_count;

    Table *tables;
    uint32_t table_count;

    Memory *memories;
    uint32_t memory_count;

    Global *globals;
    uint32_t global_count;

    Export *exports;
    uint32_t export_count;

    int has_start;
    uint32_t start_func;

    uint32_t elem_count;
    uint32_t data_count;

    DataSegment *data_segments;
    uint32_t data_segment_count;

    Code *codes;
    uint32_t code_count;

    NameSection names;
} WasmModule;

void reader_init(Reader *r, const uint8_t *data, size_t size);
int reader_eof(const Reader *r);
uint8_t read_byte(Reader *r);
uint32_t read_u32(Reader *r);
uint32_t read_leb_u32(Reader *r);
int32_t read_leb_i32(Reader *r);
int64_t read_leb_i64(Reader *r);
float read_f32(Reader *r);
double read_f64(Reader *r);
char *read_name(Reader *r);
void reader_skip(Reader *r, uint32_t n);
void skip_init_expr(Reader *r);

int wasm_parse(WasmModule *mod, const uint8_t *data, size_t size);
void wasm_free(WasmModule *mod);

const char *wasm_valtype(uint8_t t);
const char *wasm_section_name(uint8_t id);
const char *wasm_kind_name(uint8_t kind);
const char *wasm_func_name(const WasmModule *mod, uint32_t idx);
const char *wasm_local_name(const WasmModule *mod, uint32_t func_idx, uint32_t local_idx);
const char *wasm_global_name(const WasmModule *mod, uint32_t idx);
const char *wasm_type_name(const WasmModule *mod, uint32_t idx);
const char *wasm_field_name(const WasmModule *mod, uint32_t type_idx, uint32_t field_idx);

void print_headers(const WasmModule *mod, const char *filter);
void print_details(const WasmModule *mod, const char *filter);
void print_disasm(const WasmModule *mod, const char *filter);
void print_hexdump(const WasmModule *mod, const char *filter);
void print_json(const WasmModule *mod);

#endif
