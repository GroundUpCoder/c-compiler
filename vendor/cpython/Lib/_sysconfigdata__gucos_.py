# gucOS sysconfigdata (todos/0340, CPYTHON.md §5.4).
#
# Upstream generates this file during `make` by dumping the configure/Makefile
# variables (Lib/sysconfig.py:_generate_posix_vars). gucOS has no configure and
# no Makefile — the build is a fixed cc2wasm/compiler.js command line — so the
# table is written out here instead, exactly like gen/pyconfig.h and
# gen/Modules/config.c. It is a function of (CPython version, target config),
# not of a build host, which is what makes committing it correct rather than a
# captured artifact.
#
# sysconfig imports it by the name `_sysconfigdata_{sys.abiflags}_{sys.platform}
# _{multiarch}`; with ABIFLAGS empty, sys.platform "gucos" and no multiarch that
# is `_sysconfigdata__gucos_` — the double underscore is not a typo. Without it,
# `sysconfig` raises at first use and takes `pydoc` and `zoneinfo` down with it.
#
# Values describe THIS platform honestly:
#   * everything is statically linked (no dlopen on gucOS, ever), so the shared
#     -object variables name a suffix nothing will ever load, and
#     Py_ENABLE_SHARED is 0.
#   * the compiler is recorded as the toolchain that actually built the binary;
#     it is descriptive, not a working build command — gucOS cannot rebuild an
#     extension module at runtime, which is the same statement as "no dlopen".

build_time_vars = {
    'ABIFLAGS': '',
    'AR': '',
    'ARFLAGS': '',
    'BINDIR': '/opt/python-clang/bin',
    'BINLIBDEST': '/opt/python-clang/lib/python3.13',
    'CC': 'cc2wasm',
    'CCSHARED': '',
    'CFLAGS': '-O2 --target=wasm32',
    'CONFIG_ARGS': '',
    'CONFINCLUDEPY': '/opt/python-clang/include/python3.13',
    'CXX': '',
    'DESTLIB': '/opt/python-clang/lib/python3.13',
    'DESTSHARED': '/opt/python-clang/lib/python3.13/lib-dynload',
    'EXE': '.wasm',
    'EXT_SUFFIX': '.cpython-313-wasm32-gucos.so',
    'HOST_GNU_TYPE': 'wasm32-unknown-gucos',
    'INCLUDEDIR': '/opt/python-clang/include',
    'INCLUDEPY': '/opt/python-clang/include/python3.13',
    'LDFLAGS': '',
    'LDLIBRARY': '',
    'LDSHARED': '',
    'LIBDEST': '/opt/python-clang/lib/python3.13',
    'LIBDIR': '/opt/python-clang/lib',
    'LIBPL': '/opt/python-clang/lib/python3.13/config-3.13',
    'MACHDEP': 'gucos',
    'MULTIARCH': '',
    'OPT': '-O2',
    'Py_DEBUG': 0,
    'Py_ENABLE_SHARED': 0,
    'Py_GIL_DISABLED': 0,
    'SHLIB_SUFFIX': '.so',
    'SIZEOF_VOID_P': 4,
    'SO': '.cpython-313-wasm32-gucos.so',
    'SOABI': 'cpython-313-wasm32-gucos',
    'STDLIB_DIR': '/opt/python-clang/lib/python3.13',
    # zoneinfo._tzpath reads this; gucOS ships no tz database, so the search
    # list is the POSIX-conventional one and simply finds nothing. That is the
    # honest answer — ZoneInfo("Europe/Oslo") raises ZoneInfoNotFoundError
    # rather than silently reporting UTC.
    'TZPATH': '/usr/share/zoneinfo:/usr/lib/zoneinfo:/usr/share/lib/zoneinfo:/etc/zoneinfo',
    'VERSION': '3.13',
    'WITH_DYLD': 0,
    'WITH_PYMALLOC': 1,
    'abs_builddir': '',
    'abs_srcdir': '',
    'exec_prefix': '/opt/python-clang',
    'platbase': '/opt/python-clang',
    'platlibdir': 'lib',
    'prefix': '/opt/python-clang',
    'projectbase': '/opt/python-clang/bin',
    'srcdir': '',
}
