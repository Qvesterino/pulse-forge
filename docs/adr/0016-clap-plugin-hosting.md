# ADR 0016 — CLAP plugin hosting (out-of-process, wave 1 = scanning)

Date: 2026-09-27
Status: Accepted (wave 1 shipped; waves 2–4 planned, see support matrix)

## Context

ADR 0014 authorizes full-DAW scope, including third-party plug-in hosting,
and requires for each capability "its dedicated follow-up ADR, licensing
review where applicable, measurable acceptance tests and an honest support
matrix". This ADR is that follow-up for plug-in formats, and records the
decision made there: **CLAP first**.

CLAP (Cleave Audio Plugin API) is MIT-licensed, has no certification gate
unlike AAX/AU, is the format modern DAWs converge on, and its C ABI is
loadable from a minimal host without any SDK runtime. VST3 would additionally
require GPLv3/proprietary dual-licensing decisions and Steinberg's agreement
track; AU is macOS-only. The desktop shell today is a thin Web Audio shell
(ADR 0010/0011); the browser cannot load native binaries at all, so hosting
is desktop-only by construction.

## Decision

**Out-of-process by construction.** Plugins never load into the Electron
renderer or the audio process. The host stack is layered:

1. **`clap-probe`** (`native/clap-probe/`, C, MIT CLAP 1.2.10 headers
   vendored byte-exact by `scripts/vendor-clap.mjs` with a SHA-256 manifest):
   loads ONE `.clap` binary, walks its `clap_plugin_factory`, prints one
   bounded JSON line per plugin descriptor, exits. Exit codes classify the
   file: 0 probed, 2 not-a-CLAP, 3 init refused / version incompatible,
   4 usage. It never instantiates and never processes audio.
2. **`desktop/clap-host-manager.cjs`**: spawns one probe per file
   (`shell: false`, kill-on-timeout), strictly validates and bounds the JSONL
   output, aggregates scans, quarantines files whose probe crashed or hung.
   The renderer never names an executable — the probe path comes from app
   resources or the dev-tree default; scanned paths are user-picked files
   passed as a single argument.
3. **Waves 2–4 (not shipped)**: an audio host process (PCM + events over a
   framed pipe, block-locked to the engine), parameter/GUI bridges, and
   project-model device integration. Each wave updates this ADR before
   landing; the audio host must prove drift/latency acceptance tests against
   the live/offline parity rule (invariant 3) before any UI exposure.

**Licensing review.** The CLAP API is MIT; the vendored headers keep upstream
LICENSE (`native/clap-probe/CLAP-LICENSE`). KYX links nothing from plugins —
the probe `LoadLibrary`s user-installed files, the same relationship any DAW
has with user plugin libraries. No plugin binaries ship with KYX.

**Support matrix (honest).**

| Capability                                  | Status                                                           |
| ------------------------------------------- | ---------------------------------------------------------------- |
| Scan installed `.clap` files, list metadata | Shipped (wave 1, Windows x64)                                    |
| Run a CLAP plugin's audio in the graph      | Not shipped                                                      |
| CLAP parameter/GUI/state extensions         | Not shipped                                                      |
| VST3 / AU / AAX                             | Not planned for now                                              |
| macOS / Linux probe                         | Not shipped (mirrors the `native/mrt2-host` pattern when needed) |

**Measurable acceptance (wave 1).** `tests/clap-host.test.ts` verifies the
vendored manifest byte-exactness and, when the MSVC toolchain is present
(`npm run build:clap-probe`), drives the real probe end-to-end against two
compiled fixtures: a valid one-plugin CLAP (`org.kyx.test.clap-fixture`) and
a DLL without `clap_entry` (classified not-a-CLAP). Manager behavior
(malformed JSONL dropped, exit-code classification, hung-probe kill,
signal-death quarantine) is pinned with a scripted fake spawn so the suite
runs green on machines without the toolchain, skipping only the native
end-to-end tests with an explicit reason.

## Consequences

- A crashy or hostile plugin can never take down the DAW during scanning —
  the blast radius is one probe process. The same isolation boundary is the
  foundation the wave-2 audio host must extend, not weaken.
- Scanning is O(files) processes; for large libraries the manager should
  batch with a concurrency cap before any UI shows scan progress.
- The vendored header tree is byte-exact upstream (no divergence policy,
  unlike the fxeq/ultina/ozvena cores), so an SDK upgrade is a re-vendor
  with a manifest diff.
- `clap-probe.exe` is a developer/desktop artifact only: it never enters the
  web bundle, and `npm run build` budgets are untouched.
