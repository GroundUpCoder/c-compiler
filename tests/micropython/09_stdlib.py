# todos/0117 R2 — the curated stdlib, as a stdin-driven smoke test.
#
# The kernel e2e (tests/kernel/test_micropython_stdlib_e2e.js) owns everything
# that needs a real filesystem or a real process. This file owns the part that
# is pure computation, so a module going missing or an encoding changing shows
# up in the cheap suite too. Every value here is what CPython 3 prints.

import json, re, struct, binascii, heapq, collections, array, math, cmath, errno

# --- json -----------------------------------------------------------------
print(json.dumps(json.loads('{"a": [1, 2, {"b": null}], "c": true}')))
print(json.dumps([1, "two", None, True, False]))
print(json.dumps({"k": "v"}, separators=(",", ":")))

# --- re -------------------------------------------------------------------
print(re.sub("[0-9]+", "#", "a12b345c"))
m = re.match(r"(\w+)@(\w+)\.(\w+)", "user@example.com")
print(m.group(0), m.group(1), m.group(2), m.group(3))
print(m.span(1))
print(re.search("b+", "aabbbcc").group(0))
print([x for x in re.compile(r"\d").split("a1b2c")])

# --- struct ---------------------------------------------------------------
print(struct.unpack("<HI", struct.pack("<HI", 7, 99999)))
print(struct.calcsize("<HI"), struct.calcsize(">bq"))
print(struct.unpack(">h", struct.pack(">h", -2)))

# --- binascii -------------------------------------------------------------
print(binascii.b2a_base64(b"hello").decode().strip())
print(binascii.a2b_base64("aGVsbG8=").decode())
print(binascii.hexlify(b"\x00\x01\xfe\xff").decode())
print(binascii.unhexlify("4f4b").decode())

# --- heapq ----------------------------------------------------------------
h = []
for v in (5, 1, 9, 3):
    heapq.heappush(h, v)
print([heapq.heappop(h) for _ in range(4)])

# --- collections ----------------------------------------------------------
P = collections.namedtuple("P", ["x", "y"])
p = P(3, 4)
print(p, p.x + p.y)
d = collections.OrderedDict()
d["b"] = 2
d["a"] = 1
print(list(d.keys()), list(d.values()))
q = collections.deque((1, 2, 3), 10)
q.append(4)
print(q.popleft(), q.pop(), len(q))

# --- array ----------------------------------------------------------------
a = array.array("i", [1, 2, 3])
a.append(4)
print(list(a), len(a))
print(list(array.array("f", [0.5, 1.5])))

# --- math / cmath ---------------------------------------------------------
print(math.floor(2.7), math.ceil(2.1), round(math.pi, 4))
# NB not `print(cmath.sqrt(-1))`: CPython prints exactly `1j`, MicroPython
# `(6.123233995736766e-17+1j)` — it computes the root in polar form. That is a
# real dialect difference (README.md "Known gaps"), so assert the mathematical
# fact rather than pinning either spelling.
print(abs(cmath.sqrt(-1) - 1j) < 1e-9)

# --- errno ----------------------------------------------------------------
print(errno.ENOENT, errno.EEXIST, errno.EINVAL)
