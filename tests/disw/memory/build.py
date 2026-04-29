#!/usr/bin/env python3
"""Function with memory load/store to test memarg display."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from wasm_builder import *

w = WasmBuilder()
w.type_section([
    ([I32], [I32]),
])
w.function_section([0])
w.memory_section([(1,)])
w.code_section([
    ([],
     local_get(0) + i32_load(align=2, offset=8) +       # natural align, offset shown
     local_get(0) + i32_const(42) +
     i32_store(align=2, offset=16) +                     # natural align, offset shown
     local_get(0) + i32_load8_u(align=2, offset=4) +    # non-natural align shown
     i32_add()),
])
w.write("input.wasm")
