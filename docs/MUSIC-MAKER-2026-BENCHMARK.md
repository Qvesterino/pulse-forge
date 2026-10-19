# Music Maker 2026 → KYX product benchmark

**Audit date:** 2026-10-19

**Sources:** [MAGIX Music Maker](https://www.magix.com/int/music/music-maker/), the [official Music Maker feature list](https://www.magix.com/us/music-editing/music-maker/functions/) and its [2026 feature highlights](https://www.magix.com/int/music/music-maker/new-features/).

This is a feature and workflow benchmark, not a plan to copy MAGIX code, content,
names or visual design. Status is based on shipped KYX code and its architecture
decisions, not on roadmap intent.

## Audit status at a glance

| Area                                 | KYX status                                         | Evidence-based summary                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loop discovery and content           | Starter pack implemented; listening review pending | The browser filters imported loops and offers eight opt-in KYX-original loops across House, Techno, UK Garage and Trap.                                          |
| Loop preview and placement           | Partial                                            | BPM-tagged imports preview at project tempo and `Add` inserts a fitted, undoable audio clip; files without BPM cannot be tempo-matched automatically.            |
| Song foundation and generation       | Guided entry and loop demos implemented            | Genre, mood and BPM seed the song draft; users can install the first-party pack or open one of two saved loop-backed demo projects.                              |
| Clip pitch and tempo                 | Implemented                                        | AudioClip stores an undoable ±24-semitone offset separately from stretch rate; the dialog, project migration and shared live/offline trigger are covered.        |
| Live Pads and Live Sets              | Capture implemented; loop pack available           | KYX captures quantized pad performances into editable clips; the optional starter pack is available, while ready-made Live Set examples remain absent.           |
| MIDI multi-object editing            | Implemented                                        | Selected arrangement MIDI clips share one undoable batch editor for note-property transforms; a combined multi-pattern Piano Roll is an optional extension.      |
| Spectrum and EQ                      | Integrated workflow; visualizer partial            | Master spectrum and draggable EQ response now share the Mastering view; the spectrum remains single-color and EQ frequency/Q controls stay in the insert editor. |
| Effects and beat making              | Partial / unverified                               | Core effects, drum instruments and kits exist; common end-to-end workflows still need comparison.                                                                |
| Audio recording and export           | Partial                                            | Core recording and export exist, while formats and KYX Studio device support differ.                                                                             |
| VST3 processing and native audio I/O | Missing as shipping capabilities                   | KYX has structural plug-in scanning and native I/O experiments, but neither is qualified product processing/device support.                                      |

## Findings

### Loop discovery — partial

MAGIX describes its 2026 Loop Browser as optimized for faster browsing and adds
a Genre Filter, with Soundpool and instrument lists. KYX's `LOOPS` view browses
user-imported audio and filters by genre, mood, instrument, key and BPM range;
users can edit loop tags from the Sounds list. KYX now also offers an opt-in,
first-party loop catalog. MAGIX's edition comparison shows that Soundpool
availability varies by edition, so each KYX pack needs its own creation or
licensing decision. Users can correct or supply loop BPM in the tag editor when automatic
tempo detection is missing or wrong; the corrected value drives BPM filtering,
tempo-aware preview and fitted clip placement. The first KYX-authored pack
adds eight four-bar loops across House, Techno, UK Garage and Trap. It is an
explicit ~4.9 MB install, persisted with stable sample IDs for local/offline
use; the WAVs stay out of the app-shell precache.

### Loop audition and placement — partial

MAGIX positions its browser as a fast route from finding loops to song
arrangement. KYX previews on the next beat, and `Add` inserts a fitted
`AudioClip` through the command system, which makes the edit undoable and
project-persistent. This wave corrects preview playback rate. For tempo changes
of at least 1%, preview and clip playback share the same pitch-preserving
stretch renderer and cache; below that threshold, both use reciprocal
resampling. If stretch rendering fails, preview falls back to tempo-matched
resampling, which changes pitch.

### Song foundation — full-song generation exists; guided loop workflow partial

MAGIX Song Maker starts from a selected genre and lets users customize loops,
instruments and effects. KYX already has a broader text-to-song composer:
`composeFullTrack` builds a multi-section arrangement, previews it as a draft,
supports best-per-section or coherent full-song directions, and applies the
chosen song through an undoable command. Users can refine production intent
before applying it, and the draft reports section progress. The different
workflow is not a missing song generator. The project browser now has a guided
song starter for genre, mood and BPM. It creates the matching project template,
prefills the existing full-song prompt, opens the Intent panel, and opens the
loop browser with matching genre/mood and a nearby BPM range. Users can choose
the available key tag, audition against the project tempo and add a loop to the
arrangement. The remaining gap is ready-to-use content and a measured
first-session usability pass. The first pack and two loop-backed demos are
implemented; a listening review and usability pass remain.

### Pitch and tempo — implemented for core clip-pitch behavior

KYX audio clips store an undoable ±24-semitone pitch offset independently of
clip duration and tempo fit; live playback and offline rendering use the shared
trigger path. Evidence: `tests/audio-clip-pitch.test.tsx`,
`tests/clip-clipboard.test.ts` and `tests/offline-parity.test.ts`.

### Live Pads and Live Sets — performance capture implemented; starter loops available

MAGIX lets users assign loops to pads and launch them, and includes ready-to-use
Live Sets. KYX has project-local 4×4 sets. Outside arrangement capture, pad
launches create editable finite AudioClips. During capture, loop pads toggle
open-ended voices on bar boundaries while one-shot pads stay finite. FINISH or
transport stop commits the pad intervals with Scene launches in one undoable
command. Runtime voices use the Scheduler and AudioEngine; no project schema
change is needed. The implementation and limits are recorded in
[ADR 0055](adr/0055-live-pad-performance-capture.md) and covered by
`tests/live-pad-capture.test.ts` plus the existing Live Set tests.

The opt-in KYX Starter Loops pack supplies a small first set of playable loops;
a broader ready-to-use Live Set catalog remains a separate product gap.

### MIDI multi-object editing — published batch workflow implemented

MAGIX describes selecting several MIDI objects and editing all note properties
together. KYX supports Ctrl/Cmd-click toggling and Shift-range selection across
MIDI clips. Its context menu opens a batch editor for common note transforms:
transpose, time offset, duration/velocity scaling, fine pitch, pan, filter
expression, release velocity, Mod X/Y, slide flags and clearing per-note locks.
One command applies the edit across source patterns and one undo restores the
previous document.

Source identity stays predictable: selected clips sharing one pattern remain
linked to each other, while that source is cloned when an unselected MIDI clip
or scene still uses it. A locked selected clip disables the batch action.
Values are clamped to legal ranges and edits that extend a phrase can extend
the selected clips as part of the same command.

This satisfies the published multi-object property-edit workflow. It applies
the same transform to every note in each selected object; it does not combine
notes from different patterns into one Piano Roll canvas. MAGIX's feature page
does not claim that combined-canvas workflow, so treat it as a possible KYX
extension rather than a current parity gap.

### Spectrum and EQ — integrated master workflow; visualizer parity partial

MAGIX advertises Spectrum Visualizer 2 with a color-coded display and built-in
EQ. KYX now overlays a draggable master-EQ response on the live spectrum in the
Mastering workspace. The EQ is an ordinary master insert: the user adds it
explicitly, gain drags and bypass use the existing undoable commands, and the
effect rack remains the place to edit frequency and Q. The regular Mixer
spectrum stays read-only. This closes the basic integrated spectrum/EQ workflow
without changing DSP or project schema. Visualizer parity is still partial:
KYX's spectrum uses one accent color and the overlay exposes four gain handles,
not a color-coded multi-band visualizer with all controls in place.

### Effects and beat making — primitives implemented; workflow parity unverified

MAGIX lists 44 effects, chain presets, drag-and-drop and Beatbox Pro 3 custom
kits. KYX has a project effect rack, built-in drum instruments/kits and a broad
effect/plugin set. The matching primitives exist, but effect count does not
prove product parity. Compare common beat-building tasks in the UI before
changing the effect surface.

### VST3 and native audio I/O — partial and gated

MAGIX lists VST3 support. KYX Studio has a structural VST3 scan only; the web
build cannot host native VST binaries. Current Studio audio uses Web Audio and
browser-visible devices. VST3 render-through remains gated by the pinned SDK
version, file-license/notice audit and native host build in
[ADR 0035](adr/0035-vst3-hosting-policy.md). Native Windows streams remain
gated by [ADR 0050](adr/0050-windows-audio-io-direction.md).

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
  preview ratio, fitted placement, undo, refusal when a sample buffer is not
  ready, and manual BPM correction with range validation.
- Added an IndexedDB reload regression proving BPM and loop tags survive a read
  through a fresh `UserSampleRepository` instance.
- No schema migration was needed. Imported samples remain the available loop
  source; licensing or creating factory loop packs is outside this code wave.

## KYX Starter Loops v1 — implemented; listening review pending

The first pack contains eight deterministic, KYX-authored four-bar stereo
WAVs: drum and musical layers for House, Techno, UK Garage and Trap. The source
generator is `scripts/generate-kyx-starter-loops.mjs`; its versioned manifest
pins each stable ID, file size, SHA-256 hash, BPM, genre, mood, instrument and
key. No third-party recordings or sample files are included. The pack and its
credits are registered as `kyx-original` in `src/sample-library/licenses.ts`
and `public/licenses/credits.md`.

The Loop Browser installs the pack only after the user asks. It validates the
manifest and every WAV hash, decodes the audio and persists it through the
existing user-sample repository; the samples then restore from local storage
and the existing preview/placement path can use them. The Project Browser can
also install the pack and open either a saved Afterhours House or Half-Time
Trap demo with two arrangement clips. These projects remain local and reference
the stable pack sample IDs; sharing a project without its audio assets is not
yet a portable-pack workflow.

The pack is a functional first content drop, not a claim of release-ready
sound design. The next content gate is a human listening pass in KYX across
headphones and speakers, then tune transients, loop seams and mix levels before
expanding the catalog. No automated tests were run for this implementation
wave.

## Live Performance Capture wave delivered

- Extended `ArrangementCaptureController` with runtime-only pad start/stop
  intents and captured intervals alongside existing Scene launches.
- Loop pads now start and stop on one-bar Scheduler boundaries during Capture;
  repeated taps cancel queued starts or stops. One-shots remain finite and may
  layer, and different loop pads can play together.
- Reused the project track route and tempo-fit clip trigger. Captured intervals
  become ordinary finite `AudioClip`s and are appended with Scene clips using
  one undoable command; no source audio is flattened and no schema migration is
  needed.
- Added cleanup for pause, cancel, project replacement, close, panic and audio
  context loss. Existing non-capture one-tap behavior remains unchanged.
- Focused coverage: `tests/live-pad-capture.test.ts`,
  `tests/ui/LivePadsPanel.test.tsx`, `tests/live-sets.test.ts`,
  `tests/arrangement-variations.test.ts`, and `tests/audio-clip-pitch.test.tsx`.
- Remaining limits: one-bar quantization only; active voices keep the tempo fit
  chosen at launch; captured intervals shorter than the existing 0.25-bar
  `AudioClip` minimum are clamped; ready-made licensed loops and Live Set
  content are not part of this wave.

## Master Spectrum + EQ wave delivered

- The Mastering workspace overlays the existing interactive EQ response curve
  on the live master spectrum. The Mixer meter retains its read-only analyzer.
- The EQ is inserted only after the user selects `ADD EQ`; no effect is added
  automatically. Gain edits and bypass use the existing master-effect command
  path, so they participate in undo/redo and use the same live/offline DSP.
- Existing insert controls remain responsible for frequency and Q. This wave
  adds no project schema or audio-engine behavior.
- Focused coverage: `tests/ui/MasterSpectrumEq.test.tsx`,
  `tests/ui/MasterMeter.test.tsx`, `tests/eq-curve-gesture.test.tsx`, and
  `tests/offline-parity.test.ts`.
- Remaining visual gap: the spectrum is single-color and the overlay is the
  standard four-band EQ curve, not MAGIX's color-coded Spectrum Visualizer 2.

## Recommended benchmark order after this wave

1. **Song foundation listening and usability pass** — review the new loop pack
   on speakers and headphones, refine any weak loops, then observe a new user
   creating, saving, reopening and exporting a short beat.
2. **Spectrum visualizer parity** — assess whether color-coded frequency bands
   and direct frequency/Q gestures add enough value beyond the integrated master
   EQ and existing track FXEQ panel.
3. **Studio plug-in and device support** — continue only through ADR 0035's
   VST3 licensing gate and ADR 0050's native I/O measurements and support
   matrix.

## Guided song starter entry wave implemented

- Added a project-browser flow for genre, mood and BPM using the existing genre
  templates and full-song composer.
- The new project opens with a prefilled prompt and the Intent panel visible;
  the Sounds strip opens in LOOPS with genre, mood and a ±10% BPM window.
- Users choose a key from their imported loop metadata, preview at project
  tempo, and add clips through the existing undoable arrangement command.
- The Loop Browser also offers the opt-in KYX Starter Loops v1 pack; the
  Project Browser has Afterhours House and Half-Time Trap demo projects.
- The pack's next gate is human listening review and the new-user create/save/
  reopen/export usability pass.

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

| KYX target/path          | Current state                                                                                                                                                                 | Gate before a stronger support claim                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KYX Web                  | Web Audio engine and browser-visible devices; native VST binaries are outside this target.                                                                                    | Continue browser audio behavior; do not imply VST3 or native-device hosting.                                                                                                                             |
| KYX Studio Web Audio     | The current Electron shell still runs the Web Audio device path, with device selection and browser latency diagnostics.                                                       | Keep as fallback and report device/latency limits honestly.                                                                                                                                              |
| Windows WASAPI shared    | The packaged Studio connects exact shared-WASAPI endpoint sessions to the live AudioEngine through a bounded AudioWorklet/utility PCM bridge; hardware qualification is open. | Verify the Volt connector/channel map, device-clocked 30-minute duplex soak, analog round-trip latency and disconnect/reconnect recovery on the physical reference interface.                            |
| Windows WASAPI exclusive | A bounded probe opened, but had later discontinuities and lacks product qualification.                                                                                        | Remain opt-in/out of release until MMCSS, repeatable dropout-free operation and recovery pass.                                                                                                           |
| Windows ASIO             | Fixture boundary exists; the reference Volt's registered driver was 32-bit and could not load in the 64-bit probe.                                                            | Confirm a supported x64 driver and licensing/distribution route; fixture success is not device support.                                                                                                  |
| VST3                     | Out-of-process structural `.vst3` scan only; no SDK-linked processing or UI hosting.                                                                                          | Pin VST SDK 3.8+ and retain the applicable MIT/BSD-like notices; Wave 2 offline render-through must prove state round-trip and per-plugin crash isolation before Wave 3 real-time hosting is considered. |

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
  `src/ui/SpectrumAnalyzer.tsx`, `src/ui/MasterSpectrumEq.tsx`, `src/ui/MasterMeter.tsx`,
  `src/ui/FxEqPanel.tsx` and `src/effects/fxeq-core/`.
- Full-song generation and draft application:
  `src/intent/compose.ts`, `src/ui/IntentPanel.tsx` and
  `src/ui/intent/SongDraftPanel.tsx`.
- Live Pads, clip pitch, VST3 and Windows I/O: `docs/CURRENT-STATE.md` and the
  ADRs linked above.
- Proposed Live Pad runtime capture contract: `docs/adr/0055-live-pad-performance-capture.md`.
