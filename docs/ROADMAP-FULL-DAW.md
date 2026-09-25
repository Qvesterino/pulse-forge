# KYX full-DAW delivery roadmap

**Status:** active product goal, started 2026-09-25  
**Charter:** `docs/adr/0014-full-daw-scope.md`  
**Baseline and gaps:** `docs/DAW-CAPABILITY-AUDIT-2026-09.md`

This is a staged product completion plan, not a promise that every phase ships
today. Keep Web and Studio capabilities separate in the support matrix. A
feature is “done” only when its project contract, UI, recovery, tests, hardware
evidence and release documentation agree.

## Phase 0 — make the target and baseline truthful

- [x] Owner changes the goal from focused beat workstation to full production
      DAW.
- [x] Record the product decision in ADR 0014 and capture current gaps.
- [x] Reconcile README/VISION/AGENTS/architecture language and identify dirty
      workspace changes before feature work is integrated.
- [ ] Establish an owner-approved Studio support matrix: Windows version,
      reference PC, audio interface(s), driver mode, sample rates and buffer sizes.

**Exit:** no contradictory scope claims; one reproducible current-state audit;
reference hardware is available for honest capture/latency gates.

## Phase 1 — instrument-ready capture using the existing recorder

- [x] Present the feature as **Audio Input / Instrument Recording**, not a
      vocal-only path; preserve microphone use as one of the supported sources.
- [x] Show worklet-confirmed captured channels/sample rate and available
      browser-reported track settings/channel range; state that Web capture can
      limit or remap channels and does not prove physical interface routing.
- [x] Add a Chromium end-to-end test with distinct synthetic stereo channels;
      verify worklet capture, durable PCM frame/block counts, timeline placement
      and project reload; exercise restoring an interrupted multichannel take
      from its persisted recovery state. These are software-path checks, not
      hardware routing, renderer-process-crash, guitar-input or latency
      certification.
- [ ] Verify the reported channel layout and stream settings on a real interface.
- [x] Document browser/Electron physical-input smoke steps for guitar/line-in,
      direct monitoring, clipping, permission denial, device removal and recovery.
- [ ] Execute the physical-input smoke test on a declared reference interface.
- [ ] Fix any discovered record-placement, channel-layout, project-swap or
      export-parity defects before expanding simultaneous capture.

The physical test procedure is [AUDIO-INPUT-HARDWARE-QA.md](./AUDIO-INPUT-HARDWARE-QA.md).

**Exit:** an instrument take is recorded from a real interface, recovered after
an induced interruption, edited as a normal AudioClip and heard unchanged in
live and offline export. Publish the verified Web capability table.

## Phase 2 — Windows Studio audio-device backend

- [x] Build and run a metadata-only WASAPI preflight on the present UA Volt 276
      endpoints; it records capability results but does not start an audio stream.
- [ ] Run stream-level WASAPI shared/exclusive and ASIO tests with explicit
      consent to temporarily initialize/use the physical audio endpoint.
- [ ] Write ADR 0015 after a measured technical spike compares Web Audio,
      WASAPI shared low-period/`IAudioClient3`, WASAPI exclusive and ASIO.
- [ ] Define a typed audio-device backend contract: enumerate/select device,
      input/output channel map, format negotiation, buffer/period, clock position,
      start/stop, device loss, xruns, latency and diagnostics.
- [ ] Benchmark whether a native I/O backend can preserve the shared project,
      transport, command and offline-render invariants. Do not use main-thread PCM
      messaging as the realtime solution.
- [ ] Keep browser Web Audio as its own backend and fallback; never silently
      change from the user-selected physical input to the system default.
- [ ] Choose the ASIO SDK route (GPLv3 or proprietary); do not infer the
      product's license from `package.json`'s private-package flag.

Current host evidence and probe limits are in
[WINDOWS-AUDIO-SPIKE-2026-09.md](./WINDOWS-AUDIO-SPIKE-2026-09.md).

**Exit:** stable 48 kHz capture/playback and duplex monitoring on the declared
Windows reference devices, with measured round-trip latency, recoverable
device-loss behavior, no sustained dropouts in a 30-minute soak and explicit
shared/exclusive fallbacks. Record raw measurements with each test result.

## Phase 3 — multitrack recording, takes and comping

- [x] Route two channels from one browser capture onto separate mono timeline
      tracks; persist the channel map for interrupted-take recovery; share one
      PCM asset and place/remove the routes as one undoable edit. This proves
      software routing only—the channel order is not verified against physical
      interface connectors.
- [ ] Extend from one active capture to several simultaneously armed capture
      streams, with per-track input monitoring modes and explicit source maps.
- [x] Preserve source-channel identity and timeline placement through durable
      block staging, recovery, project reload and channel-specific playback.
- [ ] Add punch-in/out and loop recording that retains every pass as a take.
- [ ] Add take lanes, audition, non-destructive comp selection/crossfades,
      consolidate and undo/redo.
- [ ] Add quota preflight, session recovery and multi-hour/forced-crash tests.

**Exit:** record at least eight independently routed mono channels (or four
stereo pairs) simultaneously for 30 minutes at 48 kHz on the reference host;
prove every channel's sample/frame count and placement; no silent fallbacks or
data loss; complete loop-punch-take-comp workflow with exact undo/redo.

## Phase 4 — desktop plugin ecosystem

- [ ] Prototype a VST3 scanner/host outside the UI process; blacklist crashes
      and timeouts; never load untrusted plug-in code in the renderer.
- [ ] Implement plug-in identity/version, state save/restore, parameter
      automation, sidechain/channel layouts, bypass, PDC and project portability.
- [ ] Define offline render and freeze semantics. If a plug-in cannot render
      offline, clearly require/furnish a real-time bounce before export.
- [ ] Gate each plugin format on compatibility tests across a representative
      suite; add AU only with a supported macOS host.
- [ ] Record the SDK license, trademarks, redistributables and support policy.

**Exit:** project reopen restores plug-in state; latency compensation and
automation are measured; plugin crashes do not corrupt KYX projects; real-time
and offline/frozen output has a documented parity guarantee.

## Phase 5 — AI producer and sound engineer

- [ ] Keep a testable brief contract: hard requirements, preferences, protected
      tracks/ranges and explicit edit scope.
- [ ] Expose whole-song/section variants and A/B audition before apply.
- [ ] Attach evidence to mix/audio suggestions, show the expected trade-off,
      audition the change, then commit through one reversible command.
- [ ] Build a human blind-listening benchmark against the current baseline;
      keep heuristic-teacher agreement distinct from actual musical preference.
- [ ] Download larger ONNX model packs only on explicit request with size,
      license, hash, progress, cancellation, cache and offline fallback.
- [ ] Keep MRT2 optional and platform-tiered; never upload a user's live input
      or project audio by default.

**Exit:** supported brief constraints pass the golden suite; a blinded human
benchmark demonstrates a repeatable preference improvement over baseline;
model absence, download failure or MRT2 unavailability never blocks core DAW
use.

## Phase 6 — release-grade Studio and Web support matrix

- [ ] Add real Windows interface/driver/device-change tests and installer,
      recovery and auto-update recording checks.
- [ ] Automate supported Chromium/Firefox/Edge paths; complete manual
      Safari/iOS recording/export tests before claiming those targets.
- [ ] Verify CPU, memory, disk throughput, bundle size, model cache, project
      load/save, stems and long sessions on minimum reference hardware.
- [ ] Publish “tested”, “supported”, “experimental” and “unsupported” distinctly.
- [ ] Run all unit, browser, hardware, packaging, security/license and deployed
      smoke gates from a clean release candidate.

**Exit:** reproducible release candidate; no unresolved release-blocking
failures; tested platform/device matrix published; install, update, recording
recovery and project interchange proven.

## Immediate next engineering task

Finish Phase 0's doc reconciliation and select the Phase 1 physical audio
interface/reference host. Then audit the existing recorder against an actual
guitar/line input. The software channel-split slice is in place; do not claim
physical input routing or reference-interface readiness until the hardware
procedure confirms connector-to-channel mapping and measures its clock.
