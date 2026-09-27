# ADR 0017 — SMPTE timecode (MTC in) and ASIO driver discovery

Date: 2026-09-27
Status: Accepted (wave 1 shipped; audio-path waves planned, see matrix)

## Context

ADR 0014 authorizes full-DAW scope and requires a dedicated ADR with
licensing review, measurable acceptance tests and an honest support matrix
for each pro-audio capability. This ADR covers the next two: SMPTE timecode
and ASIO. It extends the CLAP hosting ladder of ADR 0016 with the same
construction rule: discovery and metadata first, out-of-process; streaming
audio only behind a proven process boundary.

**SMPTE.** Studio sync means reading timecode from external gear. MIDI
Timecode (MTC — quarter frames over any MIDI jack, plus full-frame SysEx
jumps) is the practical in-road for a browser/desktop DAW: Web MIDI already
exists in KYX, while linear timecode (LTC over audio) would need a dedicated
decoder DSP and is explicitly out of scope here.

**ASIO.** Pro audio I/O on Windows means ASIO. The Steinberg ASIO SDK is
free to use but **not redistributable** — its headers and zip must never
enter this repository. Loading ASIO drivers also means loading third-party
kernel-adjacent code in-process, which a browser cannot do and a DAW must
sandbox: a misbehaving driver must never take the DAW down.

## Decision

**SMPTE wave 1 (shipped, web + desktop).**

- `src/midi/smpte.ts`: an MTC decoder (quarter-frame assembly with
  piece-index consistency checks, resync rules and rate-code detection),
  a full-frame SysEx parser, an `MtcReceiver` host with recency + pub/sub,
  and the timecode math — `smpteToSeconds`/`secondsToSmpTe` with correct
  29.97 drop-frame compensation (one DF hour = exactly 3600.0 s /
  107892 frames), plus `smpteToSamples`/`samplesToSmpTe` as the BWF
  `bext` timeReference bridge (ADR-free companion to the BWF wave).
- `MidiInput` routes 0xF1 quarter frames and MTC full-frame SysEx to new
  `onMtc` callbacks; the statusbar shows an MTC readout only while frames
  are fresh (< 1 s), so the feature costs nothing when unused.
- **Not shipped:** transport chase (following external timecode with the
  playhead), LTC decode, MTC/LTC _emission_. Chase is wave 2 and must
  respect ADR 0002: Transport stays the musical clock; a chase is a
  user-visible seek, not a silent re-anchor.

**ASIO wave 1 (shipped, desktop, discovery only).**

- `scripts/vendor-asio.mjs` fetches the Steinberg SDK **headers only**
  (`asio.h`, `asiosys.h`, `iasiodrv.h`) into `native/asio-host/asio-sdk/`,
  which is **gitignored**; the committed manifest records URL, zip SHA-256
  and file hashes. Running the fetch is an explicit acceptance of
  Steinberg's license terms. The SDK must never be committed.
- `native/asio-host/asio-probe.cpp` enumerates `HKLM\SOFTWARE\ASIO` in both
  registry views and queries each driver over raw COM (`IASIO`) — name,
  version, channel counts, buffer-size range, sample rate — as bounded
  JSONL. It never creates buffers and never streams. Drivers are reported
  even when they cannot load (32-bit-only in a 64-bit process), and one
  blocking driver costs the probe process, not the app: the manager kills
  on timeout and keeps the per-line-flushed partial results.
- `desktop/asio-host-manager.cjs`: tier 1 is pure Node (reg.exe query —
  works without SDK or native build); tier 2 spawns the probe with strict
  record validation, mirroring the MRT2/CLAP manager boundaries.
- **Not shipped:** ASIO streaming (wave 2 — a separate realtime host
  process with framed PCM transport, acceptance-tested for drift and
  dropouts before any UI exposure), Core Audio / WASAPI-exclusive paths,
  macOS/Linux probes.

**Licensing review.** CLAP: MIT (ADR 0016). ASIO SDK: usable, not
redistributable — the fetch-per-machine gate and gitignore are the
compliance mechanism, and no Steinberg code links into KYX binaries (the
probe uses the headers as interface declarations only). SMPTE: MTC is a
published MIDI Association spec; no licensed reference code is used.

**Measurable acceptance.** `tests/mtc-smpte.test.ts` (15 pins) anchors the
DF math to spec values and proves garbage tolerance; MTC wiring rides the
existing MIDI suites. `tests/asio-host.test.ts` (10 pins) gates the SDK
manifest, pins the manager boundary with injected runners, and — where the
SDK + MSVC exist — drives the real probe, asserting the honest contract:
clean JSON or a partial timeout, never a hang.

## Support matrix

| Capability                                           | Status                     |
| ---------------------------------------------------- | -------------------------- |
| MTC decode (quarter frames + full frames) + readout  | Shipped                    |
| Timecode math (DF/NDF, seconds, samples, BWF bridge) | Shipped                    |
| Transport chase to external timecode                 | Not shipped (wave 2)       |
| ASIO driver discovery (registry + COM probe)         | Shipped (Windows, desktop) |
| ASIO streaming audio in the graph                    | Not shipped (wave 2)       |
| LTC decode/emission, MTC emission                    | Not shipped                |

## Consequences

- ASIO vendor state is per-machine by design; CI and fresh clones run the
  suite green without the SDK (manifest + registry + manager pins only).
- The probe's per-line flush + manager's partial-parse contract is the
  template every future hardware probe (CLAP scan already follows it) must
  keep: partial honest answers beat a silent all-or-nothing.
- MTC without chase means the readout can disagree with the transport while
  an external source runs; that is visible and documented, not silent.
