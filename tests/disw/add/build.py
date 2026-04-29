#!/usr/bin/env python3
"""Single exported function: add(i32, i32) -> i32."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from wasm_builder import *

w = WasmBuilder()
w.type_section([
    ([I32, I32], [I32]),
])
w.function_section([0])
w.export_section([
    ("add", FUNC, 0),
])
w.code_section([
    ([], local_get(0) + local_get(1) + i32_add()),
])
w.write("input.wasm")
