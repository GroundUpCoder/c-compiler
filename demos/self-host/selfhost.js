// Self-host demo. Run as:
//   node host.js /tmp/qjs.wasm --std /tmp/selfhost-demo/selfhost.js
// (qjs.wasm is itself built by compiler.js)

// QuickJS doesn't ship TextEncoder/TextDecoder — polyfill before loading
// compiler.js (which uses them inside the lexer).
if (typeof TextEncoder === "undefined") {
  globalThis.TextEncoder = class {
    encode(s) {
      const utf8 = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) utf8.push(c);
        else if (c < 0x800) { utf8.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
        else if (c < 0xd800 || c >= 0xe000) {
          utf8.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else {
          i++; const c2 = s.charCodeAt(i);
          const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
          utf8.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f),
          );
        }
      }
      return new Uint8Array(utf8);
    }
  };
  globalThis.TextDecoder = class {
    decode(bytes) {
      let out = "";
      const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      for (let i = 0; i < arr.length; i++) {
        const b = arr[i];
        if (b < 0x80) out += String.fromCharCode(b);
        else if ((b & 0xe0) === 0xc0) {
          const c = ((b & 0x1f) << 6) | (arr[++i] & 0x3f);
          out += String.fromCharCode(c);
        } else if ((b & 0xf0) === 0xe0) {
          const c = ((b & 0x0f) << 12) | ((arr[++i] & 0x3f) << 6) | (arr[++i] & 0x3f);
          out += String.fromCharCode(c);
        } else {
          const cp = ((b & 0x07) << 18) | ((arr[++i] & 0x3f) << 12) |
                     ((arr[++i] & 0x3f) << 6) | (arr[++i] & 0x3f);
          const off = cp - 0x10000;
          out += String.fromCharCode(0xd800 + (off >> 10), 0xdc00 + (off & 0x3ff));
        }
      }
      return out;
    }
  };
}

console.log("[selfhost] loading compiler.js into QuickJS...");
std.evalScript(std.loadFile("compiler.js"));
const C = globalThis.CompilerJS;
if (!C) {
  console.log("[selfhost] FAIL: globalThis.CompilerJS is undefined");
  std.exit(1);
}
console.log("[selfhost] OK — got CompilerJS with " + Object.keys(C).length + " exports");

// Fake `fs` for parseAllUnits — it only uses readFileSync(path, encoding).
const fakeFS = {
  readFileSync(path, _enc) {
    const s = std.loadFile(path);
    if (s === null) throw new Error("file not found: " + path);
    return s;
  },
};

console.log("[selfhost] compiling /tmp/selfhost-demo/hello.c ...");
const pp = C.createDefaultPPRegistry();
pp.fileReader = (path) => { try { return std.loadFile(path); } catch { return null; } };

const compilerOptions = {
  debugSwitch: false, allowImplicitInt: false, allowEmptyParams: false,
  allowKnRDefinitions: false, allowImplicitFunctionDecl: false,
  allowUndefined: false, allowZeroLengthArrays: false,
  gcSections: false, gcNoExportRoots: false, noUndefined: false,
  timeReport: false, requireSources: [], backend: "default",
};
const warningFlags = { pointerDecay: false, circularDependency: false, largeStackFrame: true };

const inputFiles = ["/tmp/selfhost-demo/hello.c"];
const units = C.parseAllUnits(fakeFS, pp, inputFiles, { warningFlags, compilerOptions });

console.log("[selfhost] parsed " + units.length + " translation units");

const linkResult = C.linkTranslationUnits(units, compilerOptions);
if (linkResult.errors.length > 0) {
  console.log("[selfhost] LINK FAILED:");
  for (const e of linkResult.errors) console.log("  " + e.message);
  std.exit(1);
}
console.log("[selfhost] linked OK");

const wasmBytes = C.generateCode(units, "/tmp/selfhost-demo/hello-rebuilt.wasm",
                                 { compilerOptions, warningFlags });
console.log("[selfhost] generated " + wasmBytes.length + " bytes of wasm");

// Write the bytes to a file via std module.
const out = std.open("/tmp/selfhost-demo/hello-rebuilt.wasm", "wb");
out.write(wasmBytes.buffer, 0, wasmBytes.length);
out.close();
console.log("[selfhost] wrote /tmp/selfhost-demo/hello-rebuilt.wasm");
