// gucOS MicroPython port — the HAL clock (todos/0117 R2).
//
// Upstream's ports/unix keeps these in unix_mphal.c; ports/minimal, which this
// port started from, had only a `return 0` ticks_ms stub in mphalport.h because
// nothing referenced it. Enabling `time` in R2 made all of them live.
//
// Two clocks, deliberately:
//   - CLOCK_MONOTONIC backs ticks_ms/us/cpu. Monotonic time does not jump when
//     the wall clock is set, which is the entire point of `ticks_diff` — a
//     REALTIME-backed tick would let a clock adjustment make an elapsed
//     interval come out negative.
//   - CLOCK_REALTIME backs time_ns(), because `time.time()` means "seconds
//     since the Epoch" and a monotonic count is not that.
// Both are real in the gucOS libc (not the nominal-value class that
// e.g. statvfs is in).

#include <errno.h>
#include <fcntl.h>
#include <time.h>
#include <unistd.h>

#include "py/mperrno.h"
#include "py/mphal.h"
#include "py/runtime.h"

static uint64_t ns_of(clockid_t clk) {
    struct timespec ts;
    if (clock_gettime(clk, &ts) != 0) {
        return 0;
    }
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

mp_uint_t mp_hal_ticks_ms(void) {
    return (mp_uint_t)(ns_of(CLOCK_MONOTONIC) / 1000000ULL);
}

mp_uint_t mp_hal_ticks_us(void) {
    return (mp_uint_t)(ns_of(CLOCK_MONOTONIC) / 1000ULL);
}

// No cycle counter on wasm. Microseconds are the finest honest resolution, and
// returning them is better than returning 0: ticks_cpu()'s documented contract
// is only "a fine-grained monotonic counter", which this satisfies.
mp_uint_t mp_hal_ticks_cpu(void) {
    return mp_hal_ticks_us();
}

uint64_t mp_hal_time_ns(void) {
    return ns_of(CLOCK_REALTIME);
}

void mp_hal_delay_us(mp_uint_t us) {
    usleep((unsigned)us);
}

// Chunked, so a pending cooperative signal is claimed DURING a long sleep
// rather than after it. gucOS signal delivery is cooperative (kernel.js posts
// SIGPEND, host.js dispatches at env-import safe points), and usleep is such a
// point — but the Python-level handler only runs when mp_handle_pending is
// called, so `time.sleep(60)` would otherwise swallow a Ctrl-C for a minute.
void mp_hal_delay_ms(mp_uint_t ms) {
    const mp_uint_t slice = 50;
    while (ms > slice) {
        mp_handle_pending(MP_HANDLE_PENDING_CALLBACKS_AND_EXCEPTIONS);
        usleep(slice * 1000);
        ms -= slice;
    }
    mp_handle_pending(MP_HANDLE_PENDING_CALLBACKS_AND_EXCEPTIONS);
    usleep((unsigned)ms * 1000);
}

// os.urandom's source. /dev/urandom is a REAL character device on this image
// (host.js's BlockFS.ensureDevNodes creates it on every v4 mount), so this is
// real entropy rather than a seeded PRNG.
//
// It raises rather than degrading to a time-seeded fallback if the device is
// missing. `random` already exists for the not-actually-random case; a
// urandom() that quietly hands back predictable bytes is the worst outcome of
// the three, because every caller of it is asking precisely for the property
// the fallback would not have.
void mp_hal_get_random(size_t n, void *buf) {
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) {
        mp_raise_OSError(errno);
    }
    uint8_t *p = buf;
    while (n > 0) {
        ssize_t got = read(fd, p, n);
        if (got <= 0) {
            int err = errno;
            if (got < 0 && err == EINTR) {
                mp_handle_pending(MP_HANDLE_PENDING_CALLBACKS_AND_EXCEPTIONS);
                continue;
            }
            close(fd);
            mp_raise_OSError(got < 0 ? err : MP_EIO);
        }
        p += got;
        n -= (size_t)got;
    }
    close(fd);
}
