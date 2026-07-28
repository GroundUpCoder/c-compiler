# 0408 — netsurf JS: HTMLElement.style is a disconnected stub - style property writes are silently lost

- **Status**: open
- **Design**: —

## Goal

Found during `todos/0386`'s probe work, first-hand. An instrumentation page set
`el.style.width` and `el.style.background` from an `input` listener; nothing painted and
nothing threw. The listener itself ran (a `textContent` mirror in the same handler
painted fine).

Cause, in source: the `HTMLElement::style` getter
(`vendor/netsurf/netsurf/content/handlers/javascript/duktape/HTMLElement.bnd:155`)
returns a FRESH bare `CSSStyleDeclaration` object with no link to the element — upstream's
"minimal implementation to avoid infinite-loop in Modernizr (c.f. #2413)". Property
writes land on that detached object and are lost. This is an upstream gap, not a gucOS
regression, and it is bread-and-butter web surface: `el.style.x = '...'` is the most
common way pages move and show things.

Note the adjacent surface that DOES work: class changes restyle live (`todos/0316`), and
the `style` ATTRIBUTE (`setAttribute('style', ...)`) may already reach the CSS engine —
verify that as the possible short-term bridge.

## Plan

1. Bind `CSSStyleDeclaration` to its owning element: property sets serialize into the
   element's `style` attribute (the `setAttribute` path already feeds
   `html_css_update_style` / the restyle bridge), property gets read it back.
2. The nsgenbind bindings are COMMITTED generated sources — changes go through
   `regen-js-bindings.sh` and its documented pipeline, or through the `.bnd` inline
   bodies where the existing patches already do this.
3. Acceptance page: a listener sets `style.width`/`style.background`; assert the pixels
   moved (the `0386` probe page is a ready-made repro).

## Acceptance

- `el.style.<property> = value` repaints, and `el.style.<property>` reads back.
- A conformance-shaped e2e leg guards it.
- The `vendor/netsurf` change owes an `os/image.json` bump at merge time.
