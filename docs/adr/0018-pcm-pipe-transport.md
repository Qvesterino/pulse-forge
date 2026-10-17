# ADR 0018 — Framed PCM pipe transport (wave 2 foundation)

Date: 2026-09-27
Status: Accepted (transport + reference host shipped; ASIO streaming host pending hardware)

## Context

ADR 0016 and ADR 0017 establish out-of-process discovery for CLAP plugins
and ASIO drivers and defer the streaming layer to a "separate realtime host
process with framed PCM transport, acceptance-tested for drift and dropouts
before any UI exposure". On the development machine there is no usable
64-bit ASIO driver (one 32-bit-only registration, one registration whose
COM init hangs), so an ASIO streaming host cannot be acceptance-tested
here — and per the honesty rule, code that cannot be tested is not
advertised as working.

What CAN be fully tested on any machine is the transport itself: the frame
protocol, the parser, the consumer accounting and the pipe throughput.

## Decision

**Frame protocol (the only contract).** Every native audio source — the
reference generator now, the ASIO streaming host later — emits
little-endian frames over a spawn pipe:

```
offset 0   magic  "KYXP"
offset 4   type   u8   (1 = PCM f32le interleaved, 2 = JSON event,
                        3 = JSON stats, 4 = EOF)
offset 5   flags  u8   (0)
offset 6   reserved  u16 (0)
offset 8   seq    u32  (monotonic across PCM frames)
offset 12  len    u32  (payload bytes, capped)
offset 16  payload
```

- A source opens with an EVENT frame announcing `{rate, channels,
blockFrames}`, streams PCM blocks, closes with STATS and EOF.
- Consumers MUST validate everything before use: magic, known type, flags,
  payload cap, seq contiguity. A violation tears the stream down with a
  diagnostic — no lenient parsing ever reaches audio or UI.
- PCM payloads are float32 interleaved; the consumer copies into an aligned
  buffer before viewing (partial-frame offsets in the accumulation buffer
  are not 4-byte aligned).

**Shipped in this wave.**

- `native/pcm-host/pcm-gen.c` (`npm run build:pcm-host`, C only, no SDK, no
  hardware): deterministic sine source speaking the protocol, binary stdout
  (Windows text mode would corrupt bytes).
- `desktop/pcm-pipe.cjs`: pure frame codec (`parseFrame`/`drainFrames`) and
  the `PcmPipeSource` consumer — spawn, validation, seq-gap accounting,
  byte-rate stats, graceful `close` reporting.
- Acceptance (`tests/pcm-pipe.test.ts`, 6 pins): codec fuzz (truncation
  asks for more, violations diagnose), sample-level verification of the
  first 4800 stereo frames against `0.25·sin(2πf·n/rate)` within 1e-5,
  contiguity (`seqGaps === 0` for a 5 s run), and a throughput floor of
  ≥ 4× realtime (stereo f32 48 kHz ≈ 384 KB/s).

**Not shipped (the honest line).**

- The ASIO streaming host (`native/asio-host/asio-host.cpp`, wave 2.5) IS
  shipped: it loads a driver by DLL path or registry name, converts
  int16-LSB buffers to float32 and emits ADR 0018 frames. Acceptance runs
  against the SDK's OWN sample driver compiled as a 64-bit fixture DLL
  (realtime-paced by its timer thread): 96 000 frames per 2 s run, seq
  contiguity, bounded non-silent samples, clean EOF. Streaming from REAL
  hardware drivers and the 300 s soak stay owner gates — the fixture
  proves the host, not any specific driver.
- The renderer components exist: the SPSC SharedArrayBuffer ring
  (`src/audio-engine/pcmRing.ts`), its Node producer mirror
  (`desktop/pcm-ring-layout.cjs`), and the `pcm-playback` AudioWorklet.
  Same-process producer/reader tests verify 48 000 sine-exact frames across
  ring wrap with zero overruns against a realtime-paced source. This is
  component evidence only; it is not an Electron end-to-end playback test.
- **The desktop bridge is not operational.** `desktop/pcm-desktop.cjs`
  attempts to pass the renderer-created SAB to the main process through
  `ipcRenderer.invoke`. Electron 44.4.3 rejects that payload with
  `An object could not be cloned`; main-to-renderer `webContents.postMessage`
  rejects it too. Therefore the statusbar EXT PCM chip has no valid live
  main-process ring and must not be described as shipped playback. The
  Electron-side isolation and same-renderer native-addon spike is recorded in
  [ADR 0050](./0050-windows-audio-io-direction.md).
- The stateful linear resampler is component-tested: a 440 Hz source through
  44100→48000 stays within < 0.005 amplitude interpolation error across
  block boundaries. Its end-to-end desktop path remains unverified until the
  SAB ownership/transport boundary is replaced. Master-grade conversion
  remains future work.

## Support matrix

| Capability                                       | Status                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Framed PCM pipe protocol + Node consumer         | Shipped, acceptance-tested                                                      |
| Reference source (deterministic generator)       | Shipped                                                                         |
| ASIO streaming host (driver → frames)            | Shipped against the fixture driver (wave 2.5); real-hardware soak = owner gate  |
| Renderer ring and AudioWorklet components         | Component tests pass; Electron integration is not verified                      |
| Desktop "hear it" wiring (EXT PCM chip over IPC) | Not shipped; Electron cannot clone the ring SAB across processes                 |
| Resampling (source rate ≠ context rate)           | Component tests pass; end-to-end bridge awaits a valid ring transport            |

## Consequences

- Every future native audio source inherits a proven protocol with a test
  harness: implement the frames, point the tests at the new binary.
- The 4× realtime floor is a transport floor, not a scheduling guarantee;
  the wave-2.5 soak adds jitter/drift measurement before any realtime use.
- The protocol is deliberately byte-simple (no protobuf, no framing
  library): debuggable with `od`, parseable in any language the desktop
  shell grows.
