/**
 * RE-STYLE REGENERATION (the deep half of the remix bridge): for every
 * UN-SUNO section pattern, REGENERATE the lane content in the artist's
 * style — drum rows from the artist genre's groove (bar-variant rotation,
 * deterministic), bass from the genre's curated melodic sequences (seeded
 * Markov, sidechain-aware against the fresh kick rows) — while the SONG'S
 * IDENTITY stays: section structure, chord voicings (the transcribed
 * harmony), key, tempo, arrangement.
 *
 * Contrast with restyle.ts (timbre-only swap): regeneration CHANGES notes
 * and rows; restyle NEVER does. The two stack — regen for content, then
 * re-style for the band.
 *
 * Pure (doc, artistLabel, options) → one snapshot. Deterministic: groove
 * picked by the rendezvous hash the intent engine itself uses, everything
 * else seeded from the artist label + section name.
 */
import { resolveGrooveSeeded } from "../ai/generator";
import { generateMelodicParts } from "../ai/melodic";
import { PAD_NAMES } from "../ai/types";
import { inferPadRole } from "../ai/pad-roles";
import { artistMixProfileOf } from "../intent/artist-mix";
import { ARTIST_PRESETS, type ArtistPreset } from "../intent/artists";
import { planMixProfile, applyMixIntent } from "../intent/mix";
import { snapshot } from "../commands/core";
import {
  STEP_TICKS,
  type DrumTrack,
  type InstrumentTrack,
  type ProjectDocument,
  type NoteEvent,
} from "../project-model/types";
import type { Command } from "../commands/types";

export interface RegenStyleResult {
  command: Command | null;
  summary: string;
  /** Sections whose drums+bass were regenerated. */
  sections: number;
}

function labelSeed(label: string): number {
  let hash = 5381;
  for (let i = 0; i < label.length; i++) hash = ((hash << 5) + hash + label.charCodeAt(i)) & 0x7fffffff;
  return hash;
}

/** Deterministic PRNG (mulberry32) seeded per section. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Groove pad index → role, via PAD_NAMES (never by raw index into the kit). */
function grooveRole(padIndex: number): string {
  return inferPadRole(PAD_NAMES[padIndex] ?? undefined, padIndex);
}

export interface RegenArtistSpec {
  genre: ArtistPreset["genre"];
  style?: string;
  seedLabel: string;
}

/** Core regeneration for an already-resolved style spec — the seam the
 * Cover Band uses to drive PERSONA genres (which are not artist presets).
 * Deterministic per (doc, spec). */
export function regenerateForGenre(doc: ProjectDocument, spec: RegenArtistSpec): RegenStyleResult {
  const artist = {
    genre: spec.genre,
    style: spec.style,
    label: spec.seedLabel,
    bpmRange: null as [number, number] | null,
    mood: undefined as ArtistPreset["mood"],
  };
  const groove = resolveGrooveSeeded(artist.genre, artist.style, `${artist.label}`, artist.bpmRange ?? null, null);

  const drumTrack = doc.tracks.find((t): t is DrumTrack => t.kind === "drum");
  if (!drumTrack) {
    return { command: null, summary: `${artist.label}: no drum track to regenerate`, sections: 0 };
  }

  // Role → ordered track pad ids: groove pads map by ROLE (kick deep/punch
  // both map to kick-role track pads, first free first).
  const rolePads = new Map<string, string[]>();
  for (const pad of drumTrack.pads) {
    const role = inferPadRole(pad.name, drumTrack.pads.indexOf(pad));
    const list = rolePads.get(role) ?? [];
    list.push(pad.id);
    rolePads.set(role, list);
  }

  let next = doc;
  let commands = 0;
  let sections = 0;

  const sectionPatterns = doc.patterns.filter((p) => p.name.startsWith("UN-SUNO"));
  for (const pattern of sectionPatterns) {
    const bars = Math.max(1, Math.round(pattern.stepCount / 16));
    const sectionSeed = labelSeed(`${artist.label}|${pattern.name}`);
    const rand = mulberry32(sectionSeed);

    // 1) DRUMS: groove variants rotate per bar (deterministic; curated fills
    // and breakdown variants participate naturally). Rows keyed by ROLE.
    const rows: Record<string, number[]> = {};
    for (const pad of drumTrack.pads) rows[pad.id] = new Array<number>(pattern.stepCount).fill(0);
    const roleCursor = new Map<string, number>();
    const variantCount = groove.patterns.length;
    for (let bar = 0; bar < bars; bar++) {
      const variant = groove.patterns[bar % variantCount];
      for (const [padIndex, row] of Object.entries(variant)) {
        const role = grooveRole(Number(padIndex));
        const padList = rolePads.get(role);
        if (!padList || padList.length === 0) continue; // no such pad in the kit — dropped honestly
        const cursor = roleCursor.get(role) ?? 0;
        const padId = padList[cursor % padList.length];
        for (let step = 0; step < 16; step++) {
          const velocity = row[step];
          if (velocity > 0) rows[padId][bar * 16 + step] = velocity;
        }
      }
    }
    let updated = { ...pattern, rows };

    // 2) BASS: the genre's curated melodic sequences (seeded Markov,
    // sidechain-aware against the fresh kick rows), snapped to the project key.
    const bassTrack = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "bass");
    if (bassTrack) {
      const kickRows = Object.entries(rows)
        .filter(([padId]) => {
          const pad = drumTrack.pads.find((p) => p.id === padId);
          return pad ? inferPadRole(pad.name, drumTrack.pads.indexOf(pad)) === "kick" : false;
        })
        .map(([, row]) => row);
      const melodic = generateMelodicParts(
        { genre: artist.genre, stepCount: pattern.stepCount } as never,
        rand,
        doc.key ?? undefined,
        kickRows,
      );
      // Keep each existing chord's root as the bass register anchor: take the
      // generated rhythm, pitch it into the bass register over the chord pcs
      // already in the pattern (the transcribed harmony stays the identity).
      const existingChords =
        pattern.notes[
          doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "keys")?.id ?? ""
        ];
      const anchorPcs = (existingChords ?? []).map((n) => ((Math.round(n.pitch) % 12) + 12) % 12);
      const bassNotes: NoteEvent[] = melodic.bass
        .filter((note) => note.start < pattern.stepCount * STEP_TICKS)
        .map((note, index) => {
          const anchor = anchorPcs.length > 0 ? anchorPcs[index % anchorPcs.length] : 0;
          // Generated pitch, snapped so its pitch class matches the section's
          // chord anchor (regenerated rhythm, source harmony).
          const octave = Math.floor(note.pitch / 12);
          let pitch = octave * 12 + anchor;
          while (pitch < 24) pitch += 12;
          while (pitch > 60) pitch -= 12;
          return {
            id: `regen-b-${pattern.id}-${index}`,
            pitch,
            start: note.start,
            duration: note.duration,
            velocity: Math.max(1, Math.min(127, Math.round(note.velocity * 127))),
          };
        });
      updated = { ...updated, notes: { ...updated.notes, [bassTrack.id]: bassNotes } };
    }

    next = { ...next, patterns: next.patterns.map((p) => (p.id === pattern.id ? updated : p)) };
    commands += 1;
    sections += 1;
  }

  // 3) MIX — the artist's bus signals, same as restyle.
  try {
    const profile = artistMixProfileOf({
      version: 2,
      genre: artist.genre,
      style: artist.style ?? null,
      ...(artist.mood ? { mood: artist.mood } : {}),
      artist: artist.label,
    } as never);
    if (profile) {
      const mixProfile = planMixProfile(
        {
          genre: artist.genre,
          ...(artist.style ? { style: artist.style } : {}),
          ...(artist.mood ? { mood: artist.mood } : {}),
          artist: artist.label,
        } as never,
        profile as never,
      );
      next = applyMixIntent(next, mixProfile).execute(next);
      commands += 1;
    }
  } catch {
    // "changed nothing" — drums/bass regeneration still lands
  }

  if (commands === 0) {
    return { command: null, summary: `${artist.label}: no UN-SUNO sections to regenerate`, sections: 0 };
  }

  const command = snapshot(
    "regenStyle",
    `Regenerate as ${artist.label} (${groove.id}) — ${sections} section(s), new drums + bass`,
    doc,
    next,
  );
  return {
    command,
    summary: `${artist.label} · groove ${groove.id} · ${sections} sekcií (nové bubny + basa, akordy z originálu)`,
    sections,
  };
}

/** Public entry: EXACT artist label only. Regeneration REWRITES NOTES, so a
 * fuzzy phrase match (which happily binds "nikto taky 999" to some artist)
 * would be a silent content change nobody asked for. The UI select feeds
 * exact labels anyway. */
export function regenerateStyleCommand(doc: ProjectDocument, artistLabel: string): RegenStyleResult {
  const wanted = artistLabel.trim().toLowerCase();
  const artist = ARTIST_PRESETS.find((p) => p.label === wanted);
  if (!artist) {
    return { command: null, summary: `unknown artist "${artistLabel}" — pick one from the list`, sections: 0 };
  }
  return regenerateForGenre(doc, { genre: artist.genre, style: artist.style, seedLabel: artist.label });
}
