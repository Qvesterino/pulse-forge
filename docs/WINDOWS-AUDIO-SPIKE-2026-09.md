# Windows audio-backend preflight and stream smoke — 2026-09-26

**Status:** metadata preflight and preliminary 10-second WASAPI stream smokes;
not a latency benchmark, stable-recording certification, guitar test, ASIO test,
or backend selection. The most recent capture runs used a service thread without
MMCSS and do not isolate endpoint behavior from scheduling.
**Host:** Windows 11 Home 25H2, build 26200.9550, x64.  
**Probe:** `native/windows-audio-probe`, built from the current source with MSVC
18.7.8 and Windows SDK 10.0.26100.

## Detected reference endpoints

Windows reports these active Universal Audio endpoints:

- Capture: `INPUT 1/2 (2- Volt 276)`
- Render: `MONITOR L/R (2- Volt 276)` (current console default)

The Windows ASIO registry also contains a `Universal Audio Volt` driver entry.
Registry presence does not prove driver health, device connectivity through the
ASIO path, available buffers, or a working ASIO session. The probe did not load
or initialize any ASIO driver.

## WASAPI metadata result for Volt 276

The probe queried the active endpoint's mix format, device periods,
`IAudioClient3` shared-engine periods both with default client properties and
after setting `AudioCategory_Media` on the temporary client object, and format
support for common mono/stereo PCM/float candidates. It did not call
`IAudioClient::Initialize` or `IAudioClient3::InitializeSharedAudioStream`.

| Capability query                                         | Volt capture: INPUT 1/2                              | Volt render: MONITOR L/R                             |
| -------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Shared engine mix format                                 | 2 channels, 48 kHz, 32-bit float                     | 2 channels, 48 kHz, 32-bit float                     |
| Shared default period                                    | 480 frames / 10 ms                                   | 480 frames / 10 ms                                   |
| `IAudioClient3` default and `AudioCategory_Media` ranges | Both report min = default = max = 480 frames / 10 ms | Both report min = default = max = 480 frames / 10 ms |
| `GetDevicePeriod` minimum exclusive period               | 3 ms                                                 | 3 ms                                                 |
| Exact tested shared formats                              | 48 kHz, 2-channel PCM16 and float32                  | 48 kHz, 1- or 2-channel PCM16 and float32            |
| Exact tested exclusive formats                           | 48 kHz, 2-channel PCM16                              | 48 kHz, 2-channel PCM16                              |

For this metadata query, the tested 44.1 kHz and 96 kHz candidates did not
match the current shared-engine format; Windows reported the 48 kHz stereo
32-bit-float format as the closest match. The tested mono capture candidates
also reported the stereo mix format as the closest shared-mode match. This is
not proof that an opened stream cannot negotiate another format.

## Owner-authorized WASAPI stream smoke

After rebuilding the probe, a 10-second stream test was run against each exact
Volt 276 endpoint. Capture packets were inspected only for timing/status flags
and immediately released; sample bytes were not copied, saved or transmitted.
Render queued silence only. No test tone, analog loopback or user recording was
performed.

| Test                                               | Format / requested period                                                               | Result                                                                                                                                                                                                                      | Gate                                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| WASAPI shared capture — `INPUT 1/2 (2- Volt 276)`  | 48 kHz, 2-channel 32-bit float; 480 frames / 10 ms; endpoint buffer 1056 frames / 22 ms | 10.00 s; 952 packets; 448,128 frames (9.34 s); 41 data-discontinuity flags; 0 silent packets; 0 event timeouts; first/last device positions 0 / 479,040                                                                     | **PRELIMINARY FAIL** — capture returned non-zero; first-vs-later flags were not separated and the service thread had no MMCSS profile    |
| WASAPI shared render — `MONITOR L/R (2- Volt 276)` | 48 kHz, 2-channel 32-bit float; 480 frames / 10 ms; endpoint buffer 1056 frames / 22 ms | 10.00 s; 921 events; 445,536 frames queued (9.28 s); 0 event timeouts                                                                                                                                                       | **PASS for this smoke only** — silence was queued without MMCSS; playback fidelity and duplex operation are untested                     |
| WASAPI exclusive capture — initial exploratory run | 48 kHz, 2-channel PCM16; 144 frames / 3 ms; endpoint buffer 144 frames / 3 ms           | 10.00 s; 3,311 packets; 476,784 frames (9.93 s); 26 reported discontinuity flags; capture loop called shared-only `GetNextPacketSize`                                                                                       | **INCONCLUSIVE** — unsupported packet-service path; counts are not endpoint evidence                                                     |
| WASAPI exclusive capture — corrected packet path   | 48 kHz, 2-channel PCM16; 144 frames / 3 ms; endpoint buffer 144 frames / 3 ms           | 10.00 s; 3,332 packets; 479,808 frames (10.00 s); 3 later discontinuity flags; 0 timestamp errors; 0 device-position gaps; 0 silent packets, buffer errors, packet-size mismatches or event timeouts; positions 0 / 479,664 | **PRELIMINARY FAIL** — non-zero exit on later flags; no MMCSS profile, so test-thread scheduling is not separated from endpoint behavior |

The shared capture/render API-reported stream latency was 0.000 ms; both
exclusive runs reported 3.000 ms. These are endpoint stream latencies, not
measured round-trip latency or low-latency claims. The valid shared capture
smoke reported 41 discontinuity flags, but its probe did not separate the first
packet from later flags, count timestamp errors, or use an MMCSS service-thread
profile. The corrected exclusive capture reported 3 later discontinuities, but
no timestamp errors, device-position gaps, or event-service errors. Because
neither capture ran with the recommended MMCSS profile, neither result
certifies endpoint stability or isolates the source of the flags. The exclusive
capture packets were discarded, so audible impact was not evaluated.

The initial exclusive attempt used `GetNextPacketSize`, which Microsoft
documents as shared-mode-only; its packet/frame/flag counts are invalid. The
corrected probe now reads one full endpoint buffer per exclusive event and
registers its service thread with MMCSS (`Audio` for periods of 10 ms or more,
`Pro Audio` below 10 ms). Microsoft describes MMCSS/event-driven servicing as a
way to reduce glitch risk in low-latency exclusive streams.

The first stream attempt did not reach initialization: the probe passed a null
closest-format output pointer to shared-mode `IsFormatSupported`. The current
probe supplies and frees that output correctly. Microsoft documents that the
shared-mode call requires a valid non-null closest-match pointer, while the
mix format returned by `GetMixFormat` is supported.

## What this changes — and what it does not

- On this host, the current WASAPI shared-mode capability query exposes a
  10 ms period for the Volt endpoint, not the 3 ms exclusive minimum. The
  `AudioCategory_Media` query did not expose a shorter period here.
- The 3 ms value is the endpoint's reported minimum exclusive device period.
  Both exclusive probes opened at 3 ms; the corrected packet-path run had no
  MMCSS boost. Neither period nor `GetStreamLatency` is measured
  input-to-output round trip or a promise of reliable operation.
- The endpoint is named `INPUT 1/2`; the two-channel mix format does not prove
  that browser capture preserves the interface's physical channel identity.
- The machine has a registered `Universal Audio Volt` ASIO driver, making ASIO a
  concrete candidate for the next stream-level spike. Its startup, selected
  buffer size, channel map, duplex operation, latency and stability remain
  untested.
- `AudioEngine.ensureContext()` still constructs a browser `AudioContext`
  directly. A native backend therefore needs an explicit realtime boundary; it
  cannot be achieved by adding ASIO calls to Electron IPC or by changing only
  the input selector. The shared project model and offline renderer must remain
  intact.

## Next evidence required before ADR 0016

1. With fresh owner consent, rerun the shared capture with the current
   diagnostics and MMCSS `Audio` profile; investigate later discontinuities,
   timestamp errors or device-position gaps under a controlled host load.
   Do not call the 10-second silent-render smoke a playback-quality or duplex
   pass.
2. Before another exclusive capture, obtain fresh explicit consent because
   exclusive mode can interrupt other apps. Rerun with the current `Pro Audio`
   profile, then record device conflicts and device-loss behavior as well as
   capture stability.
3. Separately test the registered Universal Audio Volt ASIO driver: exact input
   and output channel mapping, offered buffer sizes, duplex operation, stream
   startup/stop, device loss and loopback round-trip latency. Do not confuse the
   driver's reported buffer size with measured end-to-end latency.
4. Repeat a 30-minute capture/playback soak at 48 kHz on this reference setup.
   Retain the raw latency method/values and channel/frame counts. Use
   [AUDIO-INPUT-HARDWARE-QA.md](./AUDIO-INPUT-HARDWARE-QA.md) for the guitar
   capture, monitoring, interruption and export checks.
5. Only then select the Windows Studio backend and define its contract for
   device identity, channel maps, sample formats, clock/timestamps, latency,
   xruns, hot-unplug and diagnostics. Keep Web Audio as the browser backend.

## Licensing notes for the spike

Steinberg currently offers the ASIO SDK under GPLv3 or a proprietary license;
the project has not chosen a route. The VST 3.8 SDK is MIT-licensed. Do not infer
the product's distribution license from `package.json`'s `private: true`.
Record the chosen ASIO route and required notices before distributing an ASIO
host. Sources: [Steinberg developer portal](https://www.steinberg.net/developers/),
[VST 3 licensing](https://steinbergmedia.github.io/vst3_dev_portal/pages/VST%2B3%2BLicensing/VST3%2BLicense),
[Microsoft `IAudioClient3` shared periods](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient3-getsharedmodeengineperiod),
[Microsoft `IsFormatSupported`](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-isformatsupported),
[Microsoft `GetNextPacketSize`](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudiocaptureclient-getnextpacketsize),
[Microsoft exclusive-mode MMCSS guidance](https://learn.microsoft.com/en-us/windows/desktop/coreaudio/exclusive-mode-streams),
[Microsoft capture discontinuity flags](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/ne-audioclient-_audclnt_bufferflags),
[Microsoft exclusive-mode behavior](https://learn.microsoft.com/en-us/windows/desktop/coreaudio/exclusive-mode-streams).
