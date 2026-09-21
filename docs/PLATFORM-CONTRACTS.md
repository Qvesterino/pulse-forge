# PLATFORM CONTRACTS

> **Cross-platform readiness campaign — GOAL 03 deliverable** (2026-09-21).
> Narrow, platform-neutral contracts for the capabilities that genuinely vary
> across Web / Electron / a future Android–iOS host. Each entry states
> responsibilities, inputs, outputs, error model, lifecycle, cancellation and
> capability limits. Companion: `docs/PORTABILITY_MAP.md` (where the coupling
> lives), `CAMPAIGN_STATE.md` (ledger).
>
> Principle: **do not abstract what does not vary.** The project model,
> commands, intent pipeline, export encoders and share codes are already
> pure (GOAL 02) — they need no contracts. Everything below is the complete
> set of seams a non-browser host must implement or configure.

---

## 1. Storage — `src/persistence/contracts.ts`

**Responsibilities.** Durable per-topic storage for the app's 11 data
families (projects, snapshots, presets, kits, groove pool, MORPH/Ultina
presets, frozen audio, recording recovery, library state, user samples).
Each `I*Repository` interface freezes the public surface of its concrete
IndexedDB class; `PersistenceContracts` bundles them as one injectable
backend object.

**Inputs/outputs.** Plain serializable records and byte arrays; AudioBuffers
only where a repo materializes PCM (`IRecordingRecoveryRepository
.materializeStoredSample`).

**Error model.** Methods resolve or reject with the raw storage error. Quota
exhaustion and corruption surface as rejections — best-effort callers
(autosave, recovery prune) catch at their own boundary; the repos never
swallow.

**Lifecycle.** Constructors may open lazily; `openDatabase` constructor
injection is the alternative-backend/test seam (present on
FrozenBuffer/RecordingRecovery/Library; generalize as needed). No teardown
contract — IndexedDB connections are process-scoped.

**Cancellation.** None. IndexedDB transactions run to completion;
`forEachChunk` is bounded by store size.

**Capability limits.** Per-store caps are observable contract (snapshots per
project, recovery prune age, chunk counts) — an alternative backend must
honor them to stay behavior-identical.

**Current implementation.** Raw IndexedDB behind the single `db.ts` choke
point (`openDb`, DB_VERSION 12, hardened `tx()` wrapper).
**Native implementation.** SQLite/Realm/filesystem classes implementing the
same interfaces; thread via `PersistenceContracts` at the composition root
(`createCoreServices`).

---

## 2. Asset URL resolution — `src/shared/assetUrls.ts`

**Responsibilities.** Map root-absolute static-asset paths (worklet bundles
in `public/`, ONNX models, ORT wasm, curated samples) to fetchable URLs.

**Inputs/outputs.** `assetUrl("/models/x.onnx") → string`. Default: identity
(zero behavior change). `configureAssetBase("/studio")` prefixes every path
(subpath hosting, CDN, packaged-resource roots).

**Error model.** Pure string mapping — none. Fetch failures stay with the
fetcher.

**Lifecycle.** Hosts call `configureAssetBase` once at boot, before any
worklet/model/sample load; later changes affect only new loads.

**Cancellation / limits.** n/a / no per-asset split — extend the config, do
not fork call sites.

**Current implementation.** `audio-worklets/loader.ts` (6 worklet URLs),
`PcmMicRecorder` (capture worklet), `ranker-worker`/`prior-worker` (ORT
wasm), `semantic-client`/`audio-client` (manifest probes).
**Native implementation.** Point the base at packaged resources; the
Electron `app://` scheme needs no change (standard-scheme origin already
resolves root-absolute URLs).

---

## 3. Audio decode — `src/services/audio-decode.ts`

**Responsibilities.** Bytes → `AudioBuffer` for the storage/library layers
(user sample restore, frozen-track restore, curated bank) WITHOUT requiring
Web Audio in the data layer.

**Inputs/outputs.** `decodeAudioData(bytes, sampleRate = 44100)`. Web
default: throwaway `OfflineAudioContext` (decode resamples to the context
rate — observable contract). Injection: `setAudioDecoder(fn)`.

**Error model.** Rejects with the underlying decoder error on malformed
bytes; rejects with a clear "No audio decoder available" when the platform
has neither Web Audio nor an injection.

**Lifecycle.** Inject once at boot, before first restore. **Cancellation.**
None (decode is atomic). **Limits.** Codec support = host decoder's.

**Current implementation.** `FrozenBufferRepository`, `UserSampleRepository`
and `sample-library/curated.ts` delegate here (identical previous behavior).
**Native implementation.** Inject the platform codec wrapper.
**Deliberately out of scope:** `RecordingRecoveryRepository
.materializeStoredSample` — it *creates* an empty buffer from raw PCM
(allocation, not decode) and keeps its own platform guard.

---

## 4. Save / export (file handoff) — `src/export/download.ts`

**Responsibilities.** Hand a produced artifact (Blob + suggested filename)
to the host's save/download flow. THE single seam — project JSON, WAV, MIDI,
packs and favorites all funnel through `downloadBlob`.

**Inputs/outputs.** `(blob, filename) → void` (fire-and-forget; the browser
download bar is the only feedback).

**Error model.** None surfaced — DOM-throwing hosts fail loudly; Electron
intercepts via `will-download` → native Save-As.

**Lifecycle/cancellation.** Per-call; 5 s delayed object-URL revoke is part
of the contract (Safari needs the URL alive past the click). Not
cancellable.

**Limits.** No progress, no overwrite prompt (host's job).
**Native implementation.** Replace the one function with a native save
dialog / share sheet.

---

## 5. Audio host & time (existing, documented)

- **Context ownership:** `AudioEngine.useContext(ctx)` is the only place
  context creation + graph rebuild happen; the offline renderer hands the
  engine an `OfflineAudioContext` (ADR 0003/0009). A port must provide the
  equivalent context lifecycle (create / resume-on-gesture / rebuild after
  loss).
- **Transport time:** `Transport` takes a `Clock` (`{ now(): seconds }`);
  production injects `{ now: () => engine.currentTime }`. Pure elsewhere.
- **Scheduler host:** `SchedulerDeps` (trigger/noteOn/automation/midi/
  contextState) is the complete audio-host port — already driven headless
  in tests.
- **Second live contexts (by design):** intent audition previews and video
  export hold their own contexts; audition rebuilds after context loss.
  A port with per-app audio sessions must route these through the engine
  or give them the same lifecycle.

## 6. Worker degradation (existing)

Every worker client (`src/ai/*-client.ts`, `src/audio-workers/*-client.ts`,
`src/analysis`, `src/reference`) guards `typeof Worker === "undefined"` and
falls back to the pure sync core, with job-id + timeout + circuit-breaker
wrapping. **Contract:** a platform may omit workers entirely; features
degrade, never crash. Messages are validated before processing (repo-wide
defense pattern).

## 7. Networking / collab (existing)

No raw sockets in `src/` — y-websocket + BroadcastChannel behind
`CollaborationProvider`. Endpoints derive from `location` and any
user-supplied `?server=` MUST pass `isAllowedServerUrl` (`collabShared.ts`)
— a security contract, not a suggestion. **Native implementation:** inject
endpoint config; re-host the two transports.

## 8. Permissions & device access (existing)

Mic permission is inferred from `getUserMedia` error names with
user-facing mappings (`PcmMicRecorder`); MIDI is `requestMIDIAccess`
try/catch (feature-absent on failure); no `navigator.permissions` usage.
**Native implementation:** map the host permission model onto the same
error-name semantics.

## 9. Platform detection (existing)

`window.kyxDesktop.isDesktop` (Electron preload — the only sanctioned shell
bridge) + 30+ fail-soft `typeof` guards (AudioContext, OfflineAudioContext,
MediaRecorder, Worker, navigator.MIDI, location). **Contract:** feature
detect, never UA-sniff (the single UA use is a benchmark label).

---

## Non-goals (verified — no contracts needed)

Project model / commands / intent pipeline / export encoders / share codes
(pure since GOAL 02, pinned by `tests/domain-purity.test.ts`); File System
Access API (unused); WebGL/OffscreenCanvas (unused); notifications, share
sheet, wake lock, background sync (unused today — add contracts only when a
feature needs them).
