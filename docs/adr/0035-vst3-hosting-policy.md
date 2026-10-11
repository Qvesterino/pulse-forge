# ADR 0035 — VST3 hosting policy (scan → offline render-through → real-time)

Date: 2026-10-07
Status: Wave 1 shipped (structural scan); Waves 2–3 planned

## Context

KYX Studio needs third-party plugin support to be a main DAW. VST3 is the
industry-standard format (Steinberg). The desktop shell already hosts
out-of-process plugin infrastructure on the ADR 0016 pattern: the CLAP probe
(crash-isolated scan per file), the MRT2 native host (IPC transport, process
isolation), and external PCM pipes. VST3 hosting follows the same discipline.

The web build CANNOT host VST3 — Web Audio cannot load native binaries. VST3
is desktop-only, forever, by architecture (ADR 0010/0011).

## Licensing gate (owner decision required before Wave 2 distribution)

The Steinberg VST3 SDK is dual-licensed: GPLv3 OR the Steinberg VST3 license
agreement. KYX is proprietary (all-rights reserved, see LICENSE), so shipping
SDK-linked binaries requires signing the free Steinberg VST3 agreement. The
Wave 1 structural scan links NO SDK code and ships freely; **any Wave 2+
SDK-linked distribution is blocked until the owner signs the agreement**.
Local development and testing are unaffected.

## Waves

### Wave 1 — structural scan (shipped, this ADR)

`native/vst3-probe` + `desktop/vst3-host-manager.cjs` + preload `kyxDesktop.
vst3.scan()`. Out-of-process STRUCTURAL enumeration of `.vst3` entries
(bundle layout, architecture modules, sizes) — no plugin code ever runs in
the probe, so a hostile plugin costs its own probe process at most
(ADR 0016 crash-isolation discipline). No Steinberg SDK linked — the probe
is pure Win32 C.

Deliberately NOT in Wave 1: factory enumeration (requires the SDK),
plugin audio processing, UI hosting.

### Wave 2 — offline render-through (planned)

KYX renders a range to PCM → the native host (VST3 SDK, out-of-process)
processes it through a user-selected plugin → the result returns as an audio
clip (bounce-through-plugin, like the existing Audio Canvas handoff shape).
No real-time monitoring, no GUI hosting: parameters are driven from KYX UI.
Plugin state (chunk) persists in the project document.

Wave 2 is gated by the Steinberg license agreement and the native host build
(msvc; per-plugin crash isolation stays out-of-process).

### Wave 3 — real-time hosting (planned, large)

Live plugin inserts in the mixer with PDC and GUI hosting. Explicitly out of
scope until Wave 2 is proven in production use.

## Consequences

- The renderer never names executables; the probe path comes from app
  resources; scanned paths are the only per-call input (ADR 0016 boundary).
- Probe stdout is a hostile network boundary: strict JSON validation, bounded
  line counts and byte caps, timeout kill.
- Chord track (v17), clip groups and locks (v15) are VST3-agnostic — plugins
  process audio; the arrangement model is unchanged.
- The absence of VST3 does not affect KYX Web, which ships its own effect
  rack (ADR 0005: no native DSP in the web build).
