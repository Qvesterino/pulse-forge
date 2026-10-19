# Windows audio host primitives

This directory contains a Windows-only WASAPI shared-mode duplex session,
bounded float32 channel-map and SPSC ring helpers, and a Node-API wrapper for
Electron's utility process. KYX Studio connects the utility session to the live
AudioEngine through `desktop/windows-audio-session-host.cjs` and
`src/audio-engine/windowsAudioIoBridge.ts`: bounded recycled PCM packets carry
master output to WASAPI, and captured PCM reaches arrangement recording through
the worklet bridge. Offline rendering stays on the regular offline graph.

The desktop smoke validates synthetic PCM transport and confirms that an
unknown endpoint ID is rejected. It also verifies the current Electron
boundary: ordinary MessagePort control messages arrive, while a renderer
SharedArrayBuffer payload does not. The smoke does not open a physical audio
device, so this product connection is implemented but has not yet been
qualified for device-clocked latency, analog round-trip, physical channel
identity, reconnect behavior, or a sustained hardware soak. The Volt 276 was
absent during the latest endpoint check.

The production utility observes native startup phases. If a driver-facing
WASAPI call has not returned within seven seconds, it sends the current phase
to the renderer and exits its isolated process so the next user retry gets a
fresh host. This bounds recovery; it does not qualify or repair a device path
that hangs during capture initialization or start.

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
back to a default endpoint. Separate-device clock drift correction and physical
Volt testing remain open. The integrated session contract uses bounded
ArrayBuffer packets because SAB does not cross into the utility process in
Electron 44.4.3. The smoke exercises synthetic copied packets only; it does not
measure the integrated path against a physical device.

Build and run the local checks on Windows with:

```powershell
npm run build:windows-audio-host
```
