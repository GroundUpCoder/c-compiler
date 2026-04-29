#!/usr/bin/env python3
"""Function with block, loop, if/else to test indentation."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from wasm_builder import *

w = WasmBuilder()
w.type_section([
    ([], [I32]),
])
w.function_section([0])
w.code_section([
    ([],
     block() +
       loop() +
         i32_const(0) +
         br_if(1) +
       end() +
     end() +
     i32_const(1) +
     if_(I32) +
       i32_const(10) +
     else_() +
       i32_const(20) +
     end()),
])
w.write("input.wasm")
