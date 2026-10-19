# Export a song from another DAW into KYX

This guide describes a repeatable DAW-neutral handoff using aligned audio files and one Standard MIDI File. It does not convert `.flp`, `.cpr`, `.ptx`, AAF or OMF projects. Menu names below were checked against the official manuals linked at the end on 2026-10-17; they can vary by installed version.

## Before exporting

1. Save a copy of the source project. MIDI preparation or commit operations can change the current session state.
2. Choose one common range from the session/song start through the intended ending. Include any reverb or delay tail you want to keep.
3. Export one full-range file per track, with every file starting at that same range origin. Do not trim initial silence or export isolated clips: KYX v1 places all imported audio at bar 1 and does not preserve per-file offsets.
4. Decide whether each audio track should be dry or have its track effects printed. Source fader, pan and effect choices may be baked into each WAV depending on the DAW export point; KYX receives the rendered audio, not those editable controls. Export one optional full mix as a reference and mark it as **Reference (muted)** in KYX.
5. Use PCM WAV when each file fits the current **25 MB per-file** import limit. Choose mono for genuinely mono sources; retain stereo where the track needs it. Do not force a smaller range or normalise individual tracks unless that is intentional for the new mix. KYX currently supports up to 32 audio files and one MIDI file up to 10 MB.
6. Export a single multitrack MIDI file for editable instrument parts. Include the starting tempo and meter. KYX v1 imports up to eight melodic tracks and GM drums; CC7 volume and CC11 expression become track-volume automation, CC10 becomes track-pan automation, and CC64 sustain extends note lengths. Other controllers and pitch bend are reported before import.
7. In KYX, choose **Bring a Song**, select all track-outs and the combined MIDI file, check that the names and file sizes are right, confirm they share an origin/range, review the loss report, then import as a new project. Keep the original DAW project.

### File-size reality

The current audio import ceiling is 25 MB for each file. A 44.1 kHz stereo PCM WAV is approximately 10.1 MiB/minute at 16-bit or 15.1 MiB/minute at 24-bit, before small headers. A long, high-resolution track-out can exceed the ceiling even though the DAW exported it correctly. KYX also warns when the selected audio files exceed 100 MB in total because decoded PCM can require considerably more memory than the encoded files. KYX v1 has no split/rejoin or per-clip offset workflow, so do not split a song into separately imported chunks expecting them to reconstruct in place. Use the import preflight as the authority for the current limit.

## FL Studio

### Audio track-outs

1. Route each source that should remain independently mixable to its own named Mixer track. Rename used Mixer tracks before rendering.
2. Select **File > Export > WAV** and render **Full song**.
3. In the render options, enable **Split Mixer Tracks**. Export active tracks over the same full-song range. Turn **Trim PDC silence** off so the files retain a common start.
4. If the reference mix is needed, render the normal Master output separately and give it an unambiguous name such as `Song Reference Mix.wav`.
5. Check the output folder. FL Studio does not export muted Mixer tracks, and the Split Mixer Tracks option is for WAV output.

### MIDI

1. Save the source project before changing its channels.
2. Use **Tools > Macros > Prepare for MIDI export**, then choose MIDI in **File > Export** and render the project MIDI.
3. Do not save over the original project in the prepared-for-export state. Reopen the saved source copy after the MIDI export if necessary.

For current option details, see [Image-Line: Exporting Audio & MIDI](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/fformats_save_export.htm) and [Image-Line: Recording Audio](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/recording_audio.htm).

## Cubase

### Audio track-outs

1. Set the left/right locators to the common song range. Leave the left locator at the intended shared start for every channel.
2. Choose **File > Export > Audio Mixdown** and select **Multiple** channels.
3. Select the individual channels that should become KYX audio tracks; Cubase writes a separate file for each activated channel. Avoid exporting only the Main Mix if you need editable stems.
4. Choose Wave, a sample rate appropriate for the session, and a bit depth that keeps each file below KYX's import limit. Select **Disabled (DRY)** for dry track-outs or **Inserts and Strip** to print that channel's inserts/EQ. Other signal-path choices can include group, send or master processing, so use them only when that printed sound is intended.
5. Export the optional Main Mix separately as the reference file.

### MIDI

1. Choose **File > Export > MIDI File** to export the project's MIDI tracks as one Standard MIDI File.
2. In Export Options, leave **Export as Type 0** disabled to keep MIDI parts on separate tracks. If exporting only a section, enable **Export Locator Range** and set the project's locators to the same range used for the audio track-outs.
3. Cubase includes tempo and time-signature events from the Tempo Track; if the Tempo Track is deactivated, it writes the current tempo and time signature. KYX converts MIDI note/controller timing through the tempo map into the selected constant project tempo so it remains aligned with WAV stems. Tempo changes are not retained as editable markers, and time-signature changes flatten to one project meter.
4. Controller, patch, automation and marker data may also be present depending on the Export Options. KYX maps CC7/10/11 and CC64 as listed above; pitch bend, program changes, other CC, plug-in state and native automation are not transferred and appear in the preflight report.

See [Steinberg: Export Audio Mixdown](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/export_audio_mixdown/export_audio_mixdown_options_r.html), [Steinberg: Exporting MIDI Tracks as Standard MIDI Files](https://www.steinberg.help/r/cubase-pro/cubasescore/15.0/en/cubase_nuendo_score_editor/topics/importing_exporting/exporting_midi_files_t.html), and [Steinberg: MIDI Export Options](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/preferences/preferences_midi_midi_file_export_options_r.html).

## Pro Tools

### Audio track-outs

1. If a MIDI/instrument part needs to remain as audio, commit or print it first. Decide whether each track's inserts should be included.
2. Select the same range on every track, beginning at Session Start (or another chosen common origin), and include the desired effect tails.
3. Consolidate separated clips over that range so each track-out is a continuous file from the shared start.
4. In the Clips List menu, choose **Export Clips as Files**. Export the consolidated clips as WAV, preserving each track's mono/stereo layout and using the same range/sample-rate settings.
5. If you need a reference mix, export the main output separately and name it clearly.

### MIDI

1. Unmute the MIDI and Instrument tracks to export; mute tracks that should not be included.
2. Choose **File > Export > MIDI** and select Type 1 (multitrack).
3. Set **Location Reference** to Session Start when the aligned audio files also begin at Session Start. Include the current tempo and meter where offered.

See [Avid: Exporting Individual Tracks](https://www.avid.com/pro-tools/user-guide/exporting-individual-tracks) and [Avid: Exporting MIDI Files](https://resources.avid.com/SupportFiles/PT/Pro_Tools_Reference_Guide_2020.11.pdf).

## Quick transfer check

- Every track-out represents the same range and has the same start, including leading silence where needed for alignment.
- Track names are meaningful and unique; adjust the output names in KYX preflight if the export uses names such as `Audio 1` or `Insert 12`.
- Audio files are below 25 MB each; the MIDI file is below 10 MB.
- The MIDI file is multitrack and has no more than eight melodic tracks for KYX v1.
- One optional full mix is clearly named as the reference.
- You have the original DAW project and a separate KYX project after import.
