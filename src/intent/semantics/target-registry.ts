/**
 * TARGET REGISTRY — the ONE alias table for the things an intent can name.
 *
 * Before this file the same families were spelled in four places:
 * `FADER_TARGETS` (conversation.ts), `TARGET_WORDS` + `ROLE_TARGETS` (mix.ts),
 * `FADER_PADS`, and the ordinal parser in `prior-adjustment.ts`. The regexes
 * were similar but not identical, which is how a word could be a "lead" for
 * one route and invisible to another.
 *
 * The registry keeps the layer-specific spellings where they genuinely differ:
 *
 *   - the fader treats "hats" as a PAD (only the hat pad moves), while the mix
 *     layer treats "hats" as the DRUM FAMILY (an effect lands on the drum track);
 *   - only the fader has "master";
 *   - the scene-role expansion is a mix-layer concept.
 *
 * What it unifies is the SOURCE: adding an alias is one edit, and the derived
 * tables in conversation.ts / mix.ts cannot disagree about the family id.
 */
export type FamilyTargetId = "drums" | "bass" | "chords" | "lead" | "vocal" | "master";
export type MixTargetId = Exclude<FamilyTargetId, "master">;
export type PadFamilyId = "kick" | "snare" | "clap" | "hat" | "perc" | "tom";
export type SceneRoleId = "intro" | "outro" | "verse" | "build" | "break" | "bridge" | "chorus" | "drop" | "fill";

interface FamilySpec {
  family: FamilyTargetId;
  /** Fader spelling. `master` is fader-only. */
  fader?: RegExp;
  /** Effect/param/send spelling. */
  mix?: RegExp;
}

const FAMILIES: readonly FamilySpec[] = [
  {
    family: "bass",
    fader: /\bbas(?:u|e|y|ov|om)?\b|\bbass\w*|\b808\w*/,
    mix: /\bbass\w*|\bbas(?:a|e|u|y|i|ou|ov|om)?\b|\b808\w*/,
  },
  {
    family: "drums",
    fader: /\bbic(?:i|ie|ich)?\b|\bbubn\w*|\bdrums?\b|\bbeat\b/,
    mix: /\bdrum|\bbic|\bhats?\b|\bhi.?hat/,
  },
  {
    family: "chords",
    fader: /\bklaves|\bakord\w*|\bchords?\b|\bkeys\b|\bpadov?\b/,
    mix: /\bchord|\bakord|\bpad/,
  },
  {
    family: "lead",
    fader: /\blead\w*\b|\bmelodi\w*|\bsynth\w*\b/,
    mix: /\blead(?:e|om|u|a)?\b|\bmelod/,
  },
  {
    family: "vocal",
    // "vocal" — but never the volume NOUN/ADJECTIVE ("hlasnejšie",
    // "hlasitosť" are loud-words, not the voice; the lookahead keeps
    // "zníž hlasitosť basu" a BASS ask).
    fader: /\bvocals?\b|\bvox\b|\bvokal\w*|\bspev\w*|\bhlas(?!nej|it|ilo)\w*/,
    mix: /\bvocals?\b|\bvok[aá]l\w*|\bspev\w*/i,
  },
  {
    family: "master",
    fader:
      /\bmaster\w*|\bvsetk\w*|\bcely (?:mix|beat)\b|\beverything\b|\bwhole (?:mix|beat)\b|\bmaster (?:fader|gain)\b/,
  },
];

const PADS: ReadonlyArray<readonly [RegExp, PadFamilyId]> = [
  [/\bkick\w*/, "kick"],
  [/\bsnare\w*/, "snare"],
  [/\bclap\w*/, "clap"],
  [/\bhat\w*|\bhi.?hat\w*|\bcinel\w*/, "hat"],
  [/\btoms?\b/, "tom"],
  [/\bperc(?:ussion\w*|s)?\b|\bperkus\w*/, "perc"],
];

/** Scene role → the families its instrumentation plays (song-builder map). */
const SCENE_ROLES: Readonly<Record<SceneRoleId, readonly MixTargetId[]>> = {
  intro: ["drums", "bass"],
  outro: ["drums", "bass"],
  verse: ["drums", "bass", "chords"],
  build: ["drums", "bass", "chords"],
  break: ["chords", "lead"],
  bridge: ["chords", "lead"],
  chorus: ["drums", "bass", "chords", "lead"],
  drop: ["drums", "bass", "chords", "lead"],
  fill: ["drums"],
};

export const FADER_TARGETS: ReadonlyArray<readonly [RegExp, FamilyTargetId]> = FAMILIES.filter(
  (entry): entry is FamilySpec & { fader: RegExp } => entry.fader != null,
).map((entry) => [entry.fader, entry.family] as const);

export const MIX_TARGET_WORDS: ReadonlyArray<readonly [RegExp, MixTargetId]> = FAMILIES.filter(
  (entry): entry is FamilySpec & { mix: RegExp; family: MixTargetId } => entry.mix != null && entry.family !== "master",
).map((entry) => [entry.mix, entry.family] as const);

export const FADER_PADS: ReadonlyArray<readonly [RegExp, PadFamilyId]> = PADS;

export const ROLE_TARGETS: Readonly<Record<string, readonly MixTargetId[]>> = SCENE_ROLES;

/** 1-based "track two" / "track 2" / "second track" → 0-based index. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
};

const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

export function trackOrdinalFromText(text: string): number | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  const direct = /\b(?:track|channel|stopa|stope|stopy)\s*#?\s*(\d{1,2}|[a-z]+)\b/.exec(lower);
  if (direct) {
    const raw = direct[1] ?? "";
    const value = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (value != null && value >= 1) return value - 1;
  }
  const named = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:track|channel)\b/.exec(
    lower,
  );
  if (named) {
    const value = ORDINAL_WORDS[named[1] ?? ""];
    if (value != null) return value - 1;
  }
  return null;
}
