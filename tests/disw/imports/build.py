#!/usr/bin/env python3
"""Module with imports (func, memory, global) and exports."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from wasm_builder import *

w = WasmBuilder()
w.type_section([
    ([I32], []),         # type[0]: (i32) -> nil
    ([I32, I32], [I32]), # type[1]: (i32, i32) -> i32
    ([], [I32]),         # type[2]: () -> i32
])
w.import_section([
    ("env", "print", FUNC, 0),
    ("env", "mem", MEMORY, (1, 10)),
    ("env", "base", GLOBAL, (I32, False)),
])
w.function_section([2])  # func[1] has type[2] (func[0] is imported)
w.export_section([
    ("main", FUNC, 1),
    ("memory", MEMORY, 0),
])
w.code_section([
    ([], i32_const(42)),
])
w.write("input.wasm")
