#!/usr/bin/env python3
"""Unified test runner for the C-to-WASM compiler.

Usage:
    python3 tests/run.py                                  # default: unit tests, JS compiler
    python3 tests/run.py --types=unit,extra                # multiple categories
    python3 tests/run.py --types=all --compiler=all        # everything with all compilers
    python3 tests/run.py --types=equiv --compiler=all      # CC vs JS intermediate comparison
    python3 tests/run.py --types=lua                       # Lua official test suite
    python3 tests/run.py -v                                # verbose per-test output
    python3 tests/run.py --filter=arithmetic               # only tests matching substring

Categories:
    unit   — compile+run tests from tests/unit/
    extra  — compile+run tests from tests/extra/
    equiv  — CC vs JS equivalence: parse tree + WASM binary (requires --compiler=all)
    lua    — Lua official test suite (build VM, run .lua files)
    disw   — WebAssembly disassembler output tests
    sourcemap — source map line number accuracy tests
    all    — all of the above

Compilers:
    js     — JavaScript compiler (default)
    cc     — C++ compiler (auto-builds build/a.out from compiler.cc)
    all    — both compilers (unit/extra run independently; equiv compares outputs)
"""

# TODO: Add doom OPL music module tests (needs vendor/doom/)
# TODO: Add GCC torture test category
# TODO: Add third-party test suites (c-testsuite, ucb-subset)

import argparse
import glob as globmod
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

# --- Paths ---

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
HOST_JS = os.path.join(ROOT_DIR, "host.js")
BUILD_DIR = os.path.join(ROOT_DIR, "build")
COMPILER_CC = os.path.join(BUILD_DIR, "a.out")
COMPILER_JS = os.path.join(ROOT_DIR, "compiler.js")
COMPILER_CC_SRC = os.path.join(ROOT_DIR, "compiler.cc")
TEST_TMPDIR = os.path.join(BUILD_DIR, "tmp")

UNIT_DIR = os.path.join(SCRIPT_DIR, "unit")
EXTRA_DIR = os.path.join(SCRIPT_DIR, "extra")
VENDOR_DIR = os.path.join(ROOT_DIR, "vendor")

LUA_DIR = os.path.join(VENDOR_DIR, "lua")
LUA_TEST_DIR = os.path.join(LUA_DIR, "tests")
ZLIB_DIR = os.path.join(VENDOR_DIR, "zlib")
ZLIB_TOOL_DIR = os.path.join(ZLIB_DIR, "tool")
ZLIB_TESTS_DIR = os.path.join(ZLIB_DIR, "tests")
ZLIB_GOLDEN_DIR = os.path.join(ZLIB_TESTS_DIR, "golden")

FREETYPE_DIR = os.path.join(VENDOR_DIR, "freetype")
FREETYPE_DEMO_DIR = os.path.join(FREETYPE_DIR, "demo")

DISW_DIR = os.path.join(VENDOR_DIR, "disw")
DISW_BIN = os.path.join(BUILD_DIR, "disw-native")
DISW_SOURCES = [
    os.path.join(DISW_DIR, "src", f) for f in ("parse.c", "disasm.c", "main.c", "wasm.h")
]
DISW_TEST_DIR = os.path.join(SCRIPT_DIR, "disw")

SOURCEMAP_DIR = os.path.join(SCRIPT_DIR, "sourcemap")

ALL_CATEGORIES = ["unit", "extra", "equiv", "projects", "zlib", "lua", "freetype", "disw", "sourcemap"]
DEFAULT_CATEGORIES = ["unit"]


# --- Compiler selection and building ---

def ensure_cc_built():
    """Build build/a.out from compiler.cc if missing or stale."""
    if not os.path.exists(COMPILER_CC_SRC):
        print("Error: compiler.cc not found", file=sys.stderr)
        sys.exit(1)

    os.makedirs(BUILD_DIR, exist_ok=True)

    needs_build = (
        not os.path.exists(COMPILER_CC)
        or os.path.getmtime(COMPILER_CC_SRC) > os.path.getmtime(COMPILER_CC)
    )
    if needs_build:
        print("Building build/a.out from compiler.cc...")
        r = subprocess.run(
            ["clang++", "-std=c++20", "-O0", "-Wall", "-Werror", "-Wpedantic",
             "-Wextra", "-Wno-unused-function", COMPILER_CC_SRC, "-o", COMPILER_CC],
            capture_output=True, text=True
        )
        if r.returncode != 0:
            print(f"Build failed:\n{r.stderr}", file=sys.stderr)
            sys.exit(1)
        print("Build complete.")


def get_compiler(mode):
    if mode == "cc":
        ensure_cc_built()
        return [COMPILER_CC]
    if mode == "js":
        return ["node", COMPILER_JS]
    raise ValueError(f"Unknown compiler mode: {mode}")


def compiler_label(cmd):
    if cmd[0] == "node":
        return "js"
    return "cc"


# --- Results tracking ---

class Results:
    def __init__(self, verbosity=1):
        self.verbosity = verbosity
        self.passed = 0
        self.failed = 0
        self.skipped = 0
        self.failures = []
        self._in_dots = False
        self._section_start = None

    def _end_dots(self):
        if self._in_dots:
            print()
            self._in_dots = False

    def _end_section(self):
        self._end_dots()
        if self._section_start is not None and self.verbosity >= 1:
            elapsed = time.time() - self._section_start
            print(f"    ({elapsed:.1f}s)")
            self._section_start = None

    def record(self, name, ok, msg=""):
        if ok:
            self.passed += 1
            if self.verbosity >= 2:
                print(f"  PASS  {name}")
            elif self.verbosity >= 1:
                print(".", end="", flush=True)
                self._in_dots = True
        else:
            self.failed += 1
            self.failures.append((name, msg))
            if self.verbosity >= 2:
                print(f"  FAIL  {name}")
                for line in msg.split("\n"):
                    print(f"        {line}")
            elif self.verbosity >= 1:
                print("F", end="", flush=True)
                self._in_dots = True

    def skip(self, name=""):
        self.skipped += 1
        if self.verbosity >= 2 and name:
            print(f"  SKIP  {name}")

    def section(self, title):
        self._end_section()
        self._section_start = time.time()
        if self.verbosity >= 1:
            print(f"--- {title} ---")

    def print_summary(self):
        self._end_section()
        for name, msg in self.failures:
            print(f"\n  FAIL  {name}")
            for line in msg.split("\n"):
                print(f"        {line}")
        print()
        parts = [f"{self.passed} passed", f"{self.failed} failed"]
        if self.skipped:
            parts.append(f"{self.skipped} skipped")
        print(", ".join(parts))

    @property
    def success(self):
        return self.failed == 0


# --- Test discovery ---

def load_expected(test_dir, filename):
    path = os.path.join(test_dir, filename)
    if os.path.exists(path):
        with open(path) as f:
            return f.read()
    return None


def collect_tests(directory, filter_str=None):
    """Recursively collect leaf test directories containing .c files."""
    if not os.path.isdir(directory):
        return []
    entries = os.listdir(directory)
    subdirs = sorted(d for d in entries if os.path.isdir(os.path.join(directory, d)))
    c_files = [f for f in entries if f.endswith(".c")]

    if c_files and subdirs:
        print(f"  ERROR  {directory}: has both .c files and subdirectories", file=sys.stderr)
        sys.exit(1)

    if subdirs:
        tests = []
        for d in subdirs:
            tests.extend(collect_tests(os.path.join(directory, d), filter_str))
        return tests

    if c_files:
        if filter_str and filter_str not in directory:
            return []
        return [directory]
    return []


# --- Unit/Extra tests ---

def run_with_events(cmd, events, timeout=30):
    """Run a command, feeding stdin data at scheduled times.

    events is a list of dicts: [{"at": <seconds>, "stdin": "<data>"}, ...]
    Returns a subprocess.CompletedProcess-like object.
    """
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True
    )
    sorted_events = sorted(events, key=lambda e: e["at"])
    start = time.monotonic()

    def feed_events():
        for ev in sorted_events:
            delay = ev["at"] - (time.monotonic() - start)
            if delay > 0:
                time.sleep(delay)
            if proc.poll() is not None:
                break
            if "stdin" in ev:
                try:
                    proc.stdin.write(ev["stdin"])
                    proc.stdin.flush()
                except (BrokenPipeError, OSError):
                    break
        try:
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    stdout_chunks = []
    stderr_chunks = []

    def read_stdout():
        for chunk in iter(proc.stdout.readline, ''):
            stdout_chunks.append(chunk)

    def read_stderr():
        for chunk in iter(proc.stderr.readline, ''):
            stderr_chunks.append(chunk)

    feeder = threading.Thread(target=feed_events, daemon=True)
    out_reader = threading.Thread(target=read_stdout, daemon=True)
    err_reader = threading.Thread(target=read_stderr, daemon=True)
    feeder.start()
    out_reader.start()
    err_reader.start()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise
    out_reader.join(timeout=2)
    err_reader.join(timeout=2)
    feeder.join(timeout=1)
    return subprocess.CompletedProcess(
        cmd, proc.returncode, ''.join(stdout_chunks), ''.join(stderr_chunks)
    )


def run_single_test(test_dir, compiler_cmd):
    name = os.path.relpath(test_dir, SCRIPT_DIR)

    c_files = sorted(
        os.path.join(test_dir, f) for f in os.listdir(test_dir) if f.endswith(".c")
    )
    if not c_files:
        return None

    config = {}
    config_path = os.path.join(test_dir, "config.json")
    if os.path.exists(config_path):
        with open(config_path) as f:
            config = json.load(f)

    with tempfile.NamedTemporaryFile(suffix=".wasm", delete=False) as tmp:
        wasm_path = tmp.name

    try:
        rel_c_files = [os.path.relpath(f, ROOT_DIR) for f in c_files]
        compile_cmd = [
            *compiler_cmd, "-o", wasm_path,
            f'-DTEST_TMPDIR="{TEST_TMPDIR}/"',
        ] + config.get("compilerArgs", []) + rel_c_files
        compile_result = subprocess.run(
            compile_cmd, capture_output=True, text=True, timeout=30, cwd=ROOT_DIR
        )

        expected_compiler_exitcode = 0
        ec_file = os.path.join(test_dir, "expected.compiler.exitcode")
        if os.path.exists(ec_file):
            with open(ec_file) as f:
                expected_compiler_exitcode = int(f.read().strip())

        compiler_errors = []
        expected_compiler_stderr = load_expected(test_dir, "expected.compiler.stderr")
        if expected_compiler_stderr is not None:
            if compile_result.stderr != expected_compiler_stderr:
                compiler_errors.append(
                    f"Compiler stderr mismatch:\n--- expected ---\n"
                    f"{expected_compiler_stderr}--- got ---\n{compile_result.stderr}"
                )

        if expected_compiler_exitcode != 0:
            if compile_result.returncode != expected_compiler_exitcode:
                compiler_errors.append(
                    f"Compiler exit code: got {compile_result.returncode}, "
                    f"expected {expected_compiler_exitcode}"
                )
            if compiler_errors:
                return (name, False, "\n".join(compiler_errors))
            return (name, True, "")

        if compile_result.returncode != 0:
            return (name, False,
                    f"Compilation failed (exit {compile_result.returncode}):\n{compile_result.stderr}")

        if compiler_errors:
            return (name, False, "\n".join(compiler_errors))

        run_cmd = ["node", "--experimental-wasm-exnref", HOST_JS, wasm_path] + config.get("args", [])
        events = config.get("events", [])
        if events:
            run_result = run_with_events(run_cmd, events, timeout=30)
        else:
            run_result = subprocess.run(run_cmd, capture_output=True, text=True, timeout=30)

        errors = []

        exitcode_file = os.path.join(test_dir, "expected.exitcode")
        expected_exitcode = config.get("expected", {}).get("exitcode", 0)
        if os.path.exists(exitcode_file):
            with open(exitcode_file) as f:
                expected_exitcode = int(f.read().strip())
        if run_result.returncode != expected_exitcode:
            msg = f"Exit code: got {run_result.returncode}, expected {expected_exitcode}"
            if expected_exitcode == 0 and run_result.returncode != 0:
                if run_result.stdout:
                    msg += f"\n--- stdout ---\n{run_result.stdout}"
                if run_result.stderr:
                    msg += f"\n--- stderr ---\n{run_result.stderr}"
            errors.append(msg)

        expected_stdout = load_expected(test_dir, "expected.stdout")
        if expected_stdout is not None:
            if run_result.stdout != expected_stdout:
                errors.append(
                    f"Stdout mismatch:\n--- expected ---\n"
                    f"{expected_stdout}--- got ---\n{run_result.stdout}"
                )

        expected_stderr = load_expected(test_dir, "expected.stderr")
        if expected_stderr is not None:
            if run_result.stderr != expected_stderr:
                errors.append(
                    f"Stderr mismatch:\n--- expected ---\n"
                    f"{expected_stderr}--- got ---\n{run_result.stderr}"
                )

        if errors:
            return (name, False, "\n".join(errors))
        return (name, True, "")

    except subprocess.TimeoutExpired:
        return (name, False, "Timed out")
    finally:
        if os.path.exists(wasm_path):
            os.unlink(wasm_path)


def run_unit_or_extra(test_base, compiler_cmd, results, filter_str=None, label_prefix=""):
    for test_dir in collect_tests(test_base, filter_str):
        result = run_single_test(test_dir, compiler_cmd)
        if result is None:
            results.skip()
            continue
        name, ok, msg = result
        if label_prefix:
            name = f"{label_prefix}{name}"
        results.record(name, ok, msg)


# --- Equivalence tests ---

def first_tu(text):
    lines = text.split("\n")
    result = []
    count = 0
    for line in lines:
        if line.startswith("Translation Unit"):
            count += 1
            if count > 1:
                break
        if count == 1:
            result.append(line)
    return "\n".join(result)


def first_diff_line(text_a, text_b):
    lines_a = text_a.split("\n")
    lines_b = text_b.split("\n")
    for i in range(max(len(lines_a), len(lines_b))):
        a = lines_a[i] if i < len(lines_a) else "<EOF>"
        b = lines_b[i] if i < len(lines_b) else "<EOF>"
        if a != b:
            return f"line {i+1}:\n  CC: {a.strip()[:120]}\n  JS: {b.strip()[:120]}"
    if len(lines_a) != len(lines_b):
        return f"CC={len(lines_a)} lines, JS={len(lines_b)} lines"
    return ""


def run_equiv(results, filter_str=None, actions=None):
    if actions is None:
        actions = ["parse", "wasm"]

    cc = get_compiler("cc")
    js = get_compiler("js")

    test_dirs = collect_tests(UNIT_DIR, filter_str) + collect_tests(EXTRA_DIR, filter_str)
    for test_dir in test_dirs:
        rel_dir = os.path.relpath(test_dir, ROOT_DIR)
        c_files = sorted(
            os.path.join(rel_dir, f) for f in os.listdir(test_dir) if f.endswith(".c")
        )
        if not c_files:
            continue

        ec_file = os.path.join(test_dir, "expected.compiler.exitcode")
        if os.path.exists(ec_file):
            with open(ec_file) as f:
                if f.read().strip() not in ("", "0"):
                    for action in actions:
                        results.skip(f"equiv:{action}:{rel_dir}")
                    continue

        extra = []
        cfg = os.path.join(test_dir, "config.json")
        if os.path.exists(cfg):
            with open(cfg) as f:
                extra.extend(json.load(f).get("compilerArgs", []))
        for cf in c_files:
            full_cf = os.path.join(ROOT_DIR, cf)
            if os.path.exists(full_cf):
                with open(full_cf) as fh:
                    if "TEST_TMPDIR" in fh.read():
                        extra.append('-DTEST_TMPDIR="/tmp"')
                        break

        for action in actions:
            label = f"equiv:{action}:{rel_dir}"

            if action == "wasm":
                cc_wasm = None
                js_wasm = None
                try:
                    with tempfile.NamedTemporaryFile(suffix=".wasm", delete=False) as f:
                        cc_wasm = f.name
                    with tempfile.NamedTemporaryFile(suffix=".wasm", delete=False) as f:
                        js_wasm = f.name
                    cc_cmd = [*cc, "-o", cc_wasm] + extra + c_files
                    js_cmd = [*js, "-o", js_wasm] + extra + c_files
                    cc_r = subprocess.run(cc_cmd, capture_output=True, text=True, timeout=30, cwd=ROOT_DIR)
                    js_r = subprocess.run(js_cmd, capture_output=True, text=True, timeout=30, cwd=ROOT_DIR)
                    if cc_r.returncode != 0:
                        results.record(label, False, f"CC compile failed:\n{cc_r.stderr[:200]}")
                    elif js_r.returncode != 0:
                        results.record(label, False, f"JS compile failed:\n{js_r.stderr[:200]}")
                    else:
                        with open(cc_wasm, "rb") as f:
                            cc_bytes = f.read()
                        with open(js_wasm, "rb") as f:
                            js_bytes = f.read()
                        if cc_bytes == js_bytes:
                            results.record(label, True)
                        else:
                            msg = f"WASM differs: CC={len(cc_bytes)} bytes, JS={len(js_bytes)} bytes"
                            for i in range(min(len(cc_bytes), len(js_bytes))):
                                if cc_bytes[i] != js_bytes[i]:
                                    msg += f", first diff at byte {i} (CC=0x{cc_bytes[i]:02x}, JS=0x{js_bytes[i]:02x})"
                                    break
                            results.record(label, False, msg)
                except subprocess.TimeoutExpired:
                    results.record(label, False, "timeout")
                finally:
                    for p in (cc_wasm, js_wasm):
                        if p and os.path.exists(p):
                            os.unlink(p)
                continue

            cc_cmd = [*cc, "-a", action] + extra + c_files
            js_cmd = [*js, "-a", action] + extra + c_files

            try:
                cc_r = subprocess.run(cc_cmd, capture_output=True, text=True, timeout=30, cwd=ROOT_DIR)
                js_r = subprocess.run(js_cmd, capture_output=True, text=True, timeout=30, cwd=ROOT_DIR)
            except subprocess.TimeoutExpired:
                results.record(label, False, "timeout")
                continue

            cc_out = cc_r.stdout
            js_out = js_r.stdout

            if action == "parse":
                cc_out = first_tu(cc_out)
                js_out = first_tu(js_out)

            if cc_out == js_out:
                results.record(label, True)
            else:
                results.record(label, False, first_diff_line(cc_out, js_out))


# --- Projects ---


def discover_projects():
    """Find all vendor/*/bin.json files (executable projects)."""
    projects = []
    for entry in sorted(os.listdir(VENDOR_DIR)):
        pj = os.path.join(VENDOR_DIR, entry, "bin.json")
        if not os.path.isfile(pj):
            continue
        with open(pj) as f:
            proj = json.load(f)
        projects.append((proj.get("name", entry), pj))
    return projects


def run_projects(compiler_cmd, results, filter_str=None):
    """Compile-only test for each vendor project."""
    for name, pj_path in discover_projects():
        test_name = f"projects/{name}"
        if filter_str and filter_str not in test_name:
            continue
        wasm, err = build_project(pj_path, compiler_cmd)
        if wasm is None:
            results.record(test_name, False, f"Build failed:\n{err}")
        else:
            results.record(test_name, True)


def run_projects_equiv(results, filter_str=None):
    """Build each vendor project with both compilers and compare WASM output."""
    js_cmd = get_compiler("js")
    cc_cmd = get_compiler("cc")
    for name, pj_path in discover_projects():
        test_name = f"projects/{name}"
        if filter_str and filter_str not in test_name:
            continue
        js_wasm, js_err = build_project(pj_path, js_cmd)
        if js_wasm is None:
            results.record(test_name, False, f"JS build failed:\n{js_err}")
            continue
        cc_wasm, cc_err = build_project(pj_path, cc_cmd)
        if cc_wasm is None:
            results.record(test_name, False, f"CC build failed:\n{cc_err}")
            continue
        with open(js_wasm, "rb") as f:
            js_bytes = f.read()
        with open(cc_wasm, "rb") as f:
            cc_bytes = f.read()
        if js_bytes == cc_bytes:
            results.record(test_name, True)
        else:
            results.record(test_name, False,
                           f"WASM mismatch: JS={len(js_bytes)} bytes, CC={len(cc_bytes)} bytes")


# --- Zlib tests ---

ZLIB_DEMO_EXPECTED = """\
simple: OK
original: 89 compressed: 83
streaming: OK
original: 711 compressed: 104
adler32: 0x11e60398
crc32: 0xadaac02e
"""

ZLIB_GOLDEN_FILES = ["binary.dat", "empty.txt", "hello.txt", "numbers.txt", "repeat.txt"]


def run_zlib_tests(compiler_cmd, results, filter_str=None):
    import shutil

    # --- zlib_demo self-test ---
    demo_name = "zlib/demo"
    if not filter_str or filter_str in demo_name:
        demo_json = os.path.join(ZLIB_TESTS_DIR, "zlib_demo.json")
        wasm, err = build_project(demo_json, compiler_cmd)
        if wasm is None:
            results.record(demo_name, False, f"Build failed:\n{err}")
        else:
            r = subprocess.run(
                ["node", "--experimental-wasm-exnref", HOST_JS, wasm],
                capture_output=True, text=True, timeout=15,
            )
            if r.returncode != 0:
                results.record(demo_name, False,
                               f"Exit code {r.returncode}\nstderr: {r.stderr}")
            elif r.stdout != ZLIB_DEMO_EXPECTED:
                results.record(demo_name, False,
                               f"Output mismatch:\n--- expected ---\n{ZLIB_DEMO_EXPECTED}"
                               f"--- got ---\n{r.stdout}")
            else:
                results.record(demo_name, True)

    # Build zlib-tool (shared by zip and unzip tests)
    tool_json = os.path.join(ZLIB_TOOL_DIR, "bin.json")
    tool_wasm, tool_err = build_project(tool_json, compiler_cmd)

    # --- golden zip test: zip files and compare to expected.zip ---
    zip_name = "zlib/zip"
    if not filter_str or filter_str in zip_name:
        if tool_wasm is None:
            results.record(zip_name, False, f"Build failed:\n{tool_err}")
        else:
            work = tempfile.mkdtemp(prefix="zlib_zip_")
            try:
                zip_path = os.path.join(work, "output.zip")
                r = subprocess.run(
                    ["node", "--experimental-wasm-exnref", HOST_JS, tool_wasm,
                     "create", os.path.abspath(zip_path)] + ZLIB_GOLDEN_FILES,
                    capture_output=True, text=True, timeout=15, cwd=ZLIB_GOLDEN_DIR,
                )
                if r.returncode != 0:
                    results.record(zip_name, False,
                                   f"create failed (exit {r.returncode}):\n{r.stderr}")
                else:
                    golden_zip = os.path.join(ZLIB_GOLDEN_DIR, "expected.zip")
                    with open(golden_zip, "rb") as a, open(zip_path, "rb") as b:
                        if a.read() == b.read():
                            results.record(zip_name, True)
                        else:
                            results.record(zip_name, False,
                                           f"ZIP not byte-identical to expected.zip")
            finally:
                shutil.rmtree(work, ignore_errors=True)

    # --- golden unzip test: extract expected.zip and compare to source files ---
    unzip_name = "zlib/unzip"
    if not filter_str or filter_str in unzip_name:
        if tool_wasm is None:
            results.record(unzip_name, False, f"Build failed:\n{tool_err}")
        else:
            work = tempfile.mkdtemp(prefix="zlib_unzip_")
            try:
                golden_zip = os.path.join(ZLIB_GOLDEN_DIR, "expected.zip")
                r = subprocess.run(
                    ["node", "--experimental-wasm-exnref", HOST_JS, tool_wasm,
                     "extract", os.path.abspath(golden_zip)],
                    capture_output=True, text=True, timeout=15, cwd=work,
                )
                if r.returncode != 0:
                    results.record(unzip_name, False,
                                   f"extract failed (exit {r.returncode}):\n{r.stderr}")
                else:
                    errors = []
                    for name in ZLIB_GOLDEN_FILES:
                        orig = os.path.join(ZLIB_GOLDEN_DIR, name)
                        extr = os.path.join(work, name)
                        if not os.path.exists(extr):
                            errors.append(f"'{name}' not extracted")
                            continue
                        with open(orig, "rb") as a, open(extr, "rb") as b:
                            if a.read() != b.read():
                                errors.append(f"'{name}' content mismatch")
                    if errors:
                        results.record(unzip_name, False, "\n".join(errors))
                    else:
                        results.record(unzip_name, True)
            finally:
                shutil.rmtree(work, ignore_errors=True)


# --- Lua test suite ---

LUA_SKIP = {"files.lua", "heavy.lua", "verybig.lua", "big.lua", "memerr.lua", "cstack.lua", "main.lua"}


def build_project(project_json_path, compiler_cmd):
    """Build a project from its JSON file. Returns (wasm_path, error_string)."""
    with open(project_json_path) as f:
        proj = json.load(f)
    os.makedirs(BUILD_DIR, exist_ok=True)
    output = os.path.join(BUILD_DIR, f"{proj['name']}-{compiler_label(compiler_cmd)}.wasm")
    cmd = [*compiler_cmd, "-o", output, project_json_path]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60, cwd=ROOT_DIR)
    if r.returncode != 0:
        return None, r.stderr
    return output, ""


def run_lua_tests(compiler_cmd, results, filter_str=None):
    if not os.path.isdir(LUA_TEST_DIR):
        results.record("lua/build", False, f"Lua test dir not found: {LUA_TEST_DIR}")
        return

    wasm, err = build_project(os.path.join(LUA_DIR, "bin.json"), compiler_cmd)
    if wasm is None:
        results.record("lua/build", False, f"Failed to build lua.wasm:\n{err}")
        return

    files = sorted(f for f in os.listdir(LUA_TEST_DIR)
                   if f.endswith(".lua") and f != "all.lua")

    for f in files:
        test_name = f"lua/{f}"
        if filter_str and filter_str not in test_name:
            continue
        if f in LUA_SKIP:
            results.skip(test_name)
            continue

        test_path = os.path.join(LUA_TEST_DIR, f)
        try:
            r = subprocess.run(
                ["node", "--experimental-wasm-exnref", HOST_JS, wasm,
                 "-e", f"_port=true;package.path='{LUA_TEST_DIR}/?.lua;'..package.path",
                 test_path],
                capture_output=True, timeout=15, cwd=LUA_TEST_DIR
            )
            if r.returncode == 0:
                results.record(test_name, True)
            else:
                stderr = r.stderr.decode("utf-8", errors="replace") if isinstance(r.stderr, bytes) else r.stderr
                stdout = r.stdout.decode("utf-8", errors="replace") if isinstance(r.stdout, bytes) else r.stdout
                msg = ""
                if stdout:
                    msg += f"stdout: {stdout.split(chr(10))[0]}\n"
                if stderr:
                    msg += f"stderr: {stderr.split(chr(10))[0]}"
                results.record(test_name, False, f"Exit code {r.returncode}\n{msg}".strip())
        except subprocess.TimeoutExpired:
            results.record(test_name, False, "Timed out (15s)")


# --- FreeType tests ---

FREETYPE_FONT = os.path.join(FREETYPE_DEMO_DIR, "robotomono.ttf")


def run_freetype_tests(compiler_cmd, results, filter_str=None):
    test_name = "freetype/demo"
    if filter_str and filter_str not in test_name:
        return

    demo_json = os.path.join(FREETYPE_DEMO_DIR, "bin.json")
    wasm, err = build_project(demo_json, compiler_cmd)
    if wasm is None:
        results.record(test_name, False, f"Build failed:\n{err}")
        return

    work = tempfile.mkdtemp(prefix="freetype_")
    try:
        bmp_path = os.path.join(work, "output.bmp")
        r = subprocess.run(
            ["node", "--experimental-wasm-exnref", HOST_JS, wasm,
             FREETYPE_FONT, "Hello", bmp_path],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            results.record(test_name, False,
                           f"Exit code {r.returncode}\nstderr: {r.stderr}")
        elif not os.path.exists(bmp_path):
            results.record(test_name, False,
                           f"BMP not written\nstdout: {r.stdout}")
        elif "Wrote" in r.stdout and "BMP to" in r.stdout:
            results.record(test_name, True)
        else:
            results.record(test_name, False,
                           f"Unexpected output:\n{r.stdout}")
    finally:
        import shutil
        shutil.rmtree(work, ignore_errors=True)


# --- disw (WebAssembly disassembler) tests ---

def ensure_disw_built():
    """Build build/disw-native from vendor/disw/src/ if missing or stale."""
    os.makedirs(BUILD_DIR, exist_ok=True)
    needs_build = not os.path.exists(DISW_BIN)
    if not needs_build:
        bin_mtime = os.path.getmtime(DISW_BIN)
        for src in DISW_SOURCES:
            if os.path.exists(src) and os.path.getmtime(src) > bin_mtime:
                needs_build = True
                break
    if needs_build:
        print("Building disw-native...")
        r = subprocess.run(
            ["clang", "-std=c99", "-O0", "-Wall", "-Werror",
             "-I", os.path.join(DISW_DIR, "src"),
             os.path.join(DISW_DIR, "src", "parse.c"),
             os.path.join(DISW_DIR, "src", "disasm.c"),
             os.path.join(DISW_DIR, "src", "main.c"),
             "-o", DISW_BIN],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            print(f"disw build failed:\n{r.stderr}", file=sys.stderr)
            return False
        print("disw build complete.")
    return True


def run_disw_tests(results, filter_str=None):
    if not ensure_disw_built():
        results.record("disw/build", False, "Failed to build disw-native")
        return

    test_dirs = sorted(
        d for d in os.listdir(DISW_TEST_DIR)
        if os.path.isdir(os.path.join(DISW_TEST_DIR, d))
    )

    for name in test_dirs:
        test_name = f"disw/{name}"
        if filter_str and filter_str not in test_name:
            continue

        test_path = os.path.join(DISW_TEST_DIR, name)
        build_py = os.path.join(test_path, "build.py")
        expected_file = os.path.join(test_path, "expected.stdout")
        config_file = os.path.join(test_path, "config.json")

        if not os.path.exists(build_py) or not os.path.exists(expected_file):
            results.skip(test_name)
            continue

        r = subprocess.run(
            [sys.executable, build_py],
            capture_output=True, text=True, timeout=10, cwd=test_path,
        )
        if r.returncode != 0:
            results.record(test_name, False, f"build.py failed:\n{r.stderr}")
            continue

        flags = ["-h"]
        if os.path.exists(config_file):
            with open(config_file) as f:
                cfg = json.load(f)
            flags = cfg.get("flags", ["-h"])

        r = subprocess.run(
            [DISW_BIN] + flags + ["input.wasm"],
            capture_output=True, text=True, timeout=10, cwd=test_path,
        )
        if r.returncode != 0:
            results.record(test_name, False,
                           f"disw exited {r.returncode}\nstderr: {r.stderr}")
            continue

        with open(expected_file) as f:
            expected = f.read()

        if r.stdout == expected:
            results.record(test_name, True)
        else:
            results.record(test_name, False,
                           f"Output mismatch:\n--- expected ---\n{expected}"
                           f"--- got ---\n{r.stdout}")


# --- sourcemap tests ---

def run_sourcemap_tests(compiler_cmd, results, filter_str=None):
    test_dirs = sorted(
        d for d in os.listdir(SOURCEMAP_DIR)
        if os.path.isdir(os.path.join(SOURCEMAP_DIR, d))
    )

    for name in test_dirs:
        test_name = f"sourcemap/{name}"
        if filter_str and filter_str not in test_name:
            continue

        test_path = os.path.join(SOURCEMAP_DIR, name)
        verify_js = os.path.join(test_path, "verify.js")
        c_files = sorted(
            os.path.join(test_path, f) for f in os.listdir(test_path) if f.endswith(".c")
        )
        if not c_files or not os.path.exists(verify_js):
            results.skip(test_name)
            continue

        with tempfile.NamedTemporaryFile(suffix=".wasm", delete=False) as tmp:
            wasm_path = tmp.name

        try:
            rel_c_files = [os.path.relpath(f, ROOT_DIR) for f in c_files]
            compile_cmd = [*compiler_cmd, "-g", "-o", wasm_path] + rel_c_files
            cr = subprocess.run(compile_cmd, capture_output=True, text=True, timeout=30, cwd=ROOT_DIR)
            if cr.returncode != 0:
                results.record(test_name, False,
                               f"Compilation failed (exit {cr.returncode}):\n{cr.stderr}")
                continue

            vr = subprocess.run(
                ["node", verify_js, wasm_path],
                capture_output=True, text=True, timeout=10,
            )
            if vr.returncode != 0:
                results.record(test_name, False, vr.stdout.strip() or vr.stderr.strip())
            else:
                results.record(test_name, True)
        finally:
            if os.path.exists(wasm_path):
                os.unlink(wasm_path)


# --- Main ---

def main():
    parser = argparse.ArgumentParser(
        description="Unified test runner for the C-to-WASM compiler",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--all", action="store_true",
                        help="Equivalent to --types=all --compiler=all")
    parser.add_argument("--types", default="unit",
                        help="Comma-separated test categories (default: unit). Use 'all' for everything.")
    parser.add_argument("--compiler", default="js",
                        help="Which compiler: js (default), cc, or all")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Show per-test PASS/FAIL/SKIP")
    parser.add_argument("-q", "--quiet", action="store_true",
                        help="Only show final summary")
    parser.add_argument("--filter", default=None,
                        help="Only run tests matching this substring")
    parser.add_argument("--actions", nargs="+", default=["parse", "wasm"],
                        help="Actions for equiv tests (default: parse wasm)")
    args = parser.parse_args()

    if args.all:
        args.types = "all"
        args.compiler = "all"

    categories = ALL_CATEGORIES if args.types == "all" else [c.strip() for c in args.types.split(",")]

    for cat in categories:
        if cat not in ALL_CATEGORIES:
            print(f"Unknown category: {cat}", file=sys.stderr)
            print(f"Available: {', '.join(ALL_CATEGORIES)}, all", file=sys.stderr)
            sys.exit(1)

    compiler_modes = ["cc", "js"] if args.compiler == "all" else [args.compiler]

    verbosity = 1
    if args.quiet:
        verbosity = 0
    elif args.verbose:
        verbosity = 2

    os.makedirs(TEST_TMPDIR, exist_ok=True)
    results = Results(verbosity)

    for cat in categories:
        if cat in ("unit", "extra"):
            test_base = UNIT_DIR if cat == "unit" else EXTRA_DIR
            for mode in compiler_modes:
                results.section(f"{cat} ({mode})")
                run_unit_or_extra(test_base, get_compiler(mode), results,
                                  filter_str=args.filter,
                                  label_prefix=f"{mode}:" if len(compiler_modes) > 1 else "")

        elif cat == "equiv":
            if len(compiler_modes) < 2:
                if verbosity >= 1:
                    results._end_section()
                    print("--- equiv: skipped (requires --compiler=all) ---")
                continue
            results.section("equiv")
            run_equiv(results, filter_str=args.filter, actions=args.actions)

        elif cat == "projects":
            if len(compiler_modes) >= 2:
                results.section("projects (equiv)")
                run_projects_equiv(results, filter_str=args.filter)
            else:
                for mode in compiler_modes:
                    results.section(f"projects ({mode})")
                    run_projects(get_compiler(mode), results, filter_str=args.filter)

        elif cat == "zlib":
            for mode in compiler_modes:
                results.section(f"zlib ({mode})")
                run_zlib_tests(get_compiler(mode), results, filter_str=args.filter)

        elif cat == "lua":
            for mode in compiler_modes:
                results.section(f"lua ({mode})")
                run_lua_tests(get_compiler(mode), results, filter_str=args.filter)

        elif cat == "freetype":
            for mode in compiler_modes:
                results.section(f"freetype ({mode})")
                run_freetype_tests(get_compiler(mode), results, filter_str=args.filter)

        elif cat == "disw":
            results.section("disw")
            run_disw_tests(results, filter_str=args.filter)

        elif cat == "sourcemap":
            for mode in compiler_modes:
                results.section(f"sourcemap ({mode})")
                run_sourcemap_tests(get_compiler(mode), results, filter_str=args.filter)

    results.print_summary()
    sys.exit(0 if results.success else 1)


if __name__ == "__main__":
    main()
