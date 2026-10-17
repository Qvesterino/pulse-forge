# ADR 0050 — Windows audio I/O direction

- **Date:** 2026-10-17
- **Status:** Accepted evaluation policy; native stream implementation remains gated
- **Scope:** KYX Studio for Windows, with the UA Volt 276 as the first reference interface

## Context

KYX Web and the current Electron Studio use the same Web Audio engine. The
Studio I/O panel can select browser-visible input and output devices, report
the live context sample rate and latency fields, and run an output test tone.
Recording requests the saved input ID exactly, can request 1–8 capture
channels, and stops into durable recovery when the input track ends or mutes.
These are Web Audio capabilities; Electron does not yet own a native device
stream or a user-selectable hardware period.

The Windows probe evidence is intentionally bounded:

- On 2026-10-15, the Volt endpoints opened concurrently in shared WASAPI at
  48 kHz, stereo float32, with a 480-frame / 10 ms requested period and a
  1,056-frame / 22 ms endpoint buffer. The 30-second capture had one
  first-packet discontinuity and no later discontinuities, timestamp errors,
  device-position gaps, silent packets or timeouts; render queued silence.
  This did not verify physical connector mapping, audible input, monitoring,
  or analog round-trip latency. See the [Volt smoke record](../WINDOWS-AUDIO-SPIKE-2026-09.md#volt-shared-mode-smoke--2026-10-15).
- The Volt's `IAudioClient3` shared-period range was 480 frames for the tested
  format and audio category, so this evidence does not establish a lower
  shared-mode period on that endpoint.
- An exclusive-mode probe opened at the reported 3 ms minimum but had three
  later discontinuity flags and no MMCSS service-thread profile. It is not
  qualified for product use. Exclusive mode can also take the endpoint from
  other applications.
- The installed Volt ASIO registration was 32-bit-only in the 64-bit process
  probe. The fixture ASIO host and its soak prove the transport/host boundary,
  not the Volt driver. ASIO discovery and the fixture are documented in
  [ADR 0017](./0017-smpte-asio-discovery.md) and [ADR 0018](./0018-pcm-pipe-transport.md).
- A read-only endpoint enumeration on 2026-10-17 did not find the Volt
  connected. The 2026-10-15 result is retained as historical smoke evidence;
  no new hardware stream was opened in that check.

Microsoft documents `IAudioClient3` as the shared-mode API for querying legal
engine periods and initializing a stream at one of those periods. The period
must be within the reported range and aligned to the engine's fundamental
period. Invalidated endpoints require releasing the old client and attempting
to reactivate the selected endpoint; selecting a replacement is a user-visible
choice when the original device is gone. See
[IAudioClient3 shared audio streams](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient3-initializesharedaudiostream),
[Windows low-latency audio](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/low-latency-audio),
and [recovering from an invalid device](https://learn.microsoft.com/en-us/windows/win32/coreaudio/recovering-from-an-invalid-device-error).

## Decision

1. **Keep Web Audio as the current shipped device path and fallback.** The
   Studio UI must report browser capability limits honestly. A missing saved
   endpoint stays visible as missing; it is never silently changed to System
   default. Browser `baseLatency`, `outputLatency`, and WASAPI's reported
   stream latency are not presented as a measured acoustic round-trip result.
2. **Use WASAPI shared mode as the first native Windows streaming candidate.**
   It is the only path in this evidence set that completed a bounded concurrent
   Volt capture/render run. The product host must use `IAudioClient3` only with
   formats and periods returned as supported by the selected endpoint. The
   initial Volt support claim is 48 kHz shared mode; the 10 ms period is a
   measured endpoint constraint, not a KYX latency guarantee.
3. **Keep WASAPI exclusive mode opt-in and out of the release path** until a
   fresh test has explicit user consent, the correct MMCSS profile, repeatable
   dropout-free capture/render, and an audible recovery test. A 3 ms reported
   period alone is not evidence of low or stable round-trip latency.
4. **Do not select ASIO as the Volt default on this machine.** The detected
   Volt ASIO registration cannot load in the current 64-bit host. Reconsider
   ASIO after a usable x64 driver is installed and its licensing/distribution
   route is cleared. Discovery and fixture success do not count as hardware
   streaming support.
5. **Keep endpoint and channel intent explicit.** Input and output endpoints
   are separate selections. The host negotiates and reports the actual sample
   rate, sample format, input/output channel counts, period and buffer. A
   requested input channel count must either be satisfied exactly or fail
   before recording. Physical jack-to-channel mapping is a separate measured
   setup and is not inferred from the endpoint name or channel count.
6. **Device loss stops the selected stream; it never changes endpoint by
   itself.** The audio host reports an invalidated endpoint to Studio, closes
   its client and keeps already committed capture blocks available for
   recovery. The user may retry the same endpoint or explicitly select another
   endpoint. Stale buffers from a prior stream generation must not enter a new
   take.
7. **Do not route realtime PCM through React or ordinary Electron control
   IPC.** The audio callback boundary must use preallocated bounded buffers and
   report xrun/overrun counters. ADR 0018's framed pipe is already proven for
   source transport and renderer playback, but its tests do not establish a
   bidirectional, device-clocked AudioEngine path. The memory/clock bridge is
   an implementation gate, not an assumed property of the existing pipe.
8. **Use hardware direct monitoring when appropriate and label software
   monitoring honestly.** KYX cannot change the Volt's hardware monitor blend.
   Software monitoring stays optional and reports the device/context latency
   that is available; it is not described as zero-latency.

## Measurable implementation and qualification gates

- A typed backend contract must enumerate/select endpoints, negotiate format
  and period, select an exact channel map, start/stop duplex streams, report
  clock position, latency, xruns and errors, and support stop/retry after device
  loss. Project files may store user intent but never device handles or native
  audio objects.
- Before enabling native I/O in the product, test a real Volt signal on each
  intended input and output connector, verify channel identity with distinct
  left/right tones, and retain a 48 kHz shared-mode capture/render record.
- Run a 30-minute duplex soak on the selected physical configuration. Pass
  requires zero later discontinuities, timestamp errors, device-position gaps,
  event timeouts, non-finite captured samples and unreported xruns. Report the
  first-packet startup event separately.
- Measure acoustic round-trip latency through an analog cable loopback at the
  exact sample rate/period. Retain raw repeated measurements and p50/p95/max;
  do not substitute WASAPI `GetStreamLatency`, a software loopback estimate or
  a listening impression. If the measured software-monitor p95 exceeds 20 ms,
  label it high latency and recommend hardware direct monitoring until another
  mode passes the same measurement.
- Unplug the selected interface during capture and render. Pass requires an
  explicit error, no fallback endpoint, no duplicate/stale PCM after reselect,
  retained committed capture blocks, and a successful deliberate reconnect
  without restarting the project.
- Prove software input channel routing and offline render parity with distinct
  synthetic tones; separately prove physical channel identity with analog
  input. Keep the two evidence classes separate.

## Consequences

- Native Windows I/O remains **not shipped**. The decision records an evidence-
  led direction, not a user-facing support claim.
- The next engineering step is a typed capture/output backend contract and a
  measured Electron-to-host PCM bridge spike. No native host is integrated
  until callback isolation, bounded buffering, duplex clock behavior and
  shutdown/recovery pass software tests.
- The Volt reference setup stays **Open** while the device is absent and until
  physical channel mapping, analog latency, recovery and the sustained soak
  have evidence. The current record is in the
  [support matrix](../WEB-STUDIO-SUPPORT-MATRIX.md) and
  [Windows audio spike](../WINDOWS-AUDIO-SPIKE-2026-09.md).
