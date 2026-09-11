# Host callback ABI

The `c` import namespace supports table-index and direct Wasm function-reference
callbacks. Registration captures the callable at that instant. Changing a table
entry afterward does not retarget a registration. Register again to replace it.
This is a host API contract, not a claim that Wasm tables are immutable.

| Import | Wasm parameters | Result |
|---|---|---|
| `__sdl_set_animation_frame_func` | i32 table index | none |
| `__sdl_set_animation_frame_func_ref` | nullable reference to () → () | none |
| `__emscripten_async_call` | i32 table index, i32 context, i32 delay ms | none |
| `__emscripten_async_call_ref` | reference to (i32) → (), i32 context, i32 delay ms | none |

SDL has one frame registration per process. Another registration replaces it;
index zero or reference null cancels it. SDL_Quit also cancels it. Replacement
or cancellation affects subsequent invocations, not an invocation already in
progress. Table lookup and JSPI wrapper preparation occur at registration,
not once per frame. Frame pacing, input pumping and error handling are common
to both representations and all SDL backends.

Each async-call registration schedules one independent callback. It captures
both the function and the integer context value; pointed-to memory is not
copied and must remain valid until invocation. Delay is clamped at zero as
before. There is no per-timer cancellation handle; null/zero is not a timer
cancellation request. Null callbacks, empty table slots and invalid indices
fail at registration. Invalid frame registration leaves the previous one intact.

Process teardown cancels pending timers and releases the frame registration.
Callbacks do not independently keep ordinary main alive: use the existing
frame-loop or __no_exit_runtime lifetime contract. Callback exceptions and
exits use the invocation's existing termination and drain handling (#782).

Direct references must be Wasm-callable functions with the stated signature;
Small's typed func values provide that signature. GC references are not packed
into the integer context argument. No C/Small binary linking or numeric
function-table conversion is needed for these reference imports.

Small declarations:

```java
@import("c", "__sdl_set_animation_frame_func_ref")
void frame(func<void()> callback);

@import("c", "__emscripten_async_call_ref")
void later(func<void(int)> callback, int context, int delay);
```

Named, qualified and imported functions can be passed using ordinary Small
function references. The C compiler's existing table-based APIs continue to
work. Direct embedders constructing createNullSDL for table registrations must
supply a runtime context with getIndirectFunctionTable(); reference-only use
needs no table. getAnimationFrameFunc() now returns the prepared callable or
null, not a numeric table index. A custom sdlOverride must follow that contract.

Tests: tests/host/test_callback_capture.js covers capture, table mutation,
re-registration, cancellation, invalid registration, all three SDL constructor
surfaces, and the optional sibling Small consumer under JSPI and sync execution.
The browser constructor checks use a stub canvas, not a GPU workload.
