# ADR 0033 — Persist bounded external mastering delivery reports

Date: 2026-10-09 · Status: Accepted · Scope: external mastering reports and local session storage

## Context

External mastering sessions persist their source, processing settings and A/B
snapshots. Checked-delivery JSON sidecars are currently held only in the open
workspace, so closing or reloading KYX loses the in-app report download links.
The sidecar already contains the source fingerprint, config revision, file
fingerprint and verification basis, and contains no audio.

## Decision

1. Add a `delivery-reports` object store to the existing
   `kyx-mastering-sessions` IndexedDB database. Upgrade database version 3 to
   version 4 without rewriting existing session, source or reference records.
2. Persist the sidecar JSON and small display metadata only. Do not persist
   `AudioBuffer`, encoded delivery audio, source audio or a claim that an old
   report describes the current session settings.
3. Keep the six most recent distinct session/output-name reports across the
   workspace. Re-exporting the same output name in the same session replaces
   its previous report. Each sidecar is capped at 2 MiB; the report history is
   therefore bounded to 12 MiB of JSON.
4. Delete reports atomically with their owning session. A report remains
   downloadable when its session is not selected, but it is removed if that
   session is deleted.
5. A completed, inspected audio download remains successful if report
   persistence fails. Keep the report available in the current workspace and
   tell the user that the local history could not be saved.
6. Validate loaded report metadata and sidecar identity before exposing a
   download. A damaged or unsupported history must not prevent the source
   session from opening; surface a report-history warning instead.
7. Reopening a session restores the saved sidecar list only. The user must
   render and inspect again to obtain a current working report.
8. Provide an explicit clear-history action. It deletes all saved delivery
   sidecars while preserving mastering sessions, source audio and references;
   this also lets the user recover from an unsupported or damaged report row.

## Consequences

- Checked external-delivery reports survive a page reload on the same device.
- IndexedDB quota can prevent a report from being retained; audio already
  delivered remains valid, and the in-memory JSON download action remains
  available until the workspace closes.
- Deleting an external session also deletes that session's report history.
- Users can clear report history independently without removing session audio.
- Each history entry exposes its saved timestamp and originating session revision.
- Project-master analysis reports and live render buffers remain runtime-only.
- The database version changes independently from the external session record
  schema, which remains version 2.

## Validation contract

- Database version 3 sessions open unchanged after the version 4 upgrade.
- New reports survive repository close/reopen and appear in the workspace
  history with their original source/output names, saved timestamp and session
  revision.
- The history retains at most six distinct reports; same-session/name exports
  replace, and the oldest report is pruned after a seventh distinct output.
- Deleting a session removes only its reports and leaves other sessions'
  reports intact.
- Clearing report history removes sidecars while preserving sessions, source
  blobs and references.
- Invalid JSON, unsupported report schema, mismatched session/source identity,
  and oversized report records are rejected without blocking source-session
  loading.
- A storage quota failure leaves the checked audio download successful and
  exposes a clear warning while the report remains downloadable in memory.
