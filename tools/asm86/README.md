# asm86

A single-file x86 assembler written in JavaScript. Emits flat binary output (no ELF, no PE, no relocations). NASM-compatible syntax for the subset of directives and instructions that make sense in a flat-binary world. Golden-tested against NASM 2.16.03 byte-for-byte.

## Why

NASM is 170K lines of C. But for bare-metal x86 work — boot sectors, kernels, raw mode applications — you only need:

- **Flat binary output** (no object files, no linker, no relocations)
- **16-bit and 32-bit modes** (no x86-64, no REX/VEX/EVEX)
- **The instructions you actually use** (not all 1500+ x86 mnemonics)
- **The directives that matter for raw binaries** (DB/DW/DD/DQ, EQU, TIMES, etc.)

`asm86.js` is exactly that. One file. No dependencies. Runs in Node.js. Produces byte-identical output to NASM for every instruction and directive it implements.

## Exact NASM Compatibility Target

`asm86.js` is not a "nasal demon" compatible reimplementation — it's a subset that, for every instruction it accepts, produces **byte-for-byte identical output** to `nasm -f bin`.

### Scope (what we match)

- **All general-purpose x86 instructions** (MOV, ADD, SUB, CMP, JMP, CALL, RET, PUSH, POP, etc.) — full 16-bit and 32-bit forms
- **All system instructions needed for bare-metal** (LGDT, LIDT, IN, OUT, CLI, STI, HLT, IRET, MOV CRn, etc.)
- **x87 FPU instructions** (FLD, FSTP, FADD, FSIN, FCOS, etc.)
- **MMX / SSE / SSE2** — the subset useful for bare-metal graphics (MOVDQA, PXOR, etc.)
- **Full NASM expression syntax** — `$`, `$$`, `SHL`, `SHR`, unary operators, parentheses, all of it
- **Full NASM preprocessor** — `%define`, `%macro`, `%if`/`%else`/`%endif`, `%rep`, `%include`, `%error`
- **All relevant directives** — `DB`, `DW`, `DD`, `DQ`, `DT`, `RESB`, `RESW`, `RESD`, `RESQ`, `TIMES`, `EQU`, `ALIGN`, `BITS`
- **All addressing modes** — `[reg]`, `[reg+disp]`, `[reg+reg*scale]`, `[reg+reg*scale+disp]`, segment overrides

### Out of scope (by design)

- **Object file formats** — flat binary only. No ELF, PE, COFF, Mach-O. No relocations, no symbol tables, no section headers. If you need a linker, this is the wrong tool.
- **x86-64 / long mode** — REX prefixes, RIP-relative addressing, 64-bit registers. Out of scope for v1. (Could be added later.)
- **AVX / AVX2 / AVX-512** — VEX/EVEX encoding. Not needed for boot-loaders and raw-mode applications.
- **Obsolete instructions** — BCD arithmetic (AAA, AAS, DAA, DAS), x87 environment instructions (FLDENV, FSTENV, etc. — but FLDCW/FSTCW are kept for FPU control).
- **Context stack directives** — `%push`, `%pop`, `%repl`. Rarely used even in large NASM codebases.
- **Struc/endstruc** — NASM's struct macros. Use `%define` offsets instead.
- **16-bit segmented addressing in protected mode** — `[fs:bx+si+disp]` etc. Real-mode addressing modes ARE supported.

## Usage

```bash
# Assemble a file
node asm86.js -f bin input.asm -o output.bin

# The -f bin flag is accepted for NASM compatibility but ignored
# (flat binary is the only output format)
```

## Golden Tests

Every instruction and directive is tested against real NASM:

```
test/
  add.asm          # test source
  add.golden.bin   # nasm -f bin add.asm -o add.golden.bin
```

The test runner:

```bash
node test/run.js          # runs all tests
node test/run.js --filter=add   # runs tests matching "add"
```

A test passes if and only if `asm86.js` output = `nasm -f bin` output byte-for-byte.

### Adding a new instruction

1. Write `test/<mnemonic>.asm` exercising every operand form
2. Run `nasm -f bin test/<mnemonic>.asm -o test/<mnemonic>.golden.bin`
3. Run `node test/run.js --filter=<mnemonic>` — it'll fail
4. Add the instruction to the encoding table in `asm86.js`
5. Iterate until the test passes
6. Commit both the `.asm` and `.golden.bin`

NASM is the oracle. We don't guess encoding rules — we verify against the reference.

## Architecture

`asm86.js` is a single file. Internally:

```
Input .asm text
  │
  ▼
┌─────────────┐
│  Tokenizer   │  → array of tokens (mnemonics, registers, numbers, strings, punct)
└──────┬───────┘
       │
       ▼
┌─────────────┐
│ Preprocessor │  → expands %define, %macro, %include, %if → flat token stream
└──────┬───────┘
       │
       ▼
┌─────────────┐
│   Parser     │  → array of statements (label?, mnemonic+operands | directive+args)
└──────┬───────┘
       │
       ▼
┌─────────────┐
│ Multi-Pass   │  → pass 1: collect labels, compute tentative sizes
│  Assembler   │  → pass 2-N: re-evaluate with updated label values
│              │  → converges when all jump offsets stabilize (typically 3-5 passes)
└──────┬───────┘
       │
       ▼
┌─────────────┐
│   Emitter    │  → instruction encoding tables → ModR/M + SIB → flat bytes
└──────┬───────┘
       │
       ▼
   output.bin
```

### Multi-pass convergence

NASM-style multi-pass optimization: short jumps (2 bytes) vs near jumps (4+ bytes). A `jmp label` might be 2 bytes on pass 1 but need 4 bytes on pass 2 if the label moved (because some other jump between them expanded). The assembler re-runs passes until the output size stabilizes.

Convergence is guaranteed: jumps can only grow (short → near), never shrink, and the maximum jump encoding size is 5 bytes (near jmp with 32-bit displacement). At most `(numJumps × 3)` extra bytes can be added across all passes, bounding the pass count.

### Instruction encoding database

The heart of the assembler. Each mnemonic maps to an array of encoding forms:

```js
"ADD": [
  // add r/m8, r8
  { op: [0x00], ops: [{kind:"rm8"}, {kind:"r8"}], modrm:"reg=r2,rm=r1" },
  // add r/m16/32, r16/32  
  { op: [0x01], ops: [{kind:"rm1632"}, {kind:"r1632"}], modrm:"reg=r2,rm=r1" },
  // add r8, r/m8
  { op: [0x02], ops: [{kind:"r8"}, {kind:"rm8"}], modrm:"reg=r2,rm=r1" },
  // add r16/32, r/m16/32
  { op: [0x03], ops: [{kind:"r1632"}, {kind:"rm1632"}], modrm:"reg=r2,rm=r1" },
  // add al, imm8
  { op: [0x04], ops: [{kind:"al"}, {kind:"imm8"}], modrm:null },
  // ... etc
],
```

Each entry encodes: opcode bytes, operand type constraints, and how operands map onto the ModR/M byte. The encoder selects the matching form, computes ModR/M/SIB, and emits.

## Dependencies

None. Single file, no npm packages. Requires Node.js (for `Buffer` and file I/O — could be ported to browser but not a priority).

## Reference Assembler

Golden tests use NASM 2.16.03 at:
```
~/git/story/videos/011-color-a-pixel/tools/nasm-2.16.03/nasm
```

Set `NASM` env var to override, or place `nasm` on PATH.

## License

MIT — same as the rest of the c-compiler project.
