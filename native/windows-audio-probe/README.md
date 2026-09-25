# Windows audio capability probe

This small, read-only WASAPI diagnostic is a technical-spike aid for KYX Studio.
It lists active render/capture endpoints, the shared engine mix format, device
periods, default and `AudioCategory_Media` `IAudioClient3` shared-mode periods,
and whether common mono/stereo PCM/float formats are accepted in shared or
exclusive mode.

It does **not** initialize or start a stream, read microphone samples, record
audio, change Windows device settings, or measure round-trip latency. The audio
category is set only on the temporary client object so Windows can report the
matching shared-mode period range. Reported periods and format support are
capability evidence only; a real stream soak and loopback measurement are still
required before a device/backend is certified.

## Build and run (PowerShell)

Requires Visual Studio C++ build tools, the Windows SDK, and CMake.

```powershell
$probeBuildDir = Join-Path $env:TEMP 'kyx-windows-audio-probe'
cmake -S native/windows-audio-probe -B $probeBuildDir -A x64
cmake --build $probeBuildDir --config Release
& (Join-Path $probeBuildDir 'Release/kyx-windows-audio-probe.exe')
```

The output includes endpoint names, so review it before sharing. Do not add raw
endpoint IDs or machine-specific probe output to the repository.
