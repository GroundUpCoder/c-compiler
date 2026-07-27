// The clock lives in mphal.c, NOT here. Before todos/0117 R2 this header
// carried `static inline mp_uint_t mp_hal_ticks_ms(void) { return 0; }` — a
// stub nothing called, because `time` was not compiled in. `time` IS compiled
// in now, so every tick function is load-bearing (a stubbed tick makes
// `ticks_diff` return 0 forever and `time.sleep` return instantly, which is
// worse than the module being absent: a script that waits on a clock that
// never advances hangs, and hangs *silently*).
//
// They cannot be inlines in this header: py/mphal.h includes it having pulled
// in only py/mpconfig.h, so `mp_uint_t` and `mp_handle_pending` are not
// declared yet. py/mphal.h's own `#ifndef mp_hal_ticks_ms` prototypes them
// instead — the same shape upstream's unix port uses (unix_mphal.c).

// os.urandom's entropy source (extmod/modos.c calls it; upstream ports declare
// it in their own mphalport.h too). Implemented in mphal.c over /dev/urandom.
void mp_hal_get_random(size_t n, void *buf);

static inline void mp_hal_set_interrupt_char(char c) {
}

// Retry a syscall that was interrupted by a signal, giving MicroPython a
// chance to raise the pending exception (KeyboardInterrupt) in between.
// Verbatim from upstream ports/unix/mphalport.h — the gucOS kernel's
// cooperative signals surface as EINTR on brokered reads/writes exactly
// like a real one, so file.c needs the same wrapper (todos/0117 R1).
// Expanded only at its use sites, which include <errno.h>, py/runtime.h
// (mp_handle_pending) and py/mpthread.h (the GIL no-ops).
#define MP_HAL_RETRY_SYSCALL(ret, syscall, raise) { \
        for (;;) { \
            MP_THREAD_GIL_EXIT(); \
            ret = syscall; \
            MP_THREAD_GIL_ENTER(); \
            if (ret == -1) { \
                int err = errno; \
                if (err == EINTR) { \
                    mp_handle_pending(MP_HANDLE_PENDING_CALLBACKS_AND_EXCEPTIONS); \
                    continue; \
                } \
                raise; \
            } \
            break; \
        } \
}
