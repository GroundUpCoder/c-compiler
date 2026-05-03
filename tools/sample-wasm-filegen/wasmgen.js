

function section(id, content) {
    return [id, ...encodeLEBU128(content.length), ...content];
}

function encodeLEBU128(value) {
    const bytes = [];
    do {
        let byte = value & 0x7F;
        value >>>= 7;
        if (value !== 0) {
            byte |= 0x80; // set continuation bit
        }
        bytes.push(byte);
    } while (value !== 0);
    return bytes;
}

function encodeLEBS128(value) {
    value = value | 0;
    const bytes = [];
    let more = true;
    while (more) {
        let byte = value & 0x7F;
        value >>= 7;
        if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
            more = false; // last byte
        } else {
            byte |= 0x80; // set continuation byte
        }
        bytes.push(byte);
    }
    return bytes;
}

function encodeString(s) {
    const utf8 = [...new TextEncoder().encode(s)];
    return [...encodeLEBU128(utf8.length), ...utf8];
}

function encodeVector(items) {
    const out = [...encodeLEBU128(items.length)];
    for (const item of items) out.push(...item);
    return out;
}

// Value type byte encodings
const VT_I32 = 0x7F;
const VT_I64 = 0x7E;
const VT_F32 = 0x7D;
const VT_F64 = 0x7C;

// Import / export kinds
const IMPORT_FUNC = 0x00;
const EXPORT_FUNC = 0x00;
const EXPORT_MEM  = 0x02;

// Instruction emitters: each returns a byte array.
const CODE = {
    i32_const: (v) => [0x41, ...encodeLEBS128(v)],
    i64_const: (v) => [0x42, ...encodeLEBS128(v)],
    local_get: (i) => [0x20, ...encodeLEBU128(i)],
    local_set: (i) => [0x21, ...encodeLEBU128(i)],
    local_tee: (i) => [0x22, ...encodeLEBU128(i)],
    global_get: (i) => [0x23, ...encodeLEBU128(i)],
    global_set: (i) => [0x24, ...encodeLEBU128(i)],
    call: (idx) => [0x10, ...encodeLEBU128(idx)],
    drop: () => [0x1A],
    i32_add: () => [0x6A],
    i32_sub: () => [0x6B],
    i32_mul: () => [0x6C],
    i32_load: (align, offset) => [0x28, ...encodeLEBU128(align), ...encodeLEBU128(offset)],
    i32_store: (align, offset) => [0x36, ...encodeLEBU128(align), ...encodeLEBU128(offset)],
    i32_store8: (align, offset) => [0x3A, ...encodeLEBU128(align), ...encodeLEBU128(offset)],
    return_: () => [0x0F],
    end: () => [0x0B],
};

function generateWasm() {
    const out = []; // Output array of bytes

    // Magic + Version
    out.push(0x00, 0x61, 0x73, 0x6D); // Magic number "\0asm"
    out.push(0x01, 0x00, 0x00, 0x00); // Version 1

    ////////////////////////////
    // SECTION 1: Type section
    //   type 0: (i32, i32, i32) -> i32   for c.write
    //   type 1: ()              -> i32   for main
    ////////////////////////////
    const writeType = [
        0x60,
        ...encodeVector([[VT_I32], [VT_I32], [VT_I32]]),
        ...encodeVector([[VT_I32]]),
    ];
    const mainType = [
        0x60,
        ...encodeVector([]),
        ...encodeVector([[VT_I32]]),
    ];
    out.push(...section(1, encodeVector([writeType, mainType])));

    ////////////////////////////
    // SECTION 2: Import section
    //   import c.write : type 0  -> function index 0
    ////////////////////////////
    const writeImport = [
        ...encodeString("c"),
        ...encodeString("write"),
        IMPORT_FUNC,
        ...encodeLEBU128(0), // type index 0
    ];
    out.push(...section(2, encodeVector([writeImport])));

    ////////////////////////////
    // SECTION 3: Function section — one local function `main` of type 1.
    //   After this, function indices: 0 = imported write, 1 = main.
    ////////////////////////////
    out.push(...section(3, encodeVector([encodeLEBU128(1)])));

    ////////////////////////////
    // SECTION 5: Memory section — one memory, min 1 page (64 KiB), no max
    ////////////////////////////
    const memEntry = [0x00, ...encodeLEBU128(1)]; // flags=0 (no max), min=1
    out.push(...section(5, encodeVector([memEntry])));

    ////////////////////////////
    // SECTION 7: Export section — "memory" (mem 0), "main" (func 1)
    ////////////////////////////
    const exportMem  = [...encodeString("memory"), EXPORT_MEM,  ...encodeLEBU128(0)];
    const exportMain = [...encodeString("main"),   EXPORT_FUNC, ...encodeLEBU128(1)];
    out.push(...section(7, encodeVector([exportMem, exportMain])));

    const HELLO = [...new TextEncoder().encode("Hello World\n")];

    ////////////////////////////
    // SECTION 10: Code section — body of main
    //   write(1, 0, HELLO.length);
    //   drop;
    //   return 17;
    ////////////////////////////
    const body = [
        ...CODE.i32_const(1),             // fd = stdout
        ...CODE.i32_const(14),            // ptr = 14
        ...CODE.i32_const(HELLO.length),  // count
        ...CODE.call(0),                  // call imported c.write
        ...CODE.drop(),                   // discard return value
        ...CODE.i32_const(17),
        ...CODE.end(),
    ];
    const funcBody = [
        ...encodeVector([]), // no locals
        ...body,
    ];
    const funcEntry = [...encodeLEBU128(funcBody.length), ...funcBody];
    out.push(...section(10, encodeVector([funcEntry])));

    ////////////////////////////
    // SECTION 11: Data section — active segment in memory 0 at offset 0
    //   contents: HELLO ("Hello World\n")
    ////////////////////////////
    const offsetExpr = [...CODE.i32_const(14), ...CODE.end()];
    const dataEntry = [
        ...encodeLEBU128(0), // mode 0: active in memory 0, offset = const expr
        ...offsetExpr,
        ...encodeLEBU128(HELLO.length),
        ...HELLO,
    ];
    out.push(...section(11, encodeVector([dataEntry])));

    return new Uint8Array(out);
}

const wasmBinary = generateWasm();
const fs = require('fs');
const outPath = process.argv[2] || 'hello.wasm';
fs.writeFileSync(outPath, wasmBinary);
console.log(`wrote ${wasmBinary.length} bytes to ${outPath}`);
