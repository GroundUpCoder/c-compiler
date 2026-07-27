// gucOS MicroPython port — the two hooks extmod/modtime.c asks the port for
// (todos/0117 R2). Named by MICROPY_PY_TIME_INCLUDEFILE and #included INTO
// modtime.c, not compiled separately — that is upstream's mechanism, and it is
// why this file lists no includes of its own and is not in bin.json's sources.
//
// Upstream's equivalent is ports/unix/modtime.c. This is a much smaller file
// because that one also overrides sleep with a select(2) loop
// (MICROPY_PY_TIME_CUSTOM_SLEEP); here the generic mp_hal_delay_ms path in
// modtime.c is the right one — see mphal.c for why it is chunked.
//
// The epoch is 1970 (MICROPY_EPOCH_IS_1970 in mpconfigport.h), so time.time()
// agrees with CPython and with the rest of the OS instead of MicroPython's
// embedded-flavoured 2000 epoch.

// modtime.c includes its INCLUDEFILE (this file) BEFORE it includes
// timeutils.h, so mp_time_localtime_get's parameter type is not declared yet
// unless we pull it in here. The header is idempotent.
#include "shared/timeutils/timeutils.h"

static mp_obj_t mp_time_time_get(void) {
    // Seconds since the Epoch as a float, so sub-second resolution survives —
    // the float impl is double, which holds ~microsecond precision at present
    // wall-clock magnitudes.
    return mp_obj_new_float((mp_float_t)mp_hal_time_ns() / 1e9);
}

// gucOS has no timezone database and the kernel clock is UTC, so localtime IS
// gmtime here. That is a real limitation rather than a shortcut — inventing a
// fixed offset would be worse than being honestly UTC — and it is recorded in
// README.md's "Known gaps".
static void mp_time_localtime_get(timeutils_struct_time_t *tm) {
    timeutils_seconds_since_epoch_to_struct_time(
        (mp_timestamp_t)(mp_hal_time_ns() / 1000000000ULL), tm);
}
