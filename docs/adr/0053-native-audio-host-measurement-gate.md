# ADR 0053 — Native audio host (Oboe + C++ DSP): measurement gate

- **Date:** 2026-10-18
- **Status:** Accepted as a **decision gate** — no native audio host is built yet
- **Scope:** the decision whether KYX Mobile needs a native audio path for
  tracking/monitoring, and the evidence required to start it
- **Related:** ADR 0051 (mobile runtime profile), ADR 0052 (native shell
  boundary), ADR 0005 (no WASM DSP path today), ADR 0014 (full-DAW scope)

## Context

ADR 0051 makes v1 a PWA/TWA and deliberately does not claim low-latency
tracking. ADR 0052 adds an optional native shell for MIDI/SAF/foreground/focus,
but not a native audio engine.

A native host (Oboe/AAudio + C++ DSP) is a second engine. It would need its own
voice/effect graph, live/offline parity, golden vectors, background service,
device matrix and long-term maintenance. Building it because a vendor number
*looks* high would be a speculative rewrite. Building it only after measuring
the actual acoustic path is the discipline this ADR encodes.

The repository already has the measurement primitive:
`measureAudioRoundTrip` sends a pulse train through the output and detects it at
the microphone with echo cancellation/noise suppression/AGC disabled. The
latency calibration wizard uses it and stores the result.

## Decision

### 1. No Oboe/C++ host until the gate passes

Phase 3 starts only when the exported latency report shows that Web Audio
blocks the tracking use case on the **target device set**. Until then, native
audio code is not written, not scaffolded and not promised.

### 2. Evidence protocol

For each representative device (minimum: one low-end, one mid-range, one
flagship; at least five devices in total):

1. Use wired headphones or an acoustic output→mic return; **no Bluetooth**.
2. Close other audio apps; screen on; default browser zoom.
3. Run the latency calibration at the device's native sample rate.
4. Run it three times; export the JSON report each time.
5. Record the device model/OS from the report's `environment` block and whether
   the result was stable (`measurement.stable`).
6. Store the reports with the device matrix; the report schema is
   `kyx.mobile.latency.v1` and includes the exact thresholds used.

`baseLatency`/`outputLatency` are recorded but are **not** the gate: they are
browser-reported and optimistic. The acoustic loopback round trip is the gate.

### 3. Decision matrix

The report computes `verdicts.nativeHostForTracking`:

| Acoustic round trip (stable) | Verdict | Action |
| --- | --- | --- |
| ≤ 15 ms | `no` | Web Audio meets live monitoring; no native host |
| 15–25 ms, or ≤ 15 ms but unstable | `marginal` | Native host only if professional monitoring is a product requirement; otherwise improve device guidance/buffer/effect defaults |
| > 25 ms | `yes` | Native host is justified for tracking; start a separate implementation ADR |
| no measurement | `unmeasured` | Do not decide; run the protocol |

A `yes` on any **supported** target device is sufficient to justify the native
host only for that class; it is not a mandate to move sequencing/mixing off Web
Audio. The hybrid path (native tracking + Web Audio composition) is allowed.

### 4. If the gate says yes

The native host must:

- use Oboe/AAudio with an explicit low-latency stream and a measured
  round-trip/underrun report;
- implement DSP in C++ with golden vectors shared with the web engine (same
  musical results, not necessarily the same node graph);
- keep the project schema and command semantics unchanged;
- report latency and provide live/offline parity tests;
- be a separate ADR with its own support matrix, signing/build gate and device
  soak; plugin hosting is out of scope until that ADR says otherwise.

It must not be a Flutter rewrite and must not replace the web engine for
composition/mixing by default.

### 5. If the gate says no/marginal

Close Phase 3 with the evidence. Do not add native audio code. Re-open the gate
when a new device class, browser, or product requirement changes the data.

## Consequences

- The latency audit is a product feature, not a one-off benchmark: the wizard's
  **DOWNLOAD REPORT** button exports the exact JSON the decision consumes.
- Real-device testing remains an owner gate; repository tests cover the report
  maths/schema, not acoustic latency.
- No speculative `android/` audio project is added to the repo.
- A `marginal` result is a product decision, not a silent upgrade: it must be
  documented in the support matrix.

## Alternatives rejected

1. **Build Oboe now.** Unjustified second engine without evidence.
2. **Trust vendor/browser latency numbers.** `baseLatency`/`outputLatency` are
   not the acoustic path and vary by route/device.
3. **Flutter rewrite.** No audio-engine benefit (ADR 0051).
4. **Use a native host for everything.** Sequencing/mixing do not need it; a
   hybrid path keeps the web engine where it is strong.

## Verification

Repository: `tests/mobile-latency-audit.test.ts` pins the schema, threshold
boundaries, unmeasured behavior, environment collection and JSON safety.
Owner: device matrix with at least five real devices, three runs each, wired
loopback, exported reports, and the resulting `nativeHostForTracking` decision.
