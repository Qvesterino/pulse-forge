# ADR 0011 — Desktop auto-updates via electron-updater on GitHub Releases

Date: 2026-09-19
Status: Accepted

Installed desktop builds update themselves with `electron-updater`, checking the repository's published GitHub Releases. This supersedes the "auto-update is deferred" consequence of ADR 0010 (the blocker — an undecided web deploy host — turned out not to block: the repo is public, so GitHub Releases is a zero-infrastructure feed).

## Decision

- **Feed**: `publish: provider: github` in `electron-builder.yml` bakes `resources/app-update.yml` into every install; electron-updater reads `latest.yml` from the latest published release (`KYX-Setup-<version>.exe` + `.exe.blockmap` + `latest.yml` — all produced by `npm run desktop:build`).
- **Cadence & safety**: first check ~10 s after launch, then every 6 h. Downloads are silent; installation happens only through the user's explicit restart (dialog: "Restart & install / Later") or, if dismissed, on the next natural app quit (`autoInstallOnAppQuit`). This mirrors the PWA `registerType: "prompt"` stance (src/pwa.ts): a running session is never torn down on its own.
- **Manual check**: Help → "Check for updates…" with explicit up-to-date / failure dialogs.
- **Runtime feed override**: `KYX_UPDATE_URL=http://host/` switches the updater to a generic provider pointing anywhere serving `latest.yml` + the installer — local end-to-end testing and future self-hosting without repackaging.
- **Packaging**: the app's web dependencies are bundled by Vite, so the installer ships only `electron-updater`'s pure-JS runtime tree (explicit `files` globs in electron-builder.yml; regenerate the list when bumping electron-updater).

## Consequences

- **Publishing a release is what ships an update**: `git tag vX.Y.Z && git push --tags`, create the GitHub release, upload the three artifacts from `release/`. Users' installed 0.1.0 picks it up within 6 h or on next launch.
- **Portable exe can't self-update** (no install location — electron-updater's NSIS flow doesn't apply): portable users re-download. The updater still runs there harmlessly.
- **No code signing yet**: electron-updater verifies the downloaded installer by sha512 from `latest.yml`; publisher-signature verification stays off until a cert is added.
- **Unauthenticated GitHub API** is used for the check (60 req/h per IP) — negligible for per-app checks every 6 h.
