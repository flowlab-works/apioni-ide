<div align="center">

# Apioni IDE

**A terminal that supervises the AI CLI you already run.**
Diffs, never auto-writes. No login to type `ls`.

`apioni.com/ide` · macOS (beta) · Apache-2.0

</div>

---

Most IDEs are **file-first**: a file tree, an editor, and a terminal bolted to the
bottom drawer. Apioni inverts the gravity — **the command flow is the canvas.** You
keep running `claude`, `codex`, or `aider` exactly as you do today; Apioni wraps that
loop and makes it durable, reviewable, and safe.

- **Supervises your CLI — doesn't replace it.** Your Claude Code / Codex runs as-is,
  with its own login, its own tokens, its own model. Apioni watches the run, surfaces
  what it read and what it proposes, and keeps you in the loop.
- **Diffs, never auto-writes.** The agent proposes a diff; nothing touches disk until
  you approve it. No hidden auto-apply path exists.
- **Every command is a durable object.** Each run becomes a `CommandBlock` — input,
  cwd, branch, exit code, detected files/errors, the proposed diff, the re-run. Kill
  the terminal, reopen — the block is still there.
- **Local-first, no account.** First screen, you type `ls`. It works fully offline.
  No telemetry by default.

Not a chat box (Cursor). Not a file-first editor (Zed / Windsurf). Not a replacement
for your CLI (Warp). It's the **command-first workspace for the agent-CLI era.**

## Install

```sh
# Homebrew (recommended)
brew install --cask flowlab-works/apioni/apioni

# or download the signed .dmg
open https://apioni.com/ide
```

## The four commitments

Verifiable on a fresh machine with no account:

1. **Diffs never auto-write** — approval-gated, always.
2. **No telemetry by default** — first run sends nothing; opt-in is a separate screen.
3. **Local-first, no login** — the terminal, blocks, and diff review work offline.
4. **Exportable audit log** — every block exports to a plain file: read / proposed / executed.

## Build from source

```sh
pnpm install
pnpm tauri dev      # run in dev
pnpm tauri build    # produce a .app / .dmg
```

Requirements: Node 20+, pnpm 9+, Rust (stable) with the Apple targets for a universal
build (`aarch64-apple-darwin`, `x86_64-apple-darwin`).

## Stack

Native, not Electron. Tauri 2 (Rust backend, the OS webview) + `xterm.js` (WebGL) +
CodeMirror 6. The release binary is ~5.6 MB; PTY I/O is raw bytes; rendering is GPU.

## Open-core

This repository is the **open-source desktop client** (Apache-2.0). The local loop and
every safety guarantee are here and always free. The paid layer — the cloud review
console, team audit / governance, and mobile approvals — is a separate, additive
product; nothing that works locally today ever moves behind it.

## Status

macOS (Apple Silicon + Intel), beta. The core is Rust + `portable-pty`, so Linux and
Windows are a port, not a rewrite — planned, not shipped.

## License

[Apache-2.0](./LICENSE) © Apioni (flowlab-works)
