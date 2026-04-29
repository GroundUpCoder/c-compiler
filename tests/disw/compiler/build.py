#!/usr/bin/env python3
"""Use the project's own compiler to generate a wasm file for disassembly."""
import os, subprocess, sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT_DIR)))
COMPILER_JS = os.path.join(ROOT_DIR, "compiler.js")
OUTPUT = os.path.join(SCRIPT_DIR, "input.wasm")
INPUT_C = os.path.join(SCRIPT_DIR, "input.c")

r = subprocess.run(
    ["node", COMPILER_JS, "-o", OUTPUT, os.path.relpath(INPUT_C, ROOT_DIR)],
    capture_output=True, text=True, cwd=ROOT_DIR,
)
if r.returncode != 0:
    print(r.stderr, file=sys.stderr)
    sys.exit(1)
