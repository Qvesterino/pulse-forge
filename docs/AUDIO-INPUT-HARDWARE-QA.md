# KYX audio-input hardware smoke test

**Status:** procedure only; no physical device has been certified by this document.  
**Scope:** guitar/line input, browser Web Audio capture, Electron Web Audio capture,
monitoring, interruption recovery and export. This is a single-input smoke test,
not proof of multichannel recording or professional round-trip latency.

## Test record

Record these values for every run. Do not publish a browser/device support claim
from a mock, one computer, or an unrepeatable listening impression.

| Field                                               | Value |
| --------------------------------------------------- | ----- |
| KYX version / commit                                |       |
| OS version and build                                |       |
| Host: browser or packaged Electron                  |       |
| Browser / Electron version                          |       |
| Audio interface make and model                      |       |
| Driver and mode (shared / exclusive / ASIO / other) |       |
| Physical input and interface channel                |       |
| Interface sample rate / buffer (if configurable)    |       |
| KYX-reported track settings and channel range       |       |
| KYX PCM capture channels and sample rate            |       |
| Measured input-to-output latency and method         |       |
| Result, notes and evidence file names               |       |

## Optional Windows metadata preflight

Before starting a stream-level hardware test, build and run the read-only
[Windows audio capability probe](../native/windows-audio-probe/README.md). It
reports WASAPI endpoint formats and periods but does not capture audio or
measure round-trip latency. The first host snapshot is documented in
[WINDOWS-AUDIO-SPIKE-2026-09.md](./WINDOWS-AUDIO-SPIKE-2026-09.md).

## Safe setup

1. Use a new disposable KYX project and headphones. Turn the interface output down
   before connecting or changing cables; avoid monitor-speaker feedback.
2. Connect the guitar through the interface's instrument/Hi-Z input or a suitable
   DI. Follow the interface and instrument manuals for input level and phantom
   power; do not enable phantom power for a guitar input.
3. Start with a conservative input gain. Confirm the interface is not clipping
   before using KYX's input trim. Do not raise the trim to conceal hardware
   clipping.
4. Record the OS, interface, driver, channel, rate, buffer and application
   versions in the test record. Keep the same device as the default output unless
   the test explicitly covers another route.

## Browser and Electron procedure

Run the sequence independently in each host. The packaged Electron app currently
uses Web Audio too; its result is not evidence for a future native backend.

1. **Permission and device selection:** deny audio-input permission, press REC,
   and confirm a readable error appears, no clip is placed and the project stays
   unchanged. Grant permission, reopen the input selector, choose the intended
   interface input, and verify that KYX does not silently switch to System
   default. Record the displayed device name.
2. **Observed format:** arm a disposable audio track and begin a short recording.
   Record the displayed PCM channel count/rate, browser track settings and any
   browser-reported channel range. Stop and inspect the resulting AudioClip and
   recovered-take metadata; the saved PCM channel count and sample rate must
   agree with the worklet-reported capture format. Treat browser capability ranges
   as hints, not proof of physical channel mapping.
3. **Signal and clipping:** play a repeatable guitar phrase with a quiet section
   and a strong strum. Confirm the meter follows the input, the clip warning
   latches only at clipping, and lowering hardware gain removes clipping without
   breaking capture. Listen to the placed clip on headphones.
4. **Monitoring:** with headphones connected, compare dry monitoring off and on.
   Confirm off is silent from the direct-monitor path and on is audible without
   feedback. Note the perceived delay; do not call it a measured latency result.
5. **Placement and export:** record against a known bar/transport position. Check
   that the clip starts at the expected musical position, survives save/reopen,
   and appears in a song export at the same position. Listen for missing,
   duplicated, swapped or truncated channels. This does not compare the live
   input path with offline DSP; it verifies the captured take's project/export path.
6. **Device loss:** in the disposable project, record long enough for at least
   one durable PCM block, then disconnect or disable the selected input. Confirm
   capture stops with a clear error, committed audio remains recoverable, and KYX
   does not continue from a different input. Reconnect, reselect deliberately,
   and make a fresh take.
7. **Interrupted-session recovery:** make another disposable take, wait for a
   visible signal and at least one 0.5-second persistence block, then close the
   host unexpectedly using a controlled test environment. Reopen KYX and recover
   the staged take. Confirm duration, channel count, sample rate, track identity
   and musical placement. Never perform this step in a project containing
   unsaved work.

## Pass / fail rules

- **Pass this smoke run** only if the chosen input stays pinned, the PCM report
  agrees with saved take metadata, the complete phrase is audible at the intended
  position after reload/export, and interruption recovery returns all committed
  blocks without silent source switching.
- **Fail** on unexplained channel-count changes, swapped channels, silent or
  truncated takes, hidden clipping, lost committed PCM, an unannounced fallback
  to another input, or a misleading/absent error after permission/device loss.
- Record any latency figure with a defined loopback measurement method and raw
  values. Listening alone is not a round-trip latency measurement.
- A pass applies only to the exact OS, host, interface, driver, rate, buffer and
  connection recorded above. Repeat configurations before marking them supported.

## Evidence to retain

Keep the filled test record, a screenshot of the capture report, the recovered
take's channel/rate/frame metadata, and the exported WAV. When investigating a
failure, also keep the console/diagnostic output and note the exact sequence that
reproduced it. Remove personal project names and device identifiers before
sharing logs.
