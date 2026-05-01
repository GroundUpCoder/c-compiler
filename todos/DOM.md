# C with DOM and React

## Goal

Let C programs built with this compiler create full interactive web pages by directly manipulating the DOM — with a React-style diffing model so updates are efficient.

## Architecture

### Buffer-based rendering

C code describes the DOM tree by calling functions that write a compact bytecode into a shared buffer. Once per frame/update, the buffer is flushed to the JS side, which applies changes to the real DOM.

This avoids per-node FFI overhead. The wasm/JS boundary is crossed once per update cycle, not once per element.

```c
void render() {
    DOMBegin();

    DOMStartTag("div");
    DOMSetAttribute("class", "container");

    DOMStartTag("h1");
    DOMText("Hello from C");
    DOMEndTag();

    DOMStartTag("button");
    DOMSetAttribute("onclick", handler_click);
    DOMText("Click me");
    DOMEndTag();

    DOMEndTag(); // div

    DOMEnd();
}
```

### Bytecode encoding

The buffer is a flat byte stream. Each instruction is a 1-byte opcode followed by inline data (lengths, string bytes, integer IDs). The JS decoder is a simple linear scan.

Candidate opcodes:
- `START_TAG(tag_name)` — open an element
- `END_TAG` — close the current element
- `TEXT(string)` — text node
- `SET_ATTR(key, value)` — set attribute on current element
- `SET_HANDLER(event_name, func_id)` — attach event callback
- `SET_STYLE(property, value)` — shorthand for style properties
- `COMPONENT_START(func_id)` / `COMPONENT_END` — component boundary (for diffing granularity)

Strings are length-prefixed (2-byte length + UTF-8 bytes), not null-terminated, so the JS side can slice without scanning.

### DOM diffing (JS side)

Each `DOMEnd()` call ships the buffer to JS. The JS runtime:

1. Decodes the bytecode into a lightweight virtual DOM tree (plain objects, not real DOM nodes)
2. Diffs against the previous virtual tree
3. Applies minimal mutations to the real DOM

This is the same strategy as React's reconciler, but the "render function" runs in wasm and the diffing runs in JS. A simple keyed-children diff (similar to Preact's) is sufficient — no need for React's full fiber architecture.

### Callbacks

Event handlers are C function pointers. The compiler already maintains a `WebAssembly.Table` (indirect function table) for function pointers. Registering a callback means passing the table index to JS.

On the JS side, `SET_HANDLER(event_name, func_id)` registers a listener that calls `table.get(func_id)(event_data)` when fired.

For passing event data back to C: allocate a small scratch struct in wasm linear memory. JS writes event fields (target value, mouse coords, key code, etc.) into it before invoking the callback. The C side reads from a known pointer.

```c
typedef struct {
    int type;
    int target_id;
    int key_code;
    float mouse_x;
    float mouse_y;
    char value[256];
} DOMEvent;

void handler_click(DOMEvent* event) {
    // ...
}
```

### State and hooks

Hooks work by maintaining a per-component state array and a cursor that resets at the start of each render call — same trick React uses. In C, this means:

```c
void Counter() {
    int* count = DOMUseState(0);  // returns pointer to persistent storage

    DOMStartTag("div");

    DOMStartTag("span");
    DOMTextFmt("Count: %d", *count);
    DOMEndTag();

    DOMStartTag("button");
    DOMSetHandler("click", increment, count);  // passes count as context
    DOMText("+1");
    DOMEndTag();

    DOMEndTag();
}

void increment(DOMEvent* event, void* ctx) {
    int* count = (int*)ctx;
    (*count)++;
    DOMRequestRender();  // schedule a re-render
}
```

`DOMUseState` allocates from a persistent state arena indexed by (component_id, slot_index). The component ID comes from the `COMPONENT_START` opcode. The slot index is the cursor position (incremented each call to `DOMUseState` within one render).

This works as long as hooks are called in the same order every render — same constraint as React, and easy to reason about in C where there's no conditional compilation trickery.

### Handler context (the closure problem)

C doesn't have closures, so handlers that need state require a context pointer. Two options:

1. **Explicit context:** `DOMSetHandler("click", func, ctx)` — handler signature is `void(DOMEvent*, void*)`. Clean, explicit, standard C idiom.
2. **Implicit via component state:** The handler can read from `DOMUseState` slots since it knows its component ID. Less boilerplate but more magical.

Option 1 is better for a C audience. Option 2 can be sugar on top later.

## Implementation plan

### Phase 1: Static rendering
- Add DOM API functions to the compiler's built-in declarations
- Implement the bytecode buffer in the C runtime (write side)
- Build the JS decoder + direct DOM builder (no diffing yet, just full replacement)
- Demo: static HTML page rendered from C

### Phase 2: Diffing
- Build the virtual DOM tree from decoded bytecode
- Implement keyed reconciliation diff
- Apply minimal DOM mutations
- Demo: dynamic content that updates without full page replacement

### Phase 3: Interactivity
- Implement `SET_HANDLER` and the callback bridge
- Build the `DOMEvent` struct and JS-to-wasm event marshaling
- Demo: button clicks, form inputs

### Phase 4: State management
- Implement `DOMUseState` and the component state arena
- Add `DOMRequestRender` for scheduling re-renders
- Demo: counter, todo list

## Open questions

- **CSS:** Inline styles via `SET_STYLE`? Or generate `<style>` blocks? Or both?
- **Lists and keys:** Need a `DOMKey(id)` call for efficient list diffing. What type is the key — int, string?
- **Async:** How does this interact with any future async/coroutine support? Render triggered by async data fetch?
- **Component nesting:** Can components call other components, or is it flat? Nested is more powerful but complicates the state arena indexing.
- **Memory:** The bytecode buffer has a fixed max size. What's a reasonable default? 64KB? Grow on demand?
