#!/usr/bin/env node
// Random x86 instruction fuzzer — golden-tests asm86.js against NASM.
//
// Generates random valid instruction sequences, assembles with both NASM and
// asm86.js, and compares byte-for-byte. Discovers encoding bugs by brute force.
//
// Usage:
//   node test/fuzz.js             # 100 random tests (fast)
//   node test/fuzz.js 1000        # 1000 random tests
//   node test/fuzz.js --seed 42   # reproducible seed
//   node test/fuzz.js --verbose   # show each test

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ASM86 = path.join(ROOT, 'asm86.js');
const TMP = path.join(ROOT, 'test', '.fuzz_tmp');
const BUNDLED_NASM = path.join(
  process.env.HOME, 'git/story/videos/011-color-a-pixel/tools/nasm-2.16.03/nasm'
);
const NASM = process.env.NASM || (fs.existsSync(BUNDLED_NASM) ? BUNDLED_NASM : 'nasm');

// ═══════════════════════════════════════════════════════════════
// Random value generators
// ═══════════════════════════════════════════════════════════════

let seed = Date.now();
function srand(s) { seed = s; }
function rand() { seed = (seed * 1664525 + 1013904223) | 0; return (seed >>> 0) / 0xFFFFFFFF; }
function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }
function pickWeighted(choices) {
  let total = choices.reduce((s,c) => s + c[0], 0);
  let r = rand() * total;
  for (const c of choices) { r -= c[0]; if (r <= 0) return c[1]; }
  return choices[choices.length-1][1];
}
function maybe(p, fn) { if (rand() < p) fn(); }

// ═══════════════════════════════════════════════════════════════
// Operand generators
// ═══════════════════════════════════════════════════════════════

const REG8 = ['al','cl','dl','bl','ah','ch','dh','bh'];
const REG16 = ['ax','cx','dx','bx','sp','bp','si','di'];
const REG32 = ['eax','ecx','edx','ebx','esp','ebp','esi','edi'];
const SEGREGS = ['es','cs','ss','ds','fs','gs'];
// Valid base registers for 16-bit addressing mode
const BASE16 = ['bx','bp'];
const INDEX16 = ['si','di'];
// Valid base and index registers for 32-bit addressing mode
const BASE32 = ['eax','ebx','ecx','edx','esi','edi','ebp','esp'];
const INDEX32 = ['eax','ebx','ecx','edx','esi','edi','ebp']; // ESP not valid as index

function genReg8() { return pick(REG8); }
function genReg16() { return pick(REG16); }
function genReg32() { return pick(REG32); }
function genReg(bits) {
  if (bits === 8) return genReg8();
  if (bits === 16) return genReg16();
  return genReg32();
}
function genImm8() { return randInt(-128, 127); }
function genImm16() { return randInt(-32768, 32767); }
function genImm32() { return randInt(-0x80000000, 0x7FFFFFFF); }
function genImm(bits) {
  if (bits <= 8) return genImm8();
  if (bits === 16) return genImm16();
  return genImm32();
}
function genUImm8() { return randInt(0, 255); }
function genUImm16() { return randInt(0, 65535); }

let labelCounter = 0;
function genLabel() { return '.L' + (labelCounter++); }

// Memory operand generators
function genMem16(defLabels) {
  // 16-bit addressing: only BX/BP as base, SI/DI as index, plus optional disp
  const modes = [
    () => '[' + pick(INDEX16) + ']',                              // [SI] or [DI]
    () => '[' + pick(BASE16) + ']',                               // [BX] or [BP]
    () => '[' + pick(BASE16) + '+' + pick(INDEX16) + ']',         // [BX+SI], [BX+DI], [BP+SI], [BP+DI]
    () => '[' + pick(BASE16) + '+' + genImm8() + ']',             // [BX+disp8], [BP+disp8]
    () => '[' + pick(BASE16) + '+' + pick(INDEX16) + '+' + genImm8() + ']', // [base+index+disp8]
  ];
  if (defLabels && defLabels.length > 0) {
    modes.push(() => '[' + pick(defLabels) + ']');
  }
  return pick(modes)();
}
function genMem32(defLabels) {
  const base = pick(BASE32);
  const idx = pick(INDEX32);
  const scale = pick([1,2,4,8]);
  const modes = [
    () => '[' + pick(BASE32) + ']',
    () => '[' + base + '+' + idx + '*' + scale + ']',
    () => '[' + pick(BASE32) + '+' + genImm32() + ']',
    () => '[' + base + '+' + idx + '*' + scale + '+' + genImm32() + ']',
    () => '[' + idx + '*' + scale + '+' + genImm32() + ']',
  ];
  // Only include label form if we have defined labels
  if (defLabels && defLabels.length > 0) {
    modes.push(() => '[' + pick(defLabels) + ']');
  }
  return pick(modes)();
}

// ═══════════════════════════════════════════════════════════════
// Instruction generators
// ═══════════════════════════════════════════════════════════════

function genMOV(bits, defLabels) {
  const r1 = genReg(bits), r2 = genReg(bits);
  const forms = [
    [5, () => `mov ${r1}, ${r2}`],
    [4, () => `mov ${r1}, ${genImm(bits)}`],
    [1, () => {
      // Memory dest: need size qualifier when source is immediate (ambiguous size)
      if (bits === 16) return `mov WORD ${genMem16(defLabels)}, ${r1}`;
      return `mov DWORD ${genMem32(defLabels)}, ${r1}`;
    }],
    [2, () => {
      // Memory source to register
      if (bits === 16) return `mov ${r1}, WORD ${genMem16(defLabels)}`;
      return `mov ${r1}, DWORD ${genMem32(defLabels)}`;
    }],
  ];
  if (bits === 16) {
    forms.push([1, () => `mov ${pick(SEGREGS)}, ${genReg16()}`]);
    forms.push([1, () => `mov ${genReg16()}, ${pick(SEGREGS)}`]);
  }
  return pickWeighted(forms)();
}

function genALU(bits, defLabels) {
  const op = pick(['add','sub','and','or','xor','cmp','adc','sbb']);
  const sz = bits === 16 ? 'WORD' : 'DWORD';
  const r1 = genReg(bits), r2 = genReg(bits);
  const forms = [
    [4, () => `${op} ${r1}, ${r2}`],
    [3, () => `${op} ${r1}, ${genImm(randInt(0,1) ? 8 : bits)}`],
    [1, () => `${op} ${r1}, ${sz} ${bits === 16 ? genMem16(defLabels) : genMem32(defLabels)}`],
    [1, () => `${op} ${sz} ${bits === 16 ? genMem16(defLabels) : genMem32(defLabels)}, ${r1}`],
    [1, () => `${op} ${sz} ${bits === 16 ? genMem16(defLabels) : genMem32(defLabels)}, ${genImm(randInt(0,1) ? 8 : bits)}`],
  ];
  return pickWeighted(forms)();
}

function genShift(bits) {
  const op = pick(['shl','shr','sar','rol','ror','rcl','rcr']);
  const r = genReg(bits);
  const count = pick(['1', 'cl', String(randInt(1, 31))]);
  return `${op} ${r}, ${count}`;
}

function genPushPop(bits) {
  const op = pick(['push','pop']);
  const r = genReg(bits === 16 ? 16 : 32);
  return `${op} ${r}`;
}

function genJMP(labels, pendingLabels) {
  // Create a new label for forward reference
  const target = (labels.length > 0 && rand() < 0.7)
    ? pick(labels)
    : genLabel();
  if (!labels.includes(target)) {
    labels.push(target);
    pendingLabels.add(target); // will be defined later
  }
  const kind = pick(['jmp','jo','jno','jb','jnb','jz','jnz','jbe','ja','js','jns','jl','jge','jle','jg']);
  return `${kind} ${target}`;
}

function genUnary(bits) {
  const op = pick(['not','neg','mul','imul','div','idiv','inc','dec']);
  const r = genReg(bits);
  return `${op} ${r}`;
}

function genSimple() {
  return pick(['nop','cli','sti','hlt','ret','cld','std']);
}

// ═══════════════════════════════════════════════════════════════
// Test case generator
// ═══════════════════════════════════════════════════════════════

function generateTestCase(numInsns, bits) {
  const lines = [];
  const defLabels = []; // labels that have been defined
  const pendingLabels = new Set(); // labels referenced but not yet defined
  const bitsDir = bits === 16 ? '16' : '32';

  lines.push(`[BITS ${bitsDir}]`);
  lines.push(`ORG 0x100`);
  lines.push('');

  // Pre-define some data labels
  for (let i = 0; i < randInt(0, 2); i++) {
    const dl = genLabel();
    defLabels.push(dl);
    const val = randInt(0, 0xFFFF);
    lines.push(`${dl}: DD ${val}`);
  }
  if (defLabels.length) lines.push('');

  for (let i = 0; i < numInsns; i++) {
    // Sometimes define a new label
    if (rand() < 0.25 || pendingLabels.size > 0 && rand() < 0.5) {
      let lab;
      if (pendingLabels.size > 0 && rand() < 0.7) {
        lab = [...pendingLabels][randInt(0, pendingLabels.size - 1)];
        pendingLabels.delete(lab);
      } else {
        lab = genLabel();
      }
      defLabels.push(lab);
      lines.push(`${lab}:`);
    }

    // Pick instruction with size-qualified memory operands where needed
    let insn;
    const cat = pickWeighted([
      [25, 'alu'], [15, 'mov'], [5, 'shift'], [8, 'pushpop'],
      [8, 'jmp'], [5, 'unary'], [3, 'simple']
    ]);

    switch (cat) {
      case 'mov': insn = genMOV(bits, defLabels); break;
      case 'alu': insn = genALU(bits, defLabels); break;
      case 'shift': insn = genShift(bits); break;
      case 'pushpop': insn = genPushPop(bits); break;
      case 'jmp': insn = genJMP(defLabels, pendingLabels); break;
      case 'unary': insn = genUnary(bits); break;
      case 'simple': insn = genSimple(); break;
    }
    lines.push(`\t${insn}`);
  }

  // Define any remaining pending forward-reference labels at the end
  if (pendingLabels.size > 0) {
    lines.push('');
    for (const lab of pendingLabels) {
      lines.push(`${lab}:`);
      lines.push(`\tNOP`);
      defLabels.push(lab);
    }
  }

  return { asm: lines.join('\n'), labels: defLabels };
}

function runCmd(cmd) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
    return { ok: true, stdout: out, stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '', code: e.status };
  }
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function testOne(testId, numInsns, bits) {
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

  const { asm } = generateTestCase(numInsns, bits);
  const asmFile = path.join(TMP, `fuzz_${testId}.asm`);
  const goldFile = path.join(TMP, `fuzz_${testId}.golden`);
  const outFile = path.join(TMP, `fuzz_${testId}.out`);

  fs.writeFileSync(asmFile, asm);

  // Run NASM
  const nasmResult = runCmd(`"${NASM}" -f bin "${asmFile}" -o "${goldFile}"`);
  if (!nasmResult.ok) {
    return { status: 'nasm_error', asm, error: nasmResult.stderr.trim() };
  }

  // Run asm86
  const asmResult = runCmd(`node "${ASM86}" -f bin "${asmFile}" -o "${outFile}"`);
  if (!asmResult.ok) {
    return { status: 'asm86_crash', asm, error: asmResult.stderr.trim() };
  }

  // Compare
  let golden, output;
  try { golden = fs.readFileSync(goldFile); } catch (_) { golden = Buffer.alloc(0); }
  try { output = fs.readFileSync(outFile); } catch (_) { output = Buffer.alloc(0); }

  if (!bytesEqual(golden, output)) {
    const msg = `size golden=${golden.length} asm86=${output.length}`;
    return { status: 'mismatch', asm, error: msg, golden, output };
  }

  return { status: 'ok' };
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

function main() {
  const args = process.argv.slice(2);
  let numTests = 100;
  let verbose = false;
  let onlyBits = 0; // 0 = both, 16 or 32

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--seed') { srand(parseInt(args[++i])); continue; }
    if (a === '--verbose' || a === '-v') { verbose = true; continue; }
    if (a === '--bits') { onlyBits = parseInt(args[++i]); continue; }
    const n = parseInt(a);
    if (!isNaN(n)) numTests = n;
  }

  console.log(`Seed: ${seed}`);
  console.log(`Tests: ${numTests}`);
  console.log(`NASM: ${NASM}`);
  console.log(`asm86: ${ASM86}`);
  console.log('');

  let ok = 0, nasmErr = 0, crash = 0, mismatch = 0;
  const failures = [];

  const startTime = Date.now();

  for (let i = 0; i < numTests; i++) {
    const bits = onlyBits || (rand() < 0.5 ? 16 : 32);
    const numInsns = randInt(5, 40);
    const result = testOne(i, numInsns, bits);

    switch (result.status) {
      case 'ok':
        ok++;
        if (verbose) process.stdout.write('.');
        break;
      case 'nasm_error':
        nasmErr++;
        if (verbose) process.stdout.write('N');
        failures.push({ id: i, type: 'nasm_err', asm: result.asm, error: result.error });
        break;
      case 'asm86_crash':
        crash++;
        if (verbose) process.stdout.write('C');
        failures.push({ id: i, type: 'crash', asm: result.asm, error: result.error });
        break;
      case 'mismatch':
        mismatch++;
        if (verbose) process.stdout.write('M');
        failures.push({
          id: i, type: 'mismatch', asm: result.asm, error: result.error,
          golden: result.golden, output: result.output
        });
        break;
    }

    if (!verbose && (i + 1) % 10 === 0) process.stdout.write('.');
    if (!verbose && (i + 1) % 100 === 0) process.stdout.write(` ${i+1}\n`);
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n${ok} passed, ${nasmErr} nasm errors, ${crash} crashes, ${mismatch} mismatches (${elapsed.toFixed(1)}s)`);

  if (failures.length > 0) {
    console.log(`\n${failures.length} failures:`);
    for (const f of failures.slice(0, 20)) {
      console.log(`\n--- FAIL #${f.id} [${f.type}] ---`);
      if (f.error) console.log(`Error: ${f.error.slice(0, 200)}`);
      console.log(`ASM:\n${f.asm.slice(0, 500)}`);
      if (f.type === 'mismatch') {
        const gHex = f.golden.slice(0, 64).toString('hex');
        const oHex = f.output.slice(0, 64).toString('hex');
        console.log(`Golden[0:64]: ${gHex}`);
        console.log(`asm86 [0:64]: ${oHex}`);
      }
    }
    if (failures.length > 20) console.log(`\n... and ${failures.length - 20} more failures`);
    process.exit(1);
  }
}

main();
