# Apioni IDE — Deployment (macOS, open-core)

How the desktop app ships: **Developer-ID-signed + notarized `.dmg` on GitHub
Releases, distributed via the landing page + a Homebrew tap, with in-app
auto-update (tauri-updater).** Everything below is wired in the repo; the items
under **Founder one-time setup** need your Apple account / decisions before the
first release can go out.

The distribution model (why): see [`../ai-orch worknplay note`] / the marketing
decision — open-core, GitHub public repo is the P0 distribution channel, signing
is non-optional (Gatekeeper blocks an unsigned app).

---

## What's already set up in this repo

| File | Purpose |
|---|---|
| `LICENSE` | Apache-2.0 (open-core desktop client) |
| `.github/workflows/release.yml` | Tag `desktop-v*` → universal build → sign → notarize → **staple the .dmg separately** → GitHub Release + `latest.json` |
| `src-tauri/tauri.conf.json` | `createUpdaterArtifacts: true` + `plugins.updater` (endpoint + pubkey slot) |
| `src-tauri/Cargo.toml` / `src/main.rs` | `tauri-plugin-updater` wired |
| `src-tauri/capabilities/default.json` | `updater:default` permission |
| `src/main.ts` | startup update check (main window only; inert until configured) |
| `packaging/homebrew/apioni.rb` | Homebrew Cask (goes in the tap repo) |

---

## Founder one-time setup (do these before the first release)

### 1. Apple signing (you have the Developer Program)
- Export your **"Developer ID Application"** cert as a `.p12`, then base64 it:
  `base64 -i cert.p12 | pbcopy`
- Create an **app-specific password** at appleid.apple.com (for notarization).
- Add these repo secrets (Settings → Secrets and variables → Actions):
  `APPLE_CERTIFICATE` (the base64), `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY` (`Developer ID Application: NAME (TEAMID)`),
  `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`.

### 2. Updater signing key
- `cd apps/desktop && pnpm tauri signer generate -w ~/.tauri/apioni-updater.key`
- Put the **public** key into `tauri.conf.json` → `plugins.updater.pubkey`
  (replace `REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY`).
- Add the **private** key + its password as repo secrets
  `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- ⚠️ Never commit the private key. `~/.tauri/*.key` stays local.

### 3. Repo visibility / open-core split  ← the one structural decision
This is a **monorepo**: `apps/desktop` (OSS client) + `apps/web` (the **paid**
Review Console) + `apps/mobile` + `crates/` + `packages/protocol`. Making the
whole repo public would expose the paid cloud code and the business docs.

Recommended: **publish the open core as a separate public repo** containing only
`apps/desktop`, `crates/apioni-core`, `crates/apioni-terminal`, `packages/protocol`
(the client + shared brain), and keep this monorepo (with `apps/web` + cloud +
`docs/`) **private**. Move `release.yml` + `LICENSE` + `packaging/` into the
public repo. Alternative: keep everything private and ship signed DMGs from
private-repo releases — but you lose the P0 "public repo = star/trust gate"
channel, so this is not recommended for the launch.
> Decide this before flipping anything to public. Nothing here forces it.

### 4. Domain + landing
- Point `apioni.com/ide` at the landing (Vercel). The landing's download button
  links to the latest GitHub Release `.dmg`; the Show HN submission URL is the
  landing (no login, demo autoplay above the fold).

---

## Cutting a release
```bash
# bump version in apps/desktop/src-tauri/tauri.conf.json + Cargo.toml + package.json
git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
```
CI builds the universal `.app`, signs + notarizes it, notarizes + **staples the
.dmg** (tauri-action staples only the `.app` — pitfall #38), attaches the `.dmg`
+ `latest.json` to a **draft** release. Un-draft after the clean-machine check.

## Homebrew tap
1. Create repo `flowlab-works/homebrew-apioni`, add `Casks/apioni.rb` from
   `packaging/homebrew/apioni.rb`.
2. Per release, update `version` + `sha256` (`shasum -a 256 <dmg>`).
3. Users: `brew install --cask flowlab-works/apioni/apioni`.
   (Submit to official homebrew-cask once the app clears notability.)

## Verify (do NOT skip — build green ≠ notarized)
On a **clean Mac / fresh user account**, download the `.dmg` and run:
```bash
spctl -a -t open --context context:primary-signature -vv <dmg>   # → accepted
xcrun stapler validate <dmg>                                     # → validated
xcrun stapler validate "/Applications/Apioni IDE.app"           # after install
```
Then double-click to install and confirm no "unidentified developer" / "damaged"
prompt. Only then un-draft the GitHub Release.
