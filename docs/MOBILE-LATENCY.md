# KYX Mobile — latency measurement and the native-host gate

Decision gate: [ADR 0053](./adr/0053-native-audio-host-measurement-gate.md).
Runtime profile: [MOBILE.md](./MOBILE.md).

Phase 3 (Oboe/AAudio + C++ DSP) is **conditional**. This document is the
measurement protocol and the only evidence that may start it.

## What is measured

The existing latency calibration measures the **acoustic output → microphone →
input round trip** with eight short pulses. It disables echo cancellation,
noise suppression and automatic gain control. The result is a median round trip
plus median jitter and a stability flag.

The browser-reported `baseLatency` and `outputLatency` are recorded too, but
they are **not** the tracking gate: they are device/browser estimates, not the
acoustic path.

## How to run it

1. Use **wired headphones** or a physical output→input loopback. Do not use
   Bluetooth; its codec/buffer latency is not representative of the app path.
2. Close other audio apps. Keep the screen on and the browser at default zoom.
3. Open **Settings → Latency calibration** (the wizard is available on desktop
   and mobile).
4. Run the audio test three times; each run should report at least five matched
   pulses and a stable result.
5. On the result screen press **DOWNLOAD REPORT**. The JSON is the evidence.
6. Name/store the file per device and date. A suggested path outside the repo:
   `release-evidence/mobile-latency/<model>-<os>-<date>-run<N>.json`.

The report is `kyx.mobile.latency.v1` and contains:

- `environment`: UA, Android platform/model/version (when User-Agent Client
  Hints are available), sample rate, reported base/output latency, AudioWorklet
  support, CPU/memory hints, mobile profile.
- `measurement`: acoustic round trip, jitter, pulse count, stable, sample rate,
  measuredAt — or `null` when the loopback was not run.
- `verdicts`: `liveMonitoring`, `midiToSound`, `sequencing`,
  `nativeHostForTracking`.
- `thresholds`: the exact values used, so the decision is reproducible.
- `reasons`: human-readable evidence, including the "reported, not acoustic"
  caveat.

## Aggregate the evidence

```bash
npm run mobile:latency-summary -- release-evidence/mobile-latency
```

The aggregator validates `kyx.mobile.latency.v1`, groups reports by device,
requires **five devices with three valid runs each**, and prints the same
decision matrix. It exits non-zero while the evidence is insufficient; it does
not invent a device or average across models. A single unstable run is treated
as marginal, not as a pass.

## Decision matrix

| Acoustic round trip (stable) | `nativeHostForTracking` | Action                                                                                    |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| ≤ 15 ms                      | `no`                    | Web Audio meets live monitoring; no native host                                           |
| 15–25 ms, or unstable        | `marginal`              | Native host only if professional monitoring is required; otherwise tune defaults/guidance |
| > 25 ms                      | `yes`                   | Native host is justified for tracking; open the implementation ADR                        |
| no measurement               | `unmeasured`            | Do not decide; run the protocol                                                           |

A `yes` on a supported device class justifies the native host for that class,
not a migration of composition/mixing away from Web Audio. A hybrid path is
allowed.

## Device matrix template

| Device      | SoC/RAM | Android | Browser/TWA | Run 1 | Run 2 | Run 3 | Stable | Verdict |
| ----------- | ------- | ------- | ----------- | ----- | ----- | ----- | ------ | ------- |
| (low-end)   |         |         |             |       |       |       |        |         |
| (mid-range) |         |         |             |       |       |       |        |         |
| (flagship)  |         |         |             |       |       |       |        |         |
| tablet      |         |         |             |       |       |       |        |         |
| TWA build   |         |         |             |       |       |       |        |         |

Record the JSON reports next to the table. Do not average across devices; the
decision is per device class.

## Limits

- Speaker→microphone measurements include the acoustic flight time and room
  reflections; wired loopback is the reference.
- Browser permission policies may deny the wake lock/microphone; that is not a
  latency result.
- Web Audio does not expose underruns/xrun counters. The report does not
  pretend to; stability/jitter is the available proxy.
- A single fast phone is not evidence for the fleet. The gate requires at least
  five real devices and three runs each.
- This report cannot prove a native host will be faster; it only proves whether
  the web path blocks tracking. The native implementation gets its own
  measured acceptance criteria in the follow-up ADR.
