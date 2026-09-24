# ADR 0013 — Windows generative companion tiers

Date: 2026-09-24  
Status: Accepted

## Context

KYX already has a provider-neutral generative runtime and a framed local
companion protocol. The shipped MRT2 C++ helper is intentionally macOS/Apple
Silicon-only because it is built on the upstream MLX/Metal path. Windows must
not attempt to execute that binary or claim realtime support before a measured
Windows inference backend exists.

The product still needs useful Windows behaviour: projects must load and edit,
generated takes must be capturable as ordinary audio clips, and a capable
Windows GPU may provide a future live stream. Those capabilities have different
performance and distribution requirements, so one boolean “MRT2 installed”
flag is insufficient.

## Decision

### 1. Windows is a separate companion backend

The macOS native helper remains owned by the existing Apple Silicon manager.
Windows gets a separate fixed companion executable/process that implements the
same versioned control and binary PCM protocol. The renderer can select a
provider, but it can never choose an executable, model path, command line or
environment.

The persisted provider id remains `mrt2` for project compatibility. Backend
identity is runtime capability data only (for example
`mrt2-windows-cuda`) and is not written into `ProjectDocument`.

### 2. Capability is tiered and explicit

Companions report one execution mode:

- `capture` — provider can produce a bounded take but cannot sustain live audio;
- `near-realtime` — experimental stream with visible latency/quality warnings;
- `realtime` — promoted only after the benchmark gate passes.

If neither capture nor live playback is available, the provider is
`unavailable`. A capture-capable provider must remain usable from the capture
workflow even when `GenerativeRuntime` correctly reports live playback as
unavailable.

The handshake may report backend id, runtime version, measured latency,
real-time factor and a human-readable warning. These values are host-local
diagnostics and are never persisted in a project.

### 3. The existing audio boundary remains authoritative

Windows inference runs in the companion process, never in React, the
Scheduler, an `AudioWorklet`, or an `OfflineAudioContext` callback. JSON carries
control messages only; PCM uses bounded binary packets and the existing
AudioWorklet/AudioEngine path. Capture remains the reproducibility boundary.

### 4. Backend order of preference

The implementation validates the upstream Python/JAX path first, then an
NVIDIA CUDA/WSL2 companion if native Windows GPU execution is not viable. A
native Windows C++ port is a separate future backend and is not implied by this
ADR. A failed benchmark downgrades the companion to `capture`, never to a
mislabelled realtime mode.

### 5. Distribution is optional and explicit

The browser bundle contains no model weights or Windows runtime. A future
packaged companion/model installer must verify fixed paths and hashes, expose
license/attribution data, and remain optional so a missing companion cannot
break boot, editing, playback of captured material or export.

## Benchmark gate

The Windows backend may advertise `realtime` only after a representative
hardware run demonstrates 48 kHz stereo output, p95 frame generation below
32 ms for the 40 ms provider frame, audio/wall-time factor at least 1.25, no
underruns during a 10-minute soak, finite PCM, stable memory, and successful
text, note-conditioning, drums and capture paths. Until then the UI reports
the measured tier and warning.

## Consequences

- Existing projects keep their `mrt2` provider id and remain portable.
- macOS native packaging and runtime checks remain unchanged.
- Windows can ship capture-only functionality before live inference is ready.
- The companion protocol and provider contract need capability-aware tests.
- A Windows model/runtime package needs its own dependency and license audit
  before release.
- The first reference adapter lives in
  `companion/mrt2-windows/kyx_mrt2_windows_host.py` and is packaged explicitly
  with `npm run build:mrt2-windows-host`. It uses the public JAX API for
  bounded capture when a compatible Windows JAX wheel and raw checkpoint are
  present; otherwise it reports `supportsCapture: false`.
- Release packaging has a separate SHA-256 manifest create/verify gate for the
  helper and model-root assets plus a guarded model-data uninstall script. No
  model files are committed to the browser or repository bundle.
