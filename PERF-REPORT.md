# Apioni IDE — Performance Optimization Report

_Terminal-first agentic IDE · Tauri 2 + xterm.js (WebGL) + CodeMirror 6 · macOS._
_Method: research → baseline → bottleneck hypothesis → prioritize → implement → verify on the release binary → lock in against regression._

## Headline results

| Metric | Before | After | Δ |
|---|---:|---:|---:|
| Cold-start JS (parsed+executed before first paint) | 1,482,195 B (single chunk) | **472,940 B** | **−68%** |
| Binary / `.app` | 25 MB (debug — no release profile) | **5.6 MB** | **−78%** |
| PTY output decode | base64 + per-byte JS loop (main thread) | raw `ArrayBuffer`, zero-copy | loop eliminated |
| Tab switch | full tab-bar teardown+rebuild | class toggles only | zero alloc |
| Keystroke JS overhead | unconditional `JSON.stringify` ×3 + regex/DOM | minimal (`pty_write` only) | removed |
| Renderer | WebGL | WebGL + context-loss recovery | no frozen panes |

---

## Findings (symptom → bottleneck → fix → improvement → remaining risk)

### 1. Startup parses ~1.5 MB of JS it doesn't need yet
- **Symptom:** cold start slower than a terminal should be; ~1.48 MB JS executed before first paint.
- **Bottleneck:** the CodeMirror editor stack (basicSetup + 14 `lang-*` grammars) was imported at module scope — **~68% of the bundle** — even though cold start always opens a *terminal*, never an editor.
- **Fix:** `import type` for the editor module; `await import("./editor")` on first file-open (already an async path); Vite emits it as a separate async chunk. (`main.ts`, `editor.ts`)
- **Improvement:** cold-start chunk **1,482,195 → 472,940 B (−68%)**; the 1.01 MB editor chunk loads only when a file is actually opened.
- **Remaining risk:** first file-open pays the editor-chunk cost once (on an async path — unnoticeable). Per-language dynamic import (all 14 grammars still ship in one editor chunk) deferred — see Deferred.

### 2. Release binary was built unoptimized (25 MB)
- **Symptom:** 25 MB app, unoptimized native code (PTY read loop, byte handling).
- **Bottleneck:** no `[profile.release]`. The desktop crate declares a nested `[workspace]` to keep its own lock/target — which **silently detaches it from the parent workspace's profiles**, so release inherited cargo defaults.
- **Fix:** `[profile.release]` in the crate's own Cargo.toml — `opt-level=3`, `lto="fat"`, `codegen-units=1`, `strip="symbols"`, `panic="unwind"`. Unwind is deliberate: the PTY code uses `.lock().unwrap()`, and `panic="abort"` would turn one poisoned lock into a whole-app crash.
- **Improvement:** **25 MB → 5.6 MB (−78%)** + optimized codegen.
- **Remaining risk:** fat LTO adds ~3–4 min build time; unwind is marginally larger than abort (accepted for resilience).

### 3. PTY output decoded byte-by-byte on the main thread
- **Symptom:** heavy output (large `cat`, build logs) could stutter the UI.
- **Bottleneck:** Rust base64-encoded PTY bytes; JS decoded them with a per-character `atob`/`charCodeAt` loop on the main thread — O(total output) main-thread work.
- **Fix:** stream raw bytes as `InvokeResponseBody::Raw(Vec<u8>)` over `Channel<ArrayBuffer>`; JS does `term.write(new Uint8Array(buf))` (zero-copy view). Dropped the `base64` dependency; 64 KB read buffer. (`main.rs`, `main.ts`)
- **Improvement:** decode loop eliminated; bulk output streams as binary straight into xterm's parser.
- **Remaining risk:** none material — xterm's parser is the only remaining cost and it batches per animation frame.

### 4. Rendering could freeze under GPU-context loss
- **Symptom:** with many panes / after backgrounding, a pane could stop repainting.
- **Bottleneck:** WebGL was loaded but a lost context (GPU reset, or the browser's ~16 live-context cap once many panes exist) left the renderer frozen.
- **Fix:** `webgl.onContextLoss(() => webgl.dispose())` → xterm falls back to its DOM renderer and keeps painting. (`main.ts`)
- **Improvement:** GPU glyph rendering with a graceful, always-painting fallback.
- **Remaining risk:** >16 simultaneous WebGL panes fall back to the (slower but functional) DOM renderer.

### 5. Every tab switch rebuilt the whole tab bar
- **Symptom:** switching tabs / toggling dirty re-created all tab DOM.
- **Bottleneck:** `render()` did `innerHTML=""` + recreated every chip (~8 listeners each) + re-parsed an SVG — on every switch, dirty toggle, and pane focus.
- **Fix:** `syncActiveAndDirty()` flips `.active`, toggles content visibility, and repaints the dirty ● on the **existing** chips (stamped `data-tab-id`). Full `render()` reserved for add/remove/reorder/rename. Routed selectTab / focusByPane / editor-dirty / save through it. (`main.ts`)
- **Improvement:** tab switch = a few class toggles, zero allocation, no listener churn.
- **Remaining risk:** none — structural changes still take the full-render path.

### 6. Per-keystroke JS overhead
- **Symptom:** input hot path did avoidable work on every key.
- **Bottleneck:** `onData` / `input` / `write` each ran `JSON.stringify` unconditionally for a no-op debug log; the IME key handler ran a Hangul regex on every keystroke; `flushRun` touched the DOM on every plain key.
- **Fix:** removed the `onData` stringify; gated `input`/`write` logs behind `IME_DEBUG` (esbuild dead-code-eliminates them); `flushRun` idle fast-path (returns before any DOM op when nothing is composing); short-circuited the composing regex behind a length check. (`main.ts`)
- **Improvement:** a plain ASCII keystroke now does the minimum — one `invoke("pty_write")`.
- **Remaining risk:** none.

### 7. Resource cleanup (indirect perf / steady-state memory)
- **Symptom:** closing panes/windows could orphan shells and retain terminals.
- **Bottleneck:** pane close only closed the PTY id; the native window close (red button) didn't reap; find's `onDidChangeResults` retained the SearchAddon → whole Terminal.
- **Fix:** `reap()` kills the process **group** (`libc::killpg(SIGKILL)`) then `child.kill()`+`wait()`; `on_window_event(Destroyed)` reaps that window's sessions; `closeFind` disposes the results subscription; `disposePty` tears down the IME window-blur listener. (`main.rs`, `main.ts`)
- **Improvement:** no orphaned shells, no retained terminals; steady-state memory stays flat.
- **Remaining risk:** none observed.

### 8. Micro DOM
- `replaceChildren(renderNode(...))` instead of `innerHTML=""` in `renderTermTab` — reparents xterm hosts in place (no detach flash / reflow).
- Cached each pane's rect for the duration of a drag (no `getBoundingClientRect` per `dragover`) + deduped `dataset.drop` writes.

---

## Correctness fixes landed alongside (this session)
- **Korean IME preedit width** — composing run now laid out in fixed terminal cells (1/2 cols via East-Asian-width), matching the shell's echoed text glyph-for-glyph.
- **App-switch data loss** — DOM window-blur doesn't fire in a WKWebView on app deactivation; commit on the native Tauri `onFocusChanged(false)` and keep a `pending` mirror that survives WebKit clearing `textarea.value`.
- **Pop-out window drag** — `startDragging()` needs `core:window:allow-start-dragging`, which is **not** in `core:default`; the main window only looked draggable because macOS's Overlay titlebar dragged it natively. Added the permission; drive `startDragging()` explicitly on the empty tab-bar zones.
- **Terminal letter-spacing** — Menlo ran loose; default `letterSpacing: -1` for the standard tighter feel (a persisted setting, adjustable).

## Deferred (documented, lower ROI or higher risk)
- **Incremental file-tree render** — only helps very large directories; medium risk (delegated listeners, depth diffing).
- **Per-language dynamic import** — needs an async `createEditor` refactor; the editor chunk is already off the cold-start path, so the win is only first-file-open memory.

## Verification & regression prevention
- `tsc --noEmit` + `cargo check` on every change; release build measured (bundle via `ls`/`wc`, binary via `ls -lh`).
- On-device smoke test of every flow on the **release** binary: spawn, Korean IME (하→한→하나), split, drag-split, pop-out, multi-window, find, settings, editor open.
- The drag/IME fixes were confirmed empirically via a temporary file-backed diagnostic log, then the instrumentation was fully removed.
- Traps locked in via comments/patterns: the nested-`[workspace]` profile detachment (Cargo.toml), the type-only-import boundary, the `IME_DEBUG` kill-switch, and the cross-project engineering-pitfalls registry.
