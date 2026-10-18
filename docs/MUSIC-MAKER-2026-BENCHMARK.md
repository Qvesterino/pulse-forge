# Music Maker 2026 → KYX product benchmark

**Audit date:** 2026-10-18  
**Sources:** [MAGIX Music Maker](https://www.magix.com/int/music/music-maker/) and the [official Music Maker feature list](https://www.magix.com/us/music-editing/music-maker/functions/).

This is a feature and workflow benchmark, not a plan to copy MAGIX code, content,
names or visual design. Status is based on shipped KYX code and its architecture
decisions, not on roadmap intent.

## Findings

### Loop discovery — partial

MAGIX presents a dedicated browser with genre filtering and Soundpool and
instrument lists. KYX's `LOOPS` view browses user-imported audio and filters by
genre, mood, instrument, key and BPM range; users can edit loop tags from the
Sounds list. KYX has no bundled tempo-tagged loop catalog. The MAGIX page makes
clear that Soundpool availability varies by edition, so a KYX content pack needs
its own creation or licensing decision.

### Loop audition and placement — partial

MAGIX positions its browser as a fast route from finding loops to song
arrangement. KYX previews on the next beat, and `Add` inserts a fitted
`AudioClip` through the command system, which makes the edit undoable and
project-persistent. This wave corrects preview playback rate. For tempo changes
of at least 1%, preview and clip playback share the same pitch-preserving
stretch renderer and cache; below that threshold, both use reciprocal
resampling. If stretch rendering fails, preview falls back to tempo-matched
resampling, which changes pitch.

### Song foundation — partial

MAGIX Song Maker starts from a selected genre and lets users customize loops,
instruments and effects. KYX has project templates and text-to-beat /
generative workflows, but no equivalent one-step genre-to-loop arrangement
backed by a curated loop catalog. A later wave can connect genre intent to
KYX-owned loop metadata and the existing project/command model.

### Pitch and tempo — implemented for core clip-pitch behavior

KYX audio clips store an undoable ±24-semitone pitch offset independently of
clip duration and tempo fit; live playback and offline rendering use the shared
trigger path. Evidence: `tests/audio-clip-pitch.test.tsx`,
`tests/clip-clipboard.test.ts` and `tests/offline-parity.test.ts`.

### Live Pads and Live Sets — partial

MAGIX lets users assign loops to pads and launch them, and includes ready-to-use
Live Sets. KYX has project-local 4×4 sets, bar-quantized launch and commands
that create editable finite AudioClips. Open-ended stop/relaunch performance
behavior is not shipped, and KYX has no bundled set catalog.

### MIDI multi-object editing — first batch-edit slice implemented

MAGIX describes selecting several MIDI objects and editing their note
properties together. KYX now supports Ctrl/Cmd-click toggling and Shift-range
selection across MIDI clips. Its context menu opens a batch editor for common
note transforms: transpose, time offset, duration/velocity scaling, fine pitch,
pan, filter expression, release velocity, Mod X/Y, slide flags and clearing
per-note locks. One command applies the edit across source patterns and one
undo restores the previous document.

Source identity stays predictable: selected clips sharing one pattern remain
linked to each other, while that source is cloned when an unselected MIDI clip
or scene still uses it. A locked selected clip disables the batch action.
Values are clamped to legal ranges and edits that extend a phrase can extend
the selected clips as part of the same command.

This is a batch property editor, not a combined Piano Roll canvas. It applies
the same transform to every note in each selected object; users still cannot
see and select individual notes across multiple source patterns in one piano
roll. That aggregate visual editing workflow remains the main parity gap.

### Spectrum and EQ — partial

MAGIX advertises Spectrum Visualizer 2 with a built-in EQ. KYX's master
Spectrum Analyzer observes an existing `AnalyserNode`, while the effect rack
also offers FXEQ's frequency-band editor and separate EQ effects. Those are
useful existing tools, but the master analyzer is observer-only and does not
let the user shape EQ directly against its live spectrum. This is a workflow
gap, not an absence of spectrum or EQ processing.

### Effects and beat making — primitives implemented; workflow parity unverified

MAGIX lists 44 effects, chain presets, drag-and-drop and Beatbox Pro 3 custom
kits. KYX has a project effect rack, built-in drum instruments/kits and a broad
effect/plugin set. The matching primitives exist, but effect count does not
prove product parity. Compare common beat-building tasks in the UI before
changing the effect surface.

### VST3 and native audio I/O — partial and gated

MAGIX lists VST3 support. KYX Studio has a structural VST3 scan only; the web
build cannot host native VST binaries. Current Studio audio uses Web Audio and
browser-visible devices. VST3 render-through requires the owner license
decision in [ADR 0035](adr/0035-vst3-hosting-policy.md). Native Windows streams
remain gated by [ADR 0050](adr/0050-windows-audio-io-direction.md).

### Recording and export — core workflows exist; platform and format parity differs

MAGIX lists direct audio/MIDI recording and common export formats. KYX has
track-input audio recording, MIDI input/recording and export paths for WAV,
FLAC, MP3, OGG and M4A. KYX Studio still uses the Web Audio device path, so its
native I/O capability remains a separate gated stage; the format lists also
differ.

## Loop Browser wave delivered

- Reused the existing `UserSampleRepository`, loop metadata, sample bank,
  `fittedLoopPlacement`, `addAudioClip` command and project persistence.
- Corrected the preview playback-rate direction: `targetBpm / sourceBpm`.
  Clip insertion intentionally retains its separate `sourceBpm / targetBpm`
  duration factor because the clip stretch renderer preserves pitch.
- Shared that renderer and cache with tempo-matched preview, so the audition
  normally matches the inserted clip's timing and pitch. If rendering fails,
  the preview retains tempo matching through resampling, which changes pitch.
- Added focused coverage for all metadata filters, both ends of the BPM range,
  preview ratio, fitted placement, undo, and refusal when a sample buffer is not
  ready.
- No schema migration was needed. Imported samples remain the available loop
  source; licensing or creating factory loop packs is outside this code wave.

## Next implementation specification — Live Performance Capture

### Shipped behavior

- A project stores up to 32 Live Sets, each with sixteen assignable pads.
- Launch is quantized to the next bar while the transport is running.
- A pad launch creates a finite, tagged, editable `AudioClip` in Song mode;
  loop length is selected from 1/2/4/8/16 bars.
- The UI reports active finite clips, and source loops retain their complete
  audio when they are longer than the selected clip length.

The finite clip workflow is implemented in `src/ui/LivePadsPanel.tsx` and
`src/commands/liveSets.ts`; current coverage is in
`tests/ui/LivePadsPanel.test.tsx` and `tests/live-sets.test.ts`.

### Proposed parity wave

Add live loop voices that can continue until a quantized stop or retrigger.
Treat pad launches and stops as musical events owned by the scheduler and audio
engine. React may show the active state, but must not schedule or own audio
voices. On stop, turn the captured launch/stop interval into a normal finite
`AudioClip` through one command, so the result is editable, saveable and
undoable. Reuse the existing sample reference, tempo-fit and shared live/offline
trigger path; do not bake the loop into a new audio file just to capture a pad
performance.

Before implementation, an ADR should settle these interaction details:

1. Whether launching the same active pad stops it or restarts it at the next
   quantized boundary, and whether a different pad stacks or replaces it.
2. The default launch/stop quantum (bar is the current behavior) and whether a
   set can choose a finer grid independently from its loop duration.
3. Whether stopping transport finalizes active pad intervals or cancels them.
   Finalized clips should enter project history as one undoable performance
   capture and autosave through the existing lifecycle.
4. How to report a launch whose sample is still loading or whose target track
   disappears before its queued boundary.

### Acceptance gates

- Launch, stop and retrigger occur on the selected musical boundary under a
  controlled transport clock; stopped-transport behavior is explicit.
- Multiple simultaneous pads follow the chosen stack/replace rule and do not
  leave voices after stop, panic, set deletion or project switch.
- Finalized intervals create correctly placed finite AudioClips with BPM fit,
  fades and source metadata preserved. One undo removes a capture and redo
  restores it.
- Save/reopen, live playback and offline export preserve the captured result;
  clip edits and tempo changes continue through the existing commands,
  project model and trigger path.
- Empty pads and failed asset loads do not create voices or undo entries.

This stage fills the gap between today's finite pad-to-arrangement action and
MAGIX's published real-time pad workflow. It does not depend on copying MAGIX
code, sound assets or interface design.

## Recommended benchmark order after this wave

1. **Live Performance Capture** — the next concrete workflow gap above.
2. **MIDI multi-object editing** — batch note-property transforms are now
   implemented for selected timeline objects. Next assess a combined Piano
   Roll view that aggregates selectable note events from those objects.
3. **Spectrum + EQ workflow** — keep the existing FXEQ and EQ processors, then
   measure whether exposing selected-track analysis with direct EQ editing is
   worth a dedicated surface.
4. **Song Maker and licensed content** — compare a complete genre-to-song task
   using KYX templates and generation. Decide whether KYX should author its own
   loop pack before adding a bundled catalog.
5. **Studio plug-in and device support** — continue only through ADR 0035's
   VST3 licensing gate and ADR 0050's native I/O measurements and support
   matrix.

The MAGIX feature page confirms the reference workflow list (recording, Song
Maker, Loop Browser, pitch controls, MIDI multi-object editing, Live Pads, a
spectrum visualizer with built-in EQ, VST support and export formats). Its
edition comparison also ties sound-library size and included instruments to
specific paid editions. Use those facts as a product benchmark, not as proof
that each feature behaves like KYX or as a license to reuse MAGIX content.

## KYX Studio plug-in and device boundary

No VST3 processing or native Windows device claim should be made from the
current discovery tools. The code and two accepted ADRs establish this
support matrix:

| KYX target/path          | Current state                                                                                                                                          | Gate before a stronger support claim                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KYX Web                  | Web Audio engine and browser-visible devices; native VST binaries are outside this target.                                                             | Continue browser audio behavior; do not imply VST3 or native-device hosting.                                                                                                                    |
| KYX Studio Web Audio     | The current Electron shell still runs the Web Audio device path, with device selection and browser latency diagnostics.                                | Keep as fallback and report device/latency limits honestly.                                                                                                                                     |
| Windows WASAPI shared    | A native duplex adapter core and IPC experiments exist, but they are not connected to the product AudioEngine and have no qualified live hardware run. | Real connector/channel mapping, 30-minute duplex soak, analog round-trip measurement, device-loss recovery and AudioEngine integration.                                                         |
| Windows WASAPI exclusive | A bounded probe opened, but had later discontinuities and lacks product qualification.                                                                 | Remain opt-in/out of release until MMCSS, repeatable dropout-free operation and recovery pass.                                                                                                  |
| Windows ASIO             | Fixture boundary exists; the reference Volt's registered driver was 32-bit and could not load in the 64-bit probe.                                     | Confirm a supported x64 driver and licensing/distribution route; fixture success is not device support.                                                                                         |
| VST3                     | Out-of-process structural `.vst3` scan only; no SDK-linked processing or UI hosting.                                                                   | Owner signs the Steinberg VST3 agreement before Wave 2. Wave 2 offline render-through must prove state round-trip and per-plugin crash isolation before Wave 3 real-time hosting is considered. |

These are the existing gates in [ADR 0035](adr/0035-vst3-hosting-policy.md)
and [ADR 0050](adr/0050-windows-audio-io-direction.md); this benchmark adds no
new licensing interpretation and does not authorize native implementation.

## Evidence in KYX

- Browser, metadata editor and actions: `src/ui/SampleBrowser.tsx` and
  `src/ui/BrowserStrip.tsx`.
- Preview BPM conversion and shared stretch rendering:
  `src/audio-engine/loopTempo.ts`, `src/audio-engine/previewDeck.ts` and
  `src/audio-engine/stretchedAudioBuffer.ts`.
- Fit and undo boundary: `src/commands/clipEditing.ts` and
  `src/commands/audioClips.ts`.
- Imported-sample metadata: `src/persistence/UserSampleRepository.ts`.
- MIDI source navigation and note-selection boundary:
  `src/ui/arrangement/MidiClipLanes.tsx`,
  `src/ui/ArrangementPanel.tsx` (`openMidiClipSource`) and
  `src/ui/PianoRoll.tsx` (`SelectedNotes`).
- Spectrum and frequency editing:
  `src/ui/SpectrumAnalyzer.tsx`, `src/ui/MasterMeter.tsx`,
  `src/ui/FxEqPanel.tsx` and `src/effects/fxeq-core/`.
- Live Pads, clip pitch, VST3 and Windows I/O: `docs/CURRENT-STATE.md` and the
  ADRs linked above.
