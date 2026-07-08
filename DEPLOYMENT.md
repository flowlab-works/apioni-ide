# Apioni IDE — Deployment

This is the public, open-core desktop client (Apache-2.0). It ships as installers
on GitHub Releases, linked from the landing page and a Homebrew tap, with in-app
auto-update on macOS.

Platforms per release:

- **macOS** — universal (Apple Silicon and Intel), Developer-ID signed and notarized, `.dmg`.
- **Windows** — x64 NSIS installer (`.exe`). Unsigned (no Authenticode cert), so SmartScreen shows a one-time "More info" then "Run anyway".
- **Linux** — x86_64 AppImage.

Auto-update (tauri-updater) runs on macOS. Windows and Linux update by downloading
the latest build.

---

## What's wired in this repo

| File | Purpose |
|---|---|
| `LICENSE` | Apache-2.0 |
| `.github/workflows/release.yml` | Tag `desktop-v*` → build matrix (macOS universal / Windows / Linux) → macOS sign + notarize + staple the `.dmg` separately (pitfall #38) → GitHub Release with versioned + stable-named assets → macOS `latest.json` |
| `src-tauri/tauri.conf.json` | `createUpdaterArtifacts: true`, `plugins.updater` endpoint + the real pubkey |
| `src-tauri/Cargo.toml` / `src/main.rs` | `tauri-plugin-updater` wired; macOS-only window/PTY APIs are `cfg`-guarded so Windows and Linux compile |
| `src-tauri/capabilities/default.json` | `updater:default` permission |
| `src/main.ts` | startup update check (main window only) |
| `packaging/homebrew/apioni.rb` | Homebrew Cask reference (the live copy lives in the tap repo) |

Configured GitHub secrets: Apple signing (`APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID`) and updater signing
(`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Optional:
`HOMEBREW_TAP_TOKEN` (a PAT with write access to the tap) auto-bumps the cask;
without it the cask-bump step skips and you bump the tap by hand (below).

---

## Cutting a release

```bash
# bump the version in all three, keeping them in sync:
#   src-tauri/tauri.conf.json   src-tauri/Cargo.toml   package.json
git tag desktop-v<version> && git push origin desktop-v<version>
```

CI runs the `verify-version` guard (tag must equal the Tauri and Cargo versions),
then builds all three platforms into a **draft** release. macOS is signed,
notarized, and the `.dmg` is stapled; the `latest.json` updater manifest is
generated on macOS only. Each platform also uploads a version-less copy so the
landing links to stable URLs:

- `releases/latest/download/Apioni-IDE_universal.dmg`
- `releases/latest/download/Apioni-IDE_x64-setup.exe`
- `releases/latest/download/Apioni-IDE_x86_64.AppImage`

Verify (below), then publish as a normal (non-prerelease) release so it becomes
`latest`:

```bash
gh release edit desktop-v<version> --draft=false --latest
```

## Homebrew tap

Tap repo: `flowlab-works/homebrew-apioni`. Users install with
`brew install --cask flowlab-works/apioni/apioni`.

Per release, if `HOMEBREW_TAP_TOKEN` is not set, bump the cask by hand:

```bash
# in flowlab-works/homebrew-apioni, edit Casks/apioni.rb:
#   version "<version>"
#   sha256 "<shasum -a 256 of Apioni.IDE_<version>_universal.dmg>"
```

## Verify (build green is not the same as notarized)

macOS, on the downloaded `.dmg`:

```bash
spctl -a -t open --context context:primary-signature -vv <dmg>   # → accepted
xcrun stapler validate <dmg>                                      # → validated
```

Then install and confirm no "unidentified developer" or "damaged" prompt before
publishing. Windows and Linux are unsigned; smoke-test by launching on each OS.
