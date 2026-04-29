#!/usr/bin/env python3
"""Module with name custom section to test function and global name display."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from wasm_builder import *

w = WasmBuilder()
w.type_section([
    ([I32, I32], [I32]),  # type[0]: (i32, i32) -> i32
    ([], []),             # type[1]: () -> nil
])
w.function_section([0, 1])
w.memory_section([(1,)])
w.global_section([
    (I32, True, i32_const(65536) + end()),
    (I32, False, i32_const(0) + end()),
])
w.export_section([
    ("add", FUNC, 0),
    ("_start", FUNC, 1),
])
w.code_section([
    ([], local_get(0) + local_get(1) + i32_add()),
    ([], global_get(0) + drop_() + nop()),
])
w.name_section(
    module_name="test_mod",
    func_names=[(0, "my_add"), (1, "my_start")],
    global_names=[(0, "__stack_pointer"), (1, "__heap_base")],
)
w.write("input.wasm")
