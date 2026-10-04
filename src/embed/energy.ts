import type { ProjectDocument } from "../project-model/types";

/**
 * ENERGY — the interactive-beat engine behind the /embed player's energy
 * slider.
 *
 * A beat reacts to the listener: one slider rides the track from a sparse,
 * dark skeleton to the full drop. The authored scene-intensity rig only
 * makes sound through explicit `source: "intensity"` macro mappings, which
 * most shared beats never author — so instead of exposing a knob that does
 * nothing, the embed renders its own ENERGY VARIANTS: offline passes over a
 * transformed clone of the project, blended live with equal-power crossfades.
 *
 * Three anchor buffers exist:
 *   [0] dark    — `applyEnergy(doc, DARK_LEVEL)`  (skeleton)
 *   [1] authored — the untouched render (byte-parity with the plain embed)
 *   [2] bright  — `applyEnergy(doc, BRIGHT_LEVEL)` (full drop)
 * A continuous slider position 0..1 crossfades between the adjacent pair
 * (0.5 is the authored mix), so the beat keeps the creator's master chain,
 * sends and glue in every variant — only the arrangement's internal energy
 * moves.
 *
 * Pure data module: no engine, no AudioContext, no React.
 */

/** Energy level of the dark anchor. Bright anchor is 1 (full energy). */
export const DARK_LEVEL = 0.2;
export const BRIGHT_LEVEL = 1;

/** Track families the energy transform can ride. */
export type EnergyFamily = "drums" | "bass" | "harmony" | "lead" | "fx" | "other";

const BASS_KINDS = new Set(["bass", "808", "logdrum", "reese", "acid"]);
const DRUM_KINDS = new Set(["drum", "drumsynth"]);
const LEAD_KINDS = new Set(["lead", "pluck", "spectral", "flute", "brass", "vocalchop"]);
const HARMONY_KINDS = new Set(["keys", "organ", "strings", "bell", "texture", "wavetable", "granular", "fm", "clav"]);
/** One-shot FX / percussion colours by name — the first thing that dies at low energy. */
const FX_NAME =
  /\bfx\b|riser|impact|downlift|sweep|vinyl|noise|ambien|atmo|foley|perc|shaker|tambo|conga|bongo|clave|rim|uvac/i;

/**
 * Classify a track for the energy transform. Group/return/generative tracks
 * are "other" — groups aggregate already-scaled members, returns carry send
 * effects whose level follows their sources.
 */
export function energyFamilyOfTrack(track: { kind: string; name: string; instrument?: string }): EnergyFamily {
  if (track.kind === "instrument") {
    const inst = track.instrument ?? "";
    if (BASS_KINDS.has(inst)) return "bass";
    if (DRUM_KINDS.has(inst)) return "drums";
    if (FX_NAME.test(track.name)) return "fx";
    if (LEAD_KINDS.has(inst)) return "lead";
    if (HARMONY_KINDS.has(inst)) return "harmony";
    return "other";
  }
  if (track.kind === "drum") return "drums";
  if (track.kind !== "group" && FX_NAME.test(track.name)) return "fx";
  return "other";
}

/**
 * Per-family gain multiplier at energy `level`. Drums and bass stay present
 * (the skeleton), pads/leads fade harder, one-shot FX die fastest — the
 * classic intro→drop lift, all inside the rendered mix.
 */
export function energyGainFactor(family: EnergyFamily, level: number): number {
  const l = Math.max(0, Math.min(1, level));
  switch (family) {
    case "drums":
      return 0.3 + 0.7 * l;
    case "bass":
      return 0.4 + 0.6 * l;
    case "harmony":
    case "lead":
      return 0.55 + 0.45 * l;
    case "fx":
      return l * l;
    case "other":
      return 0.5 + 0.5 * l;
  }
}

/** Velocity scaling at energy `level` — softer hits collapse toward ghosts. */
export function energyVelocityFactor(level: number): number {
  const l = Math.max(0, Math.min(1, level));
  return 0.35 + 0.65 * l;
}

/**
 * True when the project carries an authored intensity rig (intensity-bound
 * macros or scene intensity curves). Rig documents ride their OWN rig in
 * energy variants (scene intensities are set directly) instead of receiving
 * the generic family-gain/velocity transform — the creator's bindings stay
 * the single source of motion.
 */
export function hasAuthoredRig(doc: ProjectDocument): boolean {
  if (Array.isArray(doc.macros)) {
    for (const macro of doc.macros) {
      for (const mapping of macro.mappings) {
        if (mapping.source === "intensity") return true;
      }
    }
  }
  if (Array.isArray(doc.scenes)) {
    for (const scene of doc.scenes) {
      if (scene.intensityCurve && scene.intensityCurve.length > 0) return true;
    }
  }
  return false;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Render-time energy transform: returns a CLONE of the project reshaped for
 * offline rendering at `level`. The input document is never mutated — the
 * embed keeps playing the authored render while variants prepare.
 *
 * Rig documents: every scene's static intensity is pinned to `level` and
 * curve values are scaled toward it (shape preserved). Everything else gets
 * the generic transform: velocity scaling on drum rows and instrument notes
 * plus per-family track gains.
 */
export function applyEnergy(doc: ProjectDocument, level: number): ProjectDocument {
  const l = Math.max(0, Math.min(1, level));
  const clone = structuredClone(doc) as ProjectDocument & {
    tracks: Array<{ kind: string; gain: number; name: string; instrument?: string }>;
    patterns: Array<{
      rows?: Record<string, number[]>;
      notes?: Record<string, Array<{ velocity: number }>>;
    }>;
    scenes: Array<{ intensity: number; intensityCurve?: Array<{ offset: number; value: number }> }>;
    macros: Array<{ mappings: Array<{ source?: string }> }>;
  };

  if (hasAuthoredRig(doc)) {
    for (const scene of clone.scenes) {
      scene.intensity = l;
      if (scene.intensityCurve) {
        for (const point of scene.intensityCurve) point.value = clamp01(point.value * l);
      }
    }
    return clone as unknown as ProjectDocument;
  }

  const vFactor = energyVelocityFactor(l);
  for (const pattern of clone.patterns) {
    if (pattern.rows) {
      for (const padId of Object.keys(pattern.rows)) {
        pattern.rows[padId] = pattern.rows[padId].map((v) => clamp01(v * vFactor));
      }
    }
    if (pattern.notes) {
      for (const trackId of Object.keys(pattern.notes)) {
        for (const note of pattern.notes[trackId]) note.velocity = clamp01(note.velocity * vFactor);
      }
    }
  }
  for (const track of clone.tracks) {
    if (track.kind === "group") continue; // members already scale; the group bus follows
    track.gain = Math.max(0, track.gain * energyGainFactor(energyFamilyOfTrack(track), l));
  }
  return clone as unknown as ProjectDocument;
}

/**
 * Equal-power crossfade weights over the three anchor buffers for a
 * continuous slider position (0 = dark, 0.5 = authored, 1 = bright). The
 * third weight is always 0 in the first half and the first in the second —
 * only ADJACENT variants ever blend, so the authored mix never fights the
 * extremes.
 */
export function energyWeights(level: number): [number, number, number] {
  const l = clamp01(level);
  const t = l <= 0.5 ? l / 0.5 : (l - 0.5) / 0.5;
  const a = Math.cos((t * Math.PI) / 2);
  const b = Math.sin((t * Math.PI) / 2);
  return l <= 0.5 ? [a, b, 0] : [0, a, b];
}

// ── postMessage control API (games / OBS / embedders) ─────────────────────

export type EmbedCommand =
  | { kind: "energy"; value: number }
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "toggle" }
  | { kind: "seek"; value: number }
  | { kind: "getState" };

/**
 * Parse one inbound `message` payload into an embed command. Only the
 * `kyx:*` namespace is recognized; anything else (other scripts on the
 * host page, extensions, webpack devtools) returns null and is ignored.
 */
export function parseEmbedCommand(data: unknown): EmbedCommand | null {
  if (data == null || typeof data !== "object") return null;
  const type = (data as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  const record = data as { type: string; value?: unknown };
  const numeric = (raw: unknown): number | null => {
    const v = typeof raw === "string" ? Number(raw) : raw;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  switch (record.type) {
    case "kyx:energy": {
      const v = numeric(record.value);
      return v === null ? null : { kind: "energy", value: v };
    }
    case "kyx:play":
      return { kind: "play" };
    case "kyx:pause":
      return { kind: "pause" };
    case "kyx:toggle":
      return { kind: "toggle" };
    case "kyx:seek": {
      const v = numeric(record.value);
      return v === null ? null : { kind: "seek", value: v };
    }
    case "kyx:get-state":
      return { kind: "getState" };
    default:
      return null;
  }
}

/**
 * Deep-linkable energy: the share-page hash may carry `e` as a percent
 * (0..100) next to the beat code — `#p=<code>&e=73` boots the player with
 * the slider already at 73%, so a link can pin the energy a game, an OBS
 * scene or a chat message wants. Anything missing, non-numeric or out of
 * range degrades to the authored default (0.5) — the URL never breaks the
 * player.
 */
export function initialEnergyFromHash(hash: string): number {
  if (typeof hash !== "string" || !hash.startsWith("#")) return 0.5;
  const raw = new URLSearchParams(hash.slice(1)).get("e");
  if (raw == null || raw.trim() === "") return 0.5;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(100, value)) / 100;
}
