/**
 * SUNO MODE — one sentence → one produced track (composeFullTrack).
 *
 * Orchestrates the pieces the Intent Engine already has into a single call:
 *
 *   text ──▶ parser + section requests + length hint (#6 dynamic form)
 *        ──▶ buildSong (per-section generation, transitions, scoped FX)
 *        ──▶ mix profile (targeted EQ/compression/reverb/pump for the mood)
 *        ──▶ loudness pass (BS.1770 render → master trim toward −14 LUFS)
 *
 * The RESULT carries undoable COMMANDS plus an optional loudness runner —
 * the caller executes them (song first, mix second, loudness AFTER both are
 * applied, because the loudness render must HEAR the finished mix). Nothing
 * here mutates the document by itself; nothing throws — a failed stage
 * degrades to a shorter pipeline with the reason surfaced in the summary.
 */
import { parseIntentText } from "./text-parser";
import type { IntentInput } from "./types";
import { parseSectionRequests, type SectionParse } from "./sections";
import { buildSong, applySongCommand, parseSongLength, type SongBuild, type SongLengthHint } from "./song";
import { tileNotesAcrossPattern } from "../midi/hum-to-notes";
import { parseKey, snapToScale } from "../project-model/scales";
import { STEP_TICKS, type MusicalKey, type NoteEvent, type InstrumentTrack } from "../project-model/types";
import { planMixProfile, applyMixIntent } from "./mix";
import { parseLoudnessIntent, applyLoudnessIntent, type LoudnessApplyResult, type LoudnessRenderFn } from "./loudness";
import { SONG_LOUDNESS_TARGET_LUFS } from "./genre-reference.generated";
import type { Command } from "../commands/types";
import type { SampleBank } from "../sample-library/factory";
import type { ProjectDocument } from "../project-model/types";

export interface ComposeLoudness {
  summary: string;
  run: (doc: ProjectDocument) => Promise<LoudnessApplyResult | null>;
}

/** The artist's hummed hook — injected as the LEAD of every lead section. */
export interface ComposeHum {
  notes: readonly NoteEvent[];
  /** Tick length of one hum loop (notes tile/clamp into each section). */
  loopTicks: number;
  /** Estimated key of the hum — notes transpose to the song key. */
  key?: string | null;
}

export interface ComposeResult {
  /** The full sentence echoed through the canonical pipeline. */
  text: string;
  build: SongBuild;
  lengthHint: SongLengthHint | null;
  /** Undoable installs — execute song first, then mix. */
  commands: { song: Command; mix: Command | null };
  mixSummary: string | null;
  /** Present only when a loudness pass is requested AND possible (needs bank). */
  loudness: ComposeLoudness | null;
  /** Non-fatal stage failures — the pipeline degraded, not died. */
  skipped: string[];
}

export interface ComposeOptions {
  /** Called between stages and per section — for status lines. */
  onProgress?: (label: string) => void;
  /** Length override; default parses the text ("short", "3 minutes", "epic journey"). */
  length?: SongLengthHint | null;
  /**
   * Section requests override — callers that PRE-parsed the sentence (role
   * flow, chips) pass their parse here; otherwise the text is re-parsed.
   */
  sections?: SectionParse;
  /**
   * Intent input override — callers with a RICHER parse (semantic enrichment,
   * artist presets, production-FX ride-along) pass their input here; fields
   * the text parse found are used when omitted.
   */
  input?: IntentInput;
  /** The artist's hummed hook — becomes the LEAD of the song. */
  hum?: ComposeHum;
  /** Run the loudness pass after install. Default true when a bank is provided. */
  loudness?: boolean;
  /** Sample bank for the loudness render — loudness needs it; without it the stage skips. */
  bank?: SampleBank;
  /** Injected renderer (tests); default renders offline through the engine. */
  render?: LoudnessRenderFn;
  seed?: string;
}

/** Lead instrument: by name, else the third instrument track (bass/chord/lead). */
function resolveLeadTrackId(doc: ProjectDocument): string | null {
  const instruments = doc.tracks.filter((track): track is InstrumentTrack => track.kind === "instrument");
  const named = instruments.find((track) => track.name.toLowerCase().includes("lead"));
  return (named ?? instruments[2] ?? instruments[0])?.id ?? null;
}

/**
 * Transpose the hummed melody from its estimated key into the song key
 * (minimal semitone shift, then snap into the song scale). Same key = copy.
 */
export function transposeHumToKey(
  notes: readonly NoteEvent[],
  humKey: string | null,
  songKey: MusicalKey | null,
): NoteEvent[] {
  if (!humKey || !songKey) return [...notes];
  const hum = parseKey(humKey as MusicalKey);
  const song = parseKey(songKey);
  if (!hum || !song) return [...notes];
  let delta = song.root - hum.root;
  if (delta > 6) delta -= 12;
  if (delta < -6) delta += 12;
  if (delta === 0) return [...notes];
  return notes.map((note) => {
    const pitch = Math.max(0, Math.min(120, snapToScale(note.pitch + delta, songKey)));
    return { ...note, pitch };
  });
}

/**
 * The whole production, from one sentence. NEVER throws — a stage that cannot
 * run is reported in `skipped` and the rest of the pipeline still delivers.
 */
export async function composeFullTrack(
  doc: ProjectDocument,
  text: string,
  options: ComposeOptions = {},
): Promise<ComposeResult> {
  const skipped: string[] = [];
  const trimmed = (text ?? "").trim();

  // 1 — parse: intent + section requests + length hint (#6).
  const parsed = parseIntentText(trimmed);
  const sectionRequests = options.sections ?? parseSectionRequests(trimmed);
  const length = options.length !== undefined ? options.length : parseSongLength(trimmed);

  // 2 — generate: whole song, transitions and scoped FX baked per section.
  options.onProgress?.(`composing song — ${length?.label ?? "standard form"}`);
  const build = await buildSong(
    doc,
    {
      ...parsed.input,
      ...(options.input ?? {}),
      seed: options.seed ?? `compose-${Date.now()}`,
      roles: (options.input ?? parsed.input).roles ?? ["drums", "bass", "chords", "lead"],
    },
    {
      ...(sectionRequests ? { sections: sectionRequests } : {}),
      ...(length ? { length } : {}),
      onProgress: (done, label, total) => options.onProgress?.(`section ${label} (${done}/${total})`),
    },
  );

  // Hummed hook (Fáza 2): transpose the artist's melody into the song key and
  // tile it across every section that plays a LEAD — the beat is built
  // AROUND the artist's idea.
  if (options.hum && options.hum.notes.length > 0) {
    const leadId = resolveLeadTrackId(doc);
    if (!leadId) {
      skipped.push("hum: no lead instrument track in this project");
    } else {
      const songKey = build.key ?? (options.hum.key as MusicalKey | null) ?? null;
      const transposed = transposeHumToKey(options.hum.notes, options.hum.key ?? null, songKey);
      if (transposed.length === 0) {
        skipped.push("hum: transposition emptied the melody");
      } else {
        build.sections = build.sections.map((section) => {
          if (!section.roles.includes("lead")) return section;
          const sectionTicks = section.stepCount * STEP_TICKS;
          const tiled = tileNotesAcrossPattern(transposed, sectionTicks);
          if (tiled.length === 0) return section;
          return {
            ...section,
            pattern: { ...section.pattern, notes: { ...section.pattern.notes, [leadId]: tiled } },
          };
        });
      }
    }
  }

  // 3 — mix profile: mood/genre-driven targeted FX, one undoable snapshot.
  let mix: Command | null = null;
  let mixSummary: string | null = null;
  try {
    const profile = planMixProfile(build.baseIntent);
    mix = applyMixIntent(doc, profile);
    mixSummary = profile.summary.length > 0 ? profile.summary.join(" · ") : null;
  } catch (error) {
    skipped.push(`mix: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 4 — loudness: explicit words win ("loudness na −9"), else the SUNO
  // default trims toward the streaming target. Needs a bank to render.
  let loudness: ComposeLoudness | null = null;
  const wantsLoudness = options.loudness !== false;
  if (wantsLoudness) {
    if (!options.bank) {
      skipped.push("loudness: no sample bank provided for the render");
    } else {
      const parse = parseLoudnessIntent(text) ?? {
        direction: "louder" as const,
        targetDb: SONG_LOUDNESS_TARGET_LUFS,
        detected: [`target ${SONG_LOUDNESS_TARGET_LUFS} LUFS`],
      };
      loudness = {
        summary: parse.detected.join(", ") || "loudness pass",
        run: (installedDoc: ProjectDocument) =>
          applyLoudnessIntent(installedDoc, options.bank as SampleBank, parse, {
            ...(options.render ? { render: options.render } : {}),
          }).catch(() => null),
      };
    }
  }

  options.onProgress?.(`ready — ${build.sections.length} sections, ${build.totalBars} bars`);
  return {
    text: trimmed,
    build,
    lengthHint: length,
    commands: { song: applySongCommand(doc, build), mix },
    mixSummary,
    loudness,
    skipped,
  };
}
