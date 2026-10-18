# Windows audio host primitives

This directory contains a Windows-only WASAPI shared-mode duplex session,
bounded float32 channel-map and SPSC ring helpers, and a Node-API wrapper for
Electron's utility process. The desktop smoke loads the wrapper there and
confirms that an unknown endpoint ID is rejected. It also verifies the current
Electron boundary: ordinary MessagePort control messages arrive, while a
renderer SharedArrayBuffer payload does not. No native device is opened by this
check, and the adapter is not yet connected to the KYX AudioEngine.

Channel maps are ordered by project channel. Input copies the selected
endpoint channels into project order; output routes project channels to the
selected endpoint channels and clears unused endpoint channels. Maps must be
unique and in range. The caller supplies separate, non-overlapping buffers;
the channel-map helper performs no allocation. The SPSC FIFO allocates its
fixed-capacity storage at construction (maximum 32 MiB per direction) and
supports exactly one producer and one consumer; reads and writes allocate
nothing.

`WasapiSharedDuplexSession` requires exact active capture and render endpoint
IDs, one exact sample rate and a period accepted by both `IAudioClient3`
streams. It currently requests float32 shared mode only; unsupported formats
fail explicitly. It uses event-driven capture/render, MMCSS, bounded rings,
channel maps, stream-latency reports, xrun counters and endpoint-loss events.
Retry means constructing a new session with the selected IDs; it never falls
back to a default endpoint. Separate-device clock drift correction, the
product PCM bridge, AudioEngine/worklet routing and real Volt testing remain
unimplemented. The session contract uses bounded ArrayBuffer packets as a
candidate transport because SAB does not cross into the utility process in
Electron 44.4.3. The smoke exercises synthetic copied packets only; it does not
stream native audio.

Build and run the local checks on Windows with:

```powershell
npm run build:windows-audio-host
```
