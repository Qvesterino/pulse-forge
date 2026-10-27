# ADR 0068 — A value the domain had to change is disclosed, not silently rewritten

Date: 2026-10-27 · Status: Accepted (shipped) · Scope: command layer, project store, MCP surface

## Context

The audit (F-12, `STATE_DIVERGENCE_HUNTER_REPORT.md`) measured a divergence between what a caller
**asked for** and what the project actually **holds**:

- A command whose label says _"Set PRISM Cutoff"_ wrote a **different value** than the one that was
  asked for. The command clamped it — correctly, an out-of-range cutoff must not reach the DSP —
  but the clamp was **invisible**: the toast carried the label only, and the human (or the agent)
  could not tell an honoured request from a rewritten one.
- The report named `normalizeProject` as the authority, because it runs after **every** apply,
  coalesce, undo and redo (`src/store/ProjectStore.ts`) and clamps among others the master family
  (limiter lookahead 1..20 ms, release 10..2000 ms, LUFS target −24..0, loudness trim ±12 dB).

**Measured, the report's prescription aimed one layer too low.** The reachable silent clamps live
in TWO places, and neither of them is where the report put the fix:

| producer                                                                            | what it clamps                                                      | reachable through             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------- |
| the **command** (`clampEffectParam`, `clampInstrumentParam`, `clampTargetValue`, …) | effect / instrument / automation / plugin / send / return values    | every parameter write         |
| the **normaliser** (`normalizeProject`)                                             | the master family, the legacy `limiterStereoLink` field, `liveSets` | `setMasterConfig` and friends |

The command clamps **before** the normaliser sees the document, so on the command path the
normaliser has nothing left to clamp for the parameter families — and the command's clamp is
exactly the one the report never named. `setMasterConfig` is the opposite case: it does **not**
clamp at all, so the normaliser is the only clamp there.

## Decision

**A value the caller set is either honoured, or the change is disclosed.** The disclosure travels
**on the command**, and lands in `Command.detail` — the mechanism the toast already renders.

1. **The vocabulary** — `src/shared/clamp-report.ts`. A leaf module (no domain imports, so the
   effects, the project model, the commands and the store can all use it without a layering
   inversion):
   - `ValueClamp` — a number the caller asked for that the domain had to change
     (`requested → applied`, plus the authoritative range when the producer knows it).
   - `RepairClamp` — a document field the domain removed or filled in beyond the command's label.
   - `describeClamps(events)` — one line for the toast. The parameter is **always** named: a bulk
     command's label is generic (_"Set parameters"_), and a line that said only _"clamped to 20"_
     would not say **which** parameter moved. Repetitions of one parameter collapse to `×N`.
2. **The command layer reports.** The clamp helpers take an **optional sink**
   (`clampEffectParam(type, paramId, value, sink?)`, and the same for the instrument, target and
   trim helpers). A command factory collects the events and attaches them to the command
   (`Command.clamps`). With no sink installed — a read path, the engine's own sync — the behaviour
   is exactly as before.
3. **The normaliser's footprint is read from the document.** `normalizeProject` returns the **same
   object** when it changed nothing, so the store compares the document the command produced with
   the document the normaliser returned (`src/store/clampRepairs.ts`). The difference between the
   two IS the normaliser's footprint and nothing else — the command's own write is already on the
   "before" side. The delta is computed **only** when the normaliser actually repaired something.

   > **Measured** (2026-10-27, `tmp-probe/f12-normalizer-footprint.test.ts`): a legal effect-param
   > write, an out-of-range effect-param write (the command clamps it, so the normaliser sees a
   > legal value) and a track creation all leave a footprint of **zero** ops. An out-of-range
   > master-config write leaves exactly the three clamped fields. The reader therefore reports
   > only real repairs — there is no noise on the common path.

4. **The store composes the disclosure.** `ProjectStore.applyCommand` folds both sources into
   `Command.detail` (`withClampDetail`) and pushes the composed command onto the undo stack, so
   `lastCommandDetail` — the toast's channel — carries it. The collab store (`YDocStore`) does the
   same through the undo manager's item metadata, so the toast shows it in a collab session too.
5. **The MCP answer states it.** The MCP's own per-tool disclosure (`clamped: boolean`,
   `requestedValue` vs `value`) stays — it is the tool's read-back and it is already correct. The
   command-level disclosure is **added**: every MCP write passes through one choke point, which
   collects the clamps the command carries and the normaliser's footprint, and appends them to the
   answer text — the one channel every transport forwards verbatim.

## The coverage boundary (and why)

- **Parameter clamps are reported.** A knob, a fader, an automation value, a master setting — the
  caller expressed an intent and the domain changed it.
- **Structural clamps stay silent.** Ticks, bars, array indices, MIDI pitch (0..127), note
  velocity, and a fade bounded by its own clip's geometry. These are coordinates, not musical
  values; they are clamped on every drag, and a toast per tick would be noise that teaches the
  reader to ignore the toast.
- **A refusal is not a silent clamp.** `addAutomationRamp` and the live-set list REFUSE an
  out-of-range write (`throw`). A loud refusal is a disclosure; F-12 covers writes that were
  changed without a word.
- **The UI's own range enforcement stays.** `parseTypedControlValue` (`src/ui/controls.tsx`) snaps
  a typed value to the control's range before it reaches a command — the conventional behaviour
  (Ableton does the same) and the last line of defence for the ~50 controls whose command does not
  clamp. The command-layer report therefore covers the **API / script / agent** callers; the
  human's typed value is disclosed by the control itself, which visibly shows the value it
  accepted.

## Consequences

- The toast gains a second line for a clamped write: _"Set PRISM Cutoff"_ /
  _"clamped PRISM Cutoff 999 → 20 (allowed 20..20000)"_.
- The MCP answer gains the same information for every write path, including the ones that did not
  pre-clamp.
- The clamp helpers gained an optional parameter — source-compatible, and every existing caller
  keeps its behaviour.
- The store pays one reference check per apply (the normaliser returns the same object when it
  changed nothing); the delta is computed only when a repair actually happened.

## Regression plan

`tests/clamp-disclosure.test.ts`:

1. the clamp helper reports what it changed, and stays silent for a legal value;
2. an out-of-range parameter write carries the disclosure on the command;
3. the store folds the disclosure into the toast detail, and a legal write stays silent;
4. the normaliser's footprint on a command is disclosed (the master family clamps there);
5. a legal master write leaves no footprint and no disclosure;
6. the instrument path discloses, and the clamped value is what landed;
7. the automation path discloses and names the parameter it moved;
8. the MCP answer states the clamp, so the agent learns what LANDED.
