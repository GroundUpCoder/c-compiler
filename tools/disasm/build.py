#!/usr/bin/env python3
"""Build self-contained disassembler HTML page.

Bundles compiler.js and a freshly-compiled disw.wasm into page.html,
producing index.html that works standalone (no server needed).

Usage:
    python3 tools/disasm/build.py
"""

import base64
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOL_DIR = os.path.join(ROOT, "tools", "disasm")

def build_disw():
    wasm_path = os.path.join(TOOL_DIR, "disw.wasm")
    print("Building disw.wasm...")
    subprocess.check_call(
        ["node", os.path.join(ROOT, "compiler.js"),
         os.path.join(ROOT, "vendor", "disw", "bin.json"),
         "-o", wasm_path, "-g"],
        cwd=ROOT,
    )
    return wasm_path

def main():
    # Build disw WASM
    wasm_path = build_disw()

    # Read inputs
    compiler_js = open(os.path.join(ROOT, "compiler.js")).read()
    if compiler_js.startswith("#!"):
        compiler_js = compiler_js[compiler_js.index("\n") + 1:]

    codemirror_js = open(os.path.join(ROOT, "vendor", "codemirror", "codemirror.js")).read()

    interpreter_js = open(os.path.join(TOOL_DIR, "interpreter.js")).read()

    disw_wasm = open(wasm_path, "rb").read()
    disw_b64 = base64.b64encode(disw_wasm).decode("ascii")

    template = open(os.path.join(TOOL_DIR, "page.html")).read()

    # Escape </script> inside embedded JS so it doesn't break <script> tags
    compiler_js = compiler_js.replace("</script>", "<\\/script>")
    codemirror_js = codemirror_js.replace("</script>", "<\\/script>")
    interpreter_js = interpreter_js.replace("</script>", "<\\/script>")

    # Inject
    html = template.replace("/* __CODEMIRROR_JS__ */", codemirror_js)
    html = html.replace("/* __COMPILER_JS__ */", compiler_js)
    html = html.replace("/* __INTERPRETER_JS__ */", interpreter_js)
    html = html.replace("'__DISW_WASM_BASE64__'", "'" + disw_b64 + "'")

    out_path = os.path.join(TOOL_DIR, "index.html")
    open(out_path, "w").write(html)
    size_kb = os.path.getsize(out_path) / 1024
    print(f"Wrote {out_path} ({size_kb:.0f} KB)")

if __name__ == "__main__":
    main()
