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
    sqlite — SQLite integration tests (build sqlite.wasm, run .sql scripts)
    disw   — WebAssembly disassembler output tests
    sourcemap — source map line number accuracy tests
    all    — all of the above
"""

import argparse
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

SQLITE_DIR = os.path.join(VENDOR_DIR, "sqlite")
SQLITE_TEST_DIR = os.path.join(SCRIPT_DIR, "sqlite")

LIBPNG_DIR = os.path.join(VENDOR_DIR, "libpng")
LIBPNG_TESTDATA = os.path.join(LIBPNG_DIR, "testdata")

MICROPYTHON_DIR = os.path.join(VENDOR_DIR, "micropython")
MICROPYTHON_TEST_DIR = os.path.join(SCRIPT_DIR, "micropython")
MICROPYTHON_UPSTREAM_TEST_DIR = os.path.join(MICROPYTHON_DIR, "tests")

ALL_CATEGORIES = ["ast", "unit", "extra", "projects", "zlib", "lua", "freetype", "libpng", "micropython", "micropython-upstream", "sqlite", "disw", "sourcemap"]
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


def build_project(project_json_path, timeout=60):
    """Build a project from its JSON file. Returns (wasm_path, error_string)."""
    with open(project_json_path) as f:
        proj = json.load(f)
    os.makedirs(BUILD_DIR, exist_ok=True)
    output = os.path.join(BUILD_DIR, f"{proj['name']}-js.wasm")
    cmd = [*COMPILER_CMD, "-o", output, project_json_path]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=ROOT_DIR)
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

FREETYPE_FONT = os.path.join(FREETYPE_DEMO_DIR, "robotomono.ttf")


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

def run_micropython_tests(results, filter_str=None):
    if not os.path.isdir(MICROPYTHON_TEST_DIR):
        results.record("micropython/build", False, f"Test dir not found: {MICROPYTHON_TEST_DIR}")
        return

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
                capture_output=True, timeout=30
            )
            actual = r.stdout.decode("utf-8", errors="replace") if isinstance(r.stdout, bytes) else r.stdout
            # MicroPython's print emits \r\n; normalize before comparing.
            actual = actual.replace("\r\n", "\n")
            with open(expected_path) as ef:
                expected = ef.read()
            if actual == expected:
                results.record(test_name, True)
            else:
                stderr = r.stderr.decode("utf-8", errors="replace") if isinstance(r.stderr, bytes) else r.stderr
                msg = f"stdout mismatch:\n--- expected ---\n{expected}--- actual ---\n{actual}"
                if stderr:
                    msg += f"--- stderr ---\n{stderr.split(chr(10))[0]}"
                results.record(test_name, False, msg.strip())
        except subprocess.TimeoutExpired:
            results.record(test_name, False, "Timed out (30s)")


# --- MicroPython upstream tests ---
#
# Runs scripts from vendor/micropython/tests/{basics,float}/. For each .py:
#   - If a .py.exp file exists, use it as the expected output.
#   - Otherwise, run the .py through CPython3 and use that as expected.
#   - Compare against our compiled MicroPython's stdout (\r\n normalized).
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
    "intbig",        # requires MICROPY_LONGINT_IMPL_MPZ
    "complex",       # requires MICROPY_PY_BUILTINS_COMPLEX
    "tstring",       # Python 3.13 t-strings, not enabled
    "memoryview",    # MICROPY_PY_BUILTINS_MEMORYVIEW
    "/struct_",      # `struct` module not enabled in minimal port
    "/sys_",         # most sys_* tests need MICROPY_PY_SYS_*
    "/io_",          # MICROPY_PY_IO disabled
    "/uctypes",      # uctypes module not enabled
    "/array",        # array module not enabled
    "/gc",           # MICROPY_PY_GC details
    "math_factorial",         # needs intbig
    "math_domain_special",    # has minor float-precision differences
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
                input=script_bytes, capture_output=True, timeout=15
            )
            actual = r.stdout.decode("utf-8", errors="replace") if isinstance(r.stdout, bytes) else r.stdout
            actual = actual.replace("\r\n", "\n")
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

        elif cat == "unit":
            results.section("unit")
            run_unit_node(results, filter_str=args.filter)

        elif cat == "extra":
            results.section("extra")
            run_unit_or_extra(EXTRA_DIR, COMPILER_CMD, results, filter_str=args.filter)

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

        elif cat == "sourcemap":
            results.section("sourcemap")
            run_sourcemap_tests(results, filter_str=args.filter)

    results.print_summary()
    sys.exit(0 if results.success else 1)


if __name__ == "__main__":
    main()
