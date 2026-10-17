# Windows audio capability probe

This small WASAPI capability and stream diagnostic is a technical-spike aid for KYX Studio.
It lists active render/capture endpoints, the shared engine mix format, device
periods, default and `AudioCategory_Media` `IAudioClient3` shared-mode periods,
and whether common mono/stereo PCM/float formats are accepted in shared or
exclusive mode.

Running it with no arguments remains metadata-only. A separate stream test is
available only through the explicit `--stream-test` command below; it targets
one uniquely named endpoint for at most 30 seconds. Capture packets are read
only to collect frame/position/dropout metadata and then discarded in memory.
The render test queues silence only. Neither mode writes or transmits PCM. The
reported WASAPI stream latency is not a physical input-to-output round-trip
measurement, and this tool does not host ASIO drivers.

Capture packet servicing is mode-specific: shared mode drains available packets
with `GetNextPacketSize`; exclusive event mode reads one endpoint buffer per
event and must not call that shared-mode-only method. The diagnostic reports
first-packet separately from later discontinuity flags, plus timestamp errors
and device-position gaps. Capture results also relate the first frame's WASAPI
QPC timestamp to the `Start` call and return, exposing endpoint startup delay
without treating the reported stream latency as a round-trip measurement. It
registers the service thread with MMCSS: `Audio`
for 10 ms-or-longer periods and `Pro Audio` for shorter periods, and fails
before starting the stream if MMCSS registration fails.

The default metadata-only mode does **not** initialize or start a stream, read
microphone samples, record audio, change Windows device settings, or measure
round-trip latency. The audio category is set only on the temporary client
object so Windows can report the matching shared-mode period range. Reported
periods and format support are capability evidence only; a real stream soak and
loopback measurement are still required before a device/backend is certified.

The `--list-json` mode is the Studio's read-only endpoint-discovery interface.
It emits one UTF-8 JSON object with `schemaVersion: 2` and an `endpoints` array;
each record has an opaque endpoint `id`, friendly `name`, `flow` (`capture` or
`render`), current `state`, and `isDefaultConsole`. It enumerates all endpoint
states, opens no audio stream, and changes no device settings. Endpoint IDs are
passed through unchanged and must not be parsed or written to project files.
For active endpoints, `mixFormat` may include the Windows engine mix format
(channel count, sample rate, container bit depth, valid-bit depth, float/PCM
flag and channel mask) plus
the `IAudioClient3` shared-period range queried for that mix format. Inactive
endpoints and endpoints that cannot provide that metadata use `null`. These
values describe the current engine mix; they are not proof that arbitrary
project formats, period requests or physical channel maps can be opened.
The list uses Windows' MMDevice endpoint API; Microsoft documents endpoint IDs
as opaque values returned by `IMMDevice::GetId` ([MMDevice API](https://learn.microsoft.com/en-us/windows/win32/coreaudio/mmdevice-api),
[`IMMDevice::GetId`](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdevice-getid)).

## Build and run (PowerShell)

Requires Visual Studio C++ build tools, the Windows SDK, and CMake.

```powershell
$probeBuildDir = Join-Path $env:TEMP 'kyx-windows-audio-probe'
cmake -S native/windows-audio-probe -B $probeBuildDir -A x64
cmake --build $probeBuildDir --config Release
ctest --test-dir $probeBuildDir -C Release --output-on-failure
& (Join-Path $probeBuildDir 'Release/kyx-windows-audio-probe.exe')
```

The CTest targets cover shared-period selection, QPC timestamp conversion,
loopback-correlation math and endpoint JSON escaping. They do not initialize
an audio stream. `--list-json` is separately exercised against the current
Windows endpoint list by the build/qualification workflow.

To estimate the shared Windows render-to-loopback path, the explicit command
below plays one 2.6 ms correlation burst at -32 dBFS, captures the system mix
through WASAPI loopback for 2–10 seconds, and discards the captured samples
from memory. The burst may be audible. The estimate uses the loopback frame's
QPC timestamp and the render queue padding. This measures the Windows digital
render-to-loopback path; it does **not** measure the DAC, an analog cable path,
ADC, or physical round-trip latency:

```powershell
$probe = Join-Path $probeBuildDir 'Release/kyx-windows-audio-probe.exe'
& $probe --loopback-test '1 - MSI MP273Q E2 (AMD High Definition Audio Device)' 4
```

To run capture and render at the same time on named endpoints, use the bounded
shared-mode wrapper. Capture packet samples are discarded and render queues
silence. This checks concurrent stream operation, not signal routing or
round-trip latency:

```powershell
./native/windows-audio-probe/run-shared-duplex.ps1 `
  -CaptureEndpoint 'INPUT 1/2 (2- Volt 276)' `
  -RenderEndpoint 'MONITOR L/R (2- Volt 276)' `
  -Seconds 10
```

Only after the audio owner approves temporarily opening a physical endpoint,
run a short stream check. The friendly-name form is retained for diagnostics,
but endpoint names can be duplicated. For a device-selection check, prefer
the opaque ID from `--list-json`:

```powershell
$probe = Join-Path $probeBuildDir 'Release/kyx-windows-audio-probe.exe'
& $probe --stream-test capture shared 'INPUT 1/2 (2- Volt 276)' 10
& $probe --stream-test render shared 'MONITOR L/R (2- Volt 276)' 10
& $probe --stream-id-test render shared '<opaque endpoint ID from --list-json>' 10
```

The ID form matches the active endpoint ID exactly. It never selects by name
or falls back to the default endpoint. It still queues silence on render and
discards capture samples; it is a bounded probe, not the Studio audio backend.

Exclusive mode can interrupt other apps using that endpoint and therefore
requires a separate explicit command-line acknowledgement:

```powershell
& $probe --stream-test capture exclusive 'INPUT 1/2 (2- Volt 276)' 10 --exclusive-confirmed
```

Do not run the exclusive test while relying on system audio. The exclusive
stream command sends silence; the separate software-loopback command above
plays a short test burst. A physical round-trip measurement still needs a
separately approved analog routing procedure.

The output includes endpoint names, so review it before sharing. Do not add raw
endpoint IDs or machine-specific probe output to the repository.

WASAPI software loopback captures the system mix from a render endpoint and
does not require a hardware loopback connector. See Microsoft's [loopback
recording documentation](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
and [`IAudioCaptureClient::GetBuffer` QPC timestamp documentation](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudiocaptureclient-getbuffer).
