<div align="center">

# Apioni IDE

**A fast, native terminal for AI CLIs.**
Run Claude Code, Codex, and friends in a lightweight app with an editor, splits, and pop-out panes.

`apioni.com/ide` · macOS · Windows · Linux · Apache-2.0

</div>

---

Apioni is a small, native terminal built for the way people work with command-line
agents. Run `claude`, `codex`, or anything else you drive from the shell, and get a
real editor, split panes, and pop-out windows without leaving the terminal. The app
is around 5.6 MB and starts instantly.

- **Lightweight and native.** Rust on Tauri, with no bundled browser and no Electron overhead.
- **Editor, splits, pop-outs.** Open a file inline, divide a window into panes, or pull
  one out when you're running more than one agent at once.
- **Input that works.** Full IME support for Korean, Japanese, and Chinese, the part
  most terminals still get wrong.
- **Local-first and quiet.** No account, no telemetry unless you turn it on, works offline.

## Install

Download for your platform at [apioni.com/ide](https://apioni.com/ide).

**macOS:** Homebrew, or the signed and notarized `.dmg`.

```sh
brew install --cask flowlab-works/apioni/apioni
```

**Windows:** the x64 installer (`.exe`). It is unsigned, so Windows SmartScreen
shows a one-time "More info" then "Run anyway".

**Linux:** the x86_64 `AppImage`. Mark it executable and run it.

```sh
chmod +x Apioni-IDE_x86_64.AppImage && ./Apioni-IDE_x86_64.AppImage
```

## Build from source

```sh
pnpm install
pnpm tauri dev      # run in dev
pnpm tauri build    # produce a .app / .dmg
```

Requirements: Node 20+, pnpm 9+, and Rust (stable). For a macOS universal build,
add the Apple targets (`aarch64-apple-darwin`, `x86_64-apple-darwin`); Windows and
Linux build for the host target out of the box.

## Stack

Tauri 2 (Rust backend, the OS webview) with `xterm.js` on WebGL for the terminal and
CodeMirror 6 for the editor. The release binary is ~5.6 MB; PTY I/O is raw bytes and
rendering is GPU-accelerated.

## Open core

The desktop app is free and open under Apache-2.0. What comes next is agent-aware:
reviewing an agent's edits as diffs before they land, and a shared console for teams.
Both build on the same local-first foundation, never at the cost of what already runs
on your machine.

## Status

macOS (Apple Silicon + Intel, signed and notarized), Windows (x64), and Linux
(x86_64 AppImage). Auto-update ships on macOS today; on Windows and Linux you
update by downloading the latest build. Windows builds are not code-signed yet.

## License

[Apache-2.0](./LICENSE) © Apioni (flowlab-works)
