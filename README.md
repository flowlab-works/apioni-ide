<div align="center">

# Apioni IDE

**A fast, native terminal for AI CLIs.**
Run Claude Code, Codex, and friends in a lightweight app — with an editor, splits, and pop-out panes.

`apioni.com/ide` · macOS · Apache-2.0

</div>

---

Apioni is a small, native terminal built for the way people work with command-line
agents. Run `claude`, `codex`, or anything else you drive from the shell, and get a
real editor, split panes, and pop-out windows without leaving the terminal — in an
app that's around 5.6 MB and starts instantly.

- **Lightweight and native.** Rust on Tauri — no bundled browser, no Electron overhead.
- **Editor, splits, pop-outs.** Open a file inline, divide a window into panes, or pull
  one out — useful when you're running more than one agent at once.
- **Input that works.** Full IME support for Korean, Japanese, and Chinese — the part
  most terminals still get wrong.
- **Local-first and quiet.** No account, no telemetry unless you turn it on, works offline.

## Install

```sh
# Homebrew
brew install --cask flowlab-works/apioni/apioni

# or download the signed .dmg
open https://apioni.com/ide
```

## Build from source

```sh
pnpm install
pnpm tauri dev      # run in dev
pnpm tauri build    # produce a .app / .dmg
```

Requirements: Node 20+, pnpm 9+, and Rust (stable) with the Apple targets for a
universal build (`aarch64-apple-darwin`, `x86_64-apple-darwin`).

## Stack

Tauri 2 (Rust backend, the OS webview) with `xterm.js` on WebGL for the terminal and
CodeMirror 6 for the editor. The release binary is ~5.6 MB; PTY I/O is raw bytes and
rendering is GPU-accelerated.

## Open core

The desktop app is free and open under Apache-2.0. What's next is agent-aware —
reviewing an agent's edits as diffs before they land, and a shared console for teams —
built on the same local-first foundation, and never at the cost of what already runs
on your machine.

## Status

macOS (Apple Silicon + Intel), signed and notarized. The core is Rust + `portable-pty`,
so Linux and Windows are a port rather than a rewrite — planned, not shipped.

## License

[Apache-2.0](./LICENSE) © Apioni (flowlab-works)
