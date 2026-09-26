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

The default metadata-only mode does **not** initialize or start a stream, read
microphone samples, record audio, change Windows device settings, or measure
round-trip latency. The audio category is set only on the temporary client
object so Windows can report the matching shared-mode period range. Reported
periods and format support are capability evidence only; a real stream soak and
loopback measurement are still required before a device/backend is certified.

## Build and run (PowerShell)

Requires Visual Studio C++ build tools, the Windows SDK, and CMake.

```powershell
$probeBuildDir = Join-Path $env:TEMP 'kyx-windows-audio-probe'
cmake -S native/windows-audio-probe -B $probeBuildDir -A x64
cmake --build $probeBuildDir --config Release
ctest --test-dir $probeBuildDir -C Release --output-on-failure
& (Join-Path $probeBuildDir 'Release/kyx-windows-audio-probe.exe')
```

The CTest target exercises the shared-period selection rules only; it does not
enumerate devices or initialize an audio stream.

Only after the audio owner approves temporarily opening a physical endpoint,
run a short stream check by supplying its exact friendly name:

```powershell
$probe = Join-Path $probeBuildDir 'Release/kyx-windows-audio-probe.exe'
& $probe --stream-test capture shared 'INPUT 1/2 (2- Volt 276)' 10
& $probe --stream-test render shared 'MONITOR L/R (2- Volt 276)' 10
```

Exclusive mode can interrupt other apps using that endpoint and therefore
requires a separate explicit command-line acknowledgement:

```powershell
& $probe --stream-test capture exclusive 'INPUT 1/2 (2- Volt 276)' 10 --exclusive-confirmed
```

Do not run the exclusive test while relying on system audio. The command does
not produce a test tone; a later loopback latency test needs a separate
user-approved physical routing procedure.

The output includes endpoint names, so review it before sharing. Do not add raw
endpoint IDs or machine-specific probe output to the repository.
