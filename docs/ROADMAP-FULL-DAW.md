# KYX full-DAW delivery roadmap

**Status:** active product goal, started 2026-09-25  
**Charter:** `docs/adr/0014-full-daw-scope.md`  
**Baseline and gaps:** `docs/DAW-CAPABILITY-AUDIT-2026-09.md`

This is a staged product completion plan, not a promise that every phase ships
today. Keep Web and Studio capabilities separate in the support matrix. A
feature is “done” only when its project contract, UI, recovery, tests, hardware
evidence and release documentation agree.

## Competitive gap-closure order

The comparison with Music Maker and Samplitude Pro X8 is a prioritization aid,
not a feature-count contest. KYX should first become trustworthy for recording
and editing real audio; bundled content and AI are differentiators, not
substitutes for that studio foundation.

1. **P0 — Studio foundation (Phases 0–2):** choose reference hardware, prove
   Windows device I/O, routing, monitoring, latency and device-loss behavior.
2. **P0 — Record and edit (Phase 3):** multitrack capture, safe recovery,
   punch/loop takes, comping and precise non-destructive audio editing.
3. **P1 — Production workflow (Phase 4 and Phase 6 quality gates):** supported
   VST3 hosting plus dependable mix, metering and export behavior.
4. **P2 — Fast start and content discovery (Phase 5):** make loops, kits and
   templates quick to find and arrange; evaluate larger optional packs only
   with explicit size and license information.
5. **Differentiation, not a blocker:** continue quality-gated AI assistance
   alongside these stages, but do not let model work displace recording,
   editing or release reliability.

The practical target is selective parity: cover the Music Maker-style
loop-to-song workflow, and close Samplitude's core recording/editing gaps,
without claiming identical content libraries or every specialist feature.

## Execution roadmap — recommended order

This is the order for implementation and product decisions. It adds an
execution path to the phase backlog below; it does not mark work complete.
Dates are intentionally omitted until the reference hardware and stream
measurements make estimates credible.

| Order | Milestone | Main deliverable | Exit gate |
|---|---|---|---|
| 0 | Lock the reference setup | Confirm the recorded Windows 11 host and UA Volt 276 remain the reference, then publish the driver, channel map, sample rate, buffer settings, and initial Web/Studio support matrix | Another developer can reproduce the setup and the baseline records what is tested versus unverified |
| 1 | Qualify Windows audio I/O | Corrected shared-WASAPI capture diagnostics with MMCSS; measure software and physical duplex/loopback paths; test the registered ASIO driver; use exclusive mode only if needed and explicitly acknowledged | Raw measurements separate API-reported period and digital loopback estimates from physical round-trip latency; capture/playback stability, channel mapping, dropout and device-loss results support ADR 0016 |
| 2 | Implement the Studio audio backend | Device selection, explicit channel routing, format negotiation, monitoring, diagnostics, and device-loss recovery behind a typed backend contract | Reference setup passes the 30-minute stream soak; device changes never silently switch the selected input/output |
| 3 | Certify record → edit → export | Real instrument capture through takes, loop/punch, comping, non-destructive edits, save/reopen, undo/redo, and final export | Phase 3's reference-host channel-count and duration gate passes; edits and project audio survive reload and match the offline export |
| 4 | Complete release readiness | Explicit product/content/model licensing and privacy inventory, signed installer, update/recovery path, current release report, and published support matrix | A clean release candidate installs, updates, recovers projects, and passes the declared platform, security, licensing, and deployed-smoke gates |
| 5 | Add the desktop plug-in ecosystem | Isolated VST3 scanning/hosting, saved state, automation, channel layouts, PDC, and offline-render rules | The plug-in project reopens correctly; crashes are contained; latency and real-time/offline behavior are verified on the compatibility set |
| 6 | Improve first-session speed | Loop discovery, kits/templates, audition, and a short path from a new project to an editable exported beat | A first-time-user pilot completes the loop-to-song path, saves/reopens, and exports without data loss; record time-to-export and observed blockers |
| 7 | Expand AI assistance against listening evidence | Optional producer/mix assistance with reversible edits and a human blind-listening benchmark | Demonstrated preference or workflow improvement over baseline; unavailable models never block core DAW use |

Release-readiness work (licensing, signing, update/recovery, support claims)
starts alongside Milestones 0–3 so it does not become a last-minute project.
Public commercial claims wait for Milestone 4's evidence. Web Audio remains
the Web backend; Studio support is documented separately.

### Next implementation milestone

Start by confirming the reference setup in Milestone 0. The probe now supports
bounded concurrent shared streams and a short software render-to-WASAPI-loopback
estimate; those smokes do not measure physical round-trip latency or certify
recording stability. Next, repeat the corrected capture and loopback checks on
the reference Volt, verify physical channel routing and round-trip timing, then
test the registered ASIO path. Use exclusive mode only if a concrete requirement
remains unmet, with its explicit acknowledgement. Write ADR 0016 from the
measured results before committing to the native backend. If physical testing is
temporarily unavailable, continue the remaining software edit/recovery checks
without claiming hardware certification.

**Execution checkpoint (2026-10-12):** the probe rebuilt successfully and all
three focused CTest cases passed. Ten-second shared capture/render smokes, a
concurrent capture/render smoke, and short software render-loopback checks ran
on the current host's active endpoints. Concurrent stream startup/operation
passed. Digital render-to-loopback estimates were about 20.7 ms on the MSI
endpoint and 126.3 ms on Realtek; one Realtek run had a later discontinuity and
device-position gap, so it failed. Capture QPC shows the first microphone frame
about 502 ms after `Start` returns. The session does not enumerate the UA Volt
276 endpoint, so none of these results qualify the reference interface or
measure physical round-trip latency. A bounded rerunnable wrapper is at
`native/windows-audio-probe/run-shared-duplex.ps1`. See the [current audio-spike
recheck](./WINDOWS-AUDIO-SPIKE-2026-09.md#current-execution-recheck--2026-10-12).

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
- [x] Verify routed source-channel isolation through both the live AudioEngine
      trigger path and offline project export using distinct synthetic tones;
      this confirms software render parity, not physical connector mapping.
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
- [x] Build an explicitly opt-in WASAPI stream-test mode for one exact endpoint:
      bounded to 30 seconds, discards capture packets, renders silence only, and
      requires an extra acknowledgement before exclusive mode. This prepares
      the test harness; it is not evidence that any stream mode has passed.
- [x] Add a bounded shared-mode duplex smoke wrapper that starts capture and
      silent render concurrently on explicitly named endpoints; enforce a
      timeout and stop both probe processes on failure. This verifies concurrent
      stream operation only, not physical signal routing or round-trip latency.
- [x] Add an explicit WASAPI software render-loopback check: emit a short,
      low-level correlation burst, detect it from the render system mix, and
      estimate the digital render-to-loopback timing from QPC plus render queue
      padding. The result is endpoint-specific and never stands in for DAC/ADC
      or physical round-trip latency. Current default endpoints yielded
      preliminary 20.7 ms (MSI) and 126.3 ms (Realtek) estimates; one Realtek
      smoke failed its discontinuity/position-continuity gate.
- [ ] Rerun shared capture on the exact endpoint with MMCSS and corrected
      diagnostics; investigate later discontinuities, timestamp errors and
      device-position gaps. Measure physical round-trip latency and test the
      registered ASIO driver. Use exclusive mode only for a concrete unmet
      requirement and preserve its explicit acknowledgement.
- [ ] Write ADR 0016 after a measured technical spike compares Web Audio,
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
- [x] Request an exact browser capture channel count from 1–8 and route each
      requested channel to a distinct timeline track. Fail before recording if
      getUserMedia or the capture worklet cannot provide that exact count; never
      silently fall back to stereo. This is a software contract, not evidence
      that a specific interface exposes eight independently routed connectors.
- [ ] Extend from one active capture to several simultaneously armed capture
      streams, with per-track input monitoring modes and explicit source maps.
- [x] Preserve source-channel identity and timeline placement through durable
      block staging, recovery, project reload and channel-specific playback.
- [x] Add an explicit loop-pass capture mode: AudioWorklet-scheduled frame
      boundaries are committed atomically with each durable PCM block, and
      complete passes become selectable alternatives over one shared source.
      Pass seams are prequeued from the scheduler's lookahead at the exact
      transport audio time, retracted if the time map changes, and rejected if
      capture receives a seam after its frame. Playback wrap detection still
      runs on the 25 ms control cadence, so the transport loop itself is not
      yet sample-accurate and punch-in/out remains open.
- [x] Add single-pass punch-in/out from transport locators. Pre-roll/count-in
      audio is captured before the exact worklet punch-in marker and trimmed
      non-destructively; punch-out flushes at the exact input frame while
      transport playback continues for post-roll. The punch-in marker is
      committed with PCM and punch-out completion is durable for recovery.
      A synthetic Chromium E2E routes four punch channels to four tracks and
      verifies exact saved locator placement. This is software-path evidence
      only; native multi-stream capture and physical input routing remain open.
- [x] Show each source pass and the comp as waveform lanes aligned to the
      arrangement ruler; activate a pass with one undoable command while
      keeping all source clips. Drag a source lane to select an exact
      arrangement-tick region and apply it to the comp with one undoable
      command; source takes remain untouched.
- [x] Add isolated, cancelable offline audition for source and comp lanes.
- [x] Implement adjustable, tempo-aware crossfades at take-comp boundaries;
      keep both source passes immutable and make the overlap/fade curves
      deterministic in live and offline playback. The working-tree command and
      take-lane control are covered by synthetic tests for overlap/fades,
      repeated compatible edits, undo, audible layers, energy continuity and
      live/offline sample parity; real recorded material is not yet certified.
- [x] Replace metadata-only consolidation with a true offline-rendered asset
      saved through the user-sample store; preserve source takes and replace
      selected clips with one undoable command. A Chromium synthetic-tone E2E
      verifies IndexedDB sample/project save-reopen and pre/post-export
      sample-level parity. Captured-take consolidation and physical hardware
      remain unverified.
- [x] Verify repeated comp edits on captured PCM: a Chromium synthetic-input
      recording E2E creates a 120-tick musical crossfade, replaces an already
      comped region, checks source provenance through Undo/Redo and IndexedDB
      reopen, then proves the final 32-bit float WAV hash is unchanged after
      reload. This is durable software-path evidence, not a physical-device
      performance certification.
- [ ] Measure comp boundaries and musical crossfade continuity against
      sample-accurate captured input on supported hardware. The existing 3 ms
      warp-segment seam fade is a separate de-click and does not meet this
      gate.
- [ ] Close the pro-editing gap: verify sample-accurate clip boundaries and
      moves, non-destructive fades/crossfades, clip gain, undo/redo and the
      existing warp workflow on real recorded material. Do not duplicate
      existing trim/stretch features without first testing their limits.
- [x] Preserve fractional-tick audio split boundaries and advance the linear
      source window without bar rounding; add a 3 ms de-click fade at the seam.
      Forward warped splits now also map and crop the source window at the
      resolved warp boundary for both resample and stretch modes; the editor
      and renderer share stable duplicate-pin handling and the 64-segment cap.
      Reverse split windows now preserve the high/low source boundaries, and
      loop splits retain their trimmed loop region while advancing the right
      fragment's persisted phase. Unit tests cover resample/stretch source
      continuity, loop wrapping, schema migration and undo/redo; ProjectRepository
      save/load now verifies both split windows and the advanced loop phase;
      a Chromium OfflineAudioContext check verifies audible reverse direction
      and loop phase wrap. Real-material edit parity remains open.
- [x] Add an undoable, tick-range comp edit from transport locators. Keep source
      passes immutable, persist comp provenance, replace only the selected
      interval, and route comp AudioClips through shared live/offline playback.
      Current comp source mapping is limited to forward linear clips without
      warp/loop/pitch-preserving stretch; seams receive a 3 ms de-click fade.
- [x] Add direct take-lane region selection and one-command comping; validate
      the selected tick range and preservation of all source takes.
- [x] Add cancelable offline audition for each source/comp lane using an
      ephemeral project that isolates the take while preserving its track,
      group, send and master processing; audition never mutates the project.
- [x] Extend comp editing with adjustable musical crossfades. Synthetic tests
      cover the software behavior and live/offline parity; certify repeated
      edits and boundaries on real takes through save/reopen, undo/redo and
      final export. The rendered consolidation path is implemented, but its
      synthetic test is not evidence for real recorded material.
- [x] Add a Chromium integration fixture that records two distinct synthetic
      PCM passes through AudioWorklet capture, reloads them from IndexedDB,
      splits one restored pass at a PCM-frame-near arrangement tick and checks
      contiguous boundaries plus exact source-window offset, comps through the
      take-lane UI, adds and drags a warp pin on the captured-PCM comp, and
      checks its tick/time behavior through Undo/Redo and persistence. After
      comping, it loop-enables and splits another restored PCM fragment with
      the project commands; stable trimmed loop bounds, advanced phase and
      loop-only 32-bit float WAV hash parity after reopen are verified too.
      This certifies the synthetic software capture/edit/persistence/export
      path, not physical input routing or the musical quality of real takes.
- [x] Add runtime live take-lane audition as a non-destructive playback
      projection. Targeted scheduler, service-lifecycle and UI tests pass;
      Chromium verifies the actual buffer-source offset, resumed fade gain and
      audible selected take. Initial support is song-mode only, with transport
      looping disabled; reverse/loop/warp/stretch clips remain on stopped
      offline audition.
- [x] Translate IndexedDB quota failure during PCM append into a clear stop
      warning; stop capture and preserve all earlier committed blocks for
      recovery. This is not long-session certification.
- [x] Add schema-backed whole-take groups, undoable pass selection, and shared
      live/offline playback filtering. Automatic loop capture now feeds this
      foundation; the aligned lane overview and direct region comping are
      present, as are cancelable offline audition, adjustable musical
      crossfades, rendered consolidation and runtime live take-lane audition
      (ADR 0015); recorded-material/repeated-edit certification remains open.
- [x] Expose single-track alternate audio passes in the arrangement: record a
      new group or align a later pass to the active pass start, keep recovery
      metadata, and switch the active whole pass through an undoable command.
      This remains useful for independent sequential passes; punch-in/out and
      full recorded-material comp validation remains open; runtime live
      take-lane audition (ADR 0015) has targeted unit/UI and Chromium
      source-offset/fade-gain coverage.
- [x] Before the first PCM block, compare the browser's estimated free storage
      with a 30-minute target for the actual capture format and warn when
      headroom is low. This is approximate, advisory only; runtime writes still
      enforce quota and preserve committed blocks.
- [x] Add a Chromium E2E that captures synthetic stereo PCM, commits multiple
      IndexedDB blocks, crashes the renderer through CDP, reopens the same
      browser profile, restores both timeline routes, and confirms the staging
      session is removed. This is evidence for the Chromium renderer path; it
      does not replace renderer-process recovery checks on every supported OS.
- [ ] Add multi-hour capture soak tests.

**Exit:** record at least eight independently routed mono channels (or four
stereo pairs) simultaneously for 30 minutes at 48 kHz on the reference host;
prove every channel's sample/frame count and placement; no silent fallbacks or
data loss; complete loop-punch-take-comp workflow with exact undo/redo; perform
sample-accurate edits and hear the same result after project reload and offline
export.

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
- [x] Download larger ONNX model packs only on explicit request with size,
      license, hash, progress, cancellation, cache and offline fallback.
      Delivered 2026-09-26: `src/ai/packs/` (registry + download manager —
      SHA-256-verified streamed downloads from the pinned upstream release
      into the dedicated `pf:model-packs` Cache Storage bucket; a cancelled,
      failed or tampered download evicts itself, never half-installs) +
      `ModelPacksSection` UI card (HelpOverlay) with live progress and cancel +
      semantic client/worker load cache-first so an installed pack works
      offline in deployments that don't ship the dev-only `public/models/
    semantic/` folder. Registry hashes are pinned to the fetch script's
      manifest by `tests/model-packs.test.ts` (10/10). Companion ORT diet:
      the three unused wasm variants (asyncify/jsep/jspi, ~69.5 MB) left the
      repo — `sync-ort-assets.mjs` now copies only the variant the workers
      fetch.
- [ ] Keep MRT2 optional and platform-tiered; never upload a user's live input
      or project audio by default.

**Exit:** supported brief constraints pass the golden suite; a blinded human
benchmark demonstrates a repeatable preference improvement over baseline;
model absence, download failure or MRT2 unavailability never blocks core DAW
use.

### Music Maker-style fast-start and loop discovery (P2, after the P0 recording path)

- [ ] Audit the existing sample library, user-sample import and template flows
      before adding a second catalog or duplicating browser capabilities.
- [ ] Add a coherent loop workflow: audition without interrupting playback,
      discover by genre/BPM/key/tag, preview in project tempo/key where
      supported, and drag a loop into the arrangement with its metadata intact.
- [ ] Connect kits, presets, templates and scenes to quick-start paths so a
      new user can reach an editable song without first configuring a blank
      project. Keep generated content and imported loops distinguishable.
- [ ] Treat large or licensed sound packs as optional installs with declared
      size, source/license, progress, cancellation, offline availability and
      removal behavior. Do not bundle a large catalog until licensing and
      storage costs are clear.
- [ ] Test the loop-to-song journey end to end: preview, place, edit, save,
      reopen and export; verify preview and rendered asset identity, tempo
      behavior and undo.

**Exit:** a first-time user can discover, audition, arrange and export a loop-
based idea locally without breaking the transport or losing source metadata;
all bundled/downloaded content has a documented license and storage policy.

## Phase 6 — release-grade Studio and Web support matrix

- [ ] Add real Windows interface/driver/device-change tests and installer,
      recovery and auto-update recording checks.
- [ ] Automate supported Chromium/Firefox/Edge paths; complete manual
      Safari/iOS recording/export tests before claiming those targets.
- [ ] Verify CPU, memory, disk throughput, bundle size, model cache, project
      load/save, stems and long sessions on minimum reference hardware.
- [ ] Validate the mix/export bar with reference-track comparison, documented
      loudness targets, true-peak/inter-sample metering checks and repeatable
      export presets; keep mastering claims limited to tested behavior.
- [ ] Publish “tested”, “supported”, “experimental” and “unsupported” distinctly.
- [ ] Run all unit, browser, hardware, packaging, security/license and deployed
      smoke gates from a clean release candidate.

**Exit:** reproducible release candidate; no unresolved release-blocking
failures; tested platform/device matrix published; install, update, recording
recovery and project interchange proven.

## Immediate next engineering tasks

1. **Lock and publish the reference setup:** record the exact Windows host,
   interface, driver, channels, sample rate and buffer settings in the support
   matrix; update the capability audit with evidence and open gaps.
2. **Run the Windows audio spike:** use the bounded exact-endpoint probe,
   begin with shared WASAPI, and record latency, xruns/dropouts, channel mapping
   and device-loss/reconnect results. Compare other modes only for a specific
   unmet requirement; then write ADR 0016 and choose the backend.
3. **Build the selected backend and certify real material:** implement the
   device contract, then verify monitoring, recovery, takes, comp boundaries,
   non-destructive edits, undo/redo, save/reopen and live/offline export with
   physical recordings. Keep synthetic-browser evidence clearly labeled as
   software-path evidence.
4. **Run release-readiness work in parallel:** decide distribution and content
   licensing, prepare signed installation and update/recovery, and refresh the
   release report from a clean candidate. Do not publish platform, latency or
   commercial support claims without matching evidence.
5. **Continue in dependency order:** complete the multitrack gate, then VST3
   isolation/state/PDC and mix/export conformance; improve loop discovery and
   first-session speed; advance AI only against a human blind-listening
   benchmark.

Each milestone exits only on its listed evidence and tests, not implementation
completion alone. Update the capability audit and support matrix when evidence
changes; physical-device gates stay explicitly unverified until executed.
