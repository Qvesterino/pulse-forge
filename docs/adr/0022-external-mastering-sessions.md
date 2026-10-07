# ADR 0022 — External stereo mastering sessions

Date: 2026-10-07 · Status: Accepted · Scope: mastering sessions, local persistence, offline render

## Context

The MASTER workspace currently shapes the final output of a KYX project. A
reference WAV/MP3 can be imported for comparison, but it is deliberately
read-only: it cannot be mastered and exported as its own deliverable. The
full-DAW direction also requires a useful path for a stereo mix created in
another DAW.

## Decision

1. An external mix is an independent, local-only mastering session. Its
   original encoded source is immutable. Session state and source media live
   in a dedicated IndexedDB database, separate from KYX project documents,
   project undo/redo, collaboration, and the project sample library.
2. The first session schema stores versioned source-file metadata, the original
   Blob, a cloned `MasterConfig`, a monotonically increasing config revision,
   and bounded undo/redo config history. AudioBuffers and AudioNodes are
   runtime-only and never persisted. The current verified render/export report
   is runtime-only and must be recalculated after reopening. Schema changes
   require an explicit session migration.
3. Every session render uses the existing `renderProject()` and the same
   `AudioEngine`, master effects, worklet loader, master-chain order, quality
   bumps, latency preparation, and tail policy as a project render. The source
   is represented by one temporary, non-persisted arrangement AudioClip in a
   scratch document. The scratch document and isolated SampleBank are thrown
   away after rendering; the active project and its bank are never mutated.
4. The scratch timeline derives an internal tempo from the decoded source
   duration so the AudioClip ends exactly at the source duration. This tempo
   is an implementation detail and is not shown as session metadata.
5. Each source has a SHA-256 fingerprint, checked again when its session is
   reopened. Render and export refer to the current processing revision;
   changing settings invalidates the current in-memory render/report. The
   original file is never overwritten; exports create a new file.
6. Import limits, decoded-memory budget, supported channel layouts, codecs,
   and maximum duration are explicit and capability-checked. Oversize or
   unsupported input must fail with an actionable reason. Long-file streaming
   beyond the first supported limits is a separate acceptance gate; the
   320 MiB offline render budget remains in force.

## Consequences

- External masters do not need a project to be open and cannot modify one.
- Existing effect definitions and processor runtimes remain the only DSP
  implementation, preserving project/file master parity.
- The source Blob makes a session reopenable, but browser quota or eviction
  can prevent persistence; storage failures must remain visible and no render
  should claim that its source session was saved when the write failed.
- This ADR authorizes the session boundary and render route. The first
  bounded UI slice accepts WAV/MP3 up to 96 MiB and 12 minutes, decodes mono or
  stereo to 44.1 kHz, and rejects estimated working sets above 512 MiB. It
  reuses the full master `EffectRack` inside a session-only `ProjectStore`, so
  insert commands cannot reach the open project store. The session persists
  those edits as `MasterConfig.effects`; its settings Apply/Undo/Redo controls
  cover the full config. Named A/B snapshots of the complete session config
  persist locally; render buffers and audition state remain ephemeral. A/B
  comparison renders both versions through the same isolated source path and
  can attenuation-match the louder version for audition only. A separate
  IndexedDB object store holds one read-only WAV/MP3 reference per session;
  its SHA-256 is checked on reload, its audio is measured, and it is auditioned
  against the current render with preview-only loudness trim. It is not added to
  the scratch project, session source, or export. After a checked WAV export,
  the session can download a JSON report sidecar tied to the source hash,
  processing revision, delivery profile, render measurements and encoded-file
  inspection. The report is not automatically persisted in IndexedDB and
  contains no audio. The session report surface presents LRA, short-term
  loudness timeline, stereo checks and Mix Doctor diagnostics from the decoded
  WAV when measured; otherwise it labels the source-PCM fallback and does not
  substitute source data for missing post-encode analysis. The bounded slice still does not provide streaming,
  automatic report persistence, or validated cross-browser length claims.

## Validation contract

- A source-only scratch render contains no musical clip, track, or return
  content and leaves the source project, master config, and SampleBank intact.
- At a neutral master config, the result is sample-aligned to the source and
  includes only the documented render tail; edits use the same master chain
  as project export.
- The encoded file is parsed and decoded/measured before download when the
  available browser decoder supports it; the browser acceptance test then
  imports the delivered WAV again as a new session.
- Session create, reopen, update, revision, delete, quota failure, import
  abort, render abort, and export abort are acceptance requirements; the
  current automated coverage is incomplete.
- Chromium E2E verifies external file import, isolated insert Apply/Undo/Redo,
  session-local reference measurement/audition, named A/B snapshot renders and
  audition, 24-bit PCM+BWF v2 export, encoded WAV parsing/decoded measurements,
  and re-import of the delivered WAV. Additional Chromium cases cover source
  and reference Blob reads, SHA-256 and decode cancellation, reference worker
  analysis, cooperative source PCM audit, session-restore cancellation/retry,
  source and reference IndexedDB quota errors, blocked storage permission,
  malformed WAV input, and UI cancellation during source/A-B rendering and
  WAV encode/post-encode inspection. Source/reference quota and blocked-storage
  errors also pass in Firefox. Cross-browser duration/memory limits and Safari
  on macOS storage/device behavior remain unverified.
- A focused Firefox Playwright project passes five external-session scenarios:
  the complete WAV import, render/analyze, 24-bit BWF export/decode and re-import
  path; source/reference quota errors; blocked database permission; and source/A-B
  render cancellation. It does not claim long-file, WAV-export cancellation or
  device-monitoring parity in Firefox.
- The Windows Playwright WebKit runtime lacks `AudioContext`; it shows the
  explicit Web Audio guidance screen and is not an external-mastering target.
  Safari on macOS requires a separate owner smoke test.
- Any supported-length claim is backed by real-browser duration and memory
  measurements on the named browser/OS profile.
