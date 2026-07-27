static inline mp_uint_t mp_hal_ticks_ms(void) {
    return 0;
}
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
