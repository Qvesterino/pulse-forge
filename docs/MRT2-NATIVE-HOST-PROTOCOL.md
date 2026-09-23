# KYX MRT2 native host protocol v1

This document specifies the private, local stdio protocol between Electron's
main process and the packaged kyx-mrt2-host executable. The host is a fixed
release artifact, not a renderer-selectable service. It must not bind a network
socket or accept executable/model paths from protocol messages.

## Startup and shutdown

Electron launches the fixed packaged executable with:

    kyx-mrt2-host --model-root ~/Documents/Magenta/magenta-rt-v2

The helper loads the installed MusicCoCa assets and MRT2 Small model before
reporting ready. The first stdout line must be UTF-8 JSON, at most 4 KiB,
followed by LF:

    {"version":1,"type":"ready","providerId":"mrt2","modelId":"mrt2_small"}

No other startup message is accepted. After that line, stdout and stdin carry
length-prefixed binary frames. Stderr is diagnostic-only and is not forwarded
to the renderer. Electron sends a shutdown frame and closes stdin, then
escalates to SIGTERM/SIGKILL if the helper does not exit.

## Binary framing

Each frame is a 4-byte unsigned big-endian body length, followed by:

| Offset in body | Type           | Meaning                        |
| -------------- | -------------- | ------------------------------ |
| 0              | u8             | frame kind                     |
| 1              | u16 big-endian | UTF-8 transport-id byte length |
| 3              | bytes          | transport id                   |
| next           | bytes          | payload                        |

The body length includes the 3-byte frame header, id bytes and payload. A
transport id is at most 128 UTF-8 bytes. The empty id is valid only on the
Electron-to-host shutdown frame.

### Electron to host

| Kind | Payload                         | Purpose                       |
| ---- | ------------------------------- | ----------------------------- |
| 0    | UTF-8 JSON, at most 64 KiB      | Provider control message      |
| 1    | One complete KYXMRT2 PCM packet | Audio-style conditioning only |
| 2    | Empty                           | Close one renderer transport  |
| 3    | Empty, empty transport id       | Stop the helper               |

Control messages are MRT2 protocol v1 and only these client-to-provider types
are accepted: hello, session.create, input.update, session.start,
session.stop, session.close, and capture.start. Session creation is limited to
mrt2_small, 48 kHz, stereo output. The native host still validates all message
fields; Electron's allowlist is defense in depth.

Audio-style PCM uses the provider's existing 32-byte KYXMRT2\\0 packet header
and little-endian float32 samples. The packet kind must be style. Packets are
capped at 15 seconds, 192 kHz, two channels, and finite samples. The host must
consume/copy the PCM before returning from its input handler.

### Host to Electron

| Kind | Payload                               | Purpose                          |
| ---- | ------------------------------------- | -------------------------------- |
| 0    | UTF-8 JSON, at most 64 KiB            | Provider control response/status |
| 1    | One complete KYXMRT2 PCM packet       | Generated stereo output          |
| 2    | UTF-8 close reason, at most 400 bytes | Close one renderer transport     |

Output PCM uses the same header, with packet kind output. Packets must have
finite samples and a valid shape. Control and audio frames are tagged with the
same transport id as the request/session that produced them. Unknown or closed
transport ids are discarded by Electron; malformed frames terminate the
native host and close active renderer transports.

## Ownership and limits

- Electron allocates an unguessable transport id when the trusted KYX renderer
  opens a transport and binds it to that renderer's webContents.
- A renderer can send/close only ids it owns. Native events are relayed only to
  that owner. Destroying the renderer closes its transports.
- There is no renderer API for process execution, paths, arbitrary IPC channel
  names, or raw stdin frames.
- Electron caps control JSON at 64 KiB, PCM packets at 5,760,032 bytes, one
  native frame at 5,760,288 bytes, buffered output at two maximum frames, and
  queued child stdin at 12 MiB.
- The IPC adapter revalidates JSON shape, packet magic/version/kind/dimensions,
  packet byte length, and finite PCM before forwarding.
- A helper crash, malformed frame, startup timeout, or explicit stop emits a
  closed event for every live transport. Renderer code uses the existing
  Mrt2CompanionProvider lifecycle and does not silently reconnect.

## Native host v1 capability boundary

The checked-in Objective-C++ adapter currently supports text style prompts,
the first 25 Hz note-state frame translated to live note-on/off changes,
drumless on/off, live stereo output and bounded capture. The upstream runner
does not accept KYX's full scheduled note-frame array, so note timing follows
the existing 40 ms provider refresh cadence; it is not sample-accurate MIDI
scheduling. One process-wide RealtimeRunner means one active native generative
session at a time. A capture may reuse its owning active session.

The helper reports `supportsAudioStyle: false`, `supportsSeed: false`, and all
four product macros as `unsupported`. Upstream's current path-based audio
prompt API is documented in source as a fake embedding placeholder, and its
PCM API has no sample-rate parameter. KYX therefore refuses to pass raw audio
until the expected MusicCoCa PCM format and resampling path are confirmed with
the shipped model. Product macros likewise remain visible as wrapper concepts,
but the native helper does not pretend that they control MRT2.

Output is read from RealtimeRunner at its native 25 Hz cadence as 1920-frame,
48 kHz stereo packets. Capture packets are trimmed at the final frame to the
requested sample count; `capture.ok.frames` and duration describe that exact
PCM, while `inputHash` is SHA-256 of the sorted serialized conditioning input.
Text-encoder progress is surfaced as loading/ready/error status events.

## Build and remaining release validation

Electron's manager, fixed-path launch checks, framed transport, renderer
ownership boundary, and TypeScript provider adapter are implemented and unit
tested in KYX. The Objective-C++ source, CMake target, pinned upstream build
script, macOS arm64 packaging configuration and dedicated packaging command
are now in the repository. They have not been compiled or run here because
this development host is Windows. A supported macOS/Apple Silicon build must
compile and package the helper, then validate model loading, prompt readiness,
note timing, 48 kHz capture and long-stream behavior against the actual model
before the native availability indicator can be considered shipped.

On macOS 14+ Apple Silicon, with CMake 3.27+ and an existing local checkout
whose HEAD is the upstream `v2.0.3` tag:

    MAGENTA_REALTIME_SOURCE=/path/to/magenta-realtime npm run build:mrt2-native-host
    MAGENTA_REALTIME_SOURCE=/path/to/magenta-realtime npm run desktop:build:mac:mrt2

The first command builds only `kyx-mrt2-host` and writes the packaged input to
`build/mrt2-host/kyx-mrt2-host`. The second also runs the normal KYX production
build and packages arm64 DMG/ZIP artifacts. Model weights remain external in
`~/Documents/Magenta/magenta-rt-v2`; neither command downloads or bundles them.

The upstream C++ runner is documented for macOS 14+ and Apple Silicon. Its
audio/file API is not itself this IPC protocol, so the helper remains a small
KYX-owned adapter rather than an upstream binary. See the
[upstream core documentation](https://github.com/magenta/magenta-realtime/blob/v2.0.3/core/README.md)
and the [public realtime runner header](https://github.com/magenta/magenta-realtime/blob/v2.0.3/core/include/magentart/realtime_runner.h).
