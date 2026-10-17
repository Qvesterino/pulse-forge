# KYX DAW migration roadmap

**Status:** active product initiative, started 2026-10-17  
**Scope:** a low-friction, honest path for FL Studio, Cubase and Pro Tools users to continue work in KYX.  
**Related:** [full-DAW roadmap](./ROADMAP-FULL-DAW.md), [Web/Studio support matrix](./WEB-STUDIO-SUPPORT-MATRIX.md), [DAW capability audit](./DAW-CAPABILITY-AUDIT-2026-09.md)

This roadmap complements the full-DAW roadmap. It prioritizes bringing an existing song into KYX and completing useful work there. It does not promise native-project or plug-in-state conversion that KYX does not ship.

## Product outcome

A producer can bring an in-progress song from a familiar DAW into KYX, understand exactly what transferred, play and edit it, save/reopen it, and export it back as aligned audio/MIDI deliverables without changing or losing the original project.

The migration path should feel familiar without copying another DAW's interface. KYX should retain its own sound, terminology and creative workflow.

## Current baseline — 2026-10-17

| Area              | Shipped boundary                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| KYX projects      | The project browser imports validated KYX project documents (`.kyx` and legacy JSON-shaped projects).                                                                                                                                                                                                                                                        |
| Audio intake      | The Project Browser's **BRING A SONG FROM ANOTHER DAW** workflow accepts up to 32 selected audio files, checks the existing 25 MB per-file cap, shows aggregate audio size with a soft memory warning above 100 MB, and stages decoded audio as user assets with rollback on failure.                                                                        |
| Audio arrangement | The transfer wizard creates sampler-backed arrangement lanes at bar 1, lets users edit each output track name before import, sizes clips to source duration, and lets the user mark a reference mix muted. A distinct audio-track model is not required for this handoff.                                                                                    |
| MIDI intake       | The transfer wizard accepts one combined Standard MIDI file: up to 8 melodic tracks plus GM drums, note events on editable song clips, first tempo and first time signature. It reports tempo/meter maps, controller/program/pitch-bend/aftertouch/SysEx losses, and drum-grid mapping before import. Existing standalone MIDI import remains pattern-based. |
| Song workflow     | Independent MIDI clips, audio clips, long songs, save/reopen, offline rendering and grouped stem export are implemented; the support matrix keeps their evidence boundaries explicit.                                                                                                                                                                        |
| Recording         | Browser/software capture, takes and comping have software-path evidence. Physical routing, analog latency, reference-device qualification and native low-latency Windows audio remain open.                                                                                                                                                                  |
| Plug-ins          | CLAP discovery is metadata-only. CLAP audio processing and VST3/AU hosting are not shipped.                                                                                                                                                                                                                                                                  |
| Interchange       | **BRING A SONG** is a DAW-neutral audio + MIDI transfer path. There is no `.flp`, `.cpr`, `.ptx`, AAF or OMF importer; plug-in state, source fader/pan controls, routing, automation, tempo maps and native layout are not carried.                                                                                                                          |

Relevant implementation: `src/ui/ProjectBrowser.tsx`, `src/ui/TransferImportDialog.tsx`, `src/export/transfer-import.ts`, `src/ui/sample-import.ts`, `src/ui/DropZone.tsx`, `src/ui/PatternBar.tsx`, `src/midi/midiFile.ts`, `src/midi/midiProject.ts`, `src/commands/audioClips.ts`, `src/commands/midiClips.ts`, `src/export/scorepack.ts`.

## User journeys to support

### FL Studio producer

Bring a beat or song with separate mixer track renders and MIDI; retain the pattern/piano-roll mindset, drum programming and quick audition workflow; replace or re-create instruments/effects deliberately. FL Studio's own MIDI importer exposes track/channel selection and time-signature handling, so a useful KYX handoff must tell the user what was selected and what arrived. [Image-Line MIDI import manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/automation_midiimport.htm)

### Cubase producer

Bring long-form audio/MIDI material, tempo and meter context, track names and a reference mix; continue arranging, recording and exporting. Cubase's audio import can copy media into a project, convert to project settings and split multichannel audio; its MIDI export includes tempo and time-signature events. These are sensible expectations for a migration workflow. [Cubase audio import settings](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/importing_audio_and_midi/importing_audio_and_midi_on_import_audio_files_settings_r.html) · [Cubase MIDI export](https://www.steinberg.help/r/cubase-pro/cubasescore/15.0/en/cubase_nuendo_score_editor/topics/importing_exporting/exporting_midi_files_t.html)

### Pro Tools producer

Bring aligned track-outs, a reference mix and, where useful, MIDI; preserve edit timing and know whether processing is printed. Avid documents track-outs as separate audio files intended for transfer and recommends checking timing/alignment after reimport. AAF/OMF remains a later investigation, not a current KYX promise. [Avid track-out guide](https://www.avid.com/pro-tools/user-guide/exporting-individual-tracks)

## Delivery roadmap

### Phase 0 — truthful migration contract

- [x] Audit the current project, audio, MIDI, recording, export, device and plug-in boundaries.
- [x] Record this migration-specific roadmap and distinguish shipped, software-verified, hardware-verified and not-shipped capabilities.
- [x] Keep a first-run capability card honest: KYX project import, audio/MIDI transfer, audio hardware and plug-in-host status are separate claims in the Project Browser.

**Exit gate:** a user can tell before starting whether a transfer path is supported and what it cannot carry.

### Phase 1 — KYX Transfer Pack v1 / “Bring a Song”

Build a DAW-neutral route from standard exports rather than reverse-engineering three proprietary project formats.

- [x] Define the first accepted-input contract: file selection (no archive/parser dependency), project title/source-DAW guidance, user-selected tempo/meter, up to 32 named audio tracks, one combined MIDI file, optional muted reference mix, and explicit confirmation that all audio starts together at bar 1.
- [x] Add a preflight screen listing selected files, type/size, intended role, alignment rule, conversion boundary and unsupported MIDI/project data. Audio decoding and persistence are staged during import; a failure rolls back already staged assets before a project is saved.
- [x] Import selected audio as sampler-backed named arrangement lanes at the common origin; save a new project and preserve the original DAW project.
- [x] Preserve the user-selected source DAW as versioned project provenance and surface it in the project library; it records the transfer path, not a native project conversion.
- [x] Import MIDI notes onto editable song lanes, apply the chosen starting tempo and meter, and disclose unsupported timeline/controller data and GM drum mapping.
- [x] Add a versioned generated browser fixture with 8 decoded WAV lanes and 4 melodic MIDI lanes; verify save/reopen, media restoration, offline render and realtime playback on every MIDI lane in Chromium (`npm run test:browser:daw-transfer`).
- [x] Write repeatable source-export instructions for FL Studio, Cubase and Pro Tools, with vendor-manual links and explicit shared-range/import-size constraints (`docs/DAW-TRANSFER-EXPORT-GUIDE.md`).
- [x] Qualify realtime playback of the generated fixture; the browser acceptance gate checks non-silent MIDI track meters for all 4 lanes as well as master headroom.
- [x] Create a new KYX project and save it without changing the source DAW project.
- [ ] Repeat the full 8-audio/4-MIDI export→import→playback journey with source projects exported from installed FL Studio, Cubase and Pro Tools versions; qualify source-specific menus, timing and loss disclosure.
- [x] Include repeatable source-DAW export instructions and a generated v1 fixture. Real-DAW source projects remain a separate qualification gate. Do not claim full native-project conversion.

**Acceptance gates:**

1. A representative pack with 8 aligned audio lanes and 4 melodic MIDI lanes imports into a new KYX project with the chosen audio output names, MIDI names, and lane types intact.
2. Audio at a shared origin stays sample-aligned after decode/import, project save/reopen and offline render. v1 places every source at bar 1; explicit offsets are not supported.
3. MIDI notes, selected starting tempo/meter and track naming match the supported subset; unsupported material appears before commit in a human-readable report.
4. A malformed, oversized or partially undecodable selection fails safely and explains which file failed; staged user assets are rolled back and no project is saved.
5. The original files and source DAW project remain unchanged; the import creates a separate KYX project.
6. FL Studio, Cubase and Pro Tools export instructions are documented and repeatable from source export to KYX playback.

**v1 boundaries:** 32 audio files maximum, existing 25 MB per-file audio cap, a soft memory warning above 100 MB of selected audio, one MIDI file (10 MB maximum), up to 8 melodic MIDI tracks, GM drum notes on a 32-bar 16th-note grid, and no tempo/meter map, MIDI controller, plug-in, routing or automation transfer. User-selected project tempo/meter are stored globally. Audio is imported at bar 1 only. A manifest/archive may be added later if real user demand justifies the added transport and validation surface.

### Phase 2 — familiarity and first-session confidence

- Offer optional FL Studio, Cubase and Pro Tools onboarding profiles.
- Map common actions to KYX actions (pattern/playlist, arrangement, track selection, audition, record, comp, export) with shortcuts that users can inspect and change.
- Provide short “first song in KYX” walkthroughs using a bundled project; teach KYX's pattern/song distinction, timeline, browser, mixer and export in context.
- Add action search and contextual shortcut hints before adding DAW-specific UI modes.

**Exit gate:** a new user from each target DAW completes import → edit → save/reopen → export without needing hidden gestures or guessing terminology.

### Phase 3 — reliable Studio recording and hardware

- Follow the support matrix and audio-I/O ADR: name reference hardware, qualify driver/device routing, latency, stability, device loss/recovery and real take recovery.
- Make the core record → edit/comp → save/reopen → export workflow pass on the declared Studio setup.
- Keep Web software-path evidence separate from physical hardware support claims.

**Exit gate:** the published configuration has retained measurements and a repeatable hardware QA record; unsupported configurations have a clear fallback.

### Phase 4 — plug-in continuity

- Advance VST3 hosting only through ADR/licensing and the full-DAW roadmap: isolation, scan/blacklist, saved state, parameter automation, channel layouts, latency compensation, crash recovery and offline-render parity.
- Build a compatibility set from anonymized real user demand. Do not equate plug-in discovery with audio processing.
- During migration, let users choose between a rendered wet track, a dry track, or a KYX replacement effect. Show the choice before import.

**Exit gate:** representative plug-in projects reopen with state intact, crashes contained and live/offline audio behavior measured.

### Phase 5 — advanced exchange formats

- Measure actual demand for AAF/OMF and native FLP/CPR/PTX workflows after Transfer Pack v1 ships.
- Investigate licensing, format stability, test corpus rights and support burden before selecting any parser.
- Prefer official export APIs/neutral interchange, where available. Treat every format as a separately qualified compatibility matrix, not a blanket “opens DAW projects” claim.

**Exit gate:** only pursue a format with a legal/technical route, representative fixtures, explicit loss reporting and an owner for ongoing compatibility.

## Product principles and non-goals

- Preserve the original and make import reversible.
- Show the conversion and loss report before commit.
- Preserve KYX's sound character and workflow; familiarity is a bridge, not a clone.
- Start with a smaller set of dependable transfer paths. Do not add filler templates, empty shortcut profiles or speculative converters.
- Do not claim native project/plugin compatibility until tests prove the exact supported subset.
- Do not gate the migration roadmap on adding every specialist DAW feature; prioritize first successful song continuation.

## Metrics to track

- Time from choosing “Bring a Song” to hearing the imported project.
- Percentage of attempted imports completed without a manual repair step.
- Alignment and note/tempo/meter preservation on versioned fixture packs.
- Unsupported items shown before import versus discovered after import (target: zero silent loss).
- First-session completion by source-DAW profile: import, make one edit, save/reopen, export.
- Hardware/plugin compatibility reports linked to exact tested configurations and versions.
