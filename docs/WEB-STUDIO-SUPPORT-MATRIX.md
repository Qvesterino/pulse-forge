# KYX Web and Studio support matrix

**Status:** working qualification record, updated 2026-10-17

**Product scope:** [ADR 0014 — full-DAW scope](./adr/0014-full-daw-scope.md)  
**Execution plan:** [full-DAW roadmap](./ROADMAP-FULL-DAW.md)

This matrix separates implementation from software-path checks and physical
hardware qualification. “Implemented” does not mean certified for every host;
“software verified” does not prove device routing, analog latency or long-term
hardware stability. A hardware claim applies only to the exact host, OS, driver,
interface, channel map, sample rate and buffer recorded in its evidence.

## Status meanings

| Status                | Meaning                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| **Implemented**       | The product path exists; the cited boundary still applies.                                           |
| **Software verified** | Automated or repeatable software checks passed; no physical device claim is implied.                 |
| **Hardware smoke**    | A bounded stream opened on a named physical device; this is preliminary evidence, not qualification. |
| **Hardware verified** | A named physical configuration passed the procedure and has a retained test record.                  |
| **Not shipped**       | There is no user-available product implementation for this capability.                               |
| **Open**              | Evidence or a product decision is still required before a support claim can be made.                 |

## Product profiles

| Profile                         | Status             | Current boundary                                                                                                                                                               |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **KYX Web**                     | Implemented        | Browser-first Web Audio application. Browser permissions and device APIs define the available input behavior.                                                                  |
| **KYX Studio for Windows**      | Implemented        | Electron package runs the same Web Audio application; it is not a native low-latency audio engine.                                                                             |
| **Native Windows audio I/O**    | Not shipped / open | Direction recorded in [ADR 0050](./adr/0050-windows-audio-io-direction.md); there is no user-available native streaming backend, and Volt physical qualification remains open. |
| **macOS and Linux desktop app** | Not shipped        | No packaged desktop support claim.                                                                                                                                             |

## Recording and audio I/O

| Capability                                      | Status                    | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser input capture to durable PCM            | Software verified         | Chromium synthetic-input E2E and a 30-minute soak passed; blocks persist through IndexedDB and committed data is recoverable.                                                                                                                                                                                                                                                                                                        |
| One selected browser input stream               | Implemented               | Capture can request 1–8 channels and route channels to separate arrangement tracks. Browser/device channel mapping is unverified.                                                                                                                                                                                                                                                                                                    |
| Loop and punch passes, alternate takes, comping | Software verified         | Synthetic/browser-path capture, edit, save/reopen and export checks exist; real recorded material is not certified.                                                                                                                                                                                                                                                                                                                  |
| Multiple independent input streams at once      | Not shipped               | One capture stream is active at a time; separately armed device streams remain a roadmap item.                                                                                                                                                                                                                                                                                                                                       |
| Physical connector mapping and analog loopback  | Open                      | No connector-to-channel map, analog loopback or DAC/ADC round-trip measurement is recorded yet.                                                                                                                                                                                                                                                                                                                                      |
| Windows shared-mode duplex                      | Hardware smoke            | Bounded 10- and 30-second capture/silent-render runs passed on the active Volt 276 endpoints. This does not measure physical round-trip latency.                                                                                                                                                                                                                                                                                     |
| Windows software loopback                       | Software verified         | Default-endpoint digital loopback checks and their boundaries are documented in [the audio spike](./WINDOWS-AUDIO-SPIKE-2026-09.md). They do not measure DAC/ADC latency.                                                                                                                                                                                                                                                            |
| UA Volt 276 reference setup                     | Open                      | [10- and 30-second shared-mode streams passed on 2026-10-15](./WINDOWS-AUDIO-SPIKE-2026-09.md#volt-shared-mode-smoke--2026-10-15). A [read-only endpoint enumeration on 2026-10-17](./WINDOWS-AUDIO-SPIKE-2026-09.md#current-endpoint-check--2026-10-17) did not find the Volt connected, so the previous smoke remains historical; host/driver/channel-map qualification, physical latency and sustained hardware soak remain open. |
| ASIO discovery                                  | Implemented               | Windows desktop discovery/probe only; see [ADR 0017](./adr/0017-smpte-asio-discovery.md).                                                                                                                                                                                                                                                                                                                                            |
| ASIO audio streaming                            | Software fixture verified | A fixture-driver soak passed; real hardware drivers have not passed the release qualification gate. See ADR 0017/0018.                                                                                                                                                                                                                                                                                                               |

The recording procedure and retained evidence checklist are in
[AUDIO-INPUT-HARDWARE-QA.md](./AUDIO-INPUT-HARDWARE-QA.md). Until a physical
interface passes that procedure, describe recording support as browser
software-path capability, not certified studio hardware support.

## Composition and note editing

| Capability                                   | Status                | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Long MIDI phrases and three-minute songs     | Software verified     | ADR 0047 and `docs/CURRENT-STATE.md`: 180-second save/reload/export and 181-second live soak passed; sparse MIDI notes exceed the bounded drum step grid.                                                                                                                                                                                                                                                                                                                                                                                              |
| Independent MIDI clips per instrument lane   | Implemented           | ADR 0044: clips are independently placed and scheduled on instrument lanes; Firefox live-audio, multi-peer collaboration and filtered-stem parity gates remain open.                                                                                                                                                                                                                                                                                                                                                                                   |
| Per-note velocity and fine pitch event lanes | Implemented           | Piano Roll Event Editor (schema v35); velocity is existing note data, fine pitch is added before the shared TriggerEngine path. MIDI 1.0 output expression is not yet represented.                                                                                                                                                                                                                                                                                                                                                                     |
| Per-note pan                                 | Partially implemented | A lightweight shared capability map populates `InstrumentDefinition.noteExpressionTargets` and drives the lane list. Eighteen built-in voice instruments route overlapping notes through separate panners. Chromium sample-level tests verify hard-left/right and neutral-value behavior for Texture Synth and Vocal Chop; the other declared routes currently have graph-level evidence.                                                                                                                                                              |
| Per-note filter, release and Mod X/Y         | Partially implemented | Direct cutoff/resonance and centered Mod X/Y route to per-voice filters on 16 built-in instruments. Release velocity scales note-off envelopes on 19 instruments. `npm run test:browser:note-expression` renders every declared route in isolated Chromium OfflineAudioContext channels and passes 35/35: neutral values preserve the baseline, cutoff/Mod X/Y move audio on all 16 filter instruments, and release velocity changes the note-off tail on all 19 release instruments. Realtime/offline parity and Firefox/Safari coverage remain open. |
| FL-style slide note and portamento modes     | Partially implemented | Legacy `NoteEvent.slide` is portamento. A separate no-retrigger slide note bends held mono 808 and Acid 303 voices; chord/color groups and external MIDI still need explicit pitch-slide support.                                                                                                                                                                                                                                                                                                                                                      |

## Project interchange

| Capability                     | Status                                            | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Standard audio + MIDI transfer | Implemented; source-DAW qualification in progress | Project Browser **BRING A SONG** imports up to 32 audio files (existing 25 MB/file limit) and one Standard MIDI file (10 MB; up to 8 melodic lanes + GM drums) into a new project. Audio must share bar-1 origin. Only first MIDI tempo/meter apply; unsupported events are disclosed. `npm run test:browser:daw-transfer` verifies 8 decoded audio lanes + 4 MIDI lanes through save/reopen, media restoration, offline render and non-silent realtime MIDI playback in Chromium. Repeatable exports from installed FL Studio/Cubase/Pro Tools versions are not yet qualified; see `docs/DAW-TRANSFER-EXPORT-GUIDE.md`. |
| Native DAW project conversion  | Not shipped                                       | KYX does not import FLP, CPR, PTX, AAF or OMF and does not transfer plug-in state, mixer routing, automation or native layout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Plug-ins

| Capability                    | Status      | Current boundary                                                                                 |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| CLAP plug-in discovery        | Implemented | Windows x64 metadata scanning only; it does not load plug-in audio into the project graph.       |
| CLAP plug-in audio processing | Not shipped | An audio host, saved state, parameters, latency handling and offline parity are not shipped.     |
| VST3 / AU audio processing    | Not shipped | Follow the format-specific licensing, isolation and compatibility gates before claiming support. |

See [ADR 0016](./adr/0016-clap-plugin-hosting.md), [ADR 0035](./adr/0035-vst3-hosting-policy.md)
and the plug-in phases of the [full-DAW roadmap](./ROADMAP-FULL-DAW.md).

## Browser and release qualification

| Area                                  | Status            | Current boundary                                                                                                          |
| ------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Chromium recording/edit software path | Software verified | Synthetic channel routing, recovery, edits and a 30-minute capture soak are verified; this is not hardware qualification. |
| Firefox and Edge full-DAW recording   | Open              | Older broad browser-suite results are historical; current recording and hardware claims need a fresh declared candidate.  |
| Safari and iOS recording/export       | Open              | Manual smoke remains outstanding.                                                                                         |
| Signed Windows installer              | Open              | Code signing is not shipped.                                                                                              |
| Windows update path                   | Implemented       | Electron auto-update uses GitHub Releases; a clean-candidate install/update/recovery pass remains a release gate.         |
| Deployed production smoke             | Open              | Requires a declared `KYX_DEPLOY_URL` and a current clean release candidate.                                               |

## Reference-device record still required

The owner-approved reference setup is not locked yet. For the first qualification
record, capture at least:

- exact Windows version/build and host PC;
- interface model, firmware and driver version;
- selected physical input/output connectors and their host channel numbers;
- sample rate, buffer/period and driver mode;
- KYX version/commit and whether the host is Web or packaged Electron;
- physical round-trip method and raw measurements;
- sustained-dropout, device-loss/reconnect, committed-audio recovery and
  save/reopen/export results.

Keep values blank until measured. Do not fill this record from OS defaults,
digital render-loopback estimates or listening impressions.
