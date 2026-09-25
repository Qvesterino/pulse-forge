# Windows audio-backend preflight — 2026-09-25

**Status:** metadata-only capability preflight; not a latency benchmark, stream
soak, guitar test, or backend selection.  
**Host:** Windows 11 Home 25H2, build 26200.9550, x64.  
**Probe:** `native/windows-audio-probe`, built with MSVC 19.51 and Windows SDK
10.0.26100; it starts no audio stream and stores no audio.

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
not proof that an opened stream cannot negotiate another format; no stream was
opened.

## What this changes — and what it does not

- On this host, the current WASAPI shared-mode capability query exposes a
  10 ms period for the Volt endpoint, not the 3 ms exclusive minimum. The
  `AudioCategory_Media` query did not expose a shorter period here.
- The 3 ms value is the endpoint's reported minimum exclusive device period,
  **not** a measured input-to-output round trip and not a promised application
  buffer size. No user audio was played, captured, or monitored.
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

## Next evidence required before ADR 0015

1. With the owner's consent to temporarily initialize the physical audio
   endpoint, open a real WASAPI shared stream at the supported period and an
   exclusive stream; record the chosen format, xruns, device conflicts and
   device-loss behavior.
2. Separately test the registered Universal Audio Volt ASIO driver: exact input
   and output channel mapping, offered buffer sizes, duplex operation, stream
   startup/stop, device loss and loopback round-trip latency. Do not confuse the
   driver's reported buffer size with measured end-to-end latency.
3. Repeat a 30-minute capture/playback soak at 48 kHz on this reference setup.
   Retain the raw latency method/values and channel/frame counts. Use
   [AUDIO-INPUT-HARDWARE-QA.md](./AUDIO-INPUT-HARDWARE-QA.md) for the guitar
   capture, monitoring, interruption and export checks.
4. Only then select the Windows Studio backend and define its contract for
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
[Microsoft exclusive-mode behavior](https://learn.microsoft.com/en-us/windows/desktop/coreaudio/exclusive-mode-streams).
