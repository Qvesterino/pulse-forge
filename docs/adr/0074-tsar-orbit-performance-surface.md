# ADR 0074 — TSAR ORBIT: the 2-D performance surface (and the timed parameter path it needed)

Date: 2026-10-28 · Status: Accepted · Scope: the TSAR ORBIT surface (model,
commands, panel), the automation upsert a recording needs, and the TSAR
runtime's timed parameter writer

## Context

The flagship roadmap's wave 5 is small on paper and large in fact:

> Jednoduchá 2D X/Y plocha s voliteľným priradením na stabilné ciele (napr.
> source morph, cutoff, modulácia intenzita); mapovanie sa uloží s patchom;
> pohyb sa nahráva cez existujúcu projekt automatizáciu; overiť myš, dotyk,
> klávesnicu; MIDI learn/MPE až po overení celej cesty vstup → projekt →
> prehrávanie → export.

TSAR R6 adds the shape of the thing: a few CLEAR mapping presets plus custom
assignment (do not clutter), the movement recordable as project automation and
editable back in the existing KYX workflow, mouse/touch/keyboard (MIDI later),
**the UI is not the source of truth for the audio callback**, and the mapping
stored with the sound so the performance behaviour travels with it.

Two facts in the codebase decided how this wave had to be built. Both were
measured against today's tree, not assumed.

### Fact 1 — a recorded curve on a TSAR parameter could not survive an export

The automation bridge schedules every device parameter through
`setParameterAt` when the runtime offers one, and falls back to `setParameter`
when it does not (`src/audio-engine/deviceLookup.ts`). TSAR had **no**
`setParameterAt`: `tsarNode.setParameter` posts `{type:"param", name, value}`
with no time, and the worklet applied such a message immediately.

The consequence is not subtle. In an offline render every point of a recorded
curve was written before the first sample, so the LAST point won for the
whole render. The export was not the performance — it was the performance's
last frame, held for two minutes.

The DSP was never the obstacle: `TsarProcessor` already had a timed event
queue (`postEvent` / `applyEvent` / the in-block drain at the event's own
sample boundary). What was missing was the runtime and the worklet plumbing.

### Fact 2 — there was no "write a value at a tick" command

`addAutomationPoint` INSERTS; its duplicate guard blocks an _identical_
`(tick, value)` pair, so two different values at one tick could sit in a lane
side by side. A recording walks through ticks and writes the value it found
there, so it needs the opposite: one point per tick, the newest value wins.

## Decision

### 1. The mapping lives with the patch; the position IS the parameter value

`InstrumentTrack.orbit` holds the mapping — which parameter each axis drives
and over which range. The POSITION of the surface is not stored anywhere
else: it **is** the two parameters' values, in the track's ordinary `params`.

One number, one truth. The value the producer sees on the pad, the value the
engine plays and the value an automation lane writes are the same number, so
they cannot drift apart. What the mapping adds is what a value cannot say:
which parameter, over which range.

The mapping therefore needs a structured optional field — it is not a number,
so it cannot ride in `params`. `SCHEMA_VERSION` goes 39 → 40 with an
`additive` ledger entry (no `MIGRATIONS` step: the field is simply absent in
older documents, and absent means "no ORBIT surface").

**The project model checks the mapping's SHAPE, not its catalogue
membership.** A well-formed mapping (an object with two axes, each a
non-empty `paramId` and two finite numbers with `max > min`) is kept; a
malformed one is dropped, because "absent = no ORBIT surface" is the honest
state for a surface that cannot be described. Whether a given parameter may
be assigned to an axis is a PRODUCT catalogue (`src/tsar/orbit.ts`), not a
property of the document: a normaliser that depended on it would rewrite a
saved project whenever the catalogue changed, silently, with no schema
version to explain it. The catalogue check belongs where the surface is used
— the commands and the panel — and the panel says so when a fallback
happened, because a silent fallback would look like the surface ignoring the
producer.

The panel is the shell; `src/ui/TsarOrbit.tsx` is an inert renderer. The UI
holds no authoritative state — it derives what it draws from the project and
dispatches what the producer did (R6).

### 2. The target catalogue is curated, and it excludes what the engine cannot interpolate

The axes are a deliberate subset of TSAR's 76 parameters, not "all of them".

Discrete and enum parameters are out. The automation bridge does not
interpolate an enum or a toggle — it writes raw point events for them — so an
interpolated axis over `srcAEngine` would sweep through engine indices that do
not exist. Grain and scan parameters are out for a second reason: their
audibility depends on the source engine being granular/wavetable, and no
liveness rule models that yet. An axis whose silence cannot be predicted is
an axis that lies.

What remains is what a performer reaches for: morph, cutoff, Q, filter
envelope, spread, tune, envelope times, the mod-matrix depth, drift, tone,
drive, width, the LFO rate.

### 3. The liveness rules are the mutation engine's, reused

Wave 4 had to learn, from the DSP, which axes reach no ear (an open filter
kills Q, a silent source kills its cutoff, the global morph needs both
sources, `srcASpread` needs unison, a mod slot with no source or no
destination is off). `isOrbitAxisLive` **reuses** `isMutationAxisLive`
rather than growing a second rule set that could drift apart, and adds
exactly one rule the mutation engine does not need (the mod slot).

The panel says why an axis is silent. It does not refuse to move it: the
producer chose that target, and the truth is worth more than a veto.

### 4. A movement is ONE undoable step; the recording is ordinary project automation

The gesture is bracketed by the host (`beginUndoFrame` / `endUndoFrame`), so a
whole drag is one history entry — the Ozvena blend pad's convention, not a
third dialect.

The recording writes into the ordinary automation lanes of the two axis
parameters, through a new **upsert** command (`setAutomationPointAt`) that
keeps one point per tick and preserves the point's identity when it
overwrites. The result is a curve the existing lane editor can draw, move and
undo — not a private format that only ORBIT understands.

MIDI learn / MPE stays deferred, exactly as the roadmap says: the whole
input → project → playback → export path is proved first.

### 5. The timed parameter path (the engine change the gate forced)

- `src/instruments/tsarNode.ts` gains `setParameterAt`. Live: the message
  carries `when`, so the worklet routes it through the event queue. Offline:
  the event is **BUFFERED** and seeded into `processorOptions.events` at the
  offline barrier — an `OfflineAudioContext` does not pump the port queue
  during a render, which is why the notes use the same seeding contract.
- `src/tsar-worklet.entry.js` (and the rebuilt `public/tsar-worklet.js`)
  splits the two cases: a param message WITHOUT `when` stays immediate, one
  WITH `when` joins the event queue.
- A scheduled write is an **OVERRIDE**: it does not touch the runtime's param
  mirror. That mirror is the project's base value, and the offline seed
  snapshots it — if the curve's last point became the base, the whole render
  would start from the end of the performance.

## Evidence

Measured, not asserted. The timing suite loads the **real built worklet
bundle** (`public/tsar-worklet.js`) in Node with the AudioWorklet globals
stubbed, and then:

- a param message without `when` still applies immediately (no regression);
- a param message with `when` does **not** apply on arrival, and lands at its
  own time on the audio clock;
- the runtime posts the `when` live, and **buffers** the event offline into
  the worklet's seeded queue;
- the DSP render: the audio **before** the event is bit-identical to the flat
  render, the audio **after** it differs, and the energy after it really
  moves (a closed filter removes energy — the curve is heard, not merely
  re-digitised);
- two renders of the same script are bit-identical (the export is
  deterministic).

The model and the commands are measured too: every target is a registered,
continuous parameter; a damaged mapping still loads as a working surface; two
axes on one parameter are refused; one point per tick survives a
re-recording; the original mapping comes back with one command; the mapping
survives a save/load round trip.

**Gate — TSAR ORBIT**

| Gate                                                     | Verdict | Evidence                                                                                  |
| -------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| movement has an audible response                         | PASS    | the DSP render's energy after the event moves (the timing suite)                          |
| recorded automation survives save                        | PASS    | the mapping and the lane survive `normalizeProject` round trip (the command suite)        |
| recorded automation survives playback                    | PASS    | the live path posts the `when`; the scheduler writes the lane at the window's own time    |
| recorded automation survives the offline export          | PASS    | the curve is heard at its own time in the render; before the event the audio is identical |
| the projects stay deterministic                          | PASS    | two renders of the same script are bit-identical                                          |
| the original mapping can be restored, simply             | PASS    | `restoreDefaultOrbitMapping` — one command, no dialog                                     |
| mouse / touch / keyboard                                 | PASS    | pointer capture, one undo frame per drag, arrows + Shift + PageUp, typed numeric fallback |
| the UI is not the source of truth for the audio callback | PASS    | the panel derives and dispatches; the project model holds the mapping and the position    |

## Consequences

- TSAR can carry a recorded curve into an export for the first time. Other
  instruments already could; the flagship was the one that could not.
- The mapping travels with the patch. A producer who opens the project on
  another machine gets the same surface under the same hand.
- A track's `orbit` field is optional and absent by default: every non-TSAR
  track, and every TSAR track that never used the surface, is untouched.
- The slider taper math moved to `src/shared/taper.ts` so a DOM-free domain
  module can use it. `src/ui/controls.tsx` re-exports it, so every existing
  import site is unchanged.
- The liveness rules moved to `src/tsar/liveness.ts` and the ORBIT commands
  are **not** re-exported from the command barrel. Both moves exist for one
  reason: the studio boot path is the App shell's static closure, and a
  lazy surface must not ride into it. The surface and its commands cost
  **0 KB** of boot path; what remains is the engine fix and the model field.
- MIDI learn / MPE is still deferred — deliberately, and with the reason
  written down: the input → project → playback → export path is proved first.

## Bundle cost (measured, isolated)

The SAME tree (`4d9e96f5`) built twice — once with this wave's changes and
once with them reverted — in one isolated worktree, so the co-tenant
sessions' concurrent commits cannot contaminate the delta.

| Metric           | Before | After | Delta  | Ceiling |
| ---------------- | ------ | ----- | ------ | ------- |
| DAW JS chunks    | 5917   | 5932  | +15 KB | 5630 KB |
| studio boot path | 2199   | 2201  | +2 KB  | 2200 KB |
| shipped JS total | 8419   | 8434  | +15 KB | —       |

Two facts belong to the budget owner, and neither is comfortable: the DAW-JS
gate was **already red by 287 KB** before this wave (the wave adds 15 of the
302), and the **boot path was green before this wave with 1 KB of headroom**
and crosses the ceiling by 1 KB. The split is measurable: the surface and
its commands are lazy and cost 0 KB of boot path; the 2 KB that remain are
the `orbit` shape check in the schema, the UPSERT command and the timed
writer in the TSAR runtime — boot-critical by nature. The ceiling was **not**
raised.

## What this ADR does NOT change

- The instrument registry, the effect registry, the preset formats.
- The `AutomationPoint` / `AutomationLane` shapes. The upsert is a command,
  not a schema change.
- The scheduler, the audio bridge and the renderer's shape. They already
  scheduled parameters at a time — TSAR was the runtime that could not
  receive one.
- The bundle ceilings. The measured cost is published in
  `docs/CURRENT-STATE.md`; the decision on the ceiling is the budget owner's.
