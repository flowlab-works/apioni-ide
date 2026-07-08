# Apioni IDE — Handoff

A fast, native terminal for AI CLIs, for macOS, Windows, and Linux. Apache-2.0.
Live at [apioni.com/ide](https://apioni.com/ide).

This is the release SSOT: the public open-core desktop client. The landing page
lives in a separate repo (the apioni.com site), and the Homebrew tap is
`flowlab-works/homebrew-apioni`.

## Current state (v0.1.1, shipped)

Shipped in the app: a native terminal (`xterm.js` on WebGL) with a real editor
(CodeMirror 6), split panes on a layout tree, pane pop-out to its own window,
all-language IME, and a native menu with shortcuts. Rust PTY backend
(`portable-pty`). The release binary is about 5.6 MB.

- **Platforms:** macOS universal (Apple Silicon and Intel, signed and notarized),
  Windows x64 (NSIS installer, unsigned), Linux x86_64 (AppImage).
- **Download (stable URLs, always the latest release):**
  - `https://github.com/flowlab-works/apioni-ide/releases/latest/download/Apioni-IDE_universal.dmg`
  - `https://github.com/flowlab-works/apioni-ide/releases/latest/download/Apioni-IDE_x64-setup.exe`
  - `https://github.com/flowlab-works/apioni-ide/releases/latest/download/Apioni-IDE_x86_64.AppImage`
- **Homebrew:** `brew install --cask flowlab-works/apioni/apioni`
- **Auto-update:** macOS (tauri-updater). Windows and Linux update by downloading
  the latest build.

## Repo layout

| Path | What |
|---|---|
| `src/` | Frontend (TypeScript): `xterm.js` terminal, CodeMirror editor, layout/tabs/panes |
| `src-tauri/` | Rust backend: PTY sessions, windows, native menu, updater |
| `.github/workflows/release.yml` | Three-platform release pipeline (build, sign, notarize, publish) |
| `packaging/homebrew/apioni.rb` | Cask reference (the live copy is in the tap repo) |
| `DEPLOYMENT.md` | How to cut a release |
| `LICENSE` | Apache-2.0 |

## Releasing

Full steps in `DEPLOYMENT.md`. In short: bump the version in
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `package.json`; tag
`desktop-vX.Y.Z` and push. CI runs `verify-version`, builds all three platforms
into a draft release, and signs and notarizes macOS. Verify, then publish as a
normal release with `--latest`. Bump the Homebrew cask (`version` + the dmg
`sha256`), or set the `HOMEBREW_TAP_TOKEN` repo secret to auto-bump it.

## Roadmap (not shipped)

The direction is agent-aware review: seeing an agent's edits as diffs before they
land, and a shared console for teams, on the same local-first foundation. None of
that is in 0.1.1. Keep product copy honest about the difference.

## Notes for maintainers

- macOS-only Rust APIs (the Overlay title-bar style, and process-group kill) are
  `cfg`-guarded. Keep any new platform-specific call guarded so Windows and Linux
  keep compiling. CI is the only place Windows and Linux are actually built.
- The Korean/CJK IME bridge in `src/main.ts` runs on macOS only (a WKWebView
  workaround). WebView2 (Windows) and WebKitGTK (Linux) handle IME natively.
- Windows builds are unsigned (no Authenticode cert), so SmartScreen shows a
  one-time prompt. Adding signing means an OV/EV cert or Azure Trusted Signing.
- The frontend is one bundle shared across platforms; a platform is detected from
  the webview userAgent and stamped as `data-os` on the root element.
