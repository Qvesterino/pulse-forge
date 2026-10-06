/**
 * RE-STYLE REMIX BRIDGE (killer feature #7 candidate): keep the COMPOSITION
 * of an UN-SUNO reconstruction — the transcribed drum pattern, bass line,
 * chord voicings, arrangement — and swap the BAND through an artist preset:
 * a genre kit for the drum track, factory instrument presets for the
 * bass/keys/lead families, and the artist's mix profile on the buses.
 *
 * The invariant that makes this a remix rather than a regeneration:
 * PATTERN.ROWS AND PATTERN.NOTES NEVER CHANGE. Kit swaps replace the asset
 * behind a pad (rows are keyed by padId and untouched by construction);
 * instrument presets replace params/sample behind the track. Composition
 * is pinned by test.
 *
 * Pure `(doc, artistLabel, options) → RestyleResult` in the apply.ts /
 * unsuno.ts contract: every sub-command (kit, presets, mix) executes into a
 * `next` document and ONE final `snapshot()` wraps the whole gesture — a
 * single Ctrl-Z restores the previous band. Deterministic: the kit choice
 * hashes the artist label (no RNG), the preset picks sort by stable name.
 */
import { ARTIST_PRESETS, matchArtistPreset, type ArtistPreset } from "../intent/artists";
import { artistMixProfileOf } from "../intent/artist-mix";
import { planMixProfile, applyMixIntent } from "../intent/mix";
import { applyKitToDrumTrack } from "../commands/drumContent";
import { applyInstrumentPreset } from "../commands/instrument";
import { snapshot } from "../commands/core";
import { factoryPresets } from "../presets/factory-loader";
import { getKitPresetsForGenre, type KitPreset } from "../project-model/kit-presets";
import type { ProjectDocument, DrumTrack, InstrumentTrack } from "../project-model/types";
import type { Command } from "../commands/types";

export interface RestyleResult {
  command: Command | null;
  summary: string;
  applied: { kit: string | null; bassPreset: string | null; chordPreset: string | null; leadPreset: string | null; mix: string | null };
}

export interface RestyleOptions {
  /** Skip the mix/master pass (kit + instruments only). */
  skipMix?: boolean;
}

/** Deterministic seed from the artist label — no RNG anywhere. */
function labelSeed(label: string): number {
  let hash = 5381;
  for (let i = 0; i < label.length; i++) hash = ((hash << 5) + hash + label.charCodeAt(i)) & 0x7fffffff;
  return hash;
}

/** Exact label first (the UI select's value), then the phrase matcher. */
function resolveArtist(label: string): ArtistPreset | null {
  const wanted = label.trim().toLowerCase();
  if (!wanted) return null;
  const exact = ARTIST_PRESETS.find((p) => p.label === wanted);
  if (exact) return exact;
  return matchArtistPreset(wanted)?.preset ?? null;
}

/** Kit for the artist's genre, deterministically chosen by label seed. */
function kitForArtist(artist: ArtistPreset): KitPreset | null {
  const kits = getKitPresetsForGenre(artist.genre);
  if (kits.length === 0) return null;
  const seed = labelSeed(artist.label);
  return kits[seed % kits.length] ?? null;
}

/** First factory preset of the family whose genre matches the artist, name-
 * sorted for stability; falls back to the first preset of the family. */
function presetForFamily(
  family: "bass" | "chords" | "lead",
  genre: string,
): { id: string; name: string; apply: (doc: ProjectDocument, trackId: string) => Command } | null {
  let presets: ReturnType<typeof factoryPresets>;
  try {
    presets = factoryPresets();
  } catch {
    return null; // cold bank — honest skip, the kit + mix still land
  }
  const familyInstrument: Record<string, string[]> = {
    bass: ["bass", "808"],
    chords: ["keys", "texture", "organ", "strings"],
    lead: ["pluck", "bell", "analog", "fm", "acid", "sampler", "clav"],
  };
  const wanted = familyInstrument[family] ?? [];
  const candidates = presets
    .filter((preset) => wanted.includes(preset.instrument))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (candidates.length === 0) return null;
  const genreMatch = candidates.find((preset) => preset.genre === genre);
  const chosen = genreMatch ?? candidates[0];
  return { id: chosen.id, name: chosen.name, apply: (doc, trackId) => applyInstrumentPreset(doc, trackId, chosen) };
}

export function restyleCommand(doc: ProjectDocument, artistLabel: string, options: RestyleOptions = {}): RestyleResult {
  const applied: RestyleResult["applied"] = { kit: null, bassPreset: null, chordPreset: null, leadPreset: null, mix: null };
  const artist = resolveArtist(artistLabel);
  if (!artist) {
    return { command: null, summary: `unknown artist "${artistLabel}" — pick one from the list`, applied };
  }

  let next = doc;
  let commands = 0;

  // 1) DRUM KIT — genre kit, applied to every drum track with content.
  //    Pattern rows survive by construction (pad ids never change).
  const kit = kitForArtist(artist);
  if (kit) {
    const drumTracks = doc.tracks.filter((t): t is DrumTrack => t.kind === "drum");
    for (const track of drumTracks) {
      // The KIT's pads are the new band (KitPadCapture shape == KitPreset.pads);
      // captureKitFromTrack would re-apply the OLD band — the mistake this line avoids.
      next = applyKitToDrumTrack(next, track.id, kit.name, kit.pads).execute(next);
      commands += 1;
    }
    applied.kit = `${kit.name} (${artist.genre})`;
  }

  // 2) INSTRUMENT PRESETS per family — only tracks whose family matches.
  const instrumentTracks = doc.tracks.filter((t): t is InstrumentTrack => t.kind === "instrument");
  const familyTargets: Array<{ family: "bass" | "chords" | "lead"; kinds: string[]; key: "bassPreset" | "chordPreset" | "leadPreset" }> = [
    { family: "bass", kinds: ["bass", "808"], key: "bassPreset" },
    { family: "chords", kinds: ["keys", "texture"], key: "chordPreset" },
    { family: "lead", kinds: ["sampler"], key: "leadPreset" },
  ];
  for (const { family, kinds, key } of familyTargets) {
    const preset = presetForFamily(family, artist.genre);
    if (!preset) continue;
    const targets = instrumentTracks.filter((t) => kinds.includes(t.instrument));
    for (const track of targets) {
      next = preset.apply(next, track.id).execute(next);
      commands += 1;
    }
    if (targets.length > 0) applied[key] = preset.name;
  }

  // 3) MIX PROFILE — the artist's tone/pump/width signals onto the buses.
  if (!options.skipMix) {
    try {
      const profile = artistMixProfileOf({
        version: 2,
        genre: artist.genre,
        style: artist.style ?? null,
        ...(artist.mood ? { mood: artist.mood } : {}),
        ...(artist.energy !== undefined ? { energy: artist.energy } : {}),
        ...(artist.density !== undefined ? { density: artist.density } : {}),
        artist: artist.label,
      } as never);
      if (profile) {
        const mixIntent = {
          genre: artist.genre,
          ...(artist.style ? { style: artist.style } : {}),
          ...(artist.mood ? { mood: artist.mood } : {}),
          ...(artist.energy !== undefined ? { energy: artist.energy } : {}),
          ...(artist.density !== undefined ? { density: artist.density } : {}),
          artist: artist.label,
        };
        const mixProfile = planMixProfile(mixIntent as never, profile as never);
        next = applyMixIntent(next, mixProfile).execute(next);
        applied.mix = mixProfile.summary?.slice(0, 3).join(", ") || artist.label;
        commands += 1;
      }
    } catch {
      // "changed nothing" or a profile miss — the kit + presets still land
    }
  }

  if (commands === 0) {
    return { command: null, summary: `${artist.label}: nothing to re-style (no tracks found)`, applied };
  }
  const command = snapshot("restyle", `Re-style as ${artist.label} — ${[applied.kit, applied.bassPreset, applied.chordPreset].filter(Boolean).join(" · ")}`, doc, next);
  return {
    command,
    summary: `${artist.label}: ${[applied.kit, applied.bassPreset, applied.chordPreset, applied.leadPreset, applied.mix].filter(Boolean).join(" · ")}`,
    applied,
  };
}

/** Artist labels for the UI select (stable ids, deduplicated). */
export function artistLabels(): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const preset of ARTIST_PRESETS) {
    if (!seen.has(preset.label)) {
      seen.add(preset.label);
      labels.push(preset.label);
    }
  }
  return labels;
}
