"""Wasm binary builder -- mirrors the emit pattern in compiler.js.

Usage:
    from wasm_builder import *
    w = WasmBuilder()
    w.type_section([([I32, I32], [I32])])
    w.function_section([0])
    w.export_section([("add", FUNC, 0)])
    w.code_section([([], local_get(0) + local_get(1) + i32_add())])
    w.write("output.wasm")
"""

I32 = 0x7F
I64 = 0x7E
F32 = 0x7D
F64 = 0x7C
FUNCREF = 0x70

FUNC = 0x00
TABLE = 0x01
MEMORY = 0x02
GLOBAL = 0x03


def leb_u(value):
    out = []
    while True:
        byte = value & 0x7F
        value >>= 7
        if value != 0:
            byte |= 0x80
        out.append(byte)
        if value == 0:
            break
    return out


def leb_i(value):
    out = []
    more = True
    while more:
        byte = value & 0x7F
        value >>= 7
        if (value == 0 and (byte & 0x40) == 0) or (value == -1 and (byte & 0x40) != 0):
            more = False
        else:
            byte |= 0x80
        out.append(byte & 0xFF)
    return out


def encode_string(s):
    encoded = s.encode("utf-8")
    return leb_u(len(encoded)) + list(encoded)


def encode_limits(initial, maximum=None):
    if maximum is not None:
        return [0x01] + leb_u(initial) + leb_u(maximum)
    return [0x00] + leb_u(initial)


# -- instruction helpers (each returns a byte list) --

def local_get(idx):     return [0x20] + leb_u(idx)
def local_set(idx):     return [0x21] + leb_u(idx)
def local_tee(idx):     return [0x22] + leb_u(idx)
def global_get(idx):    return [0x23] + leb_u(idx)
def global_set(idx):    return [0x24] + leb_u(idx)
def i32_const(val):     return [0x41] + leb_i(val)
def i32_add():          return [0x6A]
def i32_sub():          return [0x6B]
def i32_mul():          return [0x6C]
def i32_eq():           return [0x46]
def i32_ne():           return [0x47]
def i32_eqz():          return [0x45]
def i32_load(align=2, offset=0):    return [0x28] + leb_u(align) + leb_u(offset)
def i32_store(align=2, offset=0):   return [0x36] + leb_u(align) + leb_u(offset)
def i32_load8_u(align=0, offset=0): return [0x2D] + leb_u(align) + leb_u(offset)
def call(idx):          return [0x10] + leb_u(idx)
def drop_():            return [0x1A]
def ret():              return [0x0F]
def nop():              return [0x01]
def unreachable():      return [0x00]
def block(bt=0x40):     return [0x02, bt]
def loop(bt=0x40):      return [0x03, bt]
def if_(bt=0x40):       return [0x04, bt]
def else_():            return [0x05]
def end():              return [0x0B]
def br(depth):          return [0x0C] + leb_u(depth)
def br_if(depth):       return [0x0D] + leb_u(depth)


class WasmBuilder:
    def __init__(self):
        self.out = [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]

    def _section(self, sid, content):
        self.out.append(sid)
        self.out.extend(leb_u(len(content)))
        self.out.extend(content)

    def type_section(self, types):
        """types: list of (param_types, result_types)."""
        c = leb_u(len(types))
        for params, results in types:
            c.append(0x60)
            c.extend(leb_u(len(params)))
            c.extend(params)
            c.extend(leb_u(len(results)))
            c.extend(results)
        self._section(1, c)

    def import_section(self, imports):
        """imports: list of (module, name, kind, desc).
        FUNC desc: type_index (int)
        MEMORY desc: (initial,) or (initial, maximum)
        TABLE desc: (elem_type, initial) or (elem_type, initial, maximum)
        GLOBAL desc: (val_type, mutable_bool)
        """
        c = leb_u(len(imports))
        for module, name, kind, desc in imports:
            c.extend(encode_string(module))
            c.extend(encode_string(name))
            c.append(kind)
            if kind == FUNC:
                c.extend(leb_u(desc))
            elif kind == MEMORY:
                c.extend(encode_limits(*desc))
            elif kind == TABLE:
                c.append(desc[0])
                c.extend(encode_limits(*desc[1:]))
            elif kind == GLOBAL:
                c.append(desc[0])
                c.append(1 if desc[1] else 0)
        self._section(2, c)

    def function_section(self, type_indices):
        c = leb_u(len(type_indices))
        for ti in type_indices:
            c.extend(leb_u(ti))
        self._section(3, c)

    def table_section(self, tables):
        """tables: list of (elem_type, initial) or (elem_type, initial, max)."""
        c = leb_u(len(tables))
        for t in tables:
            c.append(t[0])
            c.extend(encode_limits(*t[1:]))
        self._section(4, c)

    def memory_section(self, memories):
        """memories: list of (initial,) or (initial, maximum)."""
        c = leb_u(len(memories))
        for m in memories:
            c.extend(encode_limits(*m))
        self._section(5, c)

    def global_section(self, globals_):
        """globals_: list of (val_type, mutable_bool, init_expr_bytes).
        init_expr_bytes must include the trailing 0x0b (end)."""
        c = leb_u(len(globals_))
        for val_type, mutable, init in globals_:
            c.append(val_type)
            c.append(1 if mutable else 0)
            c.extend(init)
        self._section(6, c)

    def export_section(self, exports):
        """exports: list of (name, kind, index)."""
        c = leb_u(len(exports))
        for name, kind, index in exports:
            c.extend(encode_string(name))
            c.append(kind)
            c.extend(leb_u(index))
        self._section(7, c)

    def code_section(self, funcs):
        """funcs: list of (locals, body_bytes).
        locals: list of (count, type) pairs.
        body_bytes: instruction bytes (end opcode appended automatically)."""
        c = leb_u(len(funcs))
        for locals_, body in funcs:
            fb = []
            fb.extend(leb_u(len(locals_)))
            for count, vtype in locals_:
                fb.extend(leb_u(count))
                fb.append(vtype)
            fb.extend(body)
            fb.append(0x0B)
            c.extend(leb_u(len(fb)))
            c.extend(fb)
        self._section(10, c)

    def data_section(self, segments):
        """segments: list of (flags, ...).
        flags=0 (active): (0, init_expr_bytes, data_bytes)
        flags=1 (passive): (1, data_bytes)
        """
        c = leb_u(len(segments))
        for seg in segments:
            flags = seg[0]
            c.extend(leb_u(flags))
            if flags == 0:
                c.extend(seg[1])
                c.extend(leb_u(len(seg[2])))
                c.extend(seg[2])
            elif flags == 1:
                c.extend(leb_u(len(seg[1])))
                c.extend(seg[1])
        self._section(11, c)

    def name_section(self, module_name=None, func_names=None):
        """Emit a custom 'name' section.
        module_name: optional string
        func_names: optional list of (index, name) pairs
        """
        payload = []
        if module_name is not None:
            sub = encode_string(module_name)
            payload.append(0x00)
            payload.extend(leb_u(len(sub)))
            payload.extend(sub)
        if func_names is not None:
            sub = leb_u(len(func_names))
            for idx, name in func_names:
                sub.extend(leb_u(idx))
                sub.extend(encode_string(name))
            payload.append(0x01)
            payload.extend(leb_u(len(sub)))
            payload.extend(sub)
        name_bytes = encode_string("name")
        content = name_bytes + payload
        self._section(0, content)

    def encode(self):
        return bytes(self.out)

    def write(self, path):
        with open(path, "wb") as f:
            f.write(self.encode())
