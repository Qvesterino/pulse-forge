# ADR 0035 — VST3 hosting policy (scan → offline render-through → real-time)

Date: 2026-10-07
Status: Wave 1 shipped (structural scan); SDK licensing reviewed 2026-10-19; Waves 2–3 planned

## Context

KYX Studio needs third-party plugin support to be a main DAW. VST3 is the
industry-standard format (Steinberg). The desktop shell already hosts
out-of-process plugin infrastructure on the ADR 0016 pattern: the CLAP probe
(crash-isolated scan per file), the MRT2 native host (IPC transport, process
isolation), and external PCM pipes. VST3 hosting follows the same discipline.

The web build CANNOT host VST3 — Web Audio cannot load native binaries. VST3
is desktop-only, forever, by architecture (ADR 0010/0011).

## Licensing review (updated 2026-10-19)

The 2026-10-07 draft treated the SDK as dual-licensed and made a signed
Steinberg agreement an owner gate. Steinberg's current developer portal says
VST 3 has been under the MIT License since SDK version 3.8. For a Wave 2
implementation, pin VST SDK 3.8 or later and retain the applicable copyright
notice and license text in distributed copies or substantial portions. The
portal says most SDK files are MIT-licensed, with VSTGUI and mda files under a
BSD-like license, so inventory the exact files and notices used by the host.
Use of the VST name or logo is optional; if KYX uses either mark, follow
Steinberg's trademark rules. An older SDK or component outside those terms
requires its own review.

Sources: [VST 3 licensing](https://steinbergmedia.github.io/vst3_dev_portal/pages/VST%2B3%2BLicensing/Index.html),
[Steinberg VST SDK information](https://www.steinberg.net/developers/vstsdk/).
This licensing update removes the outdated signed-agreement prerequisite for
SDK 3.8+, but it does not implement or qualify VST processing, authorize a
specific SDK distribution, or change the host-isolation and acceptance gates
below. Wave 1 still links no SDK code.

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

Wave 2 is gated by the pinned SDK/file-license and notice audit, plus the
native host build (MSVC; per-plugin crash isolation stays out-of-process).

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
