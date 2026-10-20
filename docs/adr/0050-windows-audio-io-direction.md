# ADR 0050 — Windows audio I/O direction

- **Date:** 2026-10-17
- **Status:** Accepted evaluation policy; native shared-WASAPI path implemented with hardware qualification open
- **Scope:** KYX Studio for Windows, with the UA Volt 276 as the first reference interface

## Context

KYX Web and the current Electron Studio use the same Web Audio engine. The
Studio I/O panel can select browser-visible input and output devices, report
the live context sample rate and latency fields, and run an output test tone.
Recording requests the saved input ID exactly, can request 1–8 capture
channels, and stops into durable recovery when the input track ends or mutes.
The saved browser output ID is reapplied whenever the live `AudioContext` is
replaced; an unavailable saved ID remains visible and is not changed to the
system default.
These are Web Audio capabilities; Electron does not yet own a native device
stream or a user-selectable hardware period.

The Windows probe evidence is intentionally bounded:

- On 2026-10-15, the Volt endpoints opened concurrently in shared WASAPI at
  48 kHz, stereo float32, with a 480-frame / 10 ms requested period and a
  1,056-frame / 22 ms endpoint buffer. The 30-second capture had one
  first-packet discontinuity and no later discontinuities, timestamp errors,
  device-position gaps, silent packets or timeouts; render queued silence.
  This did not verify physical connector mapping, audible input, monitoring,
  or analog round-trip latency. See the [Volt smoke record](../WINDOWS-AUDIO-SPIKE-2026-09.md#volt-shared-mode-smoke--2026-10-15).
- The Volt's `IAudioClient3` shared-period range was 480 frames for the tested
  format and audio category, so this evidence does not establish a lower
  shared-mode period on that endpoint.
- An exclusive-mode probe opened at the reported 3 ms minimum but had three
  later discontinuity flags and no MMCSS service-thread profile. It is not
  qualified for product use. Exclusive mode can also take the endpoint from
  other applications.
- The installed Volt ASIO registration was 32-bit-only in the 64-bit process
  probe. The fixture ASIO host and its soak prove the transport/host boundary,
  not the Volt driver. ASIO discovery and the fixture are documented in
  [ADR 0017](./0017-smpte-asio-discovery.md) and [ADR 0018](./0018-pcm-pipe-transport.md).
- Read-only endpoint enumerations on 2026-10-17 and 2026-10-19 did not find
  the Volt connected. A fresh metadata-only list at 2026-10-19 12:36 +02:00
  still reports all Volt capture/render endpoints as `not-present`; active
  capture endpoints are Creative Live! Cam Sync and Realtek Array, and active
  render endpoints are MSI MP273Q E2 and Realtek Speakers. The active endpoints
  report 48 kHz float32, with 480-frame shared periods except Realtek render at
  512 frames. AudioSrv and AudioEndpointBuilder are running. This probe only
  enumerates metadata and opens no stream. The 2026-10-15 result is retained as
  historical smoke evidence; no hardware stream was opened in these latest
  enumerations.

Microsoft documents `IAudioClient3` as the shared-mode API for querying legal
engine periods and initializing a stream at one of those periods. The period
must be within the reported range and aligned to the engine's fundamental
period. Invalidated endpoints require releasing the old client and attempting
to reactivate the selected endpoint; selecting a replacement is a user-visible
choice when the original device is gone. See
[IAudioClient3 shared audio streams](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient3-initializesharedaudiostream),
[Windows low-latency audio](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/low-latency-audio),
and [recovering from an invalid device](https://learn.microsoft.com/en-us/windows/win32/coreaudio/recovering-from-an-invalid-device-error).

## Decision

1. **Keep Web Audio as the current shipped device path and fallback.** The
   Studio UI must report browser capability limits honestly. A missing saved
   endpoint stays visible as missing; it is never silently changed to System
   default. Browser `baseLatency`, `outputLatency`, and WASAPI's reported
   stream latency are not presented as a measured acoustic round-trip result.
2. **Use WASAPI shared mode as the first native Windows streaming candidate.**
   It is the only path in this evidence set that completed a bounded concurrent
   Volt capture/render run. The product host must use `IAudioClient3` only with
   formats and periods returned as supported by the selected endpoint. The
   initial Volt support claim is 48 kHz shared mode; the 10 ms period is a
   measured endpoint constraint, not a KYX latency guarantee.
3. **Keep WASAPI exclusive mode opt-in and out of the release path** until a
   fresh test has explicit user consent, the correct MMCSS profile, repeatable
   dropout-free capture/render, and an audible recovery test. A 3 ms reported
   period alone is not evidence of low or stable round-trip latency.
4. **Do not select ASIO as the Volt default on this machine.** The detected
   Volt ASIO registration cannot load in the current 64-bit host. Reconsider
   ASIO after a usable x64 driver is installed and its licensing/distribution
   route is cleared. Discovery and fixture success do not count as hardware
   streaming support.
5. **Keep endpoint and channel intent explicit.** Input and output endpoints
   are separate selections. The host negotiates and reports the actual sample
   rate, sample format, input/output channel counts, period and buffer. A
   requested input channel count must either be satisfied exactly or fail
   before recording. Physical jack-to-channel mapping is a separate measured
   setup and is not inferred from the endpoint name or channel count.
6. **Device loss stops the selected stream; it never changes endpoint by
   itself.** The audio host reports an invalidated endpoint to Studio, closes
   its client and keeps already committed capture blocks available for
   recovery. The user may retry the same endpoint or explicitly select another
   endpoint. Stale buffers from a prior stream generation must not enter a new
   take.
7. **Do not route realtime PCM through React or ordinary Electron control
   IPC.** The audio callback boundary must use preallocated bounded buffers and
   report xrun/overrun counters. ADR 0018's framed pipe is already proven for
   source transport and renderer playback, but its tests do not establish a
   bidirectional, device-clocked AudioEngine path. The memory/clock bridge is
   an implementation gate, not an assumed property of the existing pipe.
8. **Use hardware direct monitoring when appropriate and label software
   monitoring honestly.** KYX cannot change the Volt's hardware monitor blend.
   Software monitoring stays optional and reports the device/context latency
   that is available; it is not described as zero-latency.

## Measurable implementation and qualification gates

- A typed backend contract must enumerate/select endpoints, negotiate format
  and period, select an exact channel map, start/stop duplex streams, report
  clock position, latency, xruns and errors, and support stop/retry after device
  loss. Project files may store user intent but never device handles or native
  audio objects.
- Before enabling native I/O in the product, test a real Volt signal on each
  intended input and output connector, verify channel identity with distinct
  left/right tones, and retain a 48 kHz shared-mode capture/render record.
- Run a 30-minute duplex soak on the selected physical configuration. Pass
  requires zero later discontinuities, timestamp errors, device-position gaps,
  event timeouts, non-finite captured samples and unreported xruns. Report the
  first-packet startup event separately.
- Measure acoustic round-trip latency through an analog cable loopback at the
  exact sample rate/period. Retain raw repeated measurements and p50/p95/max;
  do not substitute WASAPI `GetStreamLatency`, a software loopback estimate or
  a listening impression. If the measured software-monitor p95 exceeds 20 ms,
  label it high latency and recommend hardware direct monitoring until another
  mode passes the same measurement.
- Unplug the selected interface during capture and render. Pass requires an
  explicit error, no fallback endpoint, no duplicate/stale PCM after reselect,
  retained committed capture blocks, and a successful deliberate reconnect
  without restarting the project.
- Prove software input channel routing and offline render parity with distinct
  synthetic tones; separately prove physical channel identity with analog
  input. Keep the two evidence classes separate.

## Consequences

- **Electron PCM bridge runtime spike (2026-10-17):** Electron 44.4.3's
  packaged-style `app://` renderer did not expose `SharedArrayBuffer` until its
  document response received `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. The desktop protocol now adds
  those headers through `desktop/audio-isolation.cjs`; `npm run desktop:smoke`
  passed against `app://bundle`: the root mounted, `crossOriginIsolated === true`,
  `SharedArrayBuffer` was available, and no renderer/preload errors fired. A
  focused Electron probe also verified that a buffer created in an isolated
  preload stayed shared with the page through `window.postMessage`.
  Electron's `ipcRenderer.invoke` and main-to-renderer `webContents.postMessage` both
  rejected the buffer with `An object could not be cloned`; the existing
  main-process pipe-to-renderer-ring path is therefore invalid. A native N-API
  marker module, compiled with Electron's Windows delay-load hook, loaded in an
  Electron 44.4.3 runtime and wrote the same ring visible to the page. The
  delay-load hook is required by Electron's [Windows native-module contract](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules).
  This proved only technical possibility, not a selected product architecture.
  Loading that addon in renderer preload requires `sandbox: false`; Electron
  recommends renderer sandboxing and warns about unsandboxed renderers when
  untrusted content is present ([sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox),
  [security](https://www.electronjs.org/docs/latest/tutorial/security)). The
  later utility-process probe preserves the current renderer sandbox.
- **Sandboxed AudioWorklet ↔ utility-process PCM transport (2026-10-17):**
  Electron's [utility process](https://www.electronjs.org/docs/latest/api/utility-process)
  and [process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
  document a separate Node-capable process with MessagePort communication to
  renderers. The current desktop smoke now exercises that route without
  disabling the renderer sandbox: an actual silent AudioWorklet sends
  100 sequential 480-frame stereo Float32 blocks at 48 kHz through a dedicated
  `MessageChannelMain` pair to a utility process and validates each returned
  block. Electron 44.4.3 completed 100/100 with p95 and maximum measured
  AudioWorklet-frame round-trip of 2 ms and no renderer/preload errors. The
  utility returns synthetic marker blocks; this proves the transport seam only,
  not WASAPI capture/render, AudioEngine routing, analog latency or a sustained
  stream. Keep the renderer sandbox enabled and use this as the candidate host
  boundary for the next native WASAPI implementation.
- **Implementation checkpoint (2026-10-17):**
  `src/audio-engine/windowsAudioIo.ts` now defines the typed duplex contract
  for endpoint enumeration, exact endpoint/channel selection, format/period
  negotiation, float32 capture/render rings, session stop, device-loss events
  and xrun reports. Its seven contract tests reject endpoint/channel
  substitution, invalid IAudioClient3 shared periods and exclusive mode
  without explicit acknowledgement. `native/windows-audio-probe/main.cpp`
  supports a metadata-only `--list-json` mode that enumerates all Core Audio
  endpoint states without opening streams. Active endpoints now include their
  current engine mix format (including container/valid bits) and queried
  `IAudioClient3` shared-period range when available. Range metadata is not
  rejected merely because its boundaries are not fundamental-period multiples;
  alignment is enforced on the requested stream period during negotiation.
  `desktop/windows-audio-devices.cjs` bounds and validates the
  v2 response before a narrow preload API exposes it in the Studio I/O panel.
  The UI labels these as current mix diagnostics, not a full supported-format
  list. This does not drive native stream selection. This does not add a
  Windows adapter or change the product support status; native I/O remains not
  shipped. The diagnostic's explicit bounded stream test now also accepts the
  exact opaque endpoint ID from enumeration; unit checks prove an ID never
  falls back to a matching name. The Windows probe's five CTest checks pass,
  including exact-ID and no-name-fallback selection. The product still has no
  user-available native stream control.
- **Browser output lifecycle (2026-10-17):** `IoPanel` subscribes to live
  `AudioEngine` context changes and reapplies the exact saved browser sink to
  each replacement context. Application calls are serialized so a delayed
  earlier sink request cannot override the most recent selection. The real
  panel lifecycle test verifies the same output ID is applied before and after
  context replacement; this remains browser/Web Audio routing, not native
  WASAPI selection or acoustic latency evidence.
- **Channel-map primitive (2026-10-17):** `native/windows-audio-host` now has
  bounded float32 helpers that copy selected input channels into project order
  and route project output channels to selected endpoint channels, clearing
  unused endpoint outputs. Validation rejects duplicate/out-of-range maps,
  oversized channel counts, invalid buffers and overlapping source/destination
  buffers before writing. The Windows C++ target builds with MSVC and its CTest
  check passes its channel-map cases. The WASAPI adapter core below now uses
  this mapping; the utility-process smoke does not start a real stream, and the
  product PCM bridge and AudioEngine do not use it yet. Native I/O remains not
  shipped.
- **Bounded PCM ring (2026-10-17):** the same target now includes a preallocated
  interleaved float32 SPSC FIFO with fixed power-of-two frame capacity, a 32 MiB
  per-direction memory ceiling, all-or-nothing writes and lock-free 64-bit indexes. Its CTest
  check covers wraparound, full-ring rejection, invalid configurations and a
  100,000-frame concurrent producer/consumer sequence. The adapter core below
  uses these rings; the product PCM bridge does not use them yet.
- **WASAPI duplex adapter core (2026-10-17):**
  `WasapiSharedDuplexSession` now opens exact active capture and render IDs,
  verifies endpoint flow, requires an exact float32 shared format and a period
  legal for both endpoints, then runs event-driven capture and render on one
  MMCSS service thread. It maps input/output channels through the bounded
  helpers, queues PCM through the fixed SPSC rings, reports stream latency and
  xrun/discontinuity counters, and stops on endpoint loss without selecting a
  replacement. A new session is required for an explicit retry. The Windows
  MSVC build succeeds and all four CTest targets pass; the duplex request test
  also proves an unknown endpoint ID fails without opening another stream.
  This is a native adapter core, not a shipped device path. It supports exact
  float32 shared mode only, has no separate-device clock-drift correction, and
  has no real Volt stream evidence. No latency or monitoring support claim
  follows from the successful build.
- **Electron N-API smoke (2026-10-17):** the native target now builds an
  Electron 44 Node-API module and packages it as a Windows extra resource. The
  desktop smoke loads it inside the existing isolated utility process, creates
  a session with deliberately nonexistent endpoint IDs, and confirms that the
  request fails without falling back to another device. The smoke still sends
  only synthetic PCM through the MessagePort. This does not open a real device
  or connect the WASAPI rings to AudioEngine/worklets, so native I/O remains
  **not shipped**. No latency or monitoring support claim follows from the
  smoke.
- **PCM process-boundary check (2026-10-17):** Electron 44.4.3's direct
  `utilityProcess.postMessage()` rejects a `SharedArrayBuffer` with
  `An object could not be cloned`. Across the renderer-to-utility MessagePort,
  an ordinary control ping arrived, the following SAB payload did not arrive,
  and the ordered follow-up ping did. The smoke therefore records shared-memory
  transport as unavailable across this boundary. The 100-block copied-
  `ArrayBuffer` AudioWorklet round-trip passed, but observed p95/max ranged from
  2/2 ms to 121/171 ms across runs; that variability is not a low-latency
  qualification. The typed contract uses bounded 1 MiB maximum PCM packets
  over a dedicated MessagePort.
- **AudioEngine integration checkpoint (2026-10-19):** the packaged Windows
  Studio now connects the exact-endpoint shared-WASAPI utility session to the
  live `AudioEngine` master through a bounded AudioWorklet packet bridge. The
  utility drains render packets to the native SPSC ring and copies native
  capture into preallocated, recycled packets; the worklet routes captured PCM
  through a `MediaStreamDestination` used by arrangement recording. The live
  output sink is scoped to the current `AudioContext`; offline rendering stays
  on the shared engine's ordinary offline destination. Selected endpoint IDs,
  sample rate, shared period and mono/stereo input plus stereo output channel
  maps are validated with no fallback. Device loss or context replacement
  stops the native session and keeps the live output muted until the user
  explicitly stops/retries, while active recording enters the existing recovery
  path. `npm run build:windows-audio-host` and the C++ channel-map, bounded-ring,
  shared-period and duplex-request checks pass. This completes the product
  connection, not hardware qualification: the Volt 276 endpoints were not
  present in the 2026-10-19 metadata-only enumeration, and the older 2026-10-15
  hardware smoke predates this connection. The current integration has no
  sustained device-clocked measurement through the AudioEngine/worklet/MessagePort
  path, no analog loopback result, and no independent endpoint clock-drift
  correction.
- **Offline AudioWorklet PCM smoke (2026-10-19):**
  `npm run test:browser:windows-audio-worklet-bridge` passes in Chromium using
  an `OfflineAudioContext`, a project-synchronized AudioEngine master graph,
  a synthetic 48 kHz / 480-frame session and a `MessageChannel`. Six render
  packets reached the bridge; five carried non-zero post-master audio (maximum
  packet RMS 0.0826). Six of six capture packets reached the offline output
  (RMS 0.178). The bridge reported six render periods, zero render drops, zero
  invalid or dropped capture packets and an empty in-flight render pool after
  acknowledgement. This verifies the offline AudioEngine master signal path
  into the public AudioWorklet and the capture/packet mechanics. The offline
  test reconnects the master output directly because the production
  `setLiveAudioOutputSink` contract deliberately requires a live context. It
  does not exercise that live sink method, the Electron utility process,
  WASAPI, device clocks, live scheduling or physical latency.
- **Native recording disconnect recovery (2026-10-19):**
  `tests/pcm-mic-recorder.test.ts` builds the native capture-stream connection,
  commits a PCM block, injects the bridge's `device-lost` event, then verifies
  that recording stops and the committed block remains in a recoverable
  session. This covers the software event path; it does not verify physical
  device removal or driver recovery.
- **Packaged desktop smoke (2026-10-19):** `npm run desktop:smoke` passes on
  `app://bundle` with the renderer sandbox and cross-origin isolation enabled.
  The synthetic 48 kHz / 480-frame probe ran for 30 seconds and delivered
  3,000/3,000 packets with zero missing packets; measured median/p95/maximum
  round-trip was 0.667/2/2 ms in this run. The native addon rejected
  deliberately unknown endpoint IDs without substitution. SharedArrayBuffer
  did not cross the utility boundary, so this continues to use copied
  ArrayBuffer packets. The result verifies synthetic transport and exact-ID
  failure behavior only; it does not qualify real endpoint timing, AudioEngine
  packet jitter under a device clock, acoustic latency or audio output.
- **Device-clocked native adapter soak (2026-10-19):** the built N-API adapter
  was run directly against the active Creative Live! Cam Sync capture endpoint
  and MSI MP273Q render endpoint, using exact IDs, 48 kHz float32, a 480-frame
  period, and zero-valued render buffers. Two 30.2-second sessions started in
  234/285 ms and each accepted 3003/3003 render writes. They reported 0/1
  render underruns, 0 capture overruns, 1 capture discontinuity per run, 0
  timestamp errors, 0 rejected writes, and 0 non-finite captured samples.
  Maximum queued capture/render frames were 480/1920; each endpoint negotiated
  a 1056-frame buffer (22 ms at 48 kHz). The adapter surfaced no positive
  `GetStreamLatency` values. Captured audio was only counted and was not saved.
  This is native-adapter evidence only: it does not measure the
  AudioEngine/worklet/MessagePort path, analog latency, Volt channel identity,
  device-loss recovery, or the required 30-minute Volt soak.
- **Integrated utility/AudioWorklet smoke (2026-10-19, failed qualification):**
  an opt-in Electron smoke now opens exact active endpoints through the
  production utility host and public AudioWorklet bridge. It sends zero-valued
  render data and counts capture only; samples are not saved. On the Creative
  webcam microphone + MSI display output at 48 kHz / 480 frames, the first
  30-second run negotiated a 1,056-frame endpoint buffer and processed 3,113
  worklet render periods with zero worklet drops or utility rejections, but
  reported one WASAPI render underrun, one capture discontinuity, and only two
  capture packets (960 frames) across the run. `GetStreamLatency` remained
  unavailable, and shutdown required terminating the owned utility process.
  The run is not a pass and does not use AudioEngine master audio or qualify
  physical latency. It exposed and fixed the capture-output connection index,
  the non-power-of-two ring capacity, and unsupported `ArrayBuffer` transfer
  lists on Electron `MessagePortMain`; PCM now uses copied bounded packets with
  sequence acknowledgements for the fixed pools. A subsequent run after adding
  the worklet-ready handshake stalled inside native WASAPI startup for more
  than 20 seconds and never became ready. The Volt was absent, so these tests
  used other active endpoints and do not establish its channel map. Native
  startup snapshots now expose the last WASAPI phase and direction through
  utility diagnostics. Instrumented attempts with the active MSI render
  endpoint stalled at different calls on the input side: Realtek Array reached
  `capture/starting-audio-client`; Creative Live! Cam Sync first remained at
  `capture/initialize-shared-stream`, then after AudioSrv recovery reached
  `capture/starting-audio-client`. The utility now reports the last phase and
  terminates its isolated process after a 7-second native-start timeout. One
  post-recovery attempt exercised this watchdog at 7.17 seconds; AudioSrv
  remained running, the active endpoints enumerated again, and no new service
  hang was recorded during the following two minutes. The run sent silence
  and saved no captured audio. Windows logs contain four AudioSrv AppHang /
  unexpected-termination events at 10:14, 10:58, 11:11 and 11:26 (one
  cross-process report references `audiodg.exe`). The 11:26 smoke found its
  selected capture endpoint inactive before stream initialization; the
  matching WER event records another AudioSrv hang. A manual `Start-Service`
  attempt failed because this session could not open the service. At
  2026-10-19 11:32:39, metadata-only enumeration confirmed Windows had
  restarted AudioSrv and restored active endpoints: Creative and Realtek
  capture, MSI and Realtek render. All reported 48 kHz float32; the active
  shared periods were 480 frames except Realtek render at 512 frames. The
  Volt endpoints remained `not-present`. This read did not open a stream, and
  no later AudioSrv event was present at 11:32. The repeated service hangs
  remain unexplained; the records do not identify the root cause or one
  specific client call.
- The startup watchdog remains armed while the native start promise is pending,
  including after a stop request. This covers renderer teardown during a stuck
  driver call; a completed or replaced session cancels the watchdog. Focused
  watchdog and utility-manager tests pass. Synthetic utility-host lifecycle
  tests now also cover Stop before worklet attachment, clean stop of a running
  session, native Start rejection and Stop while native Start never settles on
  both capture and render endpoint Start phases; these cases verify endpoint-
  specific timeout reporting and termination of the isolated utility. The
  2026-10-20 synthetic cases additionally cover native Start resolving after
  Stop without publishing `ready`, and runtime device-loss forwarding with
  native cleanup, timer cancellation and utility exit. The
  manager test verifies that an unexpected utility exit clears the
  active session and permits a retry through a fresh host. The AudioEngine
  bridge test injects its two-second missing-status error and verifies capture
  teardown plus restoration of normal master output on Stop. A native lifecycle
  review found that the N-API start worker could overlap JavaScript Stop while
  both touched the same `std::thread`; worker creation now shares the startup
  lock with Stop, and every join is serialized through a dedicated mutex. A
  CTest case overlaps Stop with startup using nonexistent exact endpoint IDs,
  so it opens no physical stream. This lifecycle evidence does not explain the
  AudioSrv hang or qualify device streaming.
- A synthetic stereo recorder case now checks the native bridge's two-channel
  worklet layout, exact two-channel recorder request, separate dry monitor
  routes and distinct left/right PCM values. After injected device loss, the
  materialized take retains both channels in recovery storage. Its AudioContext,
  native port and samples are test doubles; this does not verify physical
  connector mapping or hardware signal flow.
- The startup diagnostic previously grouped both `IAudioClient3::Start` calls
  and both `GetStreamLatency` calls under `starting-audio-client`, so a timeout
  there could not identify which native call remained blocked. Startup
  snapshots now distinguish capture start, render start, capture latency query
  and render latency query. This is passive diagnostic instrumentation; it
  does not open a device stream. A read-only Application/WER query on
  2026-10-19 reconfirmed the four documented AudioSrv hang reports (including
  one cross-process `audiodg.exe` report); it did not identify a root cause or
  add a later report after the 11:26 event.
- A read-only recovery check on 2026-10-19 found `Audiosrv` running, no
  warning/error entries in the Audio Operational or PlaybackManager logs from
  10:00–12:00, and no WER event later than 11:26. The archived WER report
  folders exist, but reading their contents returned `UnauthorizedAccess`; no
  hang dump or report payload could be inspected from this session. A static
  call-order review against Microsoft's
  [InitializeSharedAudioStream contract](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient3-initializesharedaudiostream)
  and [Start guidance](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-start)
  found the required period validation, event-driven initialization, event
  handle attachment and render-buffer priming before `Start()`. This finds no
  source-level ordering defect; it is not runtime evidence and does not explain
  the service hang.
- The I/O panel now retains the validated ready negotiation on the engine
  connection and displays endpoint-reported input/output stream latency in
  frames and milliseconds when the driver supplies it. It labels acoustic
  loopback as unmeasured; it does not reinterpret driver latency as a measured
  round trip. The ready notification arrives before the UI subscribes, so the
  connection snapshot is the durable source for these negotiated values.
- Startup phase diagnostics now flow from the utility host through the main
  process and the validated preload bridge to the I/O panel. The panel subscribes
  before requesting session startup, buffers an early phase until the session
  ID is returned, then ignores events from other sessions. The manager test
  covers valid, mismatched-session and oversized phase messages. This improves
  visibility into a pending native startup without opening a device or changing
  the WASAPI call path.
- Stopping or unmounting the I/O panel invalidates an in-flight startup. If the
  utility returns a session after cancellation, the panel discards that
  session's transferred PCM port and stops the exact session before it can
  connect to the AudioEngine. A pending port wait is rejected immediately, and
  a port arriving after cancellation is closed. Bridge and UI regression tests
  cover both the late transfer and Stop winning the delayed IPC response race;
  this is lifecycle hardening and does not qualify hardware streaming.
- Native Windows audio I/O is **implemented with qualification open**. The
  next step is to investigate the service hang without opening another stream
  until Windows audio recovers and the cause is better understood. Preserve
  the bounded utility recovery. After the underlying issue is fixed, verify
  graceful stop/retry and measure sustained jitter, queue depth, underruns and
  capture discontinuities through AudioEngine. After that,
  run the exact Volt connector map, analog round-trip measurement,
  device-loss/reconnect procedure and 30-minute duplex soak when the interface
  is present. If copied packets cannot meet the monitoring target, revisit the
  process boundary before claiming low latency.
- The Volt reference setup stays **Open** while the device is absent and until
  physical channel mapping, analog latency, recovery and the sustained soak
  have evidence. The current record is in the
  [support matrix](../WEB-STUDIO-SUPPORT-MATRIX.md) and
  [Windows audio spike](../WINDOWS-AUDIO-SPIKE-2026-09.md).
