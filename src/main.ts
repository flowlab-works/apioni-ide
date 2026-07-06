import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
// Type-only: keeps the whole CodeMirror stack (editor.ts + 13 grammars, ~half the
// bundle) OFF the cold-start chunk. createEditor is dynamically imported on first
// file-open (see openFile) — cold start always opens a terminal, never an editor.
import type { EditorHandle } from "./editor";
type CreateEditor = typeof import("./editor").createEditor;
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}
type Zone = "left" | "right" | "top" | "bottom";
type LNode = { kind: "leaf"; pane: Pane } | { kind: "split"; dir: "row" | "col"; children: LNode[] };

const THEME = {
  background: "#0c0c0e",
  foreground: "#d4d4d4",
  cursor: "#4a9eff",
  cursorAccent: "#0c0c0e",
  selectionBackground: "#264f78",
  black: "#282c34",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#d19a66",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#545862",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#c8ccd4",
};

function div(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}
function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}
function dirname(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  parts.pop();
  const up = parts.join("/");
  return up === "" ? "/" : up;
}

// Highlight styling for the terminal SearchAddon (active match brighter).
const FIND_DECOR = {
  matchBackground: "#4a9eff44",
  matchBorder: "#4a9eff88",
  matchOverviewRuler: "#4a9eff",
  activeMatchBackground: "#4a9effcc",
  activeMatchBorder: "#7cc0ff",
  activeMatchColorOverviewRuler: "#7cc0ff",
};

// ── App settings (persisted to localStorage, applied live to every terminal) ──
interface AppSettings {
  fontSize: number;
  fontFamily: string;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  letterSpacing: number;
}
const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  fontFamily: "Menlo, Monaco, 'SF Mono', monospace",
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 1000,
  // Menlo runs a touch loose; -1px per cell gives the tighter, standard terminal feel.
  letterSpacing: -1,
};
const FONT_CHOICES: { label: string; value: string }[] = [
  { label: "Menlo", value: "Menlo, Monaco, 'SF Mono', monospace" },
  { label: "SF Mono", value: "'SF Mono', Menlo, monospace" },
  { label: "Monaco", value: "Monaco, Menlo, monospace" },
  { label: "JetBrains Mono", value: "'JetBrains Mono', Menlo, monospace" },
  { label: "Fira Code", value: "'Fira Code', Menlo, monospace" },
  { label: "Courier", value: "'Courier New', monospace" },
];
const SETTINGS_KEY = "apioni.settings";
function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    /* corrupt / unavailable → defaults */
  }
  return { ...DEFAULT_SETTINGS };
}
function saveSettings(s: AppSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota → in-memory only */
  }
}

// Flatten a terminal's scrollback+viewport to text (for Print), trailing blanks off.
function termBufferText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}

// ── TEMP IME diagnostic overlay (flip IME_DEBUG=false to disable) ──────────────
// Flip to true to re-diagnose IME on the input hot path (adds per-keystroke DOM +
// alloc + an on-screen overlay); OFF in normal/shipping use. Call sites stay in place.
const IME_DEBUG = false;
let imeLogEl: HTMLDivElement | null = null;
function imeLog(msg: string) {
  if (!IME_DEBUG) return;
  if (!imeLogEl) {
    imeLogEl = document.createElement("div");
    imeLogEl.id = "imelog";
    document.body.appendChild(imeLogEl);
  }
  const line = document.createElement("div");
  line.textContent = `${Math.round(performance.now() % 100000)} ${msg}`;
  imeLogEl.appendChild(line);
  while (imeLogEl.childElementCount > 16) imeLogEl.firstElementChild?.remove();
}

let manager: Manager;
let nextPaneId = 1;
let nextTabId = 1;
let dragTabIndex = -1;
let dragPane: Pane | null = null; // pane being dragged (header grip)

class Pane {
  uid: number; // window-local id for the layout tree / focus
  ptyId = 0; // backend-assigned PTY id (global, unique across windows)
  attached: boolean; // true → re-attaches to an existing PTY instead of spawning
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  paneEl: HTMLDivElement;
  hostEl: HTMLDivElement;
  channel: Channel<ArrayBuffer>;
  title = "zsh";
  titleEl!: HTMLDivElement;
  private titleLocked = false; // true once the user renames it (stops auto-title)
  private imeCleanup: (() => void) | null = null; // tears down the window-blur IME flush
  imeFlush: (() => void) | null = null; // commit the composing Hangul run (called on focus loss)

  constructor(fontSize: number, attachPtyId?: number) {
    this.uid = nextPaneId++;
    this.attached = attachPtyId !== undefined;
    if (attachPtyId !== undefined) this.ptyId = attachPtyId;
    this.paneEl = div("pane");

    const header = div("pane-header");
    header.draggable = true;
    this.titleEl = div("ptitle");
    this.titleEl.textContent = this.title;
    // Double-click the pane title to rename it.
    this.titleEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.beginRename();
    });
    const popout = div("pbtn");
    popout.textContent = "⤢";
    popout.title = "Move to New Window";
    popout.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      manager.popoutPane(this);
    });
    const close = div("pbtn");
    close.textContent = "×";
    close.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      manager.closePane(this);
    });
    header.appendChild(this.titleEl);
    header.appendChild(popout);
    header.appendChild(close);
    header.addEventListener("mousedown", () => manager.focusByPane(this));
    header.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      manager.focusByPane(this);
      showContextMenu(e.clientX, e.clientY, [
        { label: "Rename", action: () => this.beginRename() },
        { label: "Move to New Window", action: () => manager.popoutPane(this) },
        { label: "Close", action: () => manager.closePane(this) },
      ]);
    });
    header.addEventListener("dragstart", (e) => {
      dragPane = this;
      // WebKit requires dataTransfer data or the drag never starts.
      e.dataTransfer?.setData("text/plain", "pane");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    header.addEventListener("dragend", () => {
      dragPane = null;
      manager.clearDropZones();
    });

    this.hostEl = div("xterm-host");
    this.paneEl.appendChild(header);
    this.paneEl.appendChild(this.hostEl);

    // Drop target for drag-split. `dataset.drop` drives the CSS edge preview only;
    // the drop DECISION is computed fresh from coordinates so it can't go stale.
    this.paneEl.addEventListener("dragover", (e) => {
      if (!dragPane) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const zone = zoneFor(this.paneEl, e); // uses the cached rect
      if (this.paneEl.dataset.drop !== zone) this.paneEl.dataset.drop = zone; // dedupe write
    });
    this.paneEl.addEventListener("dragleave", () => {
      delete this.paneEl.dataset.drop;
      dragRectCache.delete(this.paneEl); // recompute if the pointer re-enters
    });
    this.paneEl.addEventListener("drop", (e) => {
      if (!dragPane) return;
      e.preventDefault();
      const zone = zoneFor(this.paneEl, e);
      delete this.paneEl.dataset.drop;
      dragRectCache.delete(this.paneEl);
      manager.dropSplit(dragPane, this, zone);
    });

    const s = manager?.settings ?? DEFAULT_SETTINGS;
    this.term = new Terminal({
      fontFamily: s.fontFamily,
      fontSize,
      letterSpacing: s.letterSpacing,
      cursorBlink: s.cursorBlink,
      cursorStyle: s.cursorStyle,
      scrollback: s.scrollback,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: THEME,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.search = new SearchAddon();
    this.term.loadAddon(this.search);
    // Raw bytes from the PTY arrive as an ArrayBuffer (InvokeResponseBody::Raw) —
    // no base64, no per-byte JS decode loop on the main thread.
    this.channel = new Channel<ArrayBuffer>();
    this.channel.onmessage = (buf) => this.term.write(new Uint8Array(buf));
    this.term.onData((data) => {
      // Hot path — one call per keystroke. No per-key logging/stringify here.
      if (this.ptyId) void invoke("pty_write", { id: this.ptyId, data });
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId) void invoke("pty_resize", { id: this.ptyId, cols, rows });
    });
    // Auto-name the pane from the shell's title escape (OSC 0/2), unless the user
    // has manually renamed it. Gives each pane a distinct title instead of "zsh".
    this.term.onTitleChange((t) => {
      if (this.titleLocked || !t) return;
      this.setTitle(t, false);
    });
  }

  setTitle(t: string, locked: boolean) {
    this.title = t;
    if (locked) this.titleLocked = true;
    if (this.titleEl) this.titleEl.textContent = t;
  }

  /** Inline-edit the pane title in its header. */
  beginRename() {
    inlineEdit(this.titleEl, this.title, (v) => this.setTitle(v, true));
  }

  open() {
    this.term.open(this.hostEl);
    try {
      const webgl = new WebglAddon();
      // A lost GPU context (backgrounding, GPU reset, or hitting the browser's ~16
      // live-context cap once many panes are open) freezes the WebGL renderer. Drop the
      // addon on loss so xterm falls back to its DOM renderer and keeps painting.
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      /* WebGL unavailable → xterm falls back to the canvas/DOM renderer */
    }
    this.installKoreanImeBridge();
  }

  /**
   * Korean / CJK IME bridge for WKWebView (WRY, macOS).
   *
   * EMPIRICAL GROUND TRUTH — verified on-device via the #imelog overlay AND against
   * the shipped @xterm/xterm 5.5.0 bundle:
   *   • Per Hangul jamo, WebKit fires ONE `keydown` with keyCode===229 and
   *     `isComposing===false`. compositionstart/update/end NEVER fire here.
   *   • WebKit STILL recomposes the syllable inside `textarea.value`
   *     (하 → 한 → 하나) — the earlier garbage contained *precomposed* blocks
   *     (나, 리), which only WebKit's own composition can produce.
   *   • With no composition EVENTS, xterm can't run its composition finalize and
   *     falls back to TWO raw paths that stream the mangled textarea delta to the
   *     PTY:
   *       (a) CompositionHelper.keydown() → _handleAnyTextareaChanges(), reached
   *           ONLY on the keyCode-229 keydown; its `newValue.replace(oldValue,'')`
   *           diff shreds the recomposing value into stray jamo and drops keys.
   *       (b) Terminal._inputEvent(), the capture-phase 'input' listener.
   *
   * Composition events will NOT come, so this fix does not wait for them. It
   * (1) disables BOTH raw paths, (2) leaves WebKit's in-textarea composition
   * untouched (never preventDefault a 229 keydown, never rewrite textarea.value
   * mid-run — either aborts composition), and (3) reconciles committed text off the
   * `input` event, forwarding frozen syllables and holding the composing tail.
   * In Terminal._keyDown the custom key handler runs FIRST and a `false` return
   * EXITS _keyDown *without* preventDefault, so WebKit's IME still gets the key.
   * State is per-pane (this closure), so multiple terminals never interfere.
   */
  private installKoreanImeBridge() {
    const ta = this.term.textarea;
    if (!ta) {
      imeLog("ime:NO textarea");
      return;
    }
    // Reduce WebKit's interference with the hidden IME textarea.
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("spellcheck", "false");

    // Hangul: conjoining jamo (U+1100–11FF), compatibility jamo (U+3130–318F,
    // e.g. ㅎ U+314E / ㅏ U+314F / ㄴ U+3134), Jamo Extended-A/B, and precomposed
    // syllables (U+AC00–D7A3).
    const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힣ힰ-퟿]/;
    const hasHangul = (s: string) => HANGUL.test(s);

    const write = (data: string) => {
      if (!data) return;
      if (this.ptyId) void invoke("pty_write", { id: this.ptyId, data });
      if (IME_DEBUG) imeLog(`ime→pty ${JSON.stringify(data)}`); // stringify only when debugging
    };

    const core = (
      this.term as unknown as {
        _core?: {
          _inputEvent?: (e: InputEvent) => boolean;
          _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } };
          _compositionHelper?: {
            _handleAnyTextareaChanges?: () => void;
            _compositionView?: HTMLElement;
            _isComposing?: boolean;
            updateCompositionElements?: (dontRecurse?: boolean) => void;
          };
        };
      }
    )._core;
    const ch = core?._compositionHelper;
    const preeditView = ch?._compositionView;

    // East-Asian-Wide test — the terminal renders these glyphs across TWO cells, so the
    // preedit overlay must reserve the same width or the composing run looks narrower
    // than the committed text the shell echoes back (the "하지마" vs "하 지 마" mismatch).
    const isWide = (cp: number) =>
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi (incl. Hangul compat jamo)
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
      (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6);
    const charCells = (chStr: string) => (isWide(chStr.codePointAt(0) ?? 0) ? 2 : 1);

    // (1a) Neutralize xterm's raw-jamo keydown emitter deterministically. The custom
    //      key handler below already blocks its only caller, but this makes the kill
    //      independent of handler ordering.
    if (ch && typeof ch._handleAnyTextareaChanges === "function") {
      ch._handleAnyTextareaChanges = () => {};
      imeLog("ime:_handleAnyTextareaChanges no-op");
    }
    // (1b) Neutralize xterm's SECOND raw path (_inputEvent) for Hangul only, so
    //      non-Hangul insertText and paste keep xterm's normal behavior.
    if (core && typeof core._inputEvent === "function") {
      const orig = core._inputEvent.bind(core);
      core._inputEvent = (e: InputEvent) =>
        typeof e.data === "string" && hasHangul(e.data) ? false : orig(e);
      imeLog("ime:_inputEvent filtered");
    }

    // Live preedit overlay. We drive xterm's own composition view (a positioned div
    // that already knows how to sit on the cursor cell) so the composing syllable is
    // visible AS the user types each jamo — without sending anything to the shell yet.
    const showPreedit = (text: string) => {
      if (!ch || !preeditView) return;
      // Lay each character out in a fixed cell (1 or 2 terminal columns wide) so the
      // composing run lines up glyph-for-glyph with what the shell will echo on commit.
      const cellW = core?._renderService?.dimensions?.css?.cell?.width;
      if (cellW && cellW > 0) {
        preeditView.replaceChildren(
          ...[...text].map((chStr) => {
            const span = document.createElement("span");
            span.textContent = chStr;
            span.style.display = "inline-block";
            span.style.width = `${charCells(chStr) * cellW}px`;
            span.style.textAlign = "center";
            return span;
          }),
        );
      } else {
        preeditView.textContent = text; // dimensions not ready — plain text fallback
      }
      preeditView.classList.add("active");
      // xterm's positioner is gated on `_isComposing`; flip it on just for this
      // synchronous call so the overlay lands on the cursor cell, then restore it
      // (no keydown runs in between, so nothing else observes the flag).
      const prev = ch._isComposing;
      ch._isComposing = true;
      try {
        ch.updateCompositionElements?.(true);
      } catch {
        /* positioning is best-effort — never let it break input handling */
      } finally {
        ch._isComposing = prev ?? false;
      }
    };
    const hidePreedit = () => {
      if (!preeditView) return;
      preeditView.classList.remove("active");
      preeditView.replaceChildren();
    };

    // `pending` mirrors the current composing run. It survives even if WebKit clears
    // ta.value out from under us (which it does when the app deactivates mid-compose),
    // so the focus-loss flush below can still commit what was typed. Only ever holds a
    // Hangul run; reset on every commit.
    let pending = "";

    // Commit the WHOLE composing Hangul run to the PTY and clear the overlay. Only ever
    // emits Hangul, so it can never double-send an ASCII char xterm's keydown handled.
    // Falls back to `pending` when ta.value was already wiped by a focus-loss abort.
    const flushRun = () => {
      // Idle fast-path: nothing composing and nothing pending → skip the DOM work.
      // Hit on every plain ASCII keystroke (the key handler calls this to finalize).
      if (ta.value === "" && pending === "") return;
      const value = ta.value && hasHangul(ta.value) ? ta.value : pending;
      if (value) write(value);
      pending = "";
      ta.value = "";
      hidePreedit();
    };
    this.imeFlush = flushRun;

    // (2) Reconcile: mirror the whole composing textarea value into the on-cursor
    //     preedit overlay for LIVE feedback. Sends NOTHING to the PTY mid-composition,
    //     so the cursor never jumps from an async shell echo; the full run commits on a
    //     finalizing key or blur. IDEMPOTENT — safe to drive from `input` AND the
    //     keydown fallback (a second call with the same value is a no-op repaint).
    const reconcile = () => {
      const value = ta.value;
      if (value === "") {
        // Do NOT clear `pending` here: an empty value can be a focus-loss abort, and we
        // still want the focus-loss flush to commit the run. A real backspace-to-empty
        // just leaves a stale pending that the next keystroke or a flush overwrites.
        hidePreedit();
        return;
      }
      if (!hasHangul(value)) {
        // Pure ASCII/punctuation → xterm's keydown path already emitted it; keep the
        // textarea clean so it can't bleed into the next Hangul run.
        ta.value = "";
        hidePreedit();
        return;
      }
      pending = value; // remember the run so a focus-loss abort can't drop it
      showPreedit(value);
    };

    // Primary trigger: `input` fires AFTER WebKit updates textarea.value. (A keydown
    // fallback below covers WKWebView builds that skip `input` in direct-commit mode.)
    ta.addEventListener("input", () => {
      if (IME_DEBUG) imeLog(`in ${JSON.stringify(ta.value)}`); // stringify only when debugging
      reconcile();
    });

    // (3) Key policy — the SOLE custom key handler for this terminal.
    this.term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== "keydown") return true; // never touch keyup / keypress

      // IME jamo keydown: block xterm's raw path. A false return exits _keyDown
      // WITHOUT preventDefault, so WebKit keeps composing into textarea.value and
      // the 'input' listener above repaints the preedit. The setTimeout is a belt: it
      // reconciles on the next tick (after WebKit has written textarea.value) in case
      // this WKWebView doesn't emit an `input` event in direct-commit IME mode.
      // reconcile() is idempotent, so if `input` DID fire this is a harmless repaint.
      if (e.keyCode === 229) {
        setTimeout(reconcile, 0);
        return false;
      }

      // A bare modifier press must NOT finalize the composing syllable.
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") {
        return true;
      }

      // length check first — short-circuits the regex on the empty-textarea ASCII path
      // (the overwhelmingly common keystroke), which runs this handler every key.
      const composing = ta.value.length > 0 && hasHangul(ta.value);

      // Backspace mid-composition edits the preedit buffer: let WebKit delete a jamo
      // and suppress xterm's \x7f, then repaint. With no composing run it falls through
      // so a real Backspace reaches the shell.
      if (e.key === "Backspace" && composing) {
        setTimeout(reconcile, 0);
        return false;
      }

      // Any other finalizing key (Enter / Space / Tab / Arrows / ASCII / Ctrl-*):
      // commit the whole composed run FIRST (PTY order = <run><key>), then let xterm
      // handle the key normally.
      flushRun();
      return true;
    });

    // Focus leaving mid-composition (click-away / pane switch) commits the tail.
    ta.addEventListener("blur", () => flushRun());

    // Switching to ANOTHER APP does NOT blur the textarea (focus stays inside the
    // webview, only the app deactivates) — the DOM window-blur may not fire either in a
    // WKWebView. The Tauri native focus-change event (registered once in init()) is the
    // reliable signal; this DOM listener is a belt-and-suspenders secondary.
    const onWindowBlur = () => {
      if (document.activeElement === ta) flushRun();
    };
    window.addEventListener("blur", onWindowBlur);
    this.imeCleanup = () => {
      window.removeEventListener("blur", onWindowBlur);
      this.imeFlush = null;
    };
  }
  async spawn() {
    if (this.attached) {
      // Re-attach this window's view to an already-running PTY (pop-out target),
      // THEN refit — the resize triggers SIGWINCH so the shell repaints its
      // current line into the freshly-attached channel.
      await invoke("pty_attach", { id: this.ptyId, onData: this.channel });
      this.refit();
    } else {
      this.refit();
      this.ptyId = await invoke<number>("pty_spawn", {
        cols: this.term.cols,
        rows: this.term.rows,
        onData: this.channel,
      });
    }
  }
  refit() {
    try {
      this.fit.fit();
    } catch {
      /* hidden */
    }
  }
  flash() {
    this.paneEl.classList.remove("flash");
    void this.paneEl.offsetWidth;
    this.paneEl.classList.add("flash");
  }
  setFontSize(n: number) {
    this.term.options.fontSize = n;
  }
  /** Apply live-editable settings to this terminal (font, cursor, scrollback). */
  applySettings(s: AppSettings) {
    this.term.options.fontFamily = s.fontFamily;
    this.term.options.fontSize = s.fontSize;
    this.term.options.letterSpacing = s.letterSpacing;
    this.term.options.cursorStyle = s.cursorStyle;
    this.term.options.cursorBlink = s.cursorBlink;
    this.term.options.scrollback = s.scrollback;
  }
  /** Kill the backing shell and tear down the view. */
  disposePty() {
    this.imeCleanup?.(); // remove the window-blur listener before the term goes away
    this.imeCleanup = null;
    if (this.ptyId) void invoke("pty_close", { id: this.ptyId });
    try {
      this.term.dispose();
    } catch {
      /* ignore */
    }
  }
  /** Tear down the view only, keeping the shell alive (pop-out hand-off). */
  detach() {
    try {
      this.term.dispose();
    } catch {
      /* ignore */
    }
    this.paneEl.remove();
  }
}

// A dragged pane doesn't move while it's being dragged, so cache each target pane's
// rect for the drag instead of reading getBoundingClientRect() on every dragover
// (a forced synchronous layout on a continuous-fire event). Cleared when the drag ends.
const dragRectCache = new WeakMap<HTMLElement, DOMRect>();
function zoneFor(el: HTMLElement, e: DragEvent): Zone {
  let r = dragRectCache.get(el);
  if (!r) {
    r = el.getBoundingClientRect();
    dragRectCache.set(el, r);
  }
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  if (x < 0.28) return "left";
  if (x > 0.72) return "right";
  if (y < 0.28) return "top";
  return "bottom";
}
// Dropping a dragged tab on the CENTER of another tab merges them into a split;
// the SIDES reorder. (Cross-tab split has to be driven from the always-visible
// tab headers — an inactive tab's panes are display:none and can't be dropped on.)
function tabZone(el: HTMLElement, e: DragEvent): "merge" | "reorder" {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  return x > 0.3 && x < 0.7 ? "merge" : "reorder";
}

// ── Lightweight right-click context menu ──────────────────────────────────────
interface CtxItem {
  label: string;
  action: () => void;
}
function closeContextMenu() {
  document.querySelectorAll(".ctxmenu").forEach((m) => m.remove());
}
function showContextMenu(x: number, y: number, items: CtxItem[]) {
  closeContextMenu();
  const menu = div("ctxmenu");
  for (const it of items) {
    const row = div("ctxitem");
    row.textContent = it.label;
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
      it.action();
    });
    menu.appendChild(row);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  // Keep it on-screen.
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 4}px`;
  if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 4}px`;
  setTimeout(() => window.addEventListener("mousedown", closeContextMenu, { once: true }), 0);
}

/** Inline-edit a tab/label element's text. Calls back with the new value. */
function inlineEdit(el: HTMLElement, value: string, commit: (v: string) => void) {
  const input = document.createElement("input");
  input.className = "title-edit";
  input.value = value;
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      if (v) commit(v);
    }
    input.replaceWith(el);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}

class TermTab {
  readonly kind = "term";
  id: number;
  title: string;
  root: LNode;
  focused: number; // pane uid
  el: HTMLDivElement;
  constructor(id: number, firstPane: Pane) {
    this.id = id;
    this.title = `Tab ${id}`;
    this.root = { kind: "leaf", pane: firstPane };
    this.focused = firstPane.uid;
    this.el = div("tabpanes");
  }
  panes(): Pane[] {
    const out: Pane[] = [];
    const walk = (n: LNode) =>
      n.kind === "leaf" ? out.push(n.pane) : n.children.forEach(walk);
    walk(this.root);
    return out;
  }
  dispose() {
    this.panes().forEach((p) => p.disposePty());
    this.el.remove();
  }
}

class EditorTab {
  readonly kind = "editor";
  id: number;
  title: string;
  path: string;
  el: HTMLDivElement;
  ed: EditorHandle;
  dirty = false;
  constructor(id: number, path: string, name: string, content: string, createEditor: CreateEditor) {
    this.id = id;
    this.path = path;
    this.title = name;
    this.el = div("editor");
    this.ed = createEditor(this.el, content, path, () => {
      if (!this.dirty) {
        this.dirty = true;
        manager.syncActiveAndDirty(); // just repaint the dirty ● — no tab-bar rebuild
      }
    });
  }
  focus() {
    this.ed.focus();
  }
  save() {
    void invoke("write_file", {
      path: this.path,
      content: this.ed.getValue(),
    }).then(() => {
      this.dirty = false;
      manager.syncActiveAndDirty(); // clear the dirty ● — no tab-bar rebuild
    });
  }
  dispose() {
    this.ed.destroy();
    this.el.remove();
  }
}

type Tab = TermTab | EditorTab;

// ── Layout-tree helpers ───────────────────────────────────────────────────────
function renderNode(node: LNode): HTMLElement {
  if (node.kind === "leaf") return node.pane.paneEl;
  const el = div("split " + node.dir);
  for (const c of node.children) el.appendChild(renderNode(c));
  return el;
}
function removeLeaf(root: LNode, paneUid: number): LNode | null {
  if (root.kind === "leaf") return root.pane.uid === paneUid ? null : root;
  const kids = root.children.map((c) => removeLeaf(c, paneUid)).filter(Boolean) as LNode[];
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return { kind: "split", dir: root.dir, children: kids };
}
function splitLeaf(root: LNode, targetUid: number, dir: "row" | "col", before: boolean, moving: Pane): LNode {
  if (root.kind === "leaf") {
    if (root.pane.uid !== targetUid) return root;
    const movingLeaf: LNode = { kind: "leaf", pane: moving };
    return { kind: "split", dir, children: before ? [movingLeaf, root] : [root, movingLeaf] };
  }
  return { kind: "split", dir: root.dir, children: root.children.map((c) => splitLeaf(c, targetUid, dir, before, moving)) };
}

class Manager {
  tabs: Tab[] = [];
  active = 0;
  settings: AppSettings = loadSettings();
  fontSize = this.settings.fontSize;
  tabbar = document.getElementById("tabbar")!;
  content = document.getElementById("content")!;
  sidebar = document.getElementById("sidebar")!;
  sidebarOpen = true;
  rootDir = "";
  expanded = new Set<string>();
  cache = new Map<string, FileEntry[]>();
  renameTabId: number | null = null; // tab id currently being inline-renamed
  private lastTabDown = { id: -1, t: 0 }; // manual double-click detection on tabs
  private findBar: HTMLDivElement | null = null; // terminal search bar (lazy)
  private findInput: HTMLInputElement | null = null;
  private findCount: HTMLSpanElement | null = null;
  private findResultsDispose: (() => void) | null = null; // count listener on focused pane

  async init() {
    // Extract a pane to a new tab by dropping it on the tab bar.
    this.tabbar.addEventListener("dragover", (e) => {
      if (!dragPane) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    });
    this.tabbar.addEventListener("drop", (e) => {
      if (!dragPane) return;
      e.preventDefault();
      this.extractToTab(dragPane);
    });
    // Window drag. Tauri's built-in `data-tauri-drag-region` handler isn't reliably
    // injected into RUNTIME-created windows (the pop-outs) — the main window moved but
    // pop-outs didn't. Driving startDragging() ourselves works identically in every
    // window. Fires only on the empty drag zones (the bar itself + the flex spacer),
    // never on a tab chip or a button, so clicks/tab-drag are unaffected.
    this.tabbar.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t === this.tabbar || t.classList.contains("tab-spacer")) {
        // Requires core:window:allow-start-dragging in the capability (NOT in
        // core:default) — otherwise the ACL silently rejects this on every window.
        void getCurrentWebviewWindow().startDragging().catch(() => {});
      }
    });
    // Native window focus loss (app switch / window switch) — the RELIABLE signal to
    // commit a composing Hangul run before WebKit cancels it. DOM window-blur is not
    // dependable inside a WKWebView, so this is the primary IME-flush trigger.
    void getCurrentWebviewWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) this.focusedPane()?.imeFlush?.();
    });
    // Global shortcuts that the native menu doesn't own. Capture phase so they beat
    // xterm's textarea handler.
    window.addEventListener(
      "keydown",
      (e) => {
        // Ctrl+Tab / Ctrl+Shift+Tab → cycle tabs (universal alias; not a native menu
        // item because Tab-based accelerators are awkward for the OS menu).
        if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Tab") {
          e.preventDefault();
          this.cycleTab(e.shiftKey ? -1 : 1);
          return;
        }
        const mod = e.metaKey || e.ctrlKey;
        if (!mod || e.altKey || e.shiftKey) return;
        // ⌘1..⌘8 → that tab; ⌘9 → last tab (macOS/browser convention).
        if (/^Digit[1-9]$/.test(e.code)) {
          const n = Number(e.code.slice(5));
          e.preventDefault();
          this.selectTab(n === 9 ? this.tabs.length - 1 : n - 1);
          return;
        }
        // ⌘D → split right (alias; the menu shows ⌘\, but ⌘D is the iTerm muscle memory).
        if (e.code === "KeyD") {
          e.preventDefault();
          void this.split("row");
        }
      },
      true,
    );
    // A popped-out window carries ?attach=<ptyId> and re-attaches to that shell
    // instead of spawning a fresh one.
    const attach = new URLSearchParams(location.search).get("attach");
    await this.newTab(attach ? Number(attach) : undefined);
    await this.initSidebar();
  }

  activeTab(): Tab | undefined {
    return this.tabs[this.active];
  }
  activeTerm(): TermTab | undefined {
    const t = this.tabs[this.active];
    return t && t.kind === "term" ? t : undefined;
  }
  tabOfPane(pane: Pane): TermTab | undefined {
    return this.tabs.find(
      (t): t is TermTab => t.kind === "term" && t.panes().some((p) => p.uid === pane.uid),
    );
  }
  focusedPane(): Pane | undefined {
    const t = this.activeTerm();
    return t?.panes().find((p) => p.uid === t.focused);
  }

  async newTab(attachPtyId?: number) {
    const pane = new Pane(this.fontSize, attachPtyId);
    const tab = new TermTab(nextTabId++, pane);
    this.content.appendChild(tab.el);
    this.tabs.push(tab);
    this.active = this.tabs.length - 1;
    this.renderTermTab(tab);
    this.render();
    pane.open();
    await pane.spawn();
    this.focusPane(tab, pane.uid);
  }

  async split(dir: "row" | "col") {
    const tab = this.activeTerm();
    if (!tab) return;
    await this.splitNew(tab, tab.focused, dir, false);
  }

  /** Insert a brand-new shell pane next to `targetUid` within `tab`. */
  async splitNew(tab: TermTab, targetUid: number, dir: "row" | "col", before: boolean) {
    const moving = new Pane(this.fontSize);
    tab.root = splitLeaf(tab.root, targetUid, dir, before, moving);
    this.renderTermTab(tab);
    moving.open();
    await moving.spawn();
    tab.focused = moving.uid;
    this.refitTermTab(tab);
    this.focusPane(tab, moving.uid);
  }

  /** Drag-split: move `moving` next to `target` pane in `zone`, cross-tab safe. */
  dropSplit(moving: Pane, target: Pane, zone: Zone) {
    const dir = zone === "left" || zone === "right" ? "row" : "col";
    const before = zone === "left" || zone === "top";
    // Self-drop on an edge → spawn a fresh shell split there. This is what makes
    // drag-to-split work from a lone terminal (no other pane to drop onto).
    if (moving.uid === target.uid) {
      const tab = this.tabOfPane(target);
      if (tab) void this.splitNew(tab, target.uid, dir, before);
      return;
    }
    const targetTab = this.tabOfPane(target);
    const sourceTab = this.tabOfPane(moving);
    if (!targetTab || !sourceTab) return;
    // Detach from source.
    const newSourceRoot = removeLeaf(sourceTab.root, moving.uid);
    if (newSourceRoot === null) {
      // source tab becomes empty → remove it
      const si = this.tabs.indexOf(sourceTab);
      sourceTab.el.remove();
      this.tabs.splice(si, 1);
      if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    } else {
      sourceTab.root = newSourceRoot;
      sourceTab.focused = sourceTab.panes()[0]?.uid ?? sourceTab.focused;
      this.renderTermTab(sourceTab);
    }
    targetTab.root = splitLeaf(targetTab.root, target.uid, dir, before, moving);
    targetTab.focused = moving.uid;
    this.renderTermTab(targetTab);
    this.active = this.tabs.indexOf(targetTab);
    this.render();
    this.refitTermTab(targetTab);
    this.focusPane(targetTab, moving.uid);
  }

  /** Drag a pane onto the tab bar → extract it into its own tab. */
  extractToTab(moving: Pane) {
    const sourceTab = this.tabOfPane(moving);
    if (!sourceTab) return;
    if (sourceTab.panes().length === 1) {
      moving.flash(); // already its own tab — nothing to extract; acknowledge
      return;
    }
    const newSourceRoot = removeLeaf(sourceTab.root, moving.uid);
    if (newSourceRoot) {
      sourceTab.root = newSourceRoot;
      sourceTab.focused = sourceTab.panes()[0]?.uid ?? sourceTab.focused;
      this.renderTermTab(sourceTab);
    }
    const tab = new TermTab(nextTabId++, moving);
    this.content.appendChild(tab.el);
    this.tabs.push(tab);
    this.active = this.tabs.length - 1;
    this.renderTermTab(tab);
    this.render();
    this.refitTermTab(tab);
    this.focusPane(tab, moving.uid);
  }

  /** Pop a pane out into its own OS window, keeping its shell alive. */
  popoutPane(pane: Pane) {
    if (!pane.ptyId) return; // not yet spawned
    const tab = this.tabOfPane(pane);
    if (!tab) return;
    void invoke("popout_pane", { id: pane.ptyId });
    if (tab.panes().length === 1) {
      // Whole tab moves out → drop the (now empty) tab without killing the shell.
      const i = this.tabs.indexOf(tab);
      pane.detach();
      tab.el.remove();
      this.tabs.splice(i, 1);
      this.active = Math.max(0, this.active - 1);
      if (this.tabs.length === 0) {
        void this.newTab();
        return;
      }
      this.render();
      this.refitActive();
      this.focusActive();
    } else {
      const newRoot = removeLeaf(tab.root, pane.uid);
      pane.detach();
      if (newRoot) tab.root = newRoot;
      tab.focused = tab.panes()[0]?.uid ?? tab.focused;
      this.renderTermTab(tab);
      this.refitTermTab(tab);
      this.focusPane(tab, tab.focused);
    }
  }

  closePane(pane: Pane) {
    const tab = this.tabOfPane(pane);
    if (!tab) return;
    if (tab.panes().length === 1) {
      this.active = this.tabs.indexOf(tab);
      this.closeActive();
      return;
    }
    const newRoot = removeLeaf(tab.root, pane.uid);
    pane.disposePty();
    pane.paneEl.remove();
    if (newRoot) tab.root = newRoot;
    tab.focused = tab.panes()[0]?.uid ?? tab.focused;
    this.renderTermTab(tab);
    this.refitTermTab(tab);
    this.focusPane(tab, tab.focused);
  }

  closeActive() {
    const tab = this.activeTab();
    if (!tab) return;
    tab.dispose();
    this.tabs.splice(this.active, 1);
    this.active = Math.max(0, this.active - 1);
    if (this.tabs.length === 0) {
      // Last tab closed → close the window (quits app if it's the last window).
      void invoke("close_window");
      return;
    }
    this.render();
    this.refitActive();
    this.focusActive();
  }

  moveTab(from: number, to: number) {
    if (from < 0 || from >= this.tabs.length || from === to) return;
    const activeObj = this.tabs[this.active];
    const [moved] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, moved);
    this.active = this.tabs.indexOf(activeObj);
    this.render();
    this.refitActive();
  }

  /** Merge terminal tab `from`'s pane tree into tab `to` as a side-by-side split. */
  mergeTabs(from: number, to: number) {
    if (from < 0 || to < 0 || from >= this.tabs.length || to >= this.tabs.length || from === to)
      return;
    const src = this.tabs[from];
    const dst = this.tabs[to];
    if (src.kind !== "term" || dst.kind !== "term") {
      this.moveTab(from, to); // editor tabs can't be split-merged → reorder instead
      return;
    }
    // renderTermTab(dst) re-parents the moved panes' DOM out of src.el into dst.el.
    dst.root = { kind: "split", dir: "row", children: [dst.root, src.root] };
    const focusUid = src.panes()[0]?.uid ?? dst.focused;
    this.tabs.splice(from, 1);
    this.active = this.tabs.indexOf(dst);
    this.renderTermTab(dst);
    src.el.remove();
    this.render();
    this.refitTermTab(dst);
    this.focusPane(dst, focusUid);
  }

  beginRenameTab(i: number) {
    const tab = this.tabs[i];
    if (!tab) return;
    this.renameTabId = tab.id;
    this.render();
  }

  selectTab(i: number) {
    if (i < 0 || i >= this.tabs.length) return;
    this.active = i;
    this.syncActiveAndDirty();
    this.refitActive();
    this.focusActive();
  }
  /**
   * Cheap update for active-tab + dirty changes: flips `.active`, toggles content
   * visibility, and repaints the dirty ● — WITHOUT tearing down and rebuilding the
   * whole tab bar (N elements × ~8 listeners + an SVG re-parse) the way render() does.
   * The tab SET is unchanged here, so the existing chips (stamped with data-tab-id)
   * are reused. Structural changes (add/remove/reorder/rename) still call render().
   */
  syncActiveAndDirty() {
    const activeId = this.tabs[this.active]?.id;
    for (const tab of this.tabs) tab.el.style.display = tab.id === activeId ? "flex" : "none";
    for (const el of this.tabbar.querySelectorAll<HTMLElement>(".tab")) {
      const tab = this.tabs.find((t) => t.id === Number(el.dataset.tabId));
      if (!tab) continue;
      el.classList.toggle("active", tab.id === activeId);
      const nameEl = el.querySelector<HTMLElement>(".name"); // absent in rename mode
      if (nameEl)
        nameEl.textContent = tab.kind === "editor" && tab.dirty ? `● ${tab.title}` : tab.title;
    }
  }
  /** Move to the next/previous tab, wrapping around. */
  cycleTab(dir: number) {
    const n = this.tabs.length;
    if (n < 2) return;
    this.selectTab((this.active + dir + n) % n);
  }

  focusBy(delta: number) {
    const tab = this.activeTerm();
    if (!tab) return;
    const ps = tab.panes();
    const idx = ps.findIndex((p) => p.uid === tab.focused);
    const next = ps[(idx + delta + ps.length) % ps.length];
    if (next) this.focusPane(tab, next.uid);
  }
  focusByPane(pane: Pane) {
    const tab = this.tabOfPane(pane);
    if (tab) {
      this.active = this.tabs.indexOf(tab);
      this.focusPane(tab, pane.uid);
      this.syncActiveAndDirty(); // pane clicks stay within the active tab — no rebuild
    }
  }
  focusPane(tab: TermTab, uid: number) {
    tab.focused = uid;
    const p = tab.panes().find((x) => x.uid === uid);
    if (p) {
      p.flash();
      p.term.focus();
    }
  }
  focusActive() {
    const t = this.activeTab();
    if (!t) return;
    if (t.kind === "term") this.focusPane(t, t.focused);
    else t.focus();
  }

  setFontSize(n: number) {
    this.fontSize = Math.max(8, Math.min(28, n));
    this.settings.fontSize = this.fontSize;
    saveSettings(this.settings);
    for (const tab of this.tabs)
      if (tab.kind === "term")
        for (const p of tab.panes()) p.setFontSize(this.fontSize);
    this.refitActive();
  }

  /** Push current settings to every open terminal and persist them. */
  applySettings() {
    this.fontSize = this.settings.fontSize;
    saveSettings(this.settings);
    for (const tab of this.tabs)
      if (tab.kind === "term") for (const p of tab.panes()) p.applySettings(this.settings);
    this.refitActive();
  }

  /** Modal settings panel (⌘,). Every control applies live and persists. */
  openSettings() {
    document.getElementById("settings-overlay")?.remove();
    const overlay = div("overlay");
    overlay.id = "settings-overlay";
    const panel = div("settings-panel");
    const head = div("settings-head");
    const h = document.createElement("span");
    h.textContent = "Settings";
    const close = div("settings-close");
    close.textContent = "×";
    close.title = "Close (Esc)";
    head.append(h, close);
    panel.appendChild(head);

    const body = div("settings-body");
    const section = (name: string) => {
      const sec = div("settings-section");
      const t = div("settings-section-title");
      t.textContent = name;
      sec.appendChild(t);
      body.appendChild(sec);
      return sec;
    };
    const row = (sec: HTMLElement, label: string, control: HTMLElement) => {
      const r = div("settings-row");
      const l = document.createElement("label");
      l.textContent = label;
      r.append(l, control);
      sec.appendChild(r);
    };
    const commit = () => {
      saveSettings(this.settings);
      this.applySettings();
    };

    const appearance = section("Appearance");

    const fontSel = document.createElement("select");
    fontSel.className = "settings-input";
    for (const f of FONT_CHOICES) {
      const o = document.createElement("option");
      o.value = f.value;
      o.textContent = f.label;
      if (f.value === this.settings.fontFamily) o.selected = true;
      fontSel.appendChild(o);
    }
    fontSel.addEventListener("change", () => {
      this.settings.fontFamily = fontSel.value;
      commit();
    });
    row(appearance, "Font", fontSel);

    const sizeIn = document.createElement("input");
    sizeIn.type = "number";
    sizeIn.className = "settings-input settings-num";
    sizeIn.min = "8";
    sizeIn.max = "28";
    sizeIn.value = String(this.settings.fontSize);
    sizeIn.addEventListener("change", () => {
      const n = Math.max(8, Math.min(28, Number(sizeIn.value) || 13));
      sizeIn.value = String(n);
      this.settings.fontSize = n;
      commit();
    });
    row(appearance, "Font size", sizeIn);

    const cursorSel = document.createElement("select");
    cursorSel.className = "settings-input";
    for (const c of ["block", "bar", "underline"] as const) {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c[0].toUpperCase() + c.slice(1);
      if (c === this.settings.cursorStyle) o.selected = true;
      cursorSel.appendChild(o);
    }
    cursorSel.addEventListener("change", () => {
      this.settings.cursorStyle = cursorSel.value as AppSettings["cursorStyle"];
      commit();
    });
    row(appearance, "Cursor style", cursorSel);

    const blink = document.createElement("input");
    blink.type = "checkbox";
    blink.className = "settings-check";
    blink.checked = this.settings.cursorBlink;
    blink.addEventListener("change", () => {
      this.settings.cursorBlink = blink.checked;
      commit();
    });
    row(appearance, "Cursor blink", blink);

    const terminal = section("Terminal");
    const scroll = document.createElement("input");
    scroll.type = "number";
    scroll.className = "settings-input settings-num";
    scroll.min = "100";
    scroll.max = "100000";
    scroll.step = "100";
    scroll.value = String(this.settings.scrollback);
    scroll.addEventListener("change", () => {
      const n = Math.max(100, Math.min(100000, Number(scroll.value) || 1000));
      scroll.value = String(n);
      this.settings.scrollback = n;
      commit();
    });
    row(terminal, "Scrollback (lines)", scroll);

    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const dismiss = () => overlay.remove();
    close.addEventListener("mousedown", dismiss);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) dismiss();
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") dismiss();
    });
    overlay.tabIndex = -1;
    overlay.focus();
  }
  clearFocused() {
    const ptyId = this.focusedPane()?.ptyId;
    if (ptyId) void invoke("pty_write", { id: ptyId, data: "\x0c" });
  }
  clearDropZones() {
    document.querySelectorAll<HTMLElement>(".pane").forEach((el) => {
      delete el.dataset.drop;
      dragRectCache.delete(el); // drop cached rects at drag end so the next drag re-reads
    });
  }

  renderTermTab(tab: TermTab) {
    // replaceChildren (not innerHTML="") reparents the existing pane elements in
    // place — innerHTML="" would serialize+discard and momentarily detach every
    // xterm host (canvas + hidden textarea) before re-attaching (flash + reflow).
    tab.el.replaceChildren(renderNode(tab.root));
  }
  refitTermTab(tab: TermTab) {
    requestAnimationFrame(() => tab.panes().forEach((p) => p.refit()));
  }
  refitActive() {
    const t = this.activeTerm();
    if (t) this.refitTermTab(t);
  }

  render() {
    this.tabbar.innerHTML = "";
    this.tabs.forEach((tab, i) => {
      const t = div("tab" + (i === this.active ? " active" : ""));
      t.dataset.tabId = String(tab.id); // lets syncActiveAndDirty() find this chip

      // Rename mode: render an <input> so it survives the render()s that
      // selecting/clicking a tab triggers (a plain dblclick handler gets wiped).
      if (tab.id === this.renameTabId) {
        const input = document.createElement("input");
        input.className = "title-edit";
        input.value = tab.title;
        const commit = (save: boolean) => {
          if (save) {
            const v = input.value.trim();
            if (v) tab.title = v;
          }
          this.renameTabId = null;
          this.render();
          this.focusActive();
        };
        input.addEventListener("mousedown", (e) => e.stopPropagation());
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit(true);
          } else if (e.key === "Escape") {
            commit(false);
          }
        });
        input.addEventListener("blur", () => commit(true));
        t.appendChild(input);
        this.tabbar.appendChild(t);
        requestAnimationFrame(() => {
          input.focus();
          input.select();
        });
        return;
      }

      const name = div("name");
      name.textContent =
        tab.kind === "editor" && tab.dirty ? `● ${tab.title}` : tab.title;
      t.appendChild(name);
      const x = div("close");
      x.textContent = "×";
      x.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        this.active = i;
        this.closeActive();
      });
      t.appendChild(x);
      // Manual double-click detection — survives the render() that selectTab fires.
      t.addEventListener("mousedown", () => {
        const now = performance.now();
        if (this.lastTabDown.id === tab.id && now - this.lastTabDown.t < 350) {
          this.lastTabDown = { id: -1, t: 0 };
          this.beginRenameTab(i);
          return;
        }
        this.lastTabDown = { id: tab.id, t: now };
        this.selectTab(i);
      });
      t.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        this.selectTab(i);
        showContextMenu(ev.clientX, ev.clientY, [
          { label: "Rename", action: () => this.beginRenameTab(i) },
          { label: "Close", action: () => { this.active = i; this.closeActive(); } },
        ]);
      });
      t.draggable = true;
      t.addEventListener("dragstart", (e) => {
        dragTabIndex = i;
        e.dataTransfer?.setData("text/plain", "tab");
      });
      t.addEventListener("dragend", () => {
        dragTabIndex = -1;
        document
          .querySelectorAll<HTMLElement>(".tab[data-tab]")
          .forEach((el) => delete el.dataset.tab);
      });
      // Accept both gestures: tab-reorder/merge (dragTabIndex) and pane-extract (dragPane).
      t.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        if (dragTabIndex >= 0 && dragTabIndex !== i) t.dataset.tab = tabZone(t, e);
        else if (dragPane) t.dataset.tab = "merge";
      });
      t.addEventListener("dragleave", () => {
        delete t.dataset.tab;
      });
      t.addEventListener("drop", (e) => {
        e.preventDefault();
        delete t.dataset.tab;
        if (dragPane) {
          e.stopPropagation(); // we handle it here; don't double-fire #tabbar drop
          this.extractToTab(dragPane);
        } else if (dragTabIndex >= 0) {
          if (dragTabIndex !== i && tabZone(t, e) === "merge") this.mergeTabs(dragTabIndex, i);
          else this.moveTab(dragTabIndex, i);
          dragTabIndex = -1;
        }
      });
      this.tabbar.appendChild(t);
      tab.el.style.display = i === this.active ? "flex" : "none";
    });
    const add = div("tab-add");
    add.textContent = "+";
    add.addEventListener("mousedown", () => void this.newTab());
    this.tabbar.appendChild(add);

    // Right-aligned sidebar toggle (the file-tree panel show/hide).
    const spacer = div("tab-spacer"); // empty flex fill; the init() mousedown drags here
    this.tabbar.appendChild(spacer);
    const toggle = div("tab-toggle" + (this.sidebarOpen ? " on" : ""));
    toggle.innerHTML =
      '<svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="1.7" width="14" height="10.6" rx="1.6"/><line x1="10" y1="1.7" x2="10" y2="12.3"/></svg>';
    toggle.title = "Toggle Sidebar (⌘B)";
    toggle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.toggleSidebar();
    });
    this.tabbar.appendChild(toggle);
  }

  // ── Sidebar / file tree ───────────────────────────────────────────────────
  async initSidebar() {
    this.rootDir = await invoke<string>("home_dir");
    this.cache.set(this.rootDir, await invoke<FileEntry[]>("list_dir", { path: this.rootDir }));
    this.renderTree();
  }
  toggleSidebar(force?: boolean) {
    this.sidebarOpen = force ?? !this.sidebarOpen;
    this.sidebar.classList.toggle("hidden", !this.sidebarOpen);
    this.render();
    this.refitActive();
  }

  async toggleDir(path: string) {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
    } else {
      if (!this.cache.has(path))
        this.cache.set(path, await invoke<FileEntry[]>("list_dir", { path }));
      this.expanded.add(path);
    }
    this.renderTree();
  }

  /** Open a native folder picker and make the chosen directory the tree root. */
  async pickRoot() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: this.rootDir || undefined,
      title: "Open Folder",
    });
    if (typeof picked === "string") await this.setRoot(picked);
  }

  /** Point the file tree at a new root directory (fresh listing, reset state). */
  async setRoot(dir: string) {
    if (!dir || dir === this.rootDir) return;
    try {
      const entries = await invoke<FileEntry[]>("list_dir", { path: dir });
      this.rootDir = dir;
      this.expanded.clear();
      this.cache.clear();
      this.cache.set(dir, entries);
      if (!this.sidebarOpen) this.toggleSidebar(true);
      this.renderTree();
    } catch {
      /* not a readable directory — ignore */
    }
  }

  renderTree() {
    this.sidebar.innerHTML = "";

    const head = div("side-head");
    // Folder name doubles as a breadcrumb: click to jump to the parent directory.
    const name = div("side-root");
    name.textContent = (basename(this.rootDir) || this.rootDir).toUpperCase();
    name.title = `${this.rootDir}\nClick to go up one level`;
    name.addEventListener("click", () => void this.setRoot(dirname(this.rootDir)));

    const spacer = div("side-spacer");

    // Folder-picker icon → native "Open Folder" dialog.
    const openBtn = div("side-btn");
    openBtn.title = "Open Folder…";
    openBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
    openBtn.addEventListener("click", () => void this.pickRoot());

    head.append(name, spacer, openBtn);
    this.sidebar.appendChild(head);
    this.renderDir(this.rootDir, 0);
  }
  renderDir(dir: string, depth: number) {
    for (const e of this.cache.get(dir) ?? []) {
      const isExp = e.is_dir && this.expanded.has(e.path);
      const row = div("tree-row");
      row.style.paddingLeft = `${6 + depth * 12}px`;
      row.textContent = `${e.is_dir ? (isExp ? "▾" : "▸") : " "} ${e.name}`;
      row.addEventListener("mousedown", () =>
        e.is_dir ? void this.toggleDir(e.path) : void this.openFile(e.path, e.name),
      );
      this.sidebar.appendChild(row);
      if (isExp) this.renderDir(e.path, depth + 1);
    }
  }
  async openFile(path: string, name: string) {
    const existing = this.tabs.findIndex(
      (t) => t.kind === "editor" && t.path === path,
    );
    if (existing >= 0) {
      this.active = existing;
      this.render();
      this.refitActive();
      this.focusActive();
      return;
    }
    let content: string;
    try {
      content = await invoke<string>("read_file", { path });
    } catch (e) {
      content = `// ${String(e)}`;
    }
    // Lazily pull in the CodeMirror stack (its own async chunk) only now — the first
    // time a file is actually opened. Already an async path, so no added latency.
    const { createEditor } = await import("./editor");
    const tab = new EditorTab(nextTabId++, path, name, content, createEditor);
    this.tabs.push(tab);
    this.content.appendChild(tab.el);
    this.active = this.tabs.length - 1;
    this.render();
    tab.focus();
  }

  // ── Edit: copy / select-all (terminal- and editor-aware) ──────────────────
  copyActive() {
    const t = this.activeTab();
    const text =
      t?.kind === "editor" ? t.ed.getSelection() : (this.focusedPane()?.term.getSelection() ?? "");
    if (text) void navigator.clipboard.writeText(text);
  }
  selectAllActive() {
    const t = this.activeTab();
    if (t?.kind === "editor") t.ed.selectAll();
    else this.focusedPane()?.term.selectAll();
  }

  // ── Find: editor uses CodeMirror's search panel; terminal gets a search bar ──
  openFind() {
    const t = this.activeTab();
    if (t?.kind === "editor") {
      t.ed.find();
      return;
    }
    if (!this.findBar) this.buildFindBar();
    // (Re)bind the match counter to the CURRENTLY focused pane's search addon.
    this.findResultsDispose?.();
    const search = this.focusedPane()?.search;
    const input = this.findInput!;
    const d = search?.onDidChangeResults((r) => {
      if (!this.findCount) return;
      this.findCount.textContent = r.resultCount
        ? `${r.resultIndex + 1}/${r.resultCount}`
        : input.value
          ? "0/0"
          : "";
    });
    this.findResultsDispose = d ? () => d.dispose() : null;
    this.findBar!.style.display = "flex";
    input.focus();
    input.select();
    if (input.value) this.runFind(input.value, 0);
  }
  private buildFindBar() {
    const bar = div("findbar");
    const input = document.createElement("input");
    input.className = "find-input";
    input.placeholder = "Find in terminal";
    input.addEventListener("input", () => this.runFind(input.value, 0));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.findStep(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeFind();
      }
    });
    const count = document.createElement("span");
    count.className = "find-count";
    const prev = div("find-btn");
    prev.textContent = "‹";
    prev.title = "Previous (⇧⌘G)";
    prev.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.findStep(-1);
    });
    const next = div("find-btn");
    next.textContent = "›";
    next.title = "Next (⌘G)";
    next.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.findStep(1);
    });
    const close = div("find-btn");
    close.textContent = "×";
    close.title = "Close (Esc)";
    close.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.closeFind();
    });
    bar.append(input, count, prev, next, close);
    this.content.appendChild(bar);
    this.findBar = bar;
    this.findInput = input;
    this.findCount = count;
  }
  private runFind(q: string, dir: number) {
    const search = this.focusedPane()?.search;
    if (!search) return;
    const opts = { decorations: FIND_DECOR, incremental: dir === 0 };
    if (dir < 0) search.findPrevious(q, opts);
    else search.findNext(q, opts);
  }
  findStep(dir: number) {
    if (!this.findBar || this.findBar.style.display === "none") {
      if (this.activeTab()?.kind === "editor") {
        this.openFind();
        return;
      }
      this.openFind();
    }
    const q = this.findInput?.value ?? "";
    if (q) this.runFind(q, dir);
  }
  closeFind() {
    if (this.findBar) this.findBar.style.display = "none";
    this.focusedPane()?.search.clearDecorations();
    // Drop the onDidChangeResults subscription — it retained the SearchAddon → the
    // whole Terminal (scrollback). openFind re-binds it to the focused pane next time.
    this.findResultsDispose?.();
    this.findResultsDispose = null;
    this.focusActive();
  }

  // ── Print: the active surface's text (terminal scrollback or editor doc) ────
  printActive() {
    const t = this.activeTab();
    let text = "";
    if (t?.kind === "editor") text = t.ed.getValue();
    else {
      const p = this.focusedPane();
      if (p) text = termBufferText(p.term);
    }
    let holder = document.getElementById("printarea");
    if (!holder) {
      holder = document.createElement("div");
      holder.id = "printarea";
      document.body.appendChild(holder);
    }
    holder.textContent = "";
    const pre = document.createElement("pre");
    pre.textContent = text;
    holder.appendChild(pre);
    const cleanup = () => {
      holder!.textContent = "";
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  }

  onMenu(action: string) {
    switch (action) {
      case "new_tab":
        void this.newTab();
        break;
      case "close":
        this.closeActive();
        break;
      case "split_right":
        void this.split("row");
        break;
      case "split_down":
        void this.split("col");
        break;
      case "focus_next":
        this.focusBy(1);
        break;
      case "focus_prev":
        this.focusBy(-1);
        break;
      case "next_tab":
        this.cycleTab(1);
        break;
      case "prev_tab":
        this.cycleTab(-1);
        break;
      case "toggle_sidebar":
        this.toggleSidebar();
        break;
      case "zoom_in":
        this.setFontSize(this.fontSize + 1);
        break;
      case "zoom_out":
        this.setFontSize(this.fontSize - 1);
        break;
      case "zoom_reset":
        this.setFontSize(13);
        break;
      case "clear":
        this.clearFocused();
        break;
      case "save": {
        const t = this.activeTab();
        if (t && t.kind === "editor") t.save();
        break;
      }
      case "copy":
        this.copyActive();
        break;
      case "select_all":
        this.selectAllActive();
        break;
      case "find":
        this.openFind();
        break;
      case "find_next":
        this.findStep(1);
        break;
      case "find_prev":
        this.findStep(-1);
        break;
      case "print":
        this.printActive();
        break;
      case "settings":
        this.openSettings();
        break;
      default:
        break;
    }
  }
}

manager = new Manager();
void manager.init();

// Window-scoped listener — only THIS window receives its menu actions.
void getCurrentWebviewWindow().listen<string>("menu", (e) => manager.onMenu(e.payload));

// Auto-update: check once on startup, main window only (pop-outs must not prompt).
// Dynamic-imported so the updater client stays off the cold-start chunk; wrapped so
// it's fully inert until the endpoint + signer pubkey are configured (check() then
// just throws/returns null and we ignore it) and never blocks the terminal.
if (getCurrentWebviewWindow().label === "main") {
  void (async () => {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return;
      const { ask, message } = await import("@tauri-apps/plugin-dialog");
      const yes = await ask(
        `Apioni IDE ${update.version} is available (you have ${update.currentVersion}). Install now?`,
        { title: "Update available", kind: "info" },
      );
      if (!yes) return;
      await update.downloadAndInstall();
      await message("Update installed — please restart Apioni IDE.", { title: "Update ready" });
    } catch {
      /* no endpoint configured yet / offline / check failed — non-fatal, ignore */
    }
  })();
}

let raf = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => manager.refitActive());
});
