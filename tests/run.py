#!/usr/bin/env python3
"""Test runner for the C-to-WASM compiler.

Usage:
    python3 tests/run.py                                  # default: unit tests
    python3 tests/run.py --types=unit,extra                # multiple categories
    python3 tests/run.py --types=all                       # everything
    python3 tests/run.py --types=lua                       # Lua official test suite
    python3 tests/run.py -v                                # verbose per-test output
    python3 tests/run.py --filter=arithmetic               # only tests matching substring

Categories:
    unit   — compile+run tests from tests/unit/
    extra  — compile+run tests from tests/extra/
    lua    — Lua official test suite (build VM, run .lua files)
    libpng — libpng golden PNG decode tests (RGB, RGBA, gray, palette, gradient)
    libjpeg — libjpeg golden JPEG tests (baseline, progressive, arithmetic, gray)
    sqlite — SQLite integration tests (build sqlite.wasm, run .sql scripts)
    disw   — WebAssembly disassembler output tests
    tcc    — differential tests: wasm-built tcc vs clang-built tcc must emit
             byte-identical i386 ELF objects for the same inputs
    libc   — musl libc-test functional suite (self-checking conformance)
    fuzz   — Csmith differential corpus (checksums vs clang-native; live
             generation too when a csmith binary is available)
    sourcemap — source map line number accuracy tests
    all    — all of the above
"""

import argparse
import json
import os
import re
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
COMPILER_JS = os.path.join(ROOT_DIR, "compiler.js")
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
AST_DIR = os.path.join(SCRIPT_DIR, "ast")
BLOCKFS_DIR = os.path.join(SCRIPT_DIR, "blockfs")

LIBC_TEST_DIR = os.path.join(VENDOR_DIR, "libc-test")
CSMITH_CORPUS_DIR = os.path.join(VENDOR_DIR, "csmith-corpus")

TCC_DIR = os.path.join(VENDOR_DIR, "tcc")
TCC_NATIVE_BIN = os.path.join(BUILD_DIR, "tcc-native")
TCC_TEST_DIR = os.path.join(SCRIPT_DIR, "tcc")

SQLITE_DIR = os.path.join(VENDOR_DIR, "sqlite")
SQLITE_TEST_DIR = os.path.join(SCRIPT_DIR, "sqlite")

LIBPNG_DIR = os.path.join(VENDOR_DIR, "libpng")
LIBPNG_TESTDATA = os.path.join(LIBPNG_DIR, "testdata")

LIBJPEG_DIR = os.path.join(VENDOR_DIR, "libjpeg")
LIBJPEG_TESTDATA = os.path.join(LIBJPEG_DIR, "testdata")

MICROPYTHON_DIR = os.path.join(VENDOR_DIR, "micropython")
MICROPYTHON_TEST_DIR = os.path.join(SCRIPT_DIR, "micropython")
MICROPYTHON_UPSTREAM_TEST_DIR = os.path.join(MICROPYTHON_DIR, "tests")

# The CLI under test moved out of vendor/ when it stopped being a fixture and
# became a shipped gucOS app (ticket #474): os/git is the product, packages/
# git.json ships it, and this category is its cheap golden-backed regression
# net. The category and tests/fakegit/ keep their historical names.
FAKEGIT_DIR = os.path.join(ROOT_DIR, "os", "git")
FAKEGIT_TEST_DIR = os.path.join(SCRIPT_DIR, "fakegit")

CAIRO_DIR = os.path.join(VENDOR_DIR, "cairo")

ALL_CATEGORIES = ["ast", "blockfs", "unit", "extra", "ext", "projects", "zlib", "lua", "freetype", "libpng", "libjpeg", "cairo", "micropython", "micropython-upstream", "sqlite", "disw", "sourcemap", "tcc", "libc", "fuzz", "fakegit"]
DEFAULT_CATEGORIES = ["unit"]


# --- Compiler ---

COMPILER_CMD = ["node", COMPILER_JS]


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
            run_result = subprocess.run(
                run_cmd, capture_output=True, text=True, timeout=30,
                stdin=subprocess.PIPE,
            )

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


# --- Unit tests (delegated to node) ---

RUN_UNIT_JS = os.path.join(SCRIPT_DIR, "run-unit.js")


def run_unit_node(results, filter_str=None):
    """Run the `unit` category via tests/run-unit.js in JSONL mode.

    The node runner compiles and executes each test in-process across a
    worker_threads pool — an order-of-magnitude faster than spawning a
    fresh `node` per test. We stream its JSONL output into the existing
    Results object so verbose/quiet/summary behavior is unchanged.
    """
    cmd = ["node", "--experimental-wasm-exnref", RUN_UNIT_JS, "--jsonl"]
    if filter_str:
        cmd.append(f"--filter={filter_str}")
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1, cwd=ROOT_DIR,
    )
    stderr_chunks = []

    def drain_stderr():
        for line in iter(proc.stderr.readline, ''):
            stderr_chunks.append(line)

    err_reader = threading.Thread(target=drain_stderr, daemon=True)
    err_reader.start()

    # Tests the JS runner can't handle in-process (chdir, timed stdin) are
    # emitted as `status: skip, fallback: true`. We collect them here and
    # rerun via the subprocess-based path below — the JS runner still
    # handles the bulk of the work, and these fall back gracefully.
    fallback_names = []

    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            # Unexpected non-JSON output — surface to stderr and keep going.
            sys.stderr.write(f"run-unit.js: {line}\n")
            continue
        name = obj.get("name", "")
        status = obj.get("status")
        if status == "pass":
            results.record(name, True)
        elif status == "fail":
            results.record(name, False, obj.get("msg", ""))
        elif status == "xfail":
            # Pinned known-bug (todos NNNN): expected failure, stays GREEN.
            results.skip(name)
        elif status == "xpass":
            # A pinned bug started passing — loud failure: drop the tag.
            results.record(name, False, obj.get("msg", ""))
        elif status == "skip":
            if obj.get("fallback"):
                fallback_names.append(name)
            else:
                results.skip(name)

    proc.wait()
    err_reader.join(timeout=2)
    if proc.returncode not in (0, 1):
        results.record(
            "unit/<runner>", False,
            f"run-unit.js exited {proc.returncode}\n{''.join(stderr_chunks)}",
        )

    # Rerun fallback tests in-process here. `name` is relative to SCRIPT_DIR
    # (matching run_single_test's naming convention).
    for name in fallback_names:
        test_dir = os.path.join(SCRIPT_DIR, name)
        result = run_single_test(test_dir, COMPILER_CMD)
        if result is None:
            results.skip(name)
            continue
        result_name, ok, msg = result
        results.record(result_name, ok, msg)



# --- Projects ---


def discover_projects():
    """Find all vendor/*/bin.json files (executable projects).

    A project may opt OUT of the compile check with `"compileCheck": false` +
    a `"compileCheckSkip"` reason. That is for a vendor tree whose bin.json is
    real and consumed (vendor/cpython's is read by the sibling clang
    toolchain's manifest) but which compiler.js cannot build YET, so a red
    projects suite would say nothing new every run. The reason string must
    name the open ticket; run_projects prints it, so the exclusion is loud and
    re-reads itself every run instead of becoming folklore.
    """
    projects = []
    for entry in sorted(os.listdir(VENDOR_DIR)):
        pj = os.path.join(VENDOR_DIR, entry, "bin.json")
        if not os.path.isfile(pj):
            continue
        with open(pj) as f:
            proj = json.load(f)
        if proj.get("compileCheck", True) is False:
            reason = proj.get("compileCheckSkip", "")
            if not reason:
                raise SystemExit(
                    f"{pj}: compileCheck:false needs a compileCheckSkip reason "
                    f"naming the open ticket")
            print(f"  skip projects/{proj.get('name', entry)} — {reason}")
            continue
        projects.append((proj.get("name", entry), pj))
    # NetSurf gucOS frontend app: nested under vendor/netsurf/, so the
    # vendor/*/bin.json glob above never sees it — list it explicitly
    # (vendor/netsurf/bin.json, the monkey smoke binary, is discovered
    # normally).
    gucos = os.path.join(VENDOR_DIR, "netsurf", "gucos", "bin.json")
    if os.path.isfile(gucos):
        projects.append(("netsurf-gucos", gucos))
    return projects


def run_projects(results, filter_str=None):
    """Compile-only test for each vendor project."""
    for name, pj_path in discover_projects():
        test_name = f"projects/{name}"
        if filter_str and filter_str not in test_name:
            continue
        wasm, err = build_project(pj_path)
        if wasm is None:
            results.record(test_name, False, f"Build failed:\n{err}")
        else:
            results.record(test_name, True)

    # todos/0079: diamond dep dedup — base.json reached directly, via
    # mid.json's dep, and via a symlinked path must compile ONCE (pre-fix:
    # duplicate definition of base_value at link, twice).
    test_name = "projects/diamond-dedup"
    if not filter_str or filter_str in test_name:
        pj = os.path.join(SCRIPT_DIR, "projects", "diamond", "bin.json")
        wasm, err = build_project(pj)
        if wasm is None:
            results.record(test_name, False, f"Build failed:\n{err}")
        else:
            r = subprocess.run(
                ["node", "--experimental-wasm-exnref", HOST_JS, wasm],
                capture_output=True, text=True, timeout=30)
            ok = r.returncode == 0 and r.stdout == "diamond: 63\n"
            results.record(test_name, ok, "" if ok else
                           f"exit {r.returncode}\nstdout: {r.stdout}stderr: {r.stderr}")


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


def run_zlib_tests(results, filter_str=None):
    import shutil

    # --- zlib_demo self-test ---
    demo_name = "zlib/demo"
    if not filter_str or filter_str in demo_name:
        demo_json = os.path.join(ZLIB_TESTS_DIR, "zlib_demo.json")
        wasm, err = build_project(demo_json)
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
    tool_wasm, tool_err = build_project(tool_json)

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


# Per-project build budget. This is a HANG catcher, not a performance budget:
# the biggest projects legitimately take minutes to compile (netsurf measured
# ~62s at 4bc04fc4 and ~77s once Lane B landed, against the old 60s value —
# i.e. the suite had started failing on build DURATION alone). Keep it far
# above the slowest honest build so only a genuine hang trips it.
def build_project(project_json_path, timeout=300):
    """Build a project from its JSON file. Returns (wasm_path, error_string)."""
    with open(project_json_path) as f:
        proj = json.load(f)
    os.makedirs(BUILD_DIR, exist_ok=True)
    output = os.path.join(BUILD_DIR, f"{proj['name']}-js.wasm")
    cmd = [*COMPILER_CMD, "-o", output, project_json_path]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           cwd=ROOT_DIR)
    except subprocess.TimeoutExpired:
        # Report as an ordinary build failure. Letting TimeoutExpired escape
        # aborted the whole projects run with a traceback, so one slow project
        # hid the result of every project after it.
        return None, f"build timed out after {timeout}s"
    if r.returncode != 0:
        return None, r.stderr
    return output, ""


def run_lua_tests(results, filter_str=None):
    if not os.path.isdir(LUA_TEST_DIR):
        results.record("lua/build", False, f"Lua test dir not found: {LUA_TEST_DIR}")
        return

    wasm, err = build_project(os.path.join(LUA_DIR, "bin.json"))
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

FREETYPE_FONT = os.path.join(ROOT_DIR, "vendor", "fonts", "NotoSansMono-Regular.ttf")


def run_freetype_tests(results, filter_str=None):
    test_name = "freetype/demo"
    if filter_str and filter_str not in test_name:
        return

    demo_json = os.path.join(FREETYPE_DEMO_DIR, "bin.json")
    wasm, err = build_project(demo_json)
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


# --- cairo tests (todos/0061) ---
#
# Three binaries under vendor/cairo/:
#   bin.json           — smoke test: analytic pixel asserts (gradients, AA,
#                        clip) + cairo-ft text + PNG round-trip
#   demo/bin.json      — /bin/cairodemo's headless selftest (anchor pixels)
#   testsuite/bin.json — 14 UNMODIFIED upstream cairo test programs compared
#                        against upstream reference PNGs (9 pixel-exact)

def run_cairo_tests(results, filter_str=None):
    cases = [
        ("cairo/smoke", os.path.join(CAIRO_DIR, "bin.json"),
         [FREETYPE_FONT], "cairo 1.18.4 ok"),
        ("cairo/demo-selftest", os.path.join(CAIRO_DIR, "demo", "bin.json"),
         ["selftest", FREETYPE_FONT], "cairodemo selftest ok"),
        ("cairo/upstream-suite", os.path.join(CAIRO_DIR, "testsuite", "bin.json"),
         [os.path.join(CAIRO_DIR, "testsuite", "reference")],
         "14 upstream tests ok"),
    ]
    for test_name, bin_json, args, want in cases:
        if filter_str and filter_str not in test_name:
            continue
        wasm, err = build_project(bin_json, timeout=300)
        if wasm is None:
            results.record(test_name, False, f"Build failed:\n{err}")
            continue
        r = subprocess.run(
            ["node", "--experimental-wasm-exnref", HOST_JS, wasm, *args],
            capture_output=True, text=True, timeout=120, cwd=ROOT_DIR,
        )
        if r.returncode != 0:
            results.record(test_name, False,
                           f"Exit code {r.returncode}\nstdout: {r.stdout}\nstderr: {r.stderr}")
        elif want in r.stdout:
            results.record(test_name, True)
        else:
            results.record(test_name, False, f"Unexpected output:\n{r.stdout}")


# --- libpng tests ---
#
# Golden data lives in vendor/libpng/testdata/:
#   *.png          — input PNGs (generated by Pillow: RGB, RGBA, grayscale,
#                    grayscale+alpha, palette, 1-bit B&W, interlaced, 64x64)
#   *.rgb          — expected decoded pixels (text: "r,g,b" per line)
#   *_written.png  — expected output PNGs (generated by our libpng)
#
# Tests:
#   read   — decode each golden PNG, compare every pixel to .rgb reference
#   write  — encode pixels from .rgb, compare output bytes to _written.png golden
#   roundtrip — decode _written.png, compare every pixel to .rgb reference

LIBPNG_BASENAMES = ["rgb_2x2", "rgba_3x1", "gray_4x1", "palette_2x2", "gradient_8x8",
                    "graya_3x2", "large_64x64", "interlaced_8x8", "bw_4x2"]


def run_libpng_tests(results, filter_str=None):
    import shutil

    bin_json = os.path.join(LIBPNG_DIR, "bin.json")
    wasm, err = build_project(bin_json)
    if wasm is None:
        results.record("libpng/build", False, f"Build failed:\n{err}")
        return

    def run_test(name, args):
        if filter_str and filter_str not in name:
            return
        try:
            r = subprocess.run(
                ["node", "--experimental-wasm-exnref", HOST_JS, wasm] + args,
                capture_output=True, text=True, timeout=30,
            )
        except subprocess.TimeoutExpired:
            results.record(name, False, "Timed out (30s)")
            return
        if r.returncode != 0:
            results.record(name, False,
                           f"Exit code {r.returncode}\nstdout: {r.stdout}\nstderr: {r.stderr}")
        else:
            results.record(name, True)

    td = LIBPNG_TESTDATA
    work = tempfile.mkdtemp(prefix="libpng_")
    try:
        for base in LIBPNG_BASENAMES:
            png = os.path.join(td, f"{base}.png")
            rgb = os.path.join(td, f"{base}.rgb")
            golden_written = os.path.join(td, f"{base}_written.png")

            run_test(f"libpng/read/{base}",
                     ["read", png, rgb])

            out_png = os.path.join(work, f"{base}.png")
            run_test(f"libpng/write/{base}",
                     ["write", rgb, out_png, golden_written])

            run_test(f"libpng/roundtrip/{base}",
                     ["read", golden_written, rgb])
    finally:
        shutil.rmtree(work, ignore_errors=True)


# --- libjpeg tests ---
#
# Golden data lives in vendor/libjpeg/testdata/ (generated by a clang-native
# build of the SAME vendored tree — recipe in logs/2026-08-02/0448-libjpeg.md):
#   *.rgb      — encoder-input pixels (text: "w h", then "r,g,b" per line)
#   *.jpg      — the native-encoded JPEG (write golden AND decode input)
#   *_dec.rgb  — the native-decoded reference pixels
#   corrupt.jpg — truncated+garbled stream; decode must FAIL cleanly
#
# Tests (the wasm build must match the native build of the same C code):
#   read    — decode each .jpg, compare every pixel to *_dec.rgb (exact)
#   write   — encode from .rgb, compare bytes to the .jpg golden
#   corrupt — the error path really rejects (positive control: can go red)
#
# Modes per base: baseline, progressive (prog_*), arithmetic (ari_*),
# grayscale (gray_*) — all four entropy/colour paths of the library.

LIBJPEG_BASENAMES = [("solid_8x8", None), ("gradient_16x16", None),
                     ("freq_32x32", None), ("gray_16x16", "gray"),
                     ("prog_16x16", "prog"), ("ari_16x16", "ari")]


def run_libjpeg_tests(results, filter_str=None):
    import shutil

    bin_json = os.path.join(LIBJPEG_DIR, "bin.json")
    wasm, err = build_project(bin_json)
    if wasm is None:
        results.record("libjpeg/build", False, f"Build failed:\n{err}")
        return

    def run_test(name, args):
        if filter_str and filter_str not in name:
            return
        try:
            r = subprocess.run(
                ["node", "--experimental-wasm-exnref", HOST_JS, wasm] + args,
                capture_output=True, text=True, timeout=30,
            )
        except subprocess.TimeoutExpired:
            results.record(name, False, "Timed out (30s)")
            return
        if r.returncode != 0:
            results.record(name, False,
                           f"Exit code {r.returncode}\nstdout: {r.stdout}\nstderr: {r.stderr}")
        else:
            results.record(name, True)

    td = LIBJPEG_TESTDATA
    work = tempfile.mkdtemp(prefix="libjpeg_")
    try:
        for base, mode in LIBJPEG_BASENAMES:
            jpg = os.path.join(td, f"{base}.jpg")
            rgb = os.path.join(td, f"{base}.rgb")
            dec = os.path.join(td, f"{base}_dec.rgb")

            run_test(f"libjpeg/read/{base}", ["read", jpg, dec])

            out_jpg = os.path.join(work, f"{base}.jpg")
            run_test(f"libjpeg/write/{base}",
                     ["write", rgb, out_jpg, jpg] + ([mode] if mode else []))

        run_test("libjpeg/corrupt-rejected",
                 ["corrupt", os.path.join(td, "corrupt.jpg")])
    finally:
        shutil.rmtree(work, ignore_errors=True)


# --- SQLite tests ---
#
# Builds vendor/sqlite/bin.json once, then walks tests/sqlite/<name>/ entries.
# Each directory is one test:
#   test.sql        — fed to wasm sqlite on stdin
#   expected.txt    — required, byte-exact stdout match
#   expected_err.txt — optional, byte-exact stderr match
#   config.json     — optional per-test overrides (see tests/sqlite/README.md)
#
# Exit code is intentionally ignored: SQLite reports per-statement constraint
# failures via stderr + non-zero exit but continues processing — so we
# compare stdout/stderr instead. Set `config.json: { "expectExitCode": 0 }`
# to add an exit-code assertion.

# --- MicroPython tests ---
#
# Builds vendor/micropython/test_bin.json once (a test variant of the
# minimal port that reads the entire script from stdin and execs it via
# do_str() — no REPL). Each test under tests/micropython/<name>/ is a
# script.py + expected.stdout pair: we feed the script through stdin and
# compare stdout.

def run_micropython_genhdr_check(results, filter_str=None):
    """vendor/micropython/genhdr/* must match the sources + mpconfigport.h.

    The qstr pool, the module table and the GC root-pointer list are GENERATED
    (upstream generates them per build; this repo commits them, since vendored
    projects have no Makefile). A config edit that adds a qstr and forgets the
    regeneration is a link error at best and a stale pool at worst, so the
    regenerator's --check is a test. Needs `cc` + python3 — the same two host
    tools the tcc/fuzz categories already hard-require.
    """
    test_name = "micropython/genhdr-sync"
    if filter_str and filter_str not in test_name:
        return
    tool = os.path.join(ROOT_DIR, "tools", "mkmpgenhdr.js")
    if not os.path.exists(tool):
        results.record(test_name, False, f"Not found: {tool}")
        return
    try:
        r = subprocess.run(["node", tool, "--check"], capture_output=True,
                           text=True, timeout=300, cwd=ROOT_DIR)
    except subprocess.TimeoutExpired:
        results.record(test_name, False, "mkmpgenhdr --check timed out (300s)")
        return
    if r.returncode == 0:
        results.record(test_name, True)
    else:
        results.record(test_name, False, (r.stderr or r.stdout).strip())


def run_micropython_tests(results, filter_str=None):
    if not os.path.isdir(MICROPYTHON_TEST_DIR):
        results.record("micropython/build", False, f"Test dir not found: {MICROPYTHON_TEST_DIR}")
        return

    run_micropython_genhdr_check(results, filter_str)

    test_bin = os.path.join(MICROPYTHON_DIR, "test_bin.json")
    if not os.path.exists(test_bin):
        results.record("micropython/build", False, f"Not found: {test_bin}")
        return

    # MicroPython is ~100 .c files; give the build a generous timeout.
    wasm, err = build_project(test_bin, timeout=600)
    if wasm is None:
        results.record("micropython/build", False, f"Failed to build micropython-test.wasm:\n{err}")
        return

    files = sorted(f for f in os.listdir(MICROPYTHON_TEST_DIR) if f.endswith(".py"))
    for f in files:
        test_name = f"micropython/{f}"
        if filter_str and filter_str not in test_name:
            continue
        script_path = os.path.join(MICROPYTHON_TEST_DIR, f)
        expected_path = script_path + ".exp"
        if not os.path.exists(expected_path):
            results.record(test_name, False, f"Missing expected output: {expected_path}")
            continue
        with open(script_path, "rb") as sf:
            script_bytes = sf.read()
        try:
            r = subprocess.run(
                ["node", "--experimental-wasm-exnref", HOST_JS, wasm],
                input=script_bytes,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30
            )
            actual = r.stdout.decode("utf-8", errors="replace") if isinstance(r.stdout, bytes) else r.stdout
            # MicroPython's print emits \r\n; normalize before comparing.
            actual = actual.replace("\r\n", "\n")
            with open(expected_path) as ef:
                expected = ef.read()
            if actual == expected:
                results.record(test_name, True)
            else:
                msg = f"stdout mismatch:\n--- expected ---\n{expected}--- actual ---\n{actual}"
                results.record(test_name, False, msg.strip())
        except subprocess.TimeoutExpired:
            results.record(test_name, False, "Timed out (30s)")


# --- MicroPython upstream tests ---
#
# Runs scripts from vendor/micropython/tests/{basics,float}/. For each .py:
#   - If a .py.exp file exists, use it as the expected output.
#   - Otherwise, run the .py through CPython3 and use that as expected.
#   - Compare against our compiled MicroPython's output (\r\n normalized).
#
# stderr is MERGED into stdout, matching upstream's own run-tests.py
# (stderr=subprocess.STDOUT). Since todos/0117 R1 the port routes uncaught
# tracebacks and mp_warning() to stderr like upstream's unix port does
# (MICROPY_ERROR_PRINTER), and upstream's .exp goldens — e.g.
# basics/bytes_compare3.py.exp's "Warning: Comparison between bytes and str"
# — were recorded against a merged stream. Both are raw unbuffered write()s
# to the same pipe, so the interleaving is faithful.
# A skip list covers tests that exercise features the minimal port can't
# handle (large ints, complex numbers, async, etc.) — they'd fail for
# reasons unrelated to our compiler.

# Tests that exercise features the minimal port doesn't enable (large
# ints / complex / t-strings / memoryview's advanced bits / etc.). Most
# of these would compile if we enabled the relevant MICROPY_PY_* flag,
# but for the minimal port we deliberately leave them off — keeping
# them in the failure list is just noise. Substring match against the
# relative path under tests/.
MICROPYTHON_UPSTREAM_SKIP = {
    "complex",       # requires MICROPY_PY_BUILTINS_COMPLEX
    "tstring",       # Python 3.13 t-strings, not enabled
    "/struct_",      # `struct` module not enabled in minimal port
    "float2int_",    # imports `struct` to probe float width (module not built)
    "/uctypes",      # uctypes module not enabled
    "/array",        # array module not enabled (todos/0117 R2)
    "/gc",           # gc module not enabled (todos/0117 R2)
    "math_domain_special",    # has minor float-precision differences
    "import_star_nonmodule",  # needs MICROPY_PY_SYS_MODULES (todos/0117 R2)
    "memoryview_gc",          # needs the gc module (todos/0117 R2; not caught by /gc)
    "float_format_ints",      # needs the array module (todos/0117 R2; not caught by /array)
    # todos/0117 R1 enabled MICROPY_PY_IO / SYS_STDFILES / SYS_EXIT / FUNCTION_ATTRS
    # and lifted the "can't regenerate the QSTR pool" ceiling (tools/mkmpgenhdr.js),
    # so the whole "/io_" and "/sys_" families AND builtin_compile came OFF this
    # table (+15 green). The stragglers inside those families — sys_getsizeof,
    # sys_tracebacklimit, io_buffered_writer — need no entry here: they print
    # "SKIP" themselves, which the runner below already honours. Don't re-add a
    # blanket family skip; it hides the ones that do run.
}


def run_micropython_upstream_tests(results, filter_str=None):
    if not os.path.isdir(MICROPYTHON_UPSTREAM_TEST_DIR):
        results.record("micropython-upstream/build", False,
                       f"Test dir not found: {MICROPYTHON_UPSTREAM_TEST_DIR}")
        return

    test_bin = os.path.join(MICROPYTHON_DIR, "test_bin.json")
    wasm, err = build_project(test_bin, timeout=600)
    if wasm is None:
        results.record("micropython-upstream/build", False,
                       f"Failed to build micropython-test.wasm:\n{err}")
        return

    # Gather tests from the curated subdirs.
    subdirs = ["basics", "float"]
    files = []
    for sub in subdirs:
        d = os.path.join(MICROPYTHON_UPSTREAM_TEST_DIR, sub)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if f.endswith(".py"):
                files.append(os.path.join(sub, f))

    for rel in files:
        test_name = f"micropython-upstream/{rel}"
        if filter_str and filter_str not in test_name:
            continue
        if any(skip in test_name for skip in MICROPYTHON_UPSTREAM_SKIP):
            results.skip(test_name)
            continue

        script_path = os.path.join(MICROPYTHON_UPSTREAM_TEST_DIR, rel)
        exp_path = script_path + ".exp"

        # Compute expected output: prefer .exp file, else run CPython.
        if os.path.exists(exp_path):
            try:
                with open(exp_path) as ef:
                    expected = ef.read()
            except OSError as e:
                results.record(test_name, False, f"Couldn't read {exp_path}: {e}")
                continue
        else:
            try:
                with open(script_path, "rb") as sf:
                    script_bytes = sf.read()
                cpy = subprocess.run(["python3", "-"], input=script_bytes,
                                     capture_output=True, timeout=10)
                if cpy.returncode != 0:
                    # CPython rejected the script — usually means the test
                    # uses MicroPython-specific syntax or relies on an
                    # exception in CPython. Skip rather than failing noisily.
                    results.skip(test_name)
                    continue
                expected = cpy.stdout.decode("utf-8", errors="replace")
            except subprocess.TimeoutExpired:
                results.record(test_name, False, "CPython baseline timed out")
                continue
            except FileNotFoundError:
                results.record(test_name, False,
                               "python3 not found (needed to compute expected output)")
                return

        # Run through our MicroPython.
        try:
            with open(script_path, "rb") as sf:
                script_bytes = sf.read()
            r = subprocess.run(
                ["node", "--experimental-wasm-exnref", HOST_JS, wasm],
                input=script_bytes,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15
            )
            actual = r.stdout.decode("utf-8", errors="replace") if isinstance(r.stdout, bytes) else r.stdout
            actual = actual.replace("\r\n", "\n")
            # Upstream convention (run-tests.py): a test that prints exactly
            # "SKIP" is declaring a needed feature absent in this build.
            if actual == "SKIP\n":
                results.skip(test_name)
                continue
            if actual == expected:
                results.record(test_name, True)
            else:
                # Truncate long diffs to keep the report readable.
                trunc = lambda s: s if len(s) < 400 else s[:400] + "...[truncated]"
                msg = f"stdout mismatch:\n--- expected ---\n{trunc(expected)}--- actual ---\n{trunc(actual)}"
                results.record(test_name, False, msg.strip())
        except subprocess.TimeoutExpired:
            results.record(test_name, False, "Timed out (15s)")


def run_sqlite_tests(results, filter_str=None):
    if not os.path.isdir(SQLITE_TEST_DIR):
        results.record("sqlite/build", False, f"Test dir not found: {SQLITE_TEST_DIR}")
        return

    # SQLite amalgamation is ~250k LOC; give the build a generous timeout.
    bin_json = os.path.join(SQLITE_DIR, "bin.json")
    if not os.path.exists(bin_json):
        results.record("sqlite/build", False, f"Not found: {bin_json}")
        return
    wasm, err = build_project(bin_json, timeout=600)
    if wasm is None:
        results.record("sqlite/build", False, f"Failed to build sqlite.wasm:\n{err}")
        return

    subdirs = sorted(
        d for d in os.listdir(SQLITE_TEST_DIR)
        if os.path.isdir(os.path.join(SQLITE_TEST_DIR, d))
    )
    for d in subdirs:
        test_name = f"sqlite/{d}"
        if filter_str and filter_str not in test_name:
            continue

        test_dir = os.path.join(SQLITE_TEST_DIR, d)
        sql_path = os.path.join(test_dir, "test.sql")
        expected_path = os.path.join(test_dir, "expected.txt")
        expected_err_path = os.path.join(test_dir, "expected_err.txt")
        config_path = os.path.join(test_dir, "config.json")

        if not os.path.exists(sql_path) or not os.path.exists(expected_path):
            results.record(test_name, False,
                           "Missing test.sql or expected.txt")
            continue

        cfg = {}
        if os.path.exists(config_path):
            try:
                with open(config_path) as f:
                    cfg = json.load(f)
            except Exception as e:
                results.record(test_name, False, f"Bad config.json: {e}")
                continue
        if cfg.get("skip"):
            results.skip(test_name)
            continue

        shell_args = cfg.get("shellArgs", ["-batch"])
        with open(sql_path, "rb") as f:
            stdin_bytes = f.read()

        try:
            r = subprocess.run(
                ["node", "--experimental-wasm-exnref", HOST_JS, wasm, *shell_args],
                input=stdin_bytes,
                capture_output=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            results.record(test_name, False, "Timed out (60s)")
            continue

        stdout = r.stdout.decode("utf-8", errors="replace")
        stderr = r.stderr.decode("utf-8", errors="replace")

        with open(expected_path) as f:
            expected_stdout = f.read()

        if stdout != expected_stdout:
            msg = (f"stdout mismatch\n"
                   f"--- expected ---\n{expected_stdout}"
                   f"--- got (exit={r.returncode}) ---\n{stdout}"
                   f"--- stderr ---\n{stderr}")
            results.record(test_name, False, msg)
            continue

        if os.path.exists(expected_err_path):
            with open(expected_err_path) as f:
                expected_stderr = f.read()
            if stderr != expected_stderr:
                msg = (f"stderr mismatch\n"
                       f"--- expected ---\n{expected_stderr}"
                       f"--- got ---\n{stderr}")
                results.record(test_name, False, msg)
                continue

        expected_code = cfg.get("expectExitCode")
        if expected_code is not None and r.returncode != expected_code:
            results.record(test_name, False,
                           f"Exit code {r.returncode}, expected {expected_code}\nstderr: {stderr}")
            continue

        results.record(test_name, True)


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


# --- tcc (Tiny C Compiler, differential vs native build) ---
#
# Builds vendor/tcc twice: to wasm via compiler.js, and natively via clang.
# Each test case compiles the same input.c with both and requires the
# produced i386 ELF object files to be byte-identical — the native build
# acts as the oracle, so no binary goldens live in the repo. This is a
# deep integration test: any compiler.js miscompilation of tcc's own code
# shows up as divergent (or failing) tcc output.

def ensure_tcc_native_built():
    """Build build/tcc-native from vendor/tcc with clang if missing/stale."""
    os.makedirs(BUILD_DIR, exist_ok=True)
    sources = [
        os.path.join(TCC_DIR, f) for f in os.listdir(TCC_DIR)
        if f.endswith((".c", ".h"))
    ]
    needs_build = not os.path.exists(TCC_NATIVE_BIN)
    if not needs_build:
        bin_mtime = os.path.getmtime(TCC_NATIVE_BIN)
        needs_build = any(os.path.getmtime(s) > bin_mtime for s in sources)
    if needs_build:
        print("Building tcc-native...")
        # Mirror bin.json's defines, minus TCC_WASM_BUILD (the execvp stub
        # would conflict with the host libc's declaration).
        r = subprocess.run(
            ["clang", "-O1", "-w",
             "-DONE_SOURCE=1", "-DTCC_TARGET_I386", "-DCONFIG_TCC_PREDEFS=1",
             '-DCONFIG_TCC_CROSSPREFIX="i386-"', '-DCONFIG_TCCDIR="/tcc"',
             '-DCONFIG_TCC_SYSINCLUDEPATHS="/tcc/include"',
             '-DCONFIG_TCC_LIBPATHS="/tcc/lib"',
             '-DCONFIG_TRIPLET="i386-unknown-elf"',
             "-I", TCC_DIR, os.path.join(TCC_DIR, "tcc.c"),
             "-o", TCC_NATIVE_BIN],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            print(f"tcc-native build failed:\n{r.stderr}", file=sys.stderr)
            return False
        print("tcc-native build complete.")
    return True


def run_tcc_tests(results, filter_str=None):
    if not os.path.isdir(TCC_TEST_DIR):
        results.record("tcc/setup", False, f"Test dir not found: {TCC_TEST_DIR}")
        return
    if not ensure_tcc_native_built():
        results.record("tcc/build-native", False, "Failed to build tcc-native")
        return
    wasm, err = build_project(os.path.join(TCC_DIR, "bin.json"), timeout=300)
    if wasm is None:
        results.record("tcc/build-wasm", False, f"Failed to build tcc wasm:\n{err}")
        return

    os.makedirs(TEST_TMPDIR, exist_ok=True)

    def run_wasm_tcc(args, timeout=30):
        return subprocess.run(
            ["node", "--experimental-wasm-exnref", HOST_JS, wasm] + args,
            capture_output=True, text=True, timeout=timeout, cwd=ROOT_DIR)

    def run_native_tcc(args, timeout=30):
        return subprocess.run(
            [TCC_NATIVE_BIN] + args,
            capture_output=True, text=True, timeout=timeout, cwd=ROOT_DIR)

    # Version banner: both builds must agree.
    if not filter_str or filter_str in "tcc/version":
        rw = run_wasm_tcc(["-v"])
        rn = run_native_tcc(["-v"])
        if rw.stdout == rn.stdout and rw.returncode == 0:
            results.record("tcc/version", True)
        else:
            results.record("tcc/version", False,
                           f"-v mismatch:\n--- native ---\n{rn.stdout}--- wasm ---\n{rw.stdout}")

    test_dirs = sorted(
        d for d in os.listdir(TCC_TEST_DIR)
        if os.path.isdir(os.path.join(TCC_TEST_DIR, d))
    )
    for name in test_dirs:
        test_name = f"tcc/{name}"
        if filter_str and filter_str not in test_name:
            continue
        test_path = os.path.join(TCC_TEST_DIR, name)
        input_c = os.path.join(test_path, "input.c")
        if not os.path.exists(input_c):
            results.skip(test_name)
            continue

        flags = []
        config_file = os.path.join(test_path, "config.json")
        if os.path.exists(config_file):
            with open(config_file) as f:
                cfg = json.load(f)
            # Paths in flags are relative to the repo root (both compilers
            # run with cwd=ROOT_DIR).
            flags = cfg.get("flags", [])

        out_wasm = os.path.join(TEST_TMPDIR, f"tcc_{name}.wasm.o")
        out_native = os.path.join(TEST_TMPDIR, f"tcc_{name}.native.o")
        rn = run_native_tcc(flags + ["-c", input_c, "-o", out_native])
        if rn.returncode != 0:
            results.record(test_name, False, f"native tcc failed:\n{rn.stderr}")
            continue
        rw = run_wasm_tcc(flags + ["-c", input_c, "-o", out_wasm])
        if rw.returncode != 0:
            results.record(test_name, False,
                           f"wasm tcc exited {rw.returncode}:\n{rw.stdout}{rw.stderr}")
            continue

        with open(out_native, "rb") as f:
            expected = f.read()
        with open(out_wasm, "rb") as f:
            got = f.read()
        if expected == got:
            results.record(test_name, True)
        else:
            diff_at = next((i for i, (a, b) in enumerate(zip(expected, got)) if a != b),
                           min(len(expected), len(got)))
            results.record(test_name, False,
                           f"object files differ: native {len(expected)}B vs wasm {len(got)}B, "
                           f"first difference at byte {diff_at}")


# --- libc (musl libc-test functional suite) ---
#
# Self-checking conformance tests: t_error() prints a diagnostic and sets
# t_status; main returns it. Pass = exit 0 with empty output. See
# vendor/libc-test/README.md.

LIBC_TEST_SKIP = {
    # No process model on this target
    "vfork": "no fork/exec", "popen": "no fork/exec", "spawn": "no fork/exec",
    "fcntl": "needs fork + fd inheritance",
    "stat": "needs uids (geteuid)",
    "time": "no tzset/putenv timezone control",
    # No threads / TLS / dynamic linking
    "pthread_cancel-points": "no threads", "pthread_cancel": "no threads",
    "pthread_cond": "no threads", "pthread_mutex": "no threads",
    "pthread_mutex_pi": "no threads", "pthread_robust": "no threads",
    "pthread_tsd": "no threads", "sem_init": "no threads",
    "sem_open": "no named semaphores",
    "tls_align": "no TLS", "tls_align_dlopen": "no TLS/dlopen",
    "tls_align_dso": "no TLS", "tls_init": "no TLS",
    "tls_init_dlopen": "no TLS/dlopen", "tls_init_dso": "no TLS",
    "tls_local_exec": "no TLS",
    "dlopen": "no dynamic linking", "dlopen_dso": "no dynamic linking",
    # No SysV IPC / sockets
    "ipc_msg": "no SysV IPC", "ipc_sem": "no SysV IPC", "ipc_shm": "no SysV IPC",
    "socket": "no sockets", "inet_pton": "no networking",
    # Library features not implemented. Every entry here MUST cite the todos
    # item that funds it (todos/0298) — a bare "TODO" is a hole the suite
    # reports green over, which is how fnmatch/fdopen/utime sat skipped for
    # months after they started passing.
    "strptime": "not implemented: strptime() (todos/0307)",
    # Not a libc gap: the test writes the bare-assignment form `r = setjmp(jb);`
    # (vendor/libc-test/src/functional/setjmp.c:23), which compiler.js rejects
    # by design — it is UB per C11 7.13.1.1p4. sigsetjmp/siglongjmp DO exist.
    # This entry is PERMANENT. The todos/0311 citation is historical: ticket
    # #117 SHIPPED the p4-required contexts (switch / while / else-if /
    # expression statement, pinned by the sj_*_ctrl conformance tests) and,
    # as predicted there, this test stays skipped — line 23 is the UB form,
    # pinned rejected by diag_setjmp_assign_stmt.
    "setjmp": "test uses the C11-UB bare-assignment setjmp form, rejected by "
              "design — permanent (todos/0311 shipped as ticket #117; the "
              "p4-required contexts are accepted, line 23 remains UB)",
    # %s and width/'+' parsing DO exist; absent are %F %g %G %r %T %V, width
    # modifiers are honoured only by %C, and %y is wrong for negative years
    # (todos/0307). %s additionally diverges from musl's expectation by the
    # local UTC offset (todos/0310).
    "strftime": "missing %F %g %G %r %T %V, width modifiers only on %C, "
                "%y wrong for negative years (todos/0307); %s TZ divergence "
                "(todos/0310)",
    "sscanf_long": "needs setrlimit",
    # Locale machinery
    "clocale_mbfuncs": "no langinfo/locale beyond C",
    "mbc": "no langinfo/locale beyond C",
    "swprintf": "no langinfo/locale beyond C",
    "iconv_open": "no iconv",
    "mntent": "no /etc/mtab",
    "crypt": "no crypt()",
    "tgmath": "complex numbers not supported (__STDC_NO_COMPLEX__)",
}


def run_libc_tests(results, filter_str=None):
    func_dir = os.path.join(LIBC_TEST_DIR, "src", "functional")
    common_dir = os.path.join(LIBC_TEST_DIR, "src", "common")
    if not os.path.isdir(func_dir):
        results.record("libc/setup", False, f"Not found: {func_dir}")
        return
    os.makedirs(TEST_TMPDIR, exist_ok=True)
    support = [os.path.join(common_dir, "print.c"), os.path.join(common_dir, "rand.c")]

    for fname in sorted(os.listdir(func_dir)):
        if not fname.endswith(".c"):
            continue
        name = fname[:-2]
        test_name = f"libc/{name}"
        if filter_str and filter_str not in test_name:
            continue
        if name in LIBC_TEST_SKIP:
            results.skip(test_name)
            continue
        wasm = os.path.join(TEST_TMPDIR, f"libc_{name}.wasm")
        r = subprocess.run(
            [*COMPILER_CMD, os.path.join(func_dir, fname), *support,
             f"-I{common_dir}", "-o", wasm],
            capture_output=True, text=True, timeout=120, cwd=ROOT_DIR)
        if r.returncode != 0:
            results.record(test_name, False, f"compile failed:\n{r.stderr[:800]}")
            continue
        r = subprocess.run(
            ["node", "--experimental-wasm-exnref", HOST_JS, wasm],
            capture_output=True, text=True, timeout=60, cwd=ROOT_DIR)
        if r.returncode == 0 and r.stdout.strip() == "":
            results.record(test_name, True)
        else:
            results.record(test_name, False,
                           f"exit {r.returncode}\n{r.stdout[:800]}{r.stderr[:300]}")


# --- fuzz (Csmith differential corpus) ---
#
# Tier 1 (no extra deps): compile each vendored Csmith program with
# compiler.js and compare its checksum against the clang-native value
# recorded in manifest.json. Csmith output is UB-free by construction,
# so any mismatch is a guaranteed miscompile.
# Tier 2 (optional): if a csmith generator binary is found, also
# generate a few fresh seeds and differential-test them against clang.
#
# ORACLE SOUNDNESS (todos/0404): the native oracle is host clang, LP64
# (long = 64-bit); compiler.js targets wasm32, ILP32 (long = 32-bit).
# An L-suffixed literal in (INT32_MAX, UINT32_MAX] is a SIGNED 64-bit
# long natively but an UNSIGNED 32-bit long under ILP32 (C11 6.4.4.1p5),
# and UL literals differ in width — so a raw csmith program can be a
# DIFFERENT program on each side (seed 450020699's is: correct ILP32
# execution never terminates). Both sides therefore compile a
# width-normalized copy: every L/UL integer-literal suffix is rewritten
# to LL/ULL, which is a semantic no-op for LP64 clang (long == long
# long there) and gives the wasm side the oracle's literal types. The
# recorded tier-1 checksums came from LP64 clang on the raw sources, so
# they remain valid for the normalized ones. ILP32-specific literal
# typing itself is guarded by tests/unit/conformance/
# ilp32_long_literal_typing (a differential against an LP64 oracle
# cannot test it).

CSMITH_GEN_FLAGS = ["--max-funcs", "4", "--max-block-depth", "3",
                    "--max-array-dim", "2", "--max-array-len-per-dim", "4",
                    "--max-struct-fields", "6", "--max-expr-complexity", "8",
                    "--no-packed-struct"]
CSMITH_LIVE_SEEDS = 5  # fresh seeds per run when the generator is available

# L or UL (any case/order) on a decimal or hex integer literal, not
# already LL/ULL, not a float suffix (the lookbehind rejects "1.5L").
CSMITH_LONG_SUFFIX_RE = re.compile(
    r'(?<!\.)\b(0[xX][0-9a-fA-F]+|\d+)([uU][lL]|[lL][uU]|[lL])(?!\w)')


def normalize_long_literals(src_path, dst_path):
    """Copy a csmith program, rewriting L/UL literal suffixes to LL/ULL.

    See the ORACLE SOUNDNESS note above: this pins every long-typed
    literal to 64 bits so the LP64 native oracle and the ILP32 wasm
    build agree on the program's types.
    """
    with open(src_path) as f:
        src = f.read()
    out = CSMITH_LONG_SUFFIX_RE.sub(
        lambda m: m.group(1) + ("ULL" if "u" in m.group(2).lower() else "LL"),
        src)
    with open(dst_path, "w") as f:
        f.write(out)
    return dst_path


def find_csmith():
    import shutil
    cand = os.path.join(os.path.expanduser("~"), "git", "csmith", "build", "src", "csmith")
    if os.path.exists(cand):
        return cand
    return shutil.which("csmith")


def run_fuzz_tests(results, filter_str=None):
    corpus_dir = os.path.join(CSMITH_CORPUS_DIR, "corpus")
    runtime_dir = os.path.join(CSMITH_CORPUS_DIR, "runtime")
    manifest_path = os.path.join(CSMITH_CORPUS_DIR, "manifest.json")
    if not os.path.isfile(manifest_path):
        results.record("fuzz/setup", False, f"Not found: {manifest_path}")
        return
    with open(manifest_path) as f:
        manifest = json.load(f)
    os.makedirs(TEST_TMPDIR, exist_ok=True)

    def compile_and_run(src, tag):
        wasm = os.path.join(TEST_TMPDIR, f"fuzz_{tag}.wasm")
        r = subprocess.run(
            [*COMPILER_CMD, src, f"-I{runtime_dir}", "-o", wasm],
            capture_output=True, text=True, timeout=300, cwd=ROOT_DIR)
        if r.returncode != 0:
            return None, f"compile failed:\n{r.stderr[:600]}"
        try:
            r = subprocess.run(
                ["node", "--experimental-wasm-exnref", HOST_JS, wasm],
                capture_output=True, text=True, timeout=60, cwd=ROOT_DIR)
        except subprocess.TimeoutExpired:
            return None, "run timeout"
        if r.returncode != 0:
            return None, f"exit {r.returncode}: {r.stderr[:300]}"
        return r.stdout.strip(), None

    for fname, expected in sorted(manifest.items()):
        test_name = f"fuzz/{fname[:-2]}"
        if filter_str and filter_str not in test_name:
            continue
        src = normalize_long_literals(
            os.path.join(corpus_dir, fname),
            os.path.join(TEST_TMPDIR, f"fuzz_{fname[:-2]}_n64.c"))
        got, err = compile_and_run(src, fname[:-2])
        if err:
            results.record(test_name, False, err)
        elif got == expected:
            results.record(test_name, True)
        else:
            results.record(test_name, False,
                           f"checksum mismatch (MISCOMPILE): expected {expected!r}, got {got!r}")

    # Tier 2: live generation, differential against clang
    gen = find_csmith()
    if not gen:
        return
    if filter_str and "live" not in filter_str and filter_str not in "fuzz/live":
        return
    import random
    for _ in range(CSMITH_LIVE_SEEDS):
        seed = random.randint(1, 2**31)
        test_name = f"fuzz/live-{seed}"
        src = os.path.join(TEST_TMPDIR, f"fuzz_live_{seed}.c")
        try:
            subprocess.run([gen, "--seed", str(seed), *CSMITH_GEN_FLAGS, "-o", src],
                           check=True, timeout=60)
            # both sides compile the SAME normalized program (ORACLE
            # SOUNDNESS note above) — a raw csmith file can mean two
            # different programs to an LP64 native build and an ILP32
            # wasm build.
            src = normalize_long_literals(
                src, os.path.join(TEST_TMPDIR, f"fuzz_live_{seed}_n64.c"))
            nat = os.path.join(TEST_TMPDIR, f"fuzz_live_{seed}_n")
            r = subprocess.run(["clang", "-w", f"-I{runtime_dir}", src, "-o", nat],
                               capture_output=True, text=True, timeout=120)
            if r.returncode != 0:
                results.skip(test_name)
                continue
            n = subprocess.run([nat], capture_output=True, text=True, timeout=10)
            if n.returncode != 0:
                results.skip(test_name)  # native itself slow/odd: not our problem
                continue
        except subprocess.TimeoutExpired:
            results.skip(test_name)
            continue
        got, err = compile_and_run(src, f"live_{seed}")
        if err:
            results.record(test_name, False, f"seed {seed}: {err}")
        elif got == n.stdout.strip():
            results.record(test_name, True)
        else:
            results.record(test_name, False,
                           f"seed {seed}: checksum mismatch (MISCOMPILE): "
                           f"native {n.stdout.strip()!r}, wasm {got!r} — "
                           f"reproduce: csmith --seed {seed} {' '.join(CSMITH_GEN_FLAGS)}"
                           f", then rewrite L/UL literal suffixes to LL/ULL"
                           f" (normalize_long_literals) before comparing")


# --- sourcemap tests ---

def run_sourcemap_tests(results, filter_str=None):
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
            compile_cmd = [*COMPILER_CMD, "-g", "-o", wasm_path] + rel_c_files
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


# --- ast (JS-level unit tests for AST node invariants) ---

def run_ast_tests(results, filter_str=None):
    """Run tests/ast/*.js — JS-level unit tests for AST internals.

    Each .js file is invoked with `node`. The script's exit code is the
    pass/fail signal; its stdout is parsed for individual case failures
    when verbose output is requested.
    """
    if not os.path.isdir(AST_DIR):
        return
    test_files = sorted(
        f for f in os.listdir(AST_DIR) if f.endswith(".js")
    )
    for fname in test_files:
        test_name = f"ast/{fname[:-3]}"  # strip .js
        if filter_str and filter_str not in test_name:
            continue
        path = os.path.join(AST_DIR, fname)
        r = subprocess.run(
            ["node", path],
            capture_output=True, text=True, timeout=30, cwd=ROOT_DIR,
        )
        if r.returncode == 0:
            results.record(test_name, True)
        else:
            # Surface the test runner's own output so failures point at
            # individual cases.
            msg = r.stdout.strip() or r.stderr.strip()
            results.record(test_name, False, msg)


# --- blockfs (JS-level unit tests for the BLOCK_FS filesystem) ---

def run_ext_tests(results, filter_str=None):
    """Run tests/ext/run.js — verifies the optional libc-ext.js contract:
    the compiler works without it (graceful), and picks up regex/fnmatch/glob
    with it. The script's exit code is the pass/fail signal."""
    test_name = "ext/optional-libc-ext"
    if filter_str and filter_str not in test_name:
        return
    script = os.path.join(SCRIPT_DIR, "ext", "run.js")
    if not os.path.isfile(script):
        return
    r = subprocess.run(["node", script], capture_output=True, text=True,
                       timeout=120, cwd=ROOT_DIR)
    if r.returncode == 0:
        results.record(test_name, True)
    else:
        msg = (r.stdout.strip() or r.stderr.strip())
        results.record(test_name, False, msg)


def run_blockfs_tests(results, filter_str=None):
    """Run tests/blockfs/*.js — JS-level tests for the BLOCK_FS allocator,
    filesystem, and C end-to-end integration.

    Each .js file is invoked with `node`. The script's exit code is the
    pass/fail signal.
    """
    if not os.path.isdir(BLOCKFS_DIR):
        return
    test_files = sorted(
        f for f in os.listdir(BLOCKFS_DIR) if f.endswith(".js")
    )
    for fname in test_files:
        test_name = f"blockfs/{fname[:-3]}"  # strip .js
        if filter_str and filter_str not in test_name:
            continue
        path = os.path.join(BLOCKFS_DIR, fname)
        r = subprocess.run(
            ["node", path],
            capture_output=True, text=True, timeout=120, cwd=ROOT_DIR,
        )
        if r.returncode == 0:
            results.record(test_name, True)
        else:
            # Surface the test runner's own output for failure details.
            msg = r.stdout.strip() or r.stderr.strip()
            # Keep only the last few lines — FAIL lines and summary.
            lines = msg.split('\n')
            fail_lines = [l for l in lines if 'FAIL' in l or 'Passed:' in l or 'Failed:' in l]
            summary = '\n'.join(fail_lines[-10:]) if fail_lines else (lines[-10:] if len(lines) > 10 else lines)
            results.record(test_name, False, '\n'.join(summary) if isinstance(summary, list) else summary)


# --- fakegit tests ---
#
# Builds os/git/bin.json once, materializes the deterministic fixture repo
# (tests/fakegit/make-fixture.sh — todos/0183), then runs each
# tests/fakegit/<name>/ test against it. Each directory contains:
#   args.txt     — one argument per line. `-C <fixture>` is prepended, so the
#                  test names only the command and its own arguments.
#   cwd.txt      — OPTIONAL, one line: a path relative to the fixture root.
#                  Present ⇒ the binary runs WITH that directory as its cwd
#                  and WITHOUT -C, which is what makes the golden a proof of
#                  repo DISCOVERY (#474) rather than of an explicit path.
#   expected.txt — required, exact stdout match (captured from the fixture)

def run_fakegit_tests(results, filter_str=None):
    bin_json = os.path.join(FAKEGIT_DIR, "bin.json")
    if not os.path.exists(bin_json):
        results.record("fakegit/build", False, f"Not found: {bin_json}")
        return

    # The repo to test against: a deterministic fixture materialized fresh
    # each run (todos/0183 — goldens against the live checkout pinned one
    # HEAD and were permanently red). make-fixture.sh fixes author/
    # committer/date/tz and masks host git config, so the hashes in the
    # goldens reproduce on any machine at any HEAD.
    test_repo = os.path.join(TEST_TMPDIR, "fakegit-fixture")
    try:
        fx = subprocess.run(
            ["sh", os.path.join(FAKEGIT_TEST_DIR, "make-fixture.sh"), test_repo],
            capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        results.record("fakegit/fixture", False, "Fixture build timed out (60s)")
        return
    if fx.returncode != 0:
        results.record("fakegit/fixture", False, f"Fixture build failed:\n{fx.stderr.strip()}")
        return

    # Fakegit needs a longer build timeout (libgit2 is large)
    wasm, err = build_project(bin_json, timeout=600)
    if wasm is None:
        results.record("fakegit/build", False, f"Build failed:\n{err}")
        return

    if not os.path.isdir(FAKEGIT_TEST_DIR):
        results.record("fakegit/build", False, f"Test dir not found: {FAKEGIT_TEST_DIR}")
        return

    test_dirs = sorted(
        d for d in os.listdir(FAKEGIT_TEST_DIR)
        if os.path.isdir(os.path.join(FAKEGIT_TEST_DIR, d))
    )

    for tdir in test_dirs:
        test_name = f"fakegit/{tdir}"
        if filter_str and filter_str not in test_name:
            continue

        args_file = os.path.join(FAKEGIT_TEST_DIR, tdir, "args.txt")
        expected_file = os.path.join(FAKEGIT_TEST_DIR, tdir, "expected.txt")

        if not os.path.exists(args_file):
            results.record(test_name, False, f"Missing args.txt")
            continue
        if not os.path.exists(expected_file):
            results.record(test_name, False, f"Missing expected.txt")
            continue

        with open(args_file) as f:
            args = [line.strip() for line in f if line.strip()]

        # A cwd.txt test proves discovery: no -C, just a cwd somewhere inside
        # the repo. Everything else names the repo with -C, git's own spelling.
        cwd_file = os.path.join(FAKEGIT_TEST_DIR, tdir, "cwd.txt")
        if os.path.exists(cwd_file):
            with open(cwd_file) as f:
                rel = f.read().strip()
            run_cwd = os.path.join(test_repo, rel) if rel else test_repo
            if not os.path.isdir(run_cwd):
                results.record(test_name, False, f"cwd.txt names no directory: {rel}")
                continue
            argv = ["node", "--experimental-wasm-exnref", HOST_JS, wasm] + args
        else:
            run_cwd = None
            argv = ["node", "--experimental-wasm-exnref", HOST_JS, wasm,
                    "-C", test_repo] + args

        try:
            r = subprocess.run(
                argv, cwd=run_cwd,
                capture_output=True, timeout=60,
            )
            # Compare raw bytes to handle potential binary output cleanly
            actual = r.stdout
            with open(expected_file, "rb") as f:
                expected = f.read()
            if actual == expected:
                results.record(test_name, True)
            else:
                msg = ""
                if r.returncode != 0:
                    msg += f"Exit code: {r.returncode}\n"
                if r.stderr:
                    stderr_str = r.stderr.decode("utf-8", errors="replace")
                    msg += f"stderr: {stderr_str[:200]}\n"
                # Show first diff line (decode for display)
                alines = actual.decode("utf-8", errors="replace").split("\n")
                elines = expected.decode("utf-8", errors="replace").split("\n")
                msg += f"stdout lines: got {len(alines)}, expected {len(elines)}\n"
                for i, (a, e) in enumerate(zip(alines[:10], elines[:10])):
                    if a != e:
                        msg += f"  L{i+1}  got: {a[:100]}\n"
                        msg += f"  L{i+1}  exp: {e[:100]}\n"
                        break
                if len(actual) != len(expected):
                    msg += f"stdout bytes: got {len(actual)}, expected {len(expected)}\n"
                results.record(test_name, False, msg.strip())
        except subprocess.TimeoutExpired:
            results.record(test_name, False, "Timed out (60s)")


# --- Main ---

def main():
    parser = argparse.ArgumentParser(
        description="Test runner for the C-to-WASM compiler",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--all", action="store_true",
                        help="Equivalent to --types=all")
    parser.add_argument("--types", default="unit",
                        help="Comma-separated test categories (default: unit). Use 'all' for everything.")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Show per-test PASS/FAIL/SKIP")
    parser.add_argument("-q", "--quiet", action="store_true",
                        help="Only show final summary")
    parser.add_argument("--filter", default=None,
                        help="Only run tests matching this substring")
    args = parser.parse_args()

    if args.all:
        args.types = "all"

    categories = ALL_CATEGORIES if args.types == "all" else [c.strip() for c in args.types.split(",")]

    for cat in categories:
        if cat not in ALL_CATEGORIES:
            print(f"Unknown category: {cat}", file=sys.stderr)
            print(f"Available: {', '.join(ALL_CATEGORIES)}, all", file=sys.stderr)
            sys.exit(1)

    verbosity = 1
    if args.quiet:
        verbosity = 0
    elif args.verbose:
        verbosity = 2

    os.makedirs(TEST_TMPDIR, exist_ok=True)
    results = Results(verbosity)

    for cat in categories:
        if cat == "ast":
            results.section("ast")
            run_ast_tests(results, filter_str=args.filter)

        elif cat == "blockfs":
            results.section("blockfs")
            run_blockfs_tests(results, filter_str=args.filter)

        elif cat == "unit":
            results.section("unit")
            run_unit_node(results, filter_str=args.filter)

        elif cat == "extra":
            results.section("extra")
            run_unit_or_extra(EXTRA_DIR, COMPILER_CMD, results, filter_str=args.filter)

        elif cat == "ext":
            results.section("ext")
            run_ext_tests(results, filter_str=args.filter)

        elif cat == "projects":
            results.section("projects")
            run_projects(results, filter_str=args.filter)

        elif cat == "zlib":
            results.section("zlib")
            run_zlib_tests(results, filter_str=args.filter)

        elif cat == "lua":
            results.section("lua")
            run_lua_tests(results, filter_str=args.filter)

        elif cat == "freetype":
            results.section("freetype")
            run_freetype_tests(results, filter_str=args.filter)

        elif cat == "libpng":
            results.section("libpng")
            run_libpng_tests(results, filter_str=args.filter)

        elif cat == "libjpeg":
            results.section("libjpeg")
            run_libjpeg_tests(results, filter_str=args.filter)

        elif cat == "cairo":
            results.section("cairo")
            run_cairo_tests(results, filter_str=args.filter)

        elif cat == "micropython":
            results.section("micropython")
            run_micropython_tests(results, filter_str=args.filter)

        elif cat == "micropython-upstream":
            results.section("micropython-upstream")
            run_micropython_upstream_tests(results, filter_str=args.filter)

        elif cat == "sqlite":
            results.section("sqlite")
            run_sqlite_tests(results, filter_str=args.filter)

        elif cat == "disw":
            results.section("disw")
            run_disw_tests(results, filter_str=args.filter)

        elif cat == "tcc":
            results.section("tcc")
            run_tcc_tests(results, filter_str=args.filter)

        elif cat == "libc":
            results.section("libc")
            run_libc_tests(results, filter_str=args.filter)

        elif cat == "fuzz":
            results.section("fuzz")
            run_fuzz_tests(results, filter_str=args.filter)

        elif cat == "sourcemap":
            results.section("sourcemap")
            run_sourcemap_tests(results, filter_str=args.filter)

        elif cat == "fakegit":
            results.section("fakegit")
            run_fakegit_tests(results, filter_str=args.filter)

    results.print_summary()
    sys.exit(0 if results.success else 1)


if __name__ == "__main__":
    main()
