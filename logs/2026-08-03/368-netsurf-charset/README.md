# NetSurf charset / HTTP-header investigation harnesses (salvaged)

**Provenance.** These files were written in a NetSurf investigation worktree that was
pruned on 2026-08-03. They existed in **no git object anywhere** until this commit —
they were recovered from `~/worktree/salvage/c-compiler-2026-08-03/netsurf-charset/`
by the night decider and committed here so the material stops being one `rm -rf` from
gone.

**They are not spent.** This is the evidence trail behind two tickets that are **open
and ready** at the time of this commit:

- **`#368`** (P1, light) — *the gucOS http fetcher emits ZERO response headers;
  `vendor/netsurf/gucos/httpfetch.c:321` NUL-terminates the header blob in place.*
- **`#369`** (P2, medium) — *every NetSurf test drives `file://`, so no test can
  observe an HTTP response-header defect at all.*

Neither ticket references these harnesses by name. That is the gap this commit closes.

## What each file is

| File | What it does |
|---|---|
| `nscharset/hdrloop.c` | Standalone repro of the **exact** defect in `#368`. Replicates the two loops in `fetch_gucos_http_process_status()` verbatim over a realistic kernel header blob, and shows how many `FETCH_HEADER` messages actually get emitted (answer: zero). Builds and runs natively — no OS boot required. **This is the cheapest positive control available for `#368`.** |
| `nscharset/probe.c` | In-OS charset-chain probe. Exercises both routes by which NetSurf learns an encoding (HTTP `Content-Type` charset and hubbub's `<meta charset>` prescan) through their single chokepoint, `parserutils_charset_mibenum_from_name()`, so a break can be localised to one link. |
| `ns-charset-probe.mjs` | Browser-level mojibake ladder. Boots gucOS in headless Chromium (prod edge by default) and opens six pages whose only difference is **how** the document declares its encoding — `<meta charset>`, bare, `data:` URL with and without charset, and two real https origins (google, facebook). Writes each window's surface to `NS_MEDIA`. This is the harness that reproduces jku's original "EspaÃ±ol" / "Tiáº¿ng Viá»‡t" report. |
| `ns-charset-shots.mjs` | Screenshot companion to the probe. |
| `nscharset/monkey.mjs`, `monkey-main.c`, `nsmonkey-http.json` | NetSurf *monkey* (headless driver) harness for driving fetches without the full browser. |
| `nscharset/httphdr.mjs` | HTTP-header-level driver. |
| `nscharset/native-build.mjs`, `native-run.mjs`, `run.mjs`, `bin.json` | Build/run scaffolding for the native probes. |

## How this material maps onto the two tickets

- **`#368` acceptance 1** asks that a booted-browser fetch emit ≥4 `FETCH_HEADER`
  messages asserted by name. `hdrloop.c` is the pre-fix negative control that proves
  the count is currently **0**, and it runs natively in about a second — far cheaper
  than a boot.
- **`#368` acceptance 2** asks for a page served `text/html; charset=utf-8` with **no**
  `<meta charset>`. `ns-charset-probe.mjs` already builds exactly that ladder; its
  `bare` and `datanone` cases are that control.
- **`#369` acceptance** requires a positive control — *revert the `httpfetch.c` fix
  locally, confirm the new test goes red*. `hdrloop.c` is that control in miniature,
  and `nsmonkey-http.json` + `httphdr.mjs` are a starting point for the fixture origin
  `#369` asks someone to stand up.

## Status

Committed as **investigation material, not as a shipped test.** Nothing here is
enrolled in any suite and nothing here is expected to be green. A lane picking up
`#368` or `#369` should read these first, then decide what gets promoted into
`tests/` and what stays a log artifact.
