#!/usr/bin/env node
// Analyze fuzzer failures to find common byte-diff patterns.
// Usage: node test/analyze.js [--seed 42] [--count 200]
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ASM86 = path.join(ROOT, 'asm86.js');
const NASM = process.env.NASM || path.join(process.env.HOME, 'git/story/videos/011-color-a-pixel/tools/nasm-2.16.03/nasm');
const TMP = path.join(__dirname, '.analyze_tmp');

// Use the fuzzer's generator (copy seed/rand from fuzz.js)
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

const REG8 = ['al','cl','dl','bl','ah','ch','dh','bh'];
const REG16 = ['ax','cx','dx','bx','sp','bp','si','di'];
const REG32 = ['eax','ecx','edx','ebx','esp','ebp','esi','edi'];
const SEGREGS = ['es','cs','ss','ds','fs','gs'];
const BASE16 = ['bx','bp'];
const INDEX16 = ['si','di'];
const BASE32 = ['eax','ebx','ecx','edx','esi','edi','ebp','esp'];
const INDEX32 = ['eax','ebx','ecx','edx','esi','edi','ebp'];
let labelCounter = 0;
function genLabel() { return '.L' + (labelCounter++); }
function genReg8() { return pick(REG8); }
function genReg16() { return pick(REG16); }
function genReg32() { return pick(REG32); }
function genReg(bits) { return bits===8?genReg8():bits===16?genReg16():genReg32(); }
function genImm(bits) {
  if(bits<=8) return randInt(-128,127);
  if(bits===16) return randInt(-32768,32767);
  return randInt(-0x80000000,0x7FFFFFFF);
}
function genImm8() { return randInt(-128,127); }
function genImm32() { return randInt(-0x80000000,0x7FFFFFFF); }

function genMem16(defLabels) {
  const modes = [
    () => '[' + pick(INDEX16) + ']', () => '[' + pick(BASE16) + ']',
    () => '[' + pick(BASE16) + '+' + pick(INDEX16) + ']',
    () => '[' + pick(BASE16) + '+' + genImm8() + ']',
    () => '[' + pick(BASE16) + '+' + pick(INDEX16) + '+' + genImm8() + ']',
  ];
  if (defLabels && defLabels.length>0) modes.push(() => '[' + pick(defLabels) + ']');
  return pick(modes)();
}
function genMem32(defLabels) {
  const b = pick(BASE32), idx = pick(INDEX32), sc = pick([1,2,4,8]);
  const modes = [
    () => '[' + pick(BASE32) + ']',
    () => '[' + b + '+' + idx + '*' + sc + ']',
    () => '[' + pick(BASE32) + '+' + genImm32() + ']',
    () => '[' + b + '+' + idx + '*' + sc + '+' + genImm32() + ']',
    () => '[' + idx + '*' + sc + '+' + genImm32() + ']',
  ];
  if (defLabels && defLabels.length>0) modes.push(() => '[' + pick(defLabels) + ']');
  return pick(modes)();
}

function genMOV(bits, defLabels) {
  const r1 = genReg(bits), r2 = genReg(bits);
  const forms=[
    [5,()=>`mov ${r1}, ${r2}`],[4,()=>`mov ${r1}, ${genImm(bits)}`],
    [1,()=>bits===16?`mov WORD ${genMem16(defLabels)}, ${r1}`:`mov DWORD ${genMem32(defLabels)}, ${r1}`],
    [2,()=>bits===16?`mov ${r1}, WORD ${genMem16(defLabels)}`:`mov ${r1}, DWORD ${genMem32(defLabels)}`],
  ];
  if(bits===16){forms.push([1,()=>`mov ${pick(SEGREGS)}, ${genReg16()}`]);forms.push([1,()=>`mov ${genReg16()}, ${pick(SEGREGS)}`]);}
  return pickWeighted(forms)();
}
function genALU(bits, defLabels) {
  const op = pick(['add','sub','and','or','xor','cmp','adc','sbb']);
  const sz = bits===16?'WORD':'DWORD';
  const r1=genReg(bits),r2=genReg(bits);
  const forms=[
    [4,()=>`${op} ${r1}, ${r2}`],
    [3,()=>`${op} ${r1}, ${genImm(randInt(0,1)?8:bits)}`],
    [1,()=>`${op} ${r1}, ${sz} ${bits===16?genMem16(defLabels):genMem32(defLabels)}`],
    [1,()=>`${op} ${sz} ${bits===16?genMem16(defLabels):genMem32(defLabels)}, ${r1}`],
    [1,()=>`${op} ${sz} ${bits===16?genMem16(defLabels):genMem32(defLabels)}, ${genImm(randInt(0,1)?8:bits)}`],
  ];
  return pickWeighted(forms)();
}
function genShift(bits) {
  const op = pick(['shl','shr','sar','rol','ror','rcl','rcr']);
  const r = genReg(bits);
  return `${op} ${r}, ${pick(['1','cl',String(randInt(1,31))])}`;
}
function genPushPop(bits) {
  return pick(['push','pop']) + ' ' + genReg(bits===16?16:32);
}
function genJMP(labels, pendingLabels) {
  const target = (labels.length>0&&rand()<0.7)?pick(labels):genLabel();
  if(!labels.includes(target)){labels.push(target);pendingLabels.add(target);}
  return pick(['jmp','jo','jno','jb','jnb','jz','jnz','jbe','ja','js','jns','jl','jge','jle','jg']) + ' ' + target;
}
function genUnary(bits) {
  return pick(['not','neg','mul','imul','div','idiv','inc','dec']) + ' ' + genReg(bits);
}
function genSimple() { return pick(['nop','cli','sti','hlt','ret','cld','std']); }

function generateTestCase(numInsns, bits) {
  const lines=[], defLabels=[], pendingLabels=new Set();
  lines.push(`[BITS ${bits===16?'16':'32'}]`);
  lines.push('ORG 0x100'); lines.push('');
  for(let i=0;i<randInt(0,2);i++){
    const dl=genLabel(); defLabels.push(dl);
    lines.push(`${dl}: DD ${randInt(0,0xFFFF)}`);
  }
  if(defLabels.length) lines.push('');
  for(let i=0;i<numInsns;i++){
    if(rand()<0.25||(pendingLabels.size>0&&rand()<0.5)){
      let lab;
      if(pendingLabels.size>0&&rand()<0.7){lab=[...pendingLabels][randInt(0,pendingLabels.size-1)];pendingLabels.delete(lab);}
      else lab=genLabel();
      defLabels.push(lab); lines.push(`${lab}:`);
    }
    const cat = pickWeighted([[25,'alu'],[15,'mov'],[5,'shift'],[8,'pushpop'],[8,'jmp'],[5,'unary'],[3,'simple']]);
    let insn;
    switch(cat){
      case'mov':insn=genMOV(bits,defLabels);break;
      case'alu':insn=genALU(bits,defLabels);break;
      case'shift':insn=genShift(bits);break;
      case'pushpop':insn=genPushPop(bits);break;
      case'jmp':insn=genJMP(defLabels,pendingLabels);break;
      case'unary':insn=genUnary(bits);break;
      case'simple':insn=genSimple();break;
    }
    lines.push('\t'+insn);
  }
  if(pendingLabels.size>0){lines.push('');for(const lab of pendingLabels){lines.push(`${lab}:`);lines.push('\tNOP');}}
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  let count = 200, verbose = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seed') { srand(parseInt(args[++i])); continue; }
    if (args[i] === '-v') { verbose = true; continue; }
    const n = parseInt(args[i]); if (!isNaN(n)) count = n;
  }

  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

  // Statistics
  const statByMnemonic = {}; // mnemonic -> {mismatch: N, total: N}
  const statByDiff = {}; // "opcode_old->new" -> count
  let totalTests = 0, totalPass = 0;

  for (let i = 0; i < count; i++) {
    const bits = rand() < 0.5 ? 16 : 32;
    const numInsns = randInt(8, 30);
    const asm = generateTestCase(numInsns, bits);
    const asmFile = path.join(TMP, `a${i}.asm`);
    const goldFile = path.join(TMP, `a${i}.gold`);
    const outFile = path.join(TMP, `a${i}.out`);
    fs.writeFileSync(asmFile, asm);

    try { execSync(`"${NASM}" -f bin "${asmFile}" -o "${goldFile}"`, {encoding:'utf8',stdio:'pipe',timeout:5000}); }
    catch(e) { continue; } // skip nasm errors

    try { execSync(`node "${ASM86}" -f bin "${asmFile}" -o "${outFile}"`, {encoding:'utf8',stdio:'pipe',timeout:5000}); }
    catch(e) { continue; } // skip crashes

    const g = fs.readFileSync(goldFile);
    const o = fs.readFileSync(outFile);
    totalTests++;

    // Find first diff byte and extract the surrounding instruction context
    let firstDiff = -1;
    for (let j = 0; j < Math.max(g.length, o.length); j++) {
      if (g[j] !== o[j]) { firstDiff = j; break; }
    }

    if (firstDiff < 0) {
      totalPass++;
      continue;
    }

    // Extract mnemonic at the diff position by looking at the ASM lines
    const lines = asm.split('\n');
    // We can estimate which instruction caused the diff by the byte position
    // But it's complex. Instead, just count the first-diff opcode bytes
    const gb = firstDiff < g.length ? g[firstDiff] : -1;
    const ob = firstDiff < o.length ? o[firstDiff] : -1;
    const key = `${gb.toString(16).padStart(2,'0')}->${ob.toString(16).padStart(2,'0')}`;
    statByDiff[key] = (statByDiff[key] || 0) + 1;

    if (verbose) {
      console.log(`FAIL #${i}: byte ${firstDiff}: ${key} | sizes g=${g.length} o=${o.length}`);
    }

    // Collect first 3 diff bytes for pattern analysis
    const diffs = [];
    for (let j = firstDiff; j < Math.min(firstDiff + 6, Math.max(g.length, o.length)); j++) {
      const gbj = j < g.length ? g[j] : -1;
      const obj = j < o.length ? o[j] : -1;
      if (gbj !== obj) diffs.push(`${j-firstDiff}:${gbj.toString(16)}->${obj.toString(16)}`);
    }
  }

  // Output statistics
  console.log(`\n${totalPass}/${totalTests} passed (${(totalPass/totalTests*100).toFixed(1)}%)`);
  console.log(`\nTop byte-diff patterns:`);
  const sorted = Object.entries(statByDiff).sort((a,b) => b[1]-a[1]);
  for (const [k, v] of sorted.slice(0, 20)) {
    console.log(`  ${k}: ${v} occurrences`);
  }
}

main();
