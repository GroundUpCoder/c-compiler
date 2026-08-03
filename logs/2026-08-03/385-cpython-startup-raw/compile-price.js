// Price WebAssembly.compile + instantiate-imports-free of python-clang.wasm
const fs = require('fs');
const bytes = fs.readFileSync(process.argv[2]);
(async () => {
  console.log('bytes', bytes.length);
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    await WebAssembly.compile(bytes);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log('compile', ms.toFixed(1) + 'ms');
  }
})();
