#!/usr/bin/env python3
"""
cfg/build.py — bundle c0.js (+ any cX.js sibling), disasm.js, and
template.html into a single self-contained index.html. Double-click to
open in a browser; no build server, no module loader.

Each cX.js is wrapped in an IIFE that supplies stub `module`, `require`,
and `process` objects, then exposed as `window.CX` for the visualizer to
consume. c1.js / c2.js are only wired up when they actually define
`module.exports` (so a WIP file with no exports is silently skipped).

Source snippets shown alongside each phase explainer are extracted by
TOKENIZING the backend file — no in-source markers needed. The
SNIPPET_MAP below names which declaration to pull for each visualizer
key; the extractor finds either `function NAME (...) { ... }` or
`const|let|var NAME = ...;` at any nesting depth.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parent

# Backends, in priority order. A file is included only if it exists AND
# has `module.exports` (works-in-progress without exports are skipped).
BACKEND_FILES = [
    ("c0", "C0", "c0.js"),
    ("c1", "C1", "c1.js"),
    ("c2", "C2", "c2.js"),
]

# Snippet name (referenced by template.html via makePhaseSourceBlock)
# → JS declaration identifier to find in that backend's source.
SNIPPET_MAP = {
    "c0": {
        "lex":        "tokenize",
        "parse":      "parse",
        "ast-shape":  "AST",
        "cfg-shape":  "CFG",
        # c0's compiler is structured as four IIFEs (AST / PARSER / CFG /
        # CODEGEN). The phase-named helpers below live nested inside those
        # IIFEs but find_decl_extent searches at any depth.
        "c0-lower":   "fromAST",
        "c0-emit":    "emit",
        "c0-locals":  "layoutFor",
        "c0-lift":    "intoAST",
    },
    # c1/c2 visualizer integration is TBD — the dropdown shows them as
    # placeholders. When wired, fill in each phase → declaration mapping.
    "c1": {},
    "c2": {},
}


# ─────────────────────── JS tokenizer ─────────────────────────────
#
# Just enough to walk a JS source file resolving the classic
# regex-vs-division ambiguity correctly. The trick: track whether the
# previous SIGNIFICANT (non-ws, non-comment) token was "value-like"
# (an identifier value, number, string, regex literal, or closing
# `) ] }`). If it was, `/` is division; otherwise `/` starts a regex.
# Identifiers that look value-like but actually precede an expression
# (`return`, `typeof`, …) are tagged as non-value via the explicit set
# below.

_NON_VALUE_KEYWORDS = frozenset([
    "return", "typeof", "instanceof", "in", "of", "new", "delete",
    "void", "throw", "yield", "await", "case", "do", "else",
])


def tokenize_js(src):
    """Return [(kind, start, end), ...] covering src exactly.

    Token kinds: ws, cmt, str, regex, num, id, punct.
    Punctuation is single-byte (good enough for bracket tracking).
    """
    n = len(src)
    out = []
    i = 0
    prev_value = False
    while i < n:
        c = src[i]
        # whitespace
        if c in " \t\r\n":
            j = i
            while j < n and src[j] in " \t\r\n":
                j += 1
            out.append(("ws", i, j))
            i = j
            continue
        # line comment
        if c == "/" and i + 1 < n and src[i+1] == "/":
            j = src.find("\n", i)
            if j < 0:
                j = n
            out.append(("cmt", i, j))
            i = j
            continue
        # block comment
        if c == "/" and i + 1 < n and src[i+1] == "*":
            j = src.find("*/", i + 2)
            j = j + 2 if j >= 0 else n
            out.append(("cmt", i, j))
            i = j
            continue
        # string literal (single, double, or template). Template literals
        # may contain ${...} expressions; c0.js doesn't use those, so we
        # don't recurse into them — a single straight scan to the closing
        # quote suffices.
        if c in "\"'`":
            q = c
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j = min(j + 2, n)
                    continue
                if src[j] == q:
                    j += 1
                    break
                if src[j] == "\n" and q != "`":
                    break  # tolerate unterminated single-line string
                j += 1
            out.append(("str", i, j))
            i = j
            prev_value = True
            continue
        # regex literal — only if `/` is in regex position (prev not value).
        if c == "/" and not prev_value:
            j = i + 1
            in_class = False
            while j < n:
                ch = src[j]
                if ch == "\\":
                    j = min(j + 2, n)
                    continue
                if ch == "[":
                    in_class = True
                elif ch == "]":
                    in_class = False
                elif ch == "/" and not in_class:
                    j += 1
                    while j < n and src[j].isalpha():
                        j += 1
                    break
                elif ch == "\n":
                    break
                j += 1
            out.append(("regex", i, j))
            i = j
            prev_value = True
            continue
        # number
        if c.isdigit():
            j = i + 1
            while j < n and (src[j].isalnum() or src[j] == "."):
                j += 1
            out.append(("num", i, j))
            i = j
            prev_value = True
            continue
        # identifier (or keyword)
        if c.isalpha() or c == "_" or c == "$":
            j = i + 1
            while j < n and (src[j].isalnum() or src[j] in "_$"):
                j += 1
            out.append(("id", i, j))
            word = src[i:j]
            prev_value = word not in _NON_VALUE_KEYWORDS
            i = j
            continue
        # single-byte punctuation. Multi-char operators (==, =>, &&, ...)
        # break into a sequence of single-byte punct tokens — fine for
        # our purposes (we only care about brackets + `;`).
        out.append(("punct", i, i + 1))
        i += 1
        prev_value = c in ")]}"
    return out


# ─────────────────────── snippet extraction ───────────────────────


def _next_sig(tokens, i):
    while i < len(tokens) and tokens[i][0] in ("ws", "cmt"):
        i += 1
    return i if i < len(tokens) else None


def _decl_extent(src, tokens, start_i, keyword):
    """End-byte of a declaration whose `function`/`const`/etc. keyword
    is at tokens[start_i]. For `function`: read through the body's
    matching `}`. For others: read through the next top-level `;`."""
    start_byte = tokens[start_i][1]
    depth = 0
    if keyword == "function":
        body_seen = False
        for j in range(start_i + 1, len(tokens)):
            kind, ts, te = tokens[j]
            if kind != "punct":
                continue
            ch = src[ts]
            if ch in "({[":
                depth += 1
                if ch == "{" and depth == 1:
                    body_seen = True
            elif ch in ")]}":
                depth -= 1
                if depth == 0 and body_seen and ch == "}":
                    return (start_byte, te)
    else:
        for j in range(start_i + 1, len(tokens)):
            kind, ts, te = tokens[j]
            if kind != "punct":
                continue
            ch = src[ts]
            if ch in "({[":
                depth += 1
            elif ch in ")]}":
                depth -= 1
            elif ch == ";" and depth == 0:
                return (start_byte, te)
    return (start_byte, len(src))


def find_decl_extent(src, tokens, name):
    """Locate `function NAME ...` / `const NAME = ...;` (or let/var) at
    any nesting depth. Returns (start_byte, end_byte) or None."""
    for i, t in enumerate(tokens):
        kind, ts, te = t
        if kind != "id":
            continue
        word = src[ts:te]
        if word not in ("function", "const", "let", "var"):
            continue
        j = _next_sig(tokens, i + 1)
        if j is None:
            continue
        nt = tokens[j]
        if nt[0] != "id" or src[nt[1]:nt[2]] != name:
            continue
        return _decl_extent(src, tokens, i, word)
    return None


def _expand_to_leading_comments(src, start_byte):
    """Include any contiguous `//` line comments immediately above the
    declaration (no blank line breaking the run). Mirrors the way doc
    comments are typically attached to their decl."""
    # Walk to start of decl's line.
    i = start_byte
    while i > 0 and src[i-1] != "\n":
        i -= 1
    pos = i
    while pos > 0:
        prev_end = pos - 1  # the \n separating prev line from this one
        prev_start = prev_end
        while prev_start > 0 and src[prev_start-1] != "\n":
            prev_start -= 1
        line = src[prev_start:prev_end]
        if line.lstrip().startswith("//"):
            pos = prev_start
        else:
            break
    return pos


def extract_snippet(src, tokens, decl_name):
    extent = find_decl_extent(src, tokens, decl_name)
    if not extent:
        return None
    return src[_expand_to_leading_comments(src, extent[0]):extent[1]]


def _dedent(body):
    lines = body.split("\n")
    if lines and not lines[0].strip():
        lines = lines[1:]
    if lines and not lines[-1].strip():
        lines = lines[:-1]
    nonempty = [l for l in lines if l.strip()]
    if not nonempty:
        return "\n".join(lines)
    indent = min(len(l) - len(l.lstrip()) for l in nonempty)
    return "\n".join(l[indent:] if len(l) >= indent else l for l in lines)


# ─────────────────────── bundle assembly ──────────────────────────


def read(p):
    return (ROOT / p).read_text()


def strip_shebang(js):
    if js.startswith("#!"):
        nl = js.find("\n")
        return js[nl + 1:] if nl != -1 else ""
    return js


def wrap(js):
    """Wrap one Node-style module so module.exports becomes the IIFE result."""
    return (
        "(function() {\n"
        "  var module = { exports: {} };\n"
        "  var require = { main: null };\n"
        "  var process = { exit: function() {} };\n"
        + js + "\n"
        "  return module.exports;\n"
        "})()"
    )


def main():
    template = read("template.html")
    disasm_src = strip_shebang(read("disasm.js"))

    embedded_parts = []
    available = []
    snippets = {}
    for key, varname, fname in BACKEND_FILES:
        path = ROOT / fname
        if not path.exists():
            continue
        src = strip_shebang(read(fname))
        if "module.exports" not in src:
            sys.stderr.write(
                f"note: {fname} has no module.exports — skipping (WIP?)\n")
            continue
        embedded_parts.append(f"window.{varname} = {wrap(src)};")
        available.append(key)
        tokens = tokenize_js(src)
        for snip_key, decl_name in SNIPPET_MAP.get(key, {}).items():
            body = extract_snippet(src, tokens, decl_name)
            if body is None:
                sys.stderr.write(
                    f"warning: {fname} has no declaration named {decl_name!r} "
                    f"(snippet {snip_key!r})\n")
                continue
            # First backend wins for shared snippet keys (lex / parse /
            # ast-shape / cfg-shape are likely identical across c0/c1/c2).
            if snip_key not in snippets:
                snippets[snip_key] = _dedent(body)

    embedded_parts.append(f"window.DISASM = {wrap(disasm_src)};")
    embedded_parts.append(
        f"window.SNIPPETS = {json.dumps(snippets, ensure_ascii=False, indent=2)};")
    embedded_parts.append(
        f"window.BACKENDS_AVAILABLE = {json.dumps(available)};")

    embedded = "\n".join(embedded_parts) + "\n"
    html = template.replace("{{EMBEDDED_JS}}", embedded)
    out = ROOT / "index.html"
    out.write_text(html)
    sys.stdout.write(
        f"Wrote {out}  ({len(html):,} bytes, backends: "
        f"{', '.join(available) or '<none>'}, "
        f"{len(snippets)} snippet regions: "
        f"{', '.join(sorted(snippets)) or '<none>'})\n"
    )


if __name__ == "__main__":
    main()
