# 0085 — multi-character char constants (GCC packing)

Found during the 0075 SameBoy compile probe: `'SAME'`, `'GBS\x01'`, `'TPP1'`
evaluated to their FIRST character only — silently. C11 6.4.4.4p10 makes the
value implementation-defined, but GCC and clang agree on big-endian packing
(`'SAME'` == 0x53414D45) and real code (FourCC magics, SameBoy's GBS/ISX/TPP1
detection) depends on it. A silently-different value is a miscompile in
practice, worse than a diagnostic.

## The fix

One helper, `narrowCharConstValue`, used by BOTH evaluation sites — the lexer
CHAR→INT token resolution and the preprocessor `#if` expression evaluator (they
previously duplicated the logic, each reading exactly one character):

- single char: unchanged, including the signed-char 0x80..0xFF adjustment
  (`'\xff' == -1` on this signed-char target);
- multi-char: `v = (v << 8) | (c & 0xFF)` over all chars, wrapping in int32 —
  which naturally gives GCC's "last 4 chars survive" overflow behavior
  (`'\xff\xff\xff\xff' == -1`);
- the signed-char adjustment deliberately does NOT apply to multi-char
  constants (GCC doesn't apply it either);
- wide constants (`L'…'`/`u'…'`/`U'…'`) keep single-codepoint semantics.

Test-first per the conformance convention: `multichar_char_const` (clang-
verified golden, exercises both the runtime values and an `#if 'AB' != 0x4142`
preprocessor guard) committed failing, then the fix. Full unit suite green
(702/702).
