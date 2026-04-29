# CodeMirror 6 (vendored bundle)

Pre-built IIFE bundle of CodeMirror 6 for embedding in self-contained HTML.
Exposes `window.CM` with editor components.

## Packages included

- `@codemirror/view` 6.41.1
- `@codemirror/state` 6.6.0
- `@codemirror/language` 6.12.3
- `@codemirror/lang-cpp` 6.0.3
- `@codemirror/commands` 6.10.3
- `@codemirror/autocomplete` 6.20.1 (closeBrackets only)
- `@lezer/highlight` 1.2.3

## Rebuilding

```sh
cd /tmp && mkdir cm-bundle && cd cm-bundle
pnpm init
pnpm add @codemirror/view @codemirror/state @codemirror/language \
         @codemirror/lang-cpp @codemirror/commands @codemirror/autocomplete \
         @lezer/highlight esbuild

cat > entry.js << 'EOF'
import {EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars} from "@codemirror/view"
import {EditorState} from "@codemirror/state"
import {defaultKeymap, indentWithTab, history, historyKeymap} from "@codemirror/commands"
import {syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap, HighlightStyle} from "@codemirror/language"
import {cpp} from "@codemirror/lang-cpp"
import {closeBrackets, closeBracketsKeymap} from "@codemirror/autocomplete"
import {tags as t} from "@lezer/highlight"

window.CM = {EditorView, EditorState, keymap, cpp, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, indentOnInput, bracketMatching, foldGutter, foldKeymap, closeBrackets, closeBracketsKeymap, defaultKeymap, indentWithTab, history, historyKeymap, syntaxHighlighting, HighlightStyle, tags: t}
EOF

npx esbuild entry.js --bundle --minify --format=iife --outfile=codemirror.js
cp codemirror.js /path/to/vendor/codemirror/
```
