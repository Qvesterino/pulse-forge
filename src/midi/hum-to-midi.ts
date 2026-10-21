import type { NoteEvent } from "../project-model/types";
import { writeMidiFile } from "./midiFile";

/**
 * The hummed draft → Standard MIDI File serializer.
 *
 * WHY THIS IS ITS OWN MODULE (boot-path seam, 2026-10-21).
 *
 * `midi/midiFile.ts` is 36 KB of MIDI import/export code, and the studio
 * boot path used to pay for it at every boot: `hum-to-notes.ts` imported
 * `writeMidiFile` statically, the HumToMelody panel (a main surface, reached
 * from the Sequencer through the PianoRoll) imported `hum-to-notes`, and the
 * whole MIDI file format was parsed and evaluated for a feature that only
 * runs when a user clicks "⤓ MIDI".
 *
 * So the serializer moved here, and its ONE caller loads it at the moment of
 * the click. The format code is still one implementation — it did not get
 * copied — it just stopped being part of the boot graph.
 */
export function notesToMidiBlob(notes: readonly NoteEvent[], options: { bpm: number; name?: string }): Blob {
  if (notes.length === 0) throw new Error("No hummed notes to export");
  const bytes = writeMidiFile({
    bpm: Number.isFinite(options.bpm) && options.bpm > 0 ? options.bpm : 120,
    tracks: [
      {
        name: options.name ?? "KYX hum",
        channel: 0,
        notes: notes.map((note) => ({
          pitch: note.pitch,
          startTick: note.start,
          endTick: note.start + note.duration,
          velocity: note.velocity,
        })),
      },
    ],
  });
  return new Blob([bytes.buffer as ArrayBuffer], { type: "audio/midi" });
}
