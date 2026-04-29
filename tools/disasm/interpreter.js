// interpreter.js — WebAssembly bytecode interpreter
//
// Executes WASM modules instruction-by-instruction with full state
// inspection. Designed for integration with the disasm UI: the
// interpreter's (funcIndex, byteOffset) state maps directly to
// instruction elements rendered from the disasm JSON.
//
// Usage:
//   var interp = WasmInterpreter.create(wasmBytes, hostImports);
//   interp.start('main', []);
//   interp.step();           // one instruction
//   interp.run(1000);        // up to N steps
//   interp.getState();       // { status, funcIndex, offset, ... }
//
// The getState().offset matches the disasm JSON's instruction offset
// field, so the UI can find and highlight the current instruction.

var WasmInterpreter = (function() {
'use strict';

// ── LEB128 decoders ──

function readLebU32(bytes, pos) {
  var result = 0, shift = 0, b;
  do {
    b = bytes[pos++];
    result |= (b & 0x7F) << shift;
    shift += 7;
  } while (b & 0x80);
  return { value: result >>> 0, pos: pos };
}

function readLebI32(bytes, pos) {
  var result = 0, shift = 0, b;
  do {
    b = bytes[pos++];
    result |= (b & 0x7F) << shift;
    shift += 7;
  } while (b & 0x80);
  if (shift < 32 && (b & 0x40)) result |= (~0 << shift);
  return { value: result | 0, pos: pos };
}

function readLebI64(bytes, pos) {
  var result = 0n, shift = 0n, b;
  do {
    b = bytes[pos++];
    result |= BigInt(b & 0x7F) << shift;
    shift += 7n;
  } while (b & 0x80);
  if (shift < 64n && (b & 0x40)) result |= (~0n << shift);
  return { value: BigInt.asIntN(64, result), pos: pos };
}

function readF32(bytes, pos) {
  var buf = new ArrayBuffer(4);
  var u8 = new Uint8Array(buf);
  u8[0] = bytes[pos]; u8[1] = bytes[pos+1]; u8[2] = bytes[pos+2]; u8[3] = bytes[pos+3];
  return { value: new DataView(buf).getFloat32(0, true), pos: pos + 4 };
}

function readF64(bytes, pos) {
  var buf = new ArrayBuffer(8);
  var u8 = new Uint8Array(buf);
  for (var i = 0; i < 8; i++) u8[i] = bytes[pos + i];
  return { value: new DataView(buf).getFloat64(0, true), pos: pos + 8 };
}

function readName(bytes, pos) {
  var r = readLebU32(bytes, pos);
  var len = r.value; pos = r.pos;
  var s = '';
  for (var i = 0; i < len; i++) s += String.fromCharCode(bytes[pos + i]);
  return { value: s, pos: pos + len };
}

// ── WASM binary parser ──

function parseModule(bytes) {
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6D)
    throw new Error('Invalid WASM magic');
  var version = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  var mod = {
    version: version,
    types: [],
    imports: [],
    funcTypeIndices: [],
    tables: [],
    memories: [],
    globals: [],
    exports: [],
    start: -1,
    elements: [],
    codes: [],
    datas: [],
    numFuncImports: 0,
    numGlobalImports: 0,
    numTableImports: 0,
    numMemoryImports: 0,
    names: { func: {}, local: {}, global: {} },
  };

  var pos = 8;
  while (pos < bytes.length) {
    var secId = bytes[pos++];
    var r = readLebU32(bytes, pos);
    var secSize = r.value; pos = r.pos;
    var secEnd = pos + secSize;

    switch (secId) {
    case 1: { // Type
      r = readLebU32(bytes, pos); var count = r.value; pos = r.pos;
      for (var i = 0; i < count; i++) {
        pos++; // 0x60 func type
        r = readLebU32(bytes, pos); var pc = r.value; pos = r.pos;
        var params = [];
        for (var j = 0; j < pc; j++) { params.push(bytes[pos++]); }
        r = readLebU32(bytes, pos); var rc = r.value; pos = r.pos;
        var results = [];
        for (var j = 0; j < rc; j++) { results.push(bytes[pos++]); }
        mod.types.push({ params: params, results: results });
      }
      break;
    }
    case 2: { // Import
      r = readLebU32(bytes, pos); var count = r.value; pos = r.pos;
      for (var i = 0; i < count; i++) {
        r = readName(bytes, pos); var modName = r.value; pos = r.pos;
        r = readName(bytes, pos); var fieldName = r.value; pos = r.pos;
        var kind = bytes[pos++];
        var imp = { module: modName, name: fieldName, kind: kind };
        if (kind === 0) { // func
          r = readLebU32(bytes, pos); imp.typeIdx = r.value; pos = r.pos;
          mod.numFuncImports++;
        } else if (kind === 1) { // table
          imp.elemType = bytes[pos++];
          r = readLebU32(bytes, pos); var flags = r.value; pos = r.pos;
          r = readLebU32(bytes, pos); imp.initial = r.value; pos = r.pos;
          if (flags & 1) { r = readLebU32(bytes, pos); imp.max = r.value; pos = r.pos; }
          mod.numTableImports++;
        } else if (kind === 2) { // memory
          r = readLebU32(bytes, pos); var flags = r.value; pos = r.pos;
          r = readLebU32(bytes, pos); imp.initial = r.value; pos = r.pos;
          if (flags & 1) { r = readLebU32(bytes, pos); imp.max = r.value; pos = r.pos; }
          mod.numMemoryImports++;
        } else if (kind === 3) { // global
          imp.valType = bytes[pos++]; imp.mutable = bytes[pos++];
          mod.numGlobalImports++;
        }
        mod.imports.push(imp);
      }
      break;
    }
    case 3: { // Function
      r = readLebU32(bytes, pos); var count = r.value; pos = r.pos;
      for (var i = 0; i < count; i++) {
        r = readLebU32(bytes, pos); mod.funcTypeIndices.push(r.value); pos = r.pos;
      }
      break;
    }
    case 4: { // Table
      r = readLebU32(bytes, pos); var count = r.value; pos = r.pos;
      for (var i = 0; i < count; i++) {
        var elemType = bytes[pos++];
        r = readLebU32(bytes, pos); var flags = r.value; pos = r.pos;
        r = readLebU32(bytes, pos); var initial = r.value; pos = r.pos;
        var max = -1;
        if (flags & 1) { r = readLebU32(bytes, pos); max = r.value; pos = r.pos; }
        mod.tables.push({ elemType: elemType, initial: initial, max: max });
      }
      break;
    }
    case 5: { // Memory
      r = readLebU32(bytes, pos); var count = r.value; pos = r.pos;
      for (var i = 0; i < count; i++) {
        r = readLebU32(bytes, pos); var flags = r.value; pos = r.pos;
        r = readLebU32(bytes, pos); var initial = r.value; pos = r.pos;
        var max = -1;
        if (flags & 1) { r = readLebU32(bytes, pos); max = r.value; pos = r.pos; }
        mod.memories.push({ initial: initial, max: max });
      }
      break;
    }
    case 6: { // Global
      r = readLebU32(bytes, pos); var count = r.value; pos = r.pos;
      for (var i = 0; i < count; i++) {
        var valType = bytes[pos++];
        var mutable = bytes[pos++];
        var initResult = evalInitExpr(bytes, pos);
        mod.globals.push({ valType: valType, mutable: mutable, init: initResult.value });
        pos = initResult.pos;
      }
      break;
    }
    case 7: { // Export
      r = readLebU32(bytes, pos); var count = r.value; pos = r.pos;
      for (var i = 0; i < count; i++) {
        r = readName(bytes, pos); var name = r.value; pos = r.pos;
        var kind = bytes[pos++];
        r = readLebU32(bytes, pos); var idx = r.value; pos = r.pos;
        mod.exports.push({ name: name, kind: kind, index: idx });
      }
      break;
    }
    case 8: { // Start
      r = readLebU32(bytes, pos); mod.start = r.value; pos = r.pos;
      break;
    }
    case 9: { // Element
      r = readLebU32(bytes, pos); var count = r.value; pos = r.pos;
      for (var i = 0; i < count; i++) {
        var flags = bytes[pos++];
        if (flags === 0) {
          var offsetResult = evalInitExpr(bytes, pos);
          pos = offsetResult.pos;
          r = readLebU32(bytes, pos); var funcCount = r.value; pos = r.pos;
          var funcIndices = [];
          for (var j = 0; j < funcCount; j++) {
            r = readLebU32(bytes, pos); funcIndices.push(r.value); pos = r.pos;
          }
          mod.elements.push({ tableIdx: 0, offset: offsetResult.value, funcIndices: funcIndices });
        } else {
          // Skip other element kinds for now
          break;
        }
      }
      break;
    }
    case 10: { // Code
      r = readLebU32(bytes, pos); var count = r.value; pos = r.pos;
      for (var i = 0; i < count; i++) {
        r = readLebU32(bytes, pos); var bodySize = r.value; pos = r.pos;
        var bodyStart = pos;
        var bodyEnd = pos + bodySize;
        // Parse locals
        r = readLebU32(bytes, pos); var localDeclCount = r.value; pos = r.pos;
        var locals = [];
        for (var j = 0; j < localDeclCount; j++) {
          r = readLebU32(bytes, pos); var lcount = r.value; pos = r.pos;
          var ltype = bytes[pos++];
          for (var k = 0; k < lcount; k++) locals.push(ltype);
        }
        mod.codes.push({
          locals: locals,
          codeStart: pos,
          codeEnd: bodyEnd - 1, // exclude final 'end' opcode
          bytes: bytes,
        });
        pos = bodyEnd;
      }
      break;
    }
    case 11: { // Data
      r = readLebU32(bytes, pos); var count = r.value; pos = r.pos;
      for (var i = 0; i < count; i++) {
        var flags = bytes[pos++];
        if (flags === 0) {
          var offsetResult = evalInitExpr(bytes, pos);
          pos = offsetResult.pos;
          r = readLebU32(bytes, pos); var size = r.value; pos = r.pos;
          mod.datas.push({ memIdx: 0, offset: offsetResult.value, data: bytes.subarray(pos, pos + size) });
          pos += size;
        } else if (flags === 1) {
          r = readLebU32(bytes, pos); var size = r.value; pos = r.pos;
          mod.datas.push({ memIdx: -1, data: bytes.subarray(pos, pos + size) });
          pos += size;
        } else {
          break;
        }
      }
      break;
    }
    case 0: { // Custom section — parse "name" section
      var custStart = pos;
      r = readName(bytes, pos); var custName = r.value; pos = r.pos;
      if (custName === 'name') {
        while (pos < secEnd) {
          var subId = bytes[pos++];
          r = readLebU32(bytes, pos); var subSize = r.value; pos = r.pos;
          var subEnd = pos + subSize;
          if (subId === 1) { // function names
            r = readLebU32(bytes, pos); var nc = r.value; pos = r.pos;
            for (var ni = 0; ni < nc; ni++) {
              r = readLebU32(bytes, pos); var idx = r.value; pos = r.pos;
              r = readName(bytes, pos); mod.names.func[idx] = r.value; pos = r.pos;
            }
          } else if (subId === 2) { // local names
            r = readLebU32(bytes, pos); var fc = r.value; pos = r.pos;
            for (var fi = 0; fi < fc; fi++) {
              r = readLebU32(bytes, pos); var funcIdx = r.value; pos = r.pos;
              r = readLebU32(bytes, pos); var lc = r.value; pos = r.pos;
              var lnames = {};
              for (var li = 0; li < lc; li++) {
                r = readLebU32(bytes, pos); var lidx = r.value; pos = r.pos;
                r = readName(bytes, pos); lnames[lidx] = r.value; pos = r.pos;
              }
              mod.names.local[funcIdx] = lnames;
            }
          } else if (subId === 7) { // global names
            r = readLebU32(bytes, pos); var nc = r.value; pos = r.pos;
            for (var ni = 0; ni < nc; ni++) {
              r = readLebU32(bytes, pos); var idx = r.value; pos = r.pos;
              r = readName(bytes, pos); mod.names.global[idx] = r.value; pos = r.pos;
            }
          }
          pos = subEnd;
        }
      }
      break;
    }
    }
    pos = secEnd;
  }
  return mod;
}

function evalInitExpr(bytes, pos) {
  var op = bytes[pos++];
  var r;
  if (op === 0x41) { // i32.const
    r = readLebI32(bytes, pos);
    pos = r.pos; pos++; // skip 0x0B end
    return { value: r.value, pos: pos };
  } else if (op === 0x42) { // i64.const
    r = readLebI64(bytes, pos);
    pos = r.pos; pos++;
    return { value: r.value, pos: pos };
  } else if (op === 0x43) { // f32.const
    r = readF32(bytes, pos);
    pos = r.pos; pos++;
    return { value: r.value, pos: pos };
  } else if (op === 0x44) { // f64.const
    r = readF64(bytes, pos);
    pos = r.pos; pos++;
    return { value: r.value, pos: pos };
  } else if (op === 0x23) { // global.get
    r = readLebU32(bytes, pos);
    pos = r.pos; pos++;
    return { value: { globalRef: r.value }, pos: pos };
  } else if (op === 0xD0) { // ref.null
    pos++; // skip type
    pos++; // skip end
    return { value: null, pos: pos };
  }
  // skip to end
  while (bytes[pos] !== 0x0B) pos++;
  pos++;
  return { value: 0, pos: pos };
}

// ── Block scanner ──
// Pre-scan a function's code to build a map: offset → target offset for
// block/loop/if/else. This lets br/br_if jump efficiently.

function scanBlocks(code) {
  var bytes = code.bytes;
  var pos = code.codeStart;
  var end = code.codeEnd + 1;
  var blockStack = [];
  var map = {}; // offset → { end, else_, isLoop }

  while (pos < end) {
    var instrOff = pos;
    var op = bytes[pos++];

    if (op === 0x02 || op === 0x03 || op === 0x04) { // block, loop, if
      // skip block type
      var bt = readLebI32(bytes, pos); pos = bt.pos;
      blockStack.push({ op: op, offset: instrOff });
    } else if (op === 0x05) { // else
      var top = blockStack[blockStack.length - 1];
      if (top) {
        if (!map[top.offset]) map[top.offset] = {};
        map[top.offset].else_ = pos; // else body starts here
        top.elseOffset = instrOff;
      }
    } else if (op === 0x0B) { // end
      var top = blockStack.pop();
      if (top) {
        if (!map[top.offset]) map[top.offset] = {};
        map[top.offset].end = pos;
        map[top.offset].isLoop = (top.op === 0x03);
        if (top.elseOffset !== undefined) {
          if (!map[top.elseOffset]) map[top.elseOffset] = {};
          map[top.elseOffset].end = pos;
        }
      }
    } else if (op === 0x1F) { // try_table
      var bt = readLebI32(bytes, pos); pos = bt.pos;
      var r = readLebU32(bytes, pos); var catchCount = r.value; pos = r.pos;
      for (var ci = 0; ci < catchCount; ci++) {
        pos++; // catch kind
        var kind = bytes[pos - 1];
        if (kind === 0x00 || kind === 0x01) { // catch, catch_ref
          var r2 = readLebU32(bytes, pos); pos = r2.pos; // tag index
        }
        var r3 = readLebU32(bytes, pos); pos = r3.pos; // label
      }
      blockStack.push({ op: op, offset: instrOff });
    } else {
      // skip immediates
      pos = skipImmediates(bytes, pos, op);
    }
  }
  return map;
}

function skipImmediates(bytes, pos, op) {
  var r;
  if (op === 0x0C || op === 0x0D) { // br, br_if
    r = readLebU32(bytes, pos); return r.pos;
  } else if (op === 0x0E) { // br_table
    r = readLebU32(bytes, pos); var count = r.value; pos = r.pos;
    for (var i = 0; i <= count; i++) { r = readLebU32(bytes, pos); pos = r.pos; }
    return pos;
  } else if (op === 0x10 || op === 0xD2) { // call, ref.func
    r = readLebU32(bytes, pos); return r.pos;
  } else if (op === 0x11) { // call_indirect
    r = readLebU32(bytes, pos); pos = r.pos;
    r = readLebU32(bytes, pos); return r.pos;
  } else if (op === 0x20 || op === 0x21 || op === 0x22) { // local.get/set/tee
    r = readLebU32(bytes, pos); return r.pos;
  } else if (op === 0x23 || op === 0x24) { // global.get/set
    r = readLebU32(bytes, pos); return r.pos;
  } else if (op === 0x25 || op === 0x26) { // table.get/set
    r = readLebU32(bytes, pos); return r.pos;
  } else if (op >= 0x28 && op <= 0x3E) { // memory load/store
    r = readLebU32(bytes, pos); pos = r.pos; // align
    r = readLebU32(bytes, pos); return r.pos; // offset
  } else if (op === 0x3F || op === 0x40) { // memory.size/grow
    return pos + 1; // skip 0x00
  } else if (op === 0x41) { // i32.const
    r = readLebI32(bytes, pos); return r.pos;
  } else if (op === 0x42) { // i64.const
    r = readLebI64(bytes, pos); return r.pos;
  } else if (op === 0x43) { // f32.const
    return pos + 4;
  } else if (op === 0x44) { // f64.const
    return pos + 8;
  } else if (op === 0xD0) { // ref.null
    return pos + 1;
  } else if (op === 0x1C) { // select typed
    r = readLebU32(bytes, pos); var count = r.value; pos = r.pos;
    return pos + count;
  } else if (op === 0x08) { // throw
    r = readLebU32(bytes, pos); return r.pos;
  } else if (op === 0xFC) { // multi-byte prefix
    r = readLebU32(bytes, pos); var sub = r.value; pos = r.pos;
    if (sub === 0x0A) { // memory.copy
      return pos + 2; // src mem, dst mem
    } else if (sub === 0x0B) { // memory.fill
      return pos + 1; // mem idx
    }
    return pos;
  }
  return pos;
}

// ── Value helpers ──

var I32 = 0x7F, I64 = 0x7E, F32 = 0x7D, F64 = 0x7C;

function valDefault(type) {
  if (type === I64) return 0n;
  return 0;
}

function i32(v) { return v | 0; }
function u32(v) { return v >>> 0; }
function i64(v) { return BigInt.asIntN(64, BigInt(v)); }
function u64(v) { return BigInt.asUintN(64, BigInt(v)); }
function f32(v) { return Math.fround(v); }

function typeName(t) {
  if (t === I32) return 'i32';
  if (t === I64) return 'i64';
  if (t === F32) return 'f32';
  if (t === F64) return 'f64';
  return '?';
}

// ── Interpreter ──

function Interpreter(mod, hostImports) {
  this.mod = mod;
  this.hostImports = hostImports || {};

  // Resolve imports
  this.funcTable = []; // indexed by funcIdx: { type: 'host'|'wasm', ... }
  this.globalValues = [];
  this.globalTypes = [];

  // Import functions
  for (var i = 0; i < mod.imports.length; i++) {
    var imp = mod.imports[i];
    if (imp.kind === 0) { // func
      var hostMod = this.hostImports[imp.module];
      var hostFn = hostMod && hostMod[imp.name];
      this.funcTable.push({
        type: 'host',
        fn: hostFn || null,
        typeIdx: imp.typeIdx,
        name: imp.module + '.' + imp.name,
      });
    } else if (imp.kind === 3) { // global
      this.globalValues.push(valDefault(imp.valType));
      this.globalTypes.push({ valType: imp.valType, mutable: imp.mutable });
    }
  }

  // Module functions
  for (var i = 0; i < mod.funcTypeIndices.length; i++) {
    this.funcTable.push({
      type: 'wasm',
      codeIdx: i,
      typeIdx: mod.funcTypeIndices[i],
    });
  }

  // Module globals
  for (var i = 0; i < mod.globals.length; i++) {
    var g = mod.globals[i];
    var val = g.init;
    if (val && typeof val === 'object' && val.globalRef !== undefined) {
      val = this.globalValues[val.globalRef];
    }
    this.globalValues.push(val !== undefined ? val : valDefault(g.valType));
    this.globalTypes.push({ valType: g.valType, mutable: g.mutable });
  }

  // Memory
  var memPages = 0;
  if (mod.memories.length > 0) {
    memPages = mod.memories[0].initial;
  }
  this.memoryBuffer = new ArrayBuffer(memPages * 65536);
  this.memoryView = new DataView(this.memoryBuffer);
  this.memoryPages = memPages;
  this.memoryMaxPages = mod.memories.length > 0 && mod.memories[0].max >= 0 ? mod.memories[0].max : 65536;

  // Initialize memory from data segments
  for (var i = 0; i < mod.datas.length; i++) {
    var seg = mod.datas[i];
    if (seg.memIdx === 0) {
      var dest = new Uint8Array(this.memoryBuffer);
      dest.set(seg.data, seg.offset);
    }
  }

  // Function table (indirect calls)
  var tableSize = 0;
  if (mod.tables.length > 0) tableSize = mod.tables[0].initial;
  this.indirectTable = new Array(tableSize).fill(-1);
  for (var i = 0; i < mod.elements.length; i++) {
    var elem = mod.elements[i];
    for (var j = 0; j < elem.funcIndices.length; j++) {
      this.indirectTable[elem.offset + j] = elem.funcIndices[j];
    }
  }

  // Block maps: codeIdx → offset map
  this._blockMaps = {};

  // Execution state
  this.stack = [];     // operand stack: raw values (number or BigInt)
  this.callStack = []; // frames: { funcIdx, codeIdx, locals, pc, labelStack, savedStackHeight }
  this.status = 'ready'; // ready, running, paused, done, trapped
  this.trapMessage = '';
  this.exitCode = 0;
  this.stepCount = 0;
  this.breakpoints = {}; // offset → true
  this.stdout = [];

  // Export map
  this.exportMap = {};
  for (var i = 0; i < mod.exports.length; i++) {
    this.exportMap[mod.exports[i].name] = mod.exports[i];
  }
}

Interpreter.prototype._getBlockMap = function(codeIdx) {
  if (!this._blockMaps[codeIdx]) {
    this._blockMaps[codeIdx] = scanBlocks(this.mod.codes[codeIdx]);
  }
  return this._blockMaps[codeIdx];
};

Interpreter.prototype._trap = function(msg) {
  this.status = 'trapped';
  this.trapMessage = msg;
};

Interpreter.prototype._growMemory = function(pages) {
  var newPages = this.memoryPages + pages;
  if (newPages > this.memoryMaxPages) return -1;
  var old = this.memoryPages;
  var newBuf = new ArrayBuffer(newPages * 65536);
  new Uint8Array(newBuf).set(new Uint8Array(this.memoryBuffer));
  this.memoryBuffer = newBuf;
  this.memoryView = new DataView(this.memoryBuffer);
  this.memoryPages = newPages;
  return old;
};

// Read memory helpers for host import implementations
Interpreter.prototype.readMemoryBytes = function(ptr, len) {
  return new Uint8Array(this.memoryBuffer, ptr, len);
};

Interpreter.prototype.readCString = function(ptr) {
  var bytes = new Uint8Array(this.memoryBuffer);
  var end = ptr;
  while (end < bytes.length && bytes[end] !== 0) end++;
  var decoder = new TextDecoder('utf-8');
  return decoder.decode(bytes.subarray(ptr, end));
};

Interpreter.prototype.writeMemoryBytes = function(ptr, data) {
  new Uint8Array(this.memoryBuffer).set(data, ptr);
};

// ── Function calls ──

Interpreter.prototype._callFunc = function(funcIdx, args) {
  var entry = this.funcTable[funcIdx];
  if (!entry) { this._trap('Call to undefined function ' + funcIdx); return; }

  if (entry.type === 'host') {
    if (!entry.fn) { this._trap('Unresolved import: ' + entry.name); return; }
    var result = entry.fn.apply(this, args);
    var sig = this.mod.types[entry.typeIdx];
    if (sig.results.length > 0 && result !== undefined) {
      this.stack.push(sig.results[0] === I64 ? BigInt(result) : result);
    }
    return;
  }

  // WASM function
  var codeIdx = entry.codeIdx;
  var code = this.mod.codes[codeIdx];
  var sig = this.mod.types[entry.typeIdx];

  // Build locals: params + declared locals
  var locals = [];
  for (var i = 0; i < sig.params.length; i++) {
    locals.push(i < args.length ? args[i] : valDefault(sig.params[i]));
  }
  for (var i = 0; i < code.locals.length; i++) {
    locals.push(valDefault(code.locals[i]));
  }

  this.callStack.push({
    funcIdx: funcIdx,
    codeIdx: codeIdx,
    locals: locals,
    pc: code.codeStart,
    labelStack: [{ arity: sig.results.length, target: code.codeEnd + 1, isLoop: false }],
    savedStackHeight: this.stack.length,
  });
};

Interpreter.prototype._returnFromFunc = function() {
  var frame = this.callStack.pop();
  var sig = this.mod.types[this.funcTable[frame.funcIdx].typeIdx];
  var results = [];
  for (var i = 0; i < sig.results.length; i++) {
    results.unshift(this.stack.pop());
  }
  // Restore stack to saved height
  this.stack.length = frame.savedStackHeight;
  for (var i = 0; i < results.length; i++) {
    this.stack.push(results[i]);
  }
};

// ── Entry points ──

Interpreter.prototype.start = function(exportName, args) {
  var exp = this.exportMap[exportName];
  if (!exp || exp.kind !== 0) throw new Error('Export "' + exportName + '" not found or not a function');
  this.callStack = [];
  this.stack = [];
  this.status = 'running';
  this.stepCount = 0;
  this.stdout = [];
  this._callFunc(exp.index, args || []);
};

Interpreter.prototype.reset = function() {
  this.callStack = [];
  this.stack = [];
  this.status = 'ready';
  this.stepCount = 0;
  this.trapMessage = '';
  this.stdout = [];
};

// ── Breakpoints ──

Interpreter.prototype.setBreakpoint = function(offset) {
  this.breakpoints[offset] = true;
};

Interpreter.prototype.removeBreakpoint = function(offset) {
  delete this.breakpoints[offset];
};

Interpreter.prototype.toggleBreakpoint = function(offset) {
  if (this.breakpoints[offset]) delete this.breakpoints[offset];
  else this.breakpoints[offset] = true;
};

// ── State inspection ──
// Returns the state the UI needs to highlight current instruction and
// display variable values. The `offset` field matches the disasm JSON's
// instruction offset, enabling direct DOM lookup.

Interpreter.prototype.getState = function() {
  if (this.callStack.length === 0) {
    var doneStack = [];
    for (var i = 0; i < this.stack.length; i++) {
      var v = this.stack[i];
      doneStack.push({ value: v, type: typeof v === 'bigint' ? 'i64' : 'number' });
    }
    return {
      status: this.status,
      funcIndex: -1,
      offset: -1,
      locals: [],
      stack: doneStack,
      globals: this._getGlobalsSnapshot(),
      callDepth: 0,
      callStack: [],
      stepCount: this.stepCount,
      trapMessage: this.trapMessage,
      exitCode: this.exitCode,
      stdout: this.stdout.join(''),
    };
  }
  var frame = this.callStack[this.callStack.length - 1];
  var funcEntry = this.funcTable[frame.funcIdx];
  var sig = this.mod.types[funcEntry.typeIdx];
  var localNames = this.mod.names.local[frame.funcIdx] || {};

  var locals = [];
  for (var i = 0; i < frame.locals.length; i++) {
    var isParam = i < sig.params.length;
    var type = isParam ? sig.params[i] : this.mod.codes[frame.codeIdx].locals[i - sig.params.length];
    locals.push({
      index: i,
      type: typeName(type),
      name: localNames[i] || null,
      value: frame.locals[i],
      isParam: isParam,
    });
  }

  var stackDisplay = [];
  for (var i = 0; i < this.stack.length; i++) {
    var v = this.stack[i];
    stackDisplay.push({ value: v, type: typeof v === 'bigint' ? 'i64' : 'number' });
  }

  var callStackDisplay = [];
  for (var i = 0; i < this.callStack.length; i++) {
    var f = this.callStack[i];
    callStackDisplay.push({
      funcIndex: f.funcIdx,
      name: this.mod.names.func[f.funcIdx] || ('func[' + f.funcIdx + ']'),
      offset: f.pc,
    });
  }

  return {
    status: this.status,
    funcIndex: frame.funcIdx,
    offset: frame.pc,
    locals: locals,
    stack: stackDisplay,
    globals: this._getGlobalsSnapshot(),
    callDepth: this.callStack.length,
    callStack: callStackDisplay,
    stepCount: this.stepCount,
    trapMessage: this.trapMessage,
    exitCode: this.exitCode,
    stdout: this.stdout.join(''),
  };
};

Interpreter.prototype.getFrameLocals = function(depth) {
  if (depth < 0 || depth >= this.callStack.length) return [];
  var frame = this.callStack[depth];
  var funcEntry = this.funcTable[frame.funcIdx];
  var sig = this.mod.types[funcEntry.typeIdx];
  var localNames = this.mod.names.local[frame.funcIdx] || {};
  var locals = [];
  for (var i = 0; i < frame.locals.length; i++) {
    var isParam = i < sig.params.length;
    var type = isParam ? sig.params[i] : this.mod.codes[frame.codeIdx].locals[i - sig.params.length];
    locals.push({
      index: i,
      type: typeName(type),
      name: localNames[i] || null,
      value: frame.locals[i],
      isParam: isParam,
    });
  }
  return locals;
};

Interpreter.prototype._getGlobalsSnapshot = function() {
  var result = [];
  for (var i = 0; i < this.globalValues.length; i++) {
    result.push({
      index: i,
      name: this.mod.names.global[i] || null,
      value: this.globalValues[i],
      mutable: this.globalTypes[i].mutable,
      type: typeName(this.globalTypes[i].valType),
    });
  }
  return result;
};

// ── Step / Run ──

Interpreter.prototype.step = function() {
  if (this.status !== 'running' && this.status !== 'paused') return this.status;
  this.status = 'running';
  this._execOne();
  return this.status;
};

Interpreter.prototype.stepOver = function() {
  if (this.status !== 'running' && this.status !== 'paused') return this.status;
  this.status = 'running';
  var depth = this.callStack.length;
  this._execOne();
  while (this.status === 'running' && this.callStack.length > depth) {
    this._execOne();
  }
  if (this.status === 'running') this.status = 'paused';
  return this.status;
};

Interpreter.prototype.stepOut = function() {
  if (this.status !== 'running' && this.status !== 'paused') return this.status;
  this.status = 'running';
  var depth = this.callStack.length;
  while (this.status === 'running' && this.callStack.length >= depth) {
    this._execOne();
  }
  if (this.status === 'running') this.status = 'paused';
  return this.status;
};

Interpreter.prototype.run = function(maxSteps) {
  if (this.status !== 'running' && this.status !== 'paused') return this.status;
  this.status = 'running';
  maxSteps = maxSteps || 100000;
  for (var i = 0; i < maxSteps && this.status === 'running'; i++) {
    this._execOne();
    if (this.status === 'running' && this.callStack.length > 0) {
      var frame = this.callStack[this.callStack.length - 1];
      if (this.breakpoints[frame.pc]) {
        this.status = 'paused';
        return this.status;
      }
    }
  }
  if (this.status === 'running') this.status = 'paused';
  return this.status;
};

// ── Core execution ──

Interpreter.prototype._execOne = function() {
  if (this.callStack.length === 0) { this.status = 'done'; return; }

  var frame = this.callStack[this.callStack.length - 1];
  var code = this.mod.codes[frame.codeIdx];
  var bytes = code.bytes;
  var blockMap = this._getBlockMap(frame.codeIdx);
  var stack = this.stack;

  if (frame.pc > code.codeEnd) {
    this._returnFromFunc();
    if (this.callStack.length === 0) this.status = 'done';
    this.stepCount++;
    return;
  }

  var instrOffset = frame.pc;
  var op = bytes[frame.pc++];
  var r, a, b, v, addr, align, offset, idx;

  this.stepCount++;

  switch (op) {
  // ── Control ──
  case 0x00: // unreachable
    this._trap('unreachable executed at offset 0x' + instrOffset.toString(16));
    return;
  case 0x01: // nop
    break;
  case 0x02: // block
  case 0x03: // loop
  case 0x04: { // if
    var bt = readLebI32(bytes, frame.pc); frame.pc = bt.pos;
    var blockInfo = blockMap[instrOffset];
    var arity = 0;
    if (bt.value >= 0) {
      // type index
      arity = this.mod.types[bt.value].results.length;
    } else {
      var vt = bt.value & 0x7F;
      arity = (vt === 0x40) ? 0 : 1;
    }

    if (op === 0x04) { // if
      var cond = stack.pop();
      if (!cond) {
        // branch to else or end
        if (blockInfo && blockInfo.else_) {
          frame.pc = blockInfo.else_;
          frame.labelStack.push({ arity: arity, target: blockInfo.end, isLoop: false, height: stack.length });
        } else if (blockInfo) {
          frame.pc = blockInfo.end;
        }
        break;
      }
    }
    if (blockInfo) {
      var target = (op === 0x03) ? instrOffset : blockInfo.end;
      frame.labelStack.push({
        arity: arity,
        target: target,
        isLoop: (op === 0x03),
        loopPc: (op === 0x03) ? frame.pc : 0,
        height: stack.length,
      });
    }
    break;
  }
  case 0x05: { // else
    frame.labelStack.pop();
    var blockInfo = blockMap[instrOffset];
    if (blockInfo) frame.pc = blockInfo.end;
    break;
  }
  case 0x0B: { // end
    var label = frame.labelStack.pop();
    if (frame.labelStack.length === 0) {
      // function end
      this._returnFromFunc();
      if (this.callStack.length === 0) this.status = 'done';
      return;
    }
    break;
  }
  case 0x0C: { // br
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    this._branch(frame, r.value);
    break;
  }
  case 0x0D: { // br_if
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    if (stack.pop()) this._branch(frame, r.value);
    break;
  }
  case 0x0E: { // br_table
    r = readLebU32(bytes, frame.pc); var count = r.value; frame.pc = r.pos;
    var labels = [];
    for (var i = 0; i <= count; i++) {
      r = readLebU32(bytes, frame.pc); labels.push(r.value); frame.pc = r.pos;
    }
    var index = stack.pop() >>> 0;
    var target = index < count ? labels[index] : labels[count];
    this._branch(frame, target);
    break;
  }
  case 0x0F: { // return
    this._returnFromFunc();
    if (this.callStack.length === 0) this.status = 'done';
    return;
  }
  case 0x10: { // call
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    var funcIdx = r.value;
    var sig = this.mod.types[this.funcTable[funcIdx].typeIdx];
    var args = [];
    for (var i = 0; i < sig.params.length; i++) args.unshift(stack.pop());
    this._callFunc(funcIdx, args);
    break;
  }
  case 0x11: { // call_indirect
    r = readLebU32(bytes, frame.pc); var typeIdx = r.value; frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos; // table index
    var tableIdx = stack.pop() >>> 0;
    if (tableIdx >= this.indirectTable.length || this.indirectTable[tableIdx] < 0) {
      this._trap('call_indirect: out of bounds table access at index ' + tableIdx);
      return;
    }
    var funcIdx = this.indirectTable[tableIdx];
    var sig = this.mod.types[typeIdx];
    var args = [];
    for (var i = 0; i < sig.params.length; i++) args.unshift(stack.pop());
    this._callFunc(funcIdx, args);
    break;
  }

  // ── Parametric ──
  case 0x1A: // drop
    stack.pop();
    break;
  case 0x1B: { // select
    var c = stack.pop(); b = stack.pop(); a = stack.pop();
    stack.push(c ? a : b);
    break;
  }
  case 0x1C: { // select typed
    r = readLebU32(bytes, frame.pc); var count = r.value; frame.pc = r.pos;
    frame.pc += count; // skip type bytes
    var c = stack.pop(); b = stack.pop(); a = stack.pop();
    stack.push(c ? a : b);
    break;
  }

  // ── Variable ──
  case 0x20: // local.get
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    stack.push(frame.locals[r.value]);
    break;
  case 0x21: // local.set
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    frame.locals[r.value] = stack.pop();
    break;
  case 0x22: // local.tee
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    frame.locals[r.value] = stack[stack.length - 1];
    break;
  case 0x23: // global.get
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    stack.push(this.globalValues[r.value]);
    break;
  case 0x24: // global.set
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    this.globalValues[r.value] = stack.pop();
    break;

  // ── Memory load ──
  case 0x28: // i32.load
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(this.memoryView.getInt32(addr, true));
    break;
  case 0x29: // i64.load
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(this.memoryView.getBigInt64(addr, true));
    break;
  case 0x2A: // f32.load
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(this.memoryView.getFloat32(addr, true));
    break;
  case 0x2B: // f64.load
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(this.memoryView.getFloat64(addr, true));
    break;
  case 0x2C: // i32.load8_s
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(this.memoryView.getInt8(addr));
    break;
  case 0x2D: // i32.load8_u
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(this.memoryView.getUint8(addr));
    break;
  case 0x2E: // i32.load16_s
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(this.memoryView.getInt16(addr, true));
    break;
  case 0x2F: // i32.load16_u
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(this.memoryView.getUint16(addr, true));
    break;
  case 0x30: // i64.load8_s
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(BigInt(this.memoryView.getInt8(addr)));
    break;
  case 0x31: // i64.load8_u
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(BigInt(this.memoryView.getUint8(addr)));
    break;
  case 0x32: // i64.load16_s
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(BigInt(this.memoryView.getInt16(addr, true)));
    break;
  case 0x33: // i64.load16_u
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(BigInt(this.memoryView.getUint16(addr, true)));
    break;
  case 0x34: // i64.load32_s
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(BigInt(this.memoryView.getInt32(addr, true)));
    break;
  case 0x35: // i64.load32_u
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    addr = (stack.pop() >>> 0) + offset;
    stack.push(BigInt(this.memoryView.getUint32(addr, true)));
    break;

  // ── Memory store ──
  case 0x36: // i32.store
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    v = stack.pop(); addr = (stack.pop() >>> 0) + offset;
    this.memoryView.setInt32(addr, v, true);
    break;
  case 0x37: // i64.store
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    v = stack.pop(); addr = (stack.pop() >>> 0) + offset;
    this.memoryView.setBigInt64(addr, v, true);
    break;
  case 0x38: // f32.store
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    v = stack.pop(); addr = (stack.pop() >>> 0) + offset;
    this.memoryView.setFloat32(addr, v, true);
    break;
  case 0x39: // f64.store
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    v = stack.pop(); addr = (stack.pop() >>> 0) + offset;
    this.memoryView.setFloat64(addr, v, true);
    break;
  case 0x3A: // i32.store8
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    v = stack.pop(); addr = (stack.pop() >>> 0) + offset;
    this.memoryView.setUint8(addr, v & 0xFF);
    break;
  case 0x3B: // i32.store16
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    v = stack.pop(); addr = (stack.pop() >>> 0) + offset;
    this.memoryView.setUint16(addr, v & 0xFFFF, true);
    break;
  case 0x3C: // i64.store8
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    v = stack.pop(); addr = (stack.pop() >>> 0) + offset;
    this.memoryView.setUint8(addr, Number(v & 0xFFn));
    break;
  case 0x3D: // i64.store16
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    v = stack.pop(); addr = (stack.pop() >>> 0) + offset;
    this.memoryView.setUint16(addr, Number(v & 0xFFFFn), true);
    break;
  case 0x3E: // i64.store32
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    r = readLebU32(bytes, frame.pc); offset = r.value; frame.pc = r.pos;
    v = stack.pop(); addr = (stack.pop() >>> 0) + offset;
    this.memoryView.setUint32(addr, Number(v & 0xFFFFFFFFn), true);
    break;

  // ── Memory management ──
  case 0x3F: // memory.size
    frame.pc++; // skip 0x00
    stack.push(this.memoryPages);
    break;
  case 0x40: // memory.grow
    frame.pc++; // skip 0x00
    stack.push(this._growMemory(stack.pop()));
    break;

  // ── Constants ──
  case 0x41: // i32.const
    r = readLebI32(bytes, frame.pc); frame.pc = r.pos;
    stack.push(r.value);
    break;
  case 0x42: // i64.const
    r = readLebI64(bytes, frame.pc); frame.pc = r.pos;
    stack.push(r.value);
    break;
  case 0x43: // f32.const
    r = readF32(bytes, frame.pc); frame.pc = r.pos;
    stack.push(r.value);
    break;
  case 0x44: // f64.const
    r = readF64(bytes, frame.pc); frame.pc = r.pos;
    stack.push(r.value);
    break;

  // ── i32 comparison ──
  case 0x45: stack.push((stack.pop() === 0) ? 1 : 0); break; // i32.eqz
  case 0x46: b = stack.pop(); a = stack.pop(); stack.push((a === b) ? 1 : 0); break; // i32.eq
  case 0x47: b = stack.pop(); a = stack.pop(); stack.push((a !== b) ? 1 : 0); break; // i32.ne
  case 0x48: b = stack.pop(); a = stack.pop(); stack.push(((a | 0) < (b | 0)) ? 1 : 0); break; // i32.lt_s
  case 0x49: b = stack.pop(); a = stack.pop(); stack.push(((a >>> 0) < (b >>> 0)) ? 1 : 0); break; // i32.lt_u
  case 0x4A: b = stack.pop(); a = stack.pop(); stack.push(((a | 0) > (b | 0)) ? 1 : 0); break; // i32.gt_s
  case 0x4B: b = stack.pop(); a = stack.pop(); stack.push(((a >>> 0) > (b >>> 0)) ? 1 : 0); break; // i32.gt_u
  case 0x4C: b = stack.pop(); a = stack.pop(); stack.push(((a | 0) <= (b | 0)) ? 1 : 0); break; // i32.le_s
  case 0x4D: b = stack.pop(); a = stack.pop(); stack.push(((a >>> 0) <= (b >>> 0)) ? 1 : 0); break; // i32.le_u
  case 0x4E: b = stack.pop(); a = stack.pop(); stack.push(((a | 0) >= (b | 0)) ? 1 : 0); break; // i32.ge_s
  case 0x4F: b = stack.pop(); a = stack.pop(); stack.push(((a >>> 0) >= (b >>> 0)) ? 1 : 0); break; // i32.ge_u

  // ── i64 comparison ──
  case 0x50: stack.push((stack.pop() === 0n) ? 1 : 0); break; // i64.eqz
  case 0x51: b = stack.pop(); a = stack.pop(); stack.push((a === b) ? 1 : 0); break; // i64.eq
  case 0x52: b = stack.pop(); a = stack.pop(); stack.push((a !== b) ? 1 : 0); break; // i64.ne
  case 0x53: b = stack.pop(); a = stack.pop(); stack.push((BigInt.asIntN(64, a) < BigInt.asIntN(64, b)) ? 1 : 0); break; // i64.lt_s
  case 0x54: b = stack.pop(); a = stack.pop(); stack.push((BigInt.asUintN(64, a) < BigInt.asUintN(64, b)) ? 1 : 0); break; // i64.lt_u
  case 0x55: b = stack.pop(); a = stack.pop(); stack.push((BigInt.asIntN(64, a) > BigInt.asIntN(64, b)) ? 1 : 0); break; // i64.gt_s
  case 0x56: b = stack.pop(); a = stack.pop(); stack.push((BigInt.asUintN(64, a) > BigInt.asUintN(64, b)) ? 1 : 0); break; // i64.gt_u
  case 0x57: b = stack.pop(); a = stack.pop(); stack.push((BigInt.asIntN(64, a) <= BigInt.asIntN(64, b)) ? 1 : 0); break; // i64.le_s
  case 0x58: b = stack.pop(); a = stack.pop(); stack.push((BigInt.asUintN(64, a) <= BigInt.asUintN(64, b)) ? 1 : 0); break; // i64.le_u
  case 0x59: b = stack.pop(); a = stack.pop(); stack.push((BigInt.asIntN(64, a) >= BigInt.asIntN(64, b)) ? 1 : 0); break; // i64.ge_s
  case 0x5A: b = stack.pop(); a = stack.pop(); stack.push((BigInt.asUintN(64, a) >= BigInt.asUintN(64, b)) ? 1 : 0); break; // i64.ge_u

  // ── f32 comparison ──
  case 0x5B: b = stack.pop(); a = stack.pop(); stack.push((a === b) ? 1 : 0); break; // f32.eq
  case 0x5C: b = stack.pop(); a = stack.pop(); stack.push((a !== b) ? 1 : 0); break; // f32.ne
  case 0x5D: b = stack.pop(); a = stack.pop(); stack.push((a < b) ? 1 : 0); break; // f32.lt
  case 0x5E: b = stack.pop(); a = stack.pop(); stack.push((a > b) ? 1 : 0); break; // f32.gt
  case 0x5F: b = stack.pop(); a = stack.pop(); stack.push((a <= b) ? 1 : 0); break; // f32.le
  case 0x60: b = stack.pop(); a = stack.pop(); stack.push((a >= b) ? 1 : 0); break; // f32.ge

  // ── f64 comparison ──
  case 0x61: b = stack.pop(); a = stack.pop(); stack.push((a === b) ? 1 : 0); break; // f64.eq
  case 0x62: b = stack.pop(); a = stack.pop(); stack.push((a !== b) ? 1 : 0); break; // f64.ne
  case 0x63: b = stack.pop(); a = stack.pop(); stack.push((a < b) ? 1 : 0); break; // f64.lt
  case 0x64: b = stack.pop(); a = stack.pop(); stack.push((a > b) ? 1 : 0); break; // f64.gt
  case 0x65: b = stack.pop(); a = stack.pop(); stack.push((a <= b) ? 1 : 0); break; // f64.le
  case 0x66: b = stack.pop(); a = stack.pop(); stack.push((a >= b) ? 1 : 0); break; // f64.ge

  // ── i32 arithmetic ──
  case 0x67: stack.push(Math.clz32(stack.pop())); break; // i32.clz
  case 0x68: v = stack.pop() | 0; stack.push(v === 0 ? 32 : 31 - Math.clz32(v & -v)); break; // i32.ctz
  case 0x69: v = stack.pop() >>> 0; a = 0; while (v) { a += v & 1; v >>>= 1; } stack.push(a); break; // i32.popcnt
  case 0x6A: b = stack.pop(); a = stack.pop(); stack.push((a + b) | 0); break; // i32.add
  case 0x6B: b = stack.pop(); a = stack.pop(); stack.push((a - b) | 0); break; // i32.sub
  case 0x6C: b = stack.pop(); a = stack.pop(); stack.push(Math.imul(a, b)); break; // i32.mul
  case 0x6D: // i32.div_s
    b = stack.pop() | 0; a = stack.pop() | 0;
    if (b === 0) { this._trap('i32.div_s: division by zero'); return; }
    stack.push((a / b) | 0);
    break;
  case 0x6E: // i32.div_u
    b = stack.pop() >>> 0; a = stack.pop() >>> 0;
    if (b === 0) { this._trap('i32.div_u: division by zero'); return; }
    stack.push((a / b) >>> 0);
    break;
  case 0x6F: // i32.rem_s
    b = stack.pop() | 0; a = stack.pop() | 0;
    if (b === 0) { this._trap('i32.rem_s: division by zero'); return; }
    stack.push((a % b) | 0);
    break;
  case 0x70: // i32.rem_u
    b = stack.pop() >>> 0; a = stack.pop() >>> 0;
    if (b === 0) { this._trap('i32.rem_u: division by zero'); return; }
    stack.push((a % b) >>> 0);
    break;
  case 0x71: b = stack.pop(); a = stack.pop(); stack.push(a & b); break; // i32.and
  case 0x72: b = stack.pop(); a = stack.pop(); stack.push(a | b); break; // i32.or
  case 0x73: b = stack.pop(); a = stack.pop(); stack.push(a ^ b); break; // i32.xor
  case 0x74: b = stack.pop(); a = stack.pop(); stack.push((a << (b & 31)) | 0); break; // i32.shl
  case 0x75: b = stack.pop(); a = stack.pop(); stack.push((a | 0) >> (b & 31)); break; // i32.shr_s
  case 0x76: b = stack.pop(); a = stack.pop(); stack.push((a >>> (b & 31)) | 0); break; // i32.shr_u
  case 0x77: b = stack.pop() & 31; a = stack.pop() >>> 0; stack.push(((a << b) | (a >>> (32 - b))) | 0); break; // i32.rotl
  case 0x78: b = stack.pop() & 31; a = stack.pop() >>> 0; stack.push(((a >>> b) | (a << (32 - b))) | 0); break; // i32.rotr

  // ── i64 arithmetic ──
  case 0x79: { v = stack.pop(); a = 0n; var t = BigInt.asUintN(64, v); while (t > 0n && !(t & (1n << 63n))) { a++; t <<= 1n; } if (v === 0n) a = 64n; stack.push(a); break; } // i64.clz
  case 0x7A: { v = stack.pop(); if (v === 0n) { stack.push(64n); } else { a = 0n; var t = BigInt.asUintN(64, v); while (!(t & 1n)) { a++; t >>= 1n; } stack.push(a); } break; } // i64.ctz
  case 0x7B: { v = BigInt.asUintN(64, stack.pop()); a = 0n; while (v) { a += v & 1n; v >>= 1n; } stack.push(a); break; } // i64.popcnt
  case 0x7C: b = stack.pop(); a = stack.pop(); stack.push(BigInt.asIntN(64, a + b)); break; // i64.add
  case 0x7D: b = stack.pop(); a = stack.pop(); stack.push(BigInt.asIntN(64, a - b)); break; // i64.sub
  case 0x7E: b = stack.pop(); a = stack.pop(); stack.push(BigInt.asIntN(64, a * b)); break; // i64.mul
  case 0x7F: // i64.div_s
    b = stack.pop(); a = stack.pop();
    if (b === 0n) { this._trap('i64.div_s: division by zero'); return; }
    stack.push(BigInt.asIntN(64, a) / BigInt.asIntN(64, b));
    break;
  case 0x80: // i64.div_u
    b = stack.pop(); a = stack.pop();
    if (b === 0n) { this._trap('i64.div_u: division by zero'); return; }
    stack.push(BigInt.asUintN(64, a) / BigInt.asUintN(64, b));
    break;
  case 0x81: // i64.rem_s
    b = stack.pop(); a = stack.pop();
    if (b === 0n) { this._trap('i64.rem_s: division by zero'); return; }
    stack.push(BigInt.asIntN(64, a) % BigInt.asIntN(64, b));
    break;
  case 0x82: // i64.rem_u
    b = stack.pop(); a = stack.pop();
    if (b === 0n) { this._trap('i64.rem_u: division by zero'); return; }
    stack.push(BigInt.asUintN(64, a) % BigInt.asUintN(64, b));
    break;
  case 0x83: b = stack.pop(); a = stack.pop(); stack.push(a & b); break; // i64.and
  case 0x84: b = stack.pop(); a = stack.pop(); stack.push(a | b); break; // i64.or
  case 0x85: b = stack.pop(); a = stack.pop(); stack.push(a ^ b); break; // i64.xor
  case 0x86: b = stack.pop(); a = stack.pop(); stack.push(BigInt.asIntN(64, a << (b & 63n))); break; // i64.shl
  case 0x87: b = stack.pop(); a = stack.pop(); stack.push(BigInt.asIntN(64, a) >> (b & 63n)); break; // i64.shr_s
  case 0x88: b = stack.pop(); a = stack.pop(); stack.push(BigInt.asIntN(64, BigInt.asUintN(64, a) >> (b & 63n))); break; // i64.shr_u
  case 0x89: { b = stack.pop() & 63n; a = BigInt.asUintN(64, stack.pop()); stack.push(BigInt.asIntN(64, (a << b) | (a >> (64n - b)))); break; } // i64.rotl
  case 0x8A: { b = stack.pop() & 63n; a = BigInt.asUintN(64, stack.pop()); stack.push(BigInt.asIntN(64, (a >> b) | (a << (64n - b)))); break; } // i64.rotr

  // ── f32 arithmetic ──
  case 0x8B: stack.push(f32(Math.abs(stack.pop()))); break; // f32.abs
  case 0x8C: stack.push(f32(-stack.pop())); break; // f32.neg
  case 0x8D: stack.push(f32(Math.ceil(stack.pop()))); break; // f32.ceil
  case 0x8E: stack.push(f32(Math.floor(stack.pop()))); break; // f32.floor
  case 0x8F: stack.push(f32(Math.trunc(stack.pop()))); break; // f32.trunc
  case 0x90: stack.push(f32(Math.round(stack.pop()))); break; // f32.nearest
  case 0x91: stack.push(f32(Math.sqrt(stack.pop()))); break; // f32.sqrt
  case 0x92: b = stack.pop(); a = stack.pop(); stack.push(f32(a + b)); break; // f32.add
  case 0x93: b = stack.pop(); a = stack.pop(); stack.push(f32(a - b)); break; // f32.sub
  case 0x94: b = stack.pop(); a = stack.pop(); stack.push(f32(a * b)); break; // f32.mul
  case 0x95: b = stack.pop(); a = stack.pop(); stack.push(f32(a / b)); break; // f32.div
  case 0x96: b = stack.pop(); a = stack.pop(); stack.push(f32(Math.min(a, b))); break; // f32.min
  case 0x97: b = stack.pop(); a = stack.pop(); stack.push(f32(Math.max(a, b))); break; // f32.max
  case 0x98: { // f32.copysign
    b = stack.pop(); a = stack.pop();
    stack.push(f32(Math.sign(b) === 0 ? a : Math.abs(a) * Math.sign(b)));
    break;
  }

  // ── f64 arithmetic ──
  case 0x99: stack.push(Math.abs(stack.pop())); break; // f64.abs
  case 0x9A: stack.push(-stack.pop()); break; // f64.neg
  case 0x9B: stack.push(Math.ceil(stack.pop())); break; // f64.ceil
  case 0x9C: stack.push(Math.floor(stack.pop())); break; // f64.floor
  case 0x9D: stack.push(Math.trunc(stack.pop())); break; // f64.trunc
  case 0x9E: stack.push(Math.round(stack.pop())); break; // f64.nearest
  case 0x9F: stack.push(Math.sqrt(stack.pop())); break; // f64.sqrt
  case 0xA0: b = stack.pop(); a = stack.pop(); stack.push(a + b); break; // f64.add
  case 0xA1: b = stack.pop(); a = stack.pop(); stack.push(a - b); break; // f64.sub
  case 0xA2: b = stack.pop(); a = stack.pop(); stack.push(a * b); break; // f64.mul
  case 0xA3: b = stack.pop(); a = stack.pop(); stack.push(a / b); break; // f64.div
  case 0xA4: b = stack.pop(); a = stack.pop(); stack.push(Math.min(a, b)); break; // f64.min
  case 0xA5: b = stack.pop(); a = stack.pop(); stack.push(Math.max(a, b)); break; // f64.max
  case 0xA6: { // f64.copysign
    b = stack.pop(); a = stack.pop();
    stack.push(Math.sign(b) === 0 ? a : Math.abs(a) * Math.sign(b));
    break;
  }

  // ── Conversions ──
  case 0xA7: stack.push(Number(BigInt.asIntN(32, stack.pop())) | 0); break; // i32.wrap_i64
  case 0xA8: stack.push(Math.trunc(stack.pop()) | 0); break; // i32.trunc_f32_s
  case 0xA9: stack.push(Math.trunc(stack.pop()) >>> 0); break; // i32.trunc_f32_u
  case 0xAA: stack.push(Math.trunc(stack.pop()) | 0); break; // i32.trunc_f64_s
  case 0xAB: stack.push(Math.trunc(stack.pop()) >>> 0); break; // i32.trunc_f64_u
  case 0xAC: stack.push(BigInt(stack.pop() | 0)); break; // i64.extend_i32_s
  case 0xAD: stack.push(BigInt(stack.pop() >>> 0)); break; // i64.extend_i32_u
  case 0xAE: stack.push(BigInt(Math.trunc(stack.pop()))); break; // i64.trunc_f32_s
  case 0xAF: stack.push(BigInt.asUintN(64, BigInt(Math.trunc(stack.pop())))); break; // i64.trunc_f32_u
  case 0xB0: stack.push(BigInt(Math.trunc(stack.pop()))); break; // i64.trunc_f64_s
  case 0xB1: stack.push(BigInt.asUintN(64, BigInt(Math.trunc(stack.pop())))); break; // i64.trunc_f64_u
  case 0xB2: stack.push(f32(stack.pop() | 0)); break; // f32.convert_i32_s
  case 0xB3: stack.push(f32(stack.pop() >>> 0)); break; // f32.convert_i32_u
  case 0xB4: stack.push(f32(Number(BigInt.asIntN(64, stack.pop())))); break; // f32.convert_i64_s
  case 0xB5: stack.push(f32(Number(BigInt.asUintN(64, stack.pop())))); break; // f32.convert_i64_u
  case 0xB6: stack.push(f32(stack.pop())); break; // f32.demote_f64
  case 0xB7: stack.push(stack.pop() | 0); break; // f64.convert_i32_s — JS number is already f64
  case 0xB8: stack.push(stack.pop() >>> 0); break; // f64.convert_i32_u
  case 0xB9: stack.push(Number(BigInt.asIntN(64, stack.pop()))); break; // f64.convert_i64_s
  case 0xBA: stack.push(Number(BigInt.asUintN(64, stack.pop()))); break; // f64.convert_i64_u
  case 0xBB: stack.push(stack.pop()); break; // f64.promote_f32

  // ── Reinterpret ──
  case 0xBC: { // i32.reinterpret_f32
    var buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, stack.pop(), true);
    stack.push(new DataView(buf).getInt32(0, true));
    break;
  }
  case 0xBD: { // i64.reinterpret_f64
    var buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, stack.pop(), true);
    stack.push(new DataView(buf).getBigInt64(0, true));
    break;
  }
  case 0xBE: { // f32.reinterpret_i32
    var buf = new ArrayBuffer(4);
    new DataView(buf).setInt32(0, stack.pop(), true);
    stack.push(new DataView(buf).getFloat32(0, true));
    break;
  }
  case 0xBF: { // f64.reinterpret_i64
    var buf = new ArrayBuffer(8);
    new DataView(buf).setBigInt64(0, stack.pop(), true);
    stack.push(new DataView(buf).getFloat64(0, true));
    break;
  }

  // ── Sign extension ──
  case 0xC0: stack.push(((stack.pop() & 0xFF) << 24) >> 24); break; // i32.extend8_s
  case 0xC1: stack.push(((stack.pop() & 0xFFFF) << 16) >> 16); break; // i32.extend16_s
  case 0xC2: stack.push(BigInt.asIntN(8, stack.pop())); break; // i64.extend8_s
  case 0xC3: stack.push(BigInt.asIntN(16, stack.pop())); break; // i64.extend16_s
  case 0xC4: stack.push(BigInt.asIntN(32, stack.pop())); break; // i64.extend32_s

  // ── Reference ──
  case 0xD0: // ref.null
    frame.pc++; // skip type
    stack.push(null);
    break;
  case 0xD1: // ref.is_null
    stack.push(stack.pop() === null ? 1 : 0);
    break;
  case 0xD2: // ref.func
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    stack.push(r.value);
    break;

  // ── Exception handling ──
  case 0x08: { // throw
    r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    this._trap('throw: exception handling not fully supported');
    return;
  }
  case 0x1F: { // try_table
    var bt = readLebI32(bytes, frame.pc); frame.pc = bt.pos;
    r = readLebU32(bytes, frame.pc); var catchCount = r.value; frame.pc = r.pos;
    for (var ci = 0; ci < catchCount; ci++) {
      var kind = bytes[frame.pc++];
      if (kind === 0x00 || kind === 0x01) {
        r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
      }
      r = readLebU32(bytes, frame.pc); frame.pc = r.pos;
    }
    var blockInfo = blockMap[instrOffset];
    if (blockInfo) {
      frame.labelStack.push({ arity: 0, target: blockInfo.end, isLoop: false, height: stack.length });
    }
    break;
  }

  // ── Multi-byte prefix (0xFC) ──
  case 0xFC: {
    r = readLebU32(bytes, frame.pc); var sub = r.value; frame.pc = r.pos;
    if (sub === 0x0A) { // memory.copy
      frame.pc += 2; // skip src/dst mem indices
      var n = stack.pop() >>> 0;
      var src = stack.pop() >>> 0;
      var dst = stack.pop() >>> 0;
      var mem = new Uint8Array(this.memoryBuffer);
      mem.copyWithin(dst, src, src + n);
    } else if (sub === 0x0B) { // memory.fill
      frame.pc++; // skip mem index
      var n = stack.pop() >>> 0;
      var val = stack.pop() & 0xFF;
      var dst = stack.pop() >>> 0;
      var mem = new Uint8Array(this.memoryBuffer);
      mem.fill(val, dst, dst + n);
    } else if (sub >= 0 && sub <= 7) {
      // trunc_sat variants — clamp to target range instead of trapping
      v = stack.pop();
      var tv = isNaN(v) ? 0 : Math.trunc(v);
      switch (sub) {
        case 0: // i32.trunc_sat_f32_s
        case 2: // i32.trunc_sat_f64_s
          tv = tv < -2147483648 ? -2147483648 : tv > 2147483647 ? 2147483647 : tv;
          stack.push(tv | 0); break;
        case 1: // i32.trunc_sat_f32_u
        case 3: // i32.trunc_sat_f64_u
          tv = tv < 0 ? 0 : tv > 4294967295 ? 4294967295 : tv;
          stack.push(tv >>> 0); break;
        case 4: // i64.trunc_sat_f32_s
        case 6: // i64.trunc_sat_f64_s
          if (tv < -9223372036854775808) tv = -9223372036854775808;
          if (tv > 9223372036854775807) tv = 9223372036854775807;
          stack.push(BigInt(tv)); break;
        case 5: // i64.trunc_sat_f32_u
        case 7: // i64.trunc_sat_f64_u
          if (tv < 0) tv = 0;
          stack.push(BigInt.asUintN(64, BigInt(tv))); break;
      }
    } else {
      this._trap('Unsupported 0xFC sub-opcode: ' + sub);
      return;
    }
    break;
  }

  default:
    this._trap('Unimplemented opcode: 0x' + op.toString(16) + ' at offset 0x' + instrOffset.toString(16));
    return;
  }
};

// ── Branch helper ──
// Branch to the Nth label from the top of the label stack.

Interpreter.prototype._branch = function(frame, labelIdx) {
  var targetLabel = frame.labelStack[frame.labelStack.length - 1 - labelIdx];
  if (!targetLabel) {
    this._trap('Branch to invalid label ' + labelIdx);
    return;
  }

  // Collect result values
  var results = [];
  for (var i = 0; i < targetLabel.arity; i++) {
    results.unshift(this.stack.pop());
  }

  // Unwind stack to label height
  if (targetLabel.height !== undefined) {
    this.stack.length = targetLabel.height;
  }

  // Push results back
  for (var i = 0; i < results.length; i++) {
    this.stack.push(results[i]);
  }

  // Pop labels up to and including the target
  if (targetLabel.isLoop) {
    // For loops: jump to loop start, DON'T pop the label
    frame.labelStack.length = frame.labelStack.length - labelIdx;
    frame.pc = targetLabel.loopPc || targetLabel.target;
  } else {
    // For blocks/if: jump to end, pop all labels up to target
    frame.labelStack.length = frame.labelStack.length - labelIdx - 1;
    frame.pc = targetLabel.target;
  }
};

// ── Public API ──

return {
  create: function(wasmBytes, hostImports) {
    var bytes = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes);
    var mod = parseModule(bytes);
    return new Interpreter(mod, hostImports);
  },
};

})();
