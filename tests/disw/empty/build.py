#!/usr/bin/env python3
"""Minimal wasm module: just the 8-byte header, no sections."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from wasm_builder import *

w = WasmBuilder()
w.write("input.wasm")
