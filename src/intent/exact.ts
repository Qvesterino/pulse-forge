import type { InstrumentKind, MusicalKey } from "../project-model/types";
import { MUSICAL_KEYS } from "../project-model/types";
import { parseIntentText } from "./text-parser";

/**
 * Exact Intents (KYX_PRODUCTION_INTENT_ENGINE_MASTER.md §4.1, §19):
 * deterministic extraction of explicit commands — tempo, key, mute/solo,
 * pan, gain (dB deltas), transpose, pattern length. No models: cheap,
 * predictable, testable (master doc §4.1 — "prefer exact extraction first").
 *
 * SK extends DETECTION (nastav/stis/basa/bicie…); compiled operations are
 * canonical KYX commands. Returns null when nothing exact is detected so the
 * caller can fall through to production/generation intents.
 */

export type ExactTarget = "drums" | "bass" | "lead" | "chords" | "mix" | "kick" | "snare" | "hats";

export type ExactOp =
  | { kind: "tempo"; bpm: number }
  | { kind: "key"; key: MusicalKey }
  | { kind: "mute"; target: ExactTarget; value: boolean }
  | { kind: "solo"; target: ExactTarget; value: boolean }
  | { kind: "pan"; target: ExactTarget; value: number }
  | { kind: "gainDb"; target: ExactTarget; deltaDb: number }
  /** Absolute fader set: "bass to -6 dB", "basa na -6 dB" — reads current state in the applier. */
  | { kind: "gainDbAbsolute"; target: ExactTarget; absDb: number }
  | { kind: "transpose"; target: ExactTarget; semitones: number }
  | { kind: "patternLength"; steps: number }
  /** Relative pattern length: "4 bars longer", "o 2 takty kratsie". */
  | { kind: "patternLengthDelta"; bars: number }
  /** Project groove swing: "swing 60 percent", "vypni swing" — 0..100 maps to groove.swing 0..1. */
  | { kind: "swing"; percent: number }
  | { kind: "addTrack"; trackKind: "drum" | "instrument"; instrument: InstrumentKind }
  | { kind: "removeTrack"; target: ExactTarget }
  | { kind: "renameTrack"; target: ExactTarget; name: string }
  | { kind: "duplicateTrack"; target: ExactTarget };

export interface ExactIntentPlan {
  label: string;
  ops: ExactOp[];
}

const TARGET_RES: [RegExp, ExactTarget][] = [
  [/\bdrums?\b|\bbic\u00edc|\bbic(?:i|ie|ich)?\b|\bbubny\b/i, "drums"],
  [/\bbass\b|\bbas(?:a|u|y|e)?\b|\b808\b/i, "bass"],
  [/\blead\b|\bsynth(?:esizer)?\b|\bsyntez/i, "lead"],
  [/\bchords?\b|\bkeys?\b|\bakord/i, "chords"],
  [/\b(?:the )?mix\b|\bmaster\b|\bvsetko\b|\beverything\b|\ball\b/i, "mix"],
];

/**
 * PAD families ("mute the kick", "pan the hats right") resolve per-PAD ops on
 * the drum track — the applier already owns per-pad mute/solo/pan via
 * classifyPads. They are checked BEFORE the track targets (a named family is
 * more specific than the whole drum track) and are deliberately NOT offered
 * to gainDb/transpose: the applier has no per-pad gain/transpose op, so a
 * family named there would silently widen to the entire drum track.
 */
const PAD_TARGET_RES: [RegExp, ExactTarget][] = [
  [/\bkick\w*|\bkop\u00e1k/i, "kick"],
  [/\bsnares?\b|\bclaps?\b|\b\u017een\u00edr/i, "snare"],
  [/\bhi-?hats?\b|\bhats?\b|\b\u010dinel\w*/i, "hats"],
];

function firstTarget(lower: string, allowPads = false): ExactTarget | null {
  if (allowPads) {
    for (const [re, target] of PAD_TARGET_RES) {
      if (re.test(lower)) return target;
    }
  }
  for (const [re, target] of TARGET_RES) {
    if (re.test(lower)) return target;
  }
  return null;
}

/** Instrument-kind words an "add a … track" ask may name (bounded v1 set). */
const INSTRUMENT_KIND_WORDS: ReadonlyArray<readonly [RegExp, InstrumentKind]> = [
  [/\b808\b/, "808"],
  [/\bbass\b|\bbasov/i, "bass"],
  [/\blog ?drums?\b/i, "logdrum"],
  [/\bkeys?\b|\bkeyboards?\b/i, "keys"],
  [/\bpluck/i, "pluck"],
  [/\bflute/i, "flute"],
  [/\bacid/i, "acid"],
  [/\bbrass/i, "brass"],
  [/\bfm\b/i, "fm"],
  [/\breese/i, "reese"],
  [/\bstrings?\b/i, "strings"],
  [/\bbells?\b/i, "bell"],
  [/\borgan\b/i, "organ"],
  [/\btexture\b/i, "texture"],
  [/\bwavetable\b/i, "wavetable"],
  [/\bgranular\b/i, "granular"],
  [/\bsampler\b/i, "sampler"],
  [/\bvocal ?chops?\b/i, "vocalchop"],
  [/\bdrum ?synth\b/i, "drumsynth"],
  [/\bsynth\b|\banalog\b/i, "analog"],
];

/** Pad-family words — a pad is not a track, "add a hat track" must decline. */
const PAD_WORD = /\b(?:kick|snare|clap|hat|hi-?hat|tom|perc)/i;

const SCALE_MAP: Record<string, string> = {
  major: "Major",
  maj: "Major",
  minor: "Natural Minor",
  min: "Natural Minor",
  "natural minor": "Natural Minor",
  "harmonic minor": "Harmonic Minor",
  "melodic minor": "Melodic Minor",
  dorian: "Dorian",
  phrygian: "Phrygian",
  mixolydian: "Mixolydian",
  locrian: "Locrian",
  "pentatonic major": "Pentatonic Major",
  "pentatonic minor": "Pentatonic Minor",
};

const NOTE_BASE: Record<string, string> = {
  c: "C",
  d: "D",
  e: "E",
  f: "F",
  g: "G",
  a: "A",
  b: "B",
  h: "B",
};

/** "db" → "C#", "eb" → "D#", … (the key list is sharp-spelled). */
function flatToSharp(letter: string, accidental: string): string {
  if (accidental !== "b") return NOTE_BASE[letter] + accidental;
  const flatMap: Record<string, string> = { d: "C#", e: "D#", g: "F#", a: "G#", b: "A#" };
  return flatMap[letter] ?? NOTE_BASE[letter];
}

/**
 * True when the text parses as a genre/beat PROMPT (a genre word or a ♪
 * style chip) — router semantics. Shared by the exact and conversation
 * tempo parsers: bare-number bpm forms ("142 bpm") inside a prompt name the
 * bpm of the beat the user WANTS, not a fader move, and must not be
 * hijacked into a silent tempo change that generates nothing.
 */
export function intentCarriesGenreSignal(text: string): boolean {
  const pattern = parseIntentText(text);
  return Boolean(pattern.input.genre || pattern.detected.some((chip) => chip.startsWith("♪")));
}

export function parseExactIntent(text: string): ExactIntentPlan | null {
  // De-accented like every other parser — SK diacritics break \b word
  // boundaries ("všetko" never matches a "vsetko" stem otherwise). The
  // pattern table below is written with de-accented stems accordingly.
  const lower = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const ops: ExactOp[] = [];

  // Tempo: "set tempo to 142", "142 bpm", "tempo 138". The "tempo"-word form
  // is an explicit ask and always parses; the bare-number forms ("142 bpm",
  // "bpm 138") are GENRE-GATED (see intentCarriesGenreSignal).
  const tempo =
    /\btempo\s*(?:to|=|:)?\s*(\d{1,3})\b/.exec(lower) ??
    (intentCarriesGenreSignal(text)
      ? null
      : (/\bbpm\s*(?:to|=|:)?\s*(\d{1,3})\b/.exec(lower) ?? /\b(\d{1,3})\s*bpm\b/.exec(lower)));
  if (tempo) {
    const bpm = Math.min(300, Math.max(20, Number(tempo[1])));
    ops.push({ kind: "tempo", bpm });
  }

  // Key: "change the key to D minor", "key = f# minor", "d mol"
  const key =
    /(?:key|tonina)\s*(?:to|=|:)?\s*([a-h])\s*(#|b|\u266f|\u266d)?\s*(natural\s+|harmonic\s+|melodic\s+|pentatonic\s+)?(major|minor|maj|min|mol|dorian|phrygian|mixolydian|locrian)/.exec(
      lower,
    );
  if (key) {
    const letter = key[1];
    const accidental = key[2] === "\u266f" ? "#" : key[2] === "\u266d" ? "b" : (key[2] ?? "");
    const scaleWord = `${key[3] ?? ""}${key[4]}`.trim();
    const scale = SCALE_MAP[scaleWord];
    const note = flatToSharp(letter, accidental);
    const musicalKey = `${note} ${scale}` as MusicalKey;
    if ((MUSICAL_KEYS as string[]).includes(musicalKey)) ops.push({ kind: "key", key: musicalKey });
  }

  // Mute / unmute / solo — target required, otherwise skip (too ambiguous).
  // The capture allows hyphens so "hi-hats" resolves as the hats family.
  // "everything/all/všetko" resolves to the MIX family, which the applier
  // expands to EVERY track for mute/solo ("mute everything" is a real ask).
  const muteMatch = /\b(mute|st\u00eds|vypni)\s+(?:the\s+)?([a-z-]+)\b/.exec(lower);
  const unmuteMatch = /\b(unmute|zapni)\s+(?:the\s+)?([a-z-]+)\b/.exec(lower);
  const soloMatch = /\b(solo)\s+(?:the\s+)?([a-z-]+)\b/.exec(lower);
  const unsoloMatch = /\b(?:unsolo|solo\s+off|zrus\s+solo)\s+(?:the\s+)?([a-z-]+)\b/.exec(lower);
  if (unmuteMatch) {
    const target = firstTarget(unmuteMatch[2], true);
    if (target) ops.push({ kind: "mute", target, value: false });
  } else if (muteMatch) {
    const target = firstTarget(muteMatch[2], true);
    if (target) ops.push({ kind: "mute", target, value: true });
  }
  if (unsoloMatch) {
    const target = firstTarget(unsoloMatch[1], true);
    if (target && target !== "mix") ops.push({ kind: "solo", target, value: false });
  } else if (soloMatch) {
    const target = firstTarget(soloMatch[1] + " " + soloMatch[2], true);
    if (target) ops.push({ kind: "solo", target, value: true });
  }

  // Center pan: "center the bass" / "vycentruj hi-hats" → pan 0 (any family,
  // pads included; the mix is not a pan target).
  const centerMatch = /\b(?:cent(?:er|re)|vycentruj)\s+(?:the\s+)?([a-z-]+)\s*(?:tracks?)?\b/.exec(lower);
  if (centerMatch) {
    const target = firstTarget(centerMatch[1], true);
    if (target && target !== "mix") ops.push({ kind: "pan", target, value: 0 });
  }

  // Pan: "pan the hats 20% right", "pan bass left 30" — pad families allowed.
  const pan =
    /pan\s+(?:the\s+)?([a-z-]+)\s*(?:to\s*)?(\d{1,3})\s*%?\s*(left|right|lavo|pravo)?/.exec(lower) ??
    /pan\s+(?:the\s+)?([a-z-]+)\s*(left|right)\s*(\d{1,3})?/.exec(lower);
  if (pan) {
    const target = firstTarget(pan[1], true);
    // The second alternative ("pan bass left 30") captures the DIRECTION in
    // [2] and the optional number in [3]; the first captures the number in
    // [2]. Reading [2] as a number unconditionally made Number("left") = NaN
    // and silently dropped the whole op.
    const directional = pan[2] === "left" || pan[2] === "right";
    const pct = Number(directional ? pan[3] : pan[2]);
    const dir = directional ? pan[2] : pan[3];
    // "pan the mix" has no lane (the mix is not a pan target) — declining at
    // parse keeps the applier from producing a silent no-op command.
    if (target && target !== "mix" && Number.isFinite(pct)) {
      let value = pct;
      if (dir === "left") value = -value;
      if (!dir && /left|lavo/.test(lower) && /to\s*-?\d/.test(lower)) value = -value;
      value = Math.max(-1, Math.min(1, value / 100));
      ops.push({ kind: "pan", target, value });
    }
  }

  // Track CRUD — the word "track" is REQUIRED ("add drums" or "remove the
  // bass" alone stay generation/clarify territory; only an explicit track
  // ask creates or destroys a lane). Pad words decline: a pad is not a track.
  const addTrack = /\b(?:add|pridaj|prid)\b\s+(?:a\s+|an\s+|new\s+|nov[yý]\s+)?([a-z -]*?)\s*tracks?\b/.exec(lower);
  if (addTrack) {
    const desc = (addTrack[1] ?? "").trim();
    if (!PAD_WORD.test(desc)) {
      if (/\bdrums?\b|\bbic[ií]c?|\bbubn/i.test(desc)) {
        ops.push({ kind: "addTrack", trackKind: "drum", instrument: "analog" });
      } else {
        const instrument = INSTRUMENT_KIND_WORDS.find(([re]) => re.test(desc))?.[1];
        if (instrument) ops.push({ kind: "addTrack", trackKind: "instrument", instrument });
        else if (desc === "" || /\binstrument|\bmelodic|\bmusic/.test(desc)) {
          ops.push({ kind: "addTrack", trackKind: "instrument", instrument: "analog" });
        }
        // unknown descriptor → no op (the engine does not guess lanes)
      }
    }
  }

  const removeTrack =
    /\b(?:delete|remove|drop|zmaz|odstr[aá]ň|odstran|zahoď|zahod)\b\s+(?:the\s+)?([a-z-]+)\s+tracks?\b/.exec(lower);
  if (removeTrack) {
    const target = firstTarget(removeTrack[1]);
    if (target && target !== "mix") ops.push({ kind: "removeTrack", target });
  }

  const renameTrack = /\b(?:rename|premenuj)\b\s+(?:the\s+)?([a-z-]+)(?:\s+tracks?)?\s+(?:to|na)\s+(.+)/.exec(lower);
  if (renameTrack) {
    const target = firstTarget(renameTrack[1]);
    // Sanitize: strip quotes, collapse whitespace, cap the length — the name
    // is user text flowing into the document and every UI surface.
    const name = renameTrack[2]
      .replace(/['"“”]/g, "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
    if (target && target !== "mix" && name.length > 0) ops.push({ kind: "renameTrack", target, name });
  }

  const duplicateTrackM = /\b(?:duplicate|duplikuj|klonuj)\b\s+(?:the\s+)?([a-z-]+)\s+tracks?\b/.exec(lower);
  if (duplicateTrackM) {
    const target = firstTarget(duplicateTrackM[1]);
    if (target && target !== "mix") ops.push({ kind: "duplicateTrack", target });
  }

  // Gain dB delta: "lower drums by 2 dB", "boost the mix by 1.5 dB",
  // "zniz basu o 3 db", "hlasnejsie bicie o 2 db" (de-accented SK verbs:
  // zniz/ztichni/stis/ztlm down; zvys/zosilni/posilni/hlasnejsi up). The
  // target alternation is wider than EN (bas*/bic*/synth*) because
  // firstTarget resolves the SK inflections.
  const gainDb =
    /(lower|reduce|drop|cut|raise|boost|increase|zniz\w*|ztichn\w*|stis|ztlm\w*|zvys\w*|zosiln\w*|posiln\w*|hlasnejs\w*|tichs\w*|prihlas)\s+(?:the\s+)?(drums?|bass|bas\w*|808|lead|synth\w*|chords?|keys?|bic\w*|mix|master)\b(?:\s+(?:by|o)\s+)?\s*(\d+(?:\.\d+)?)?\s*db/.exec(
      lower,
    );
  if (gainDb) {
    const target = firstTarget(gainDb[2]);
    const sign = /lower|reduce|drop|cut|zniz|ztichn|stis|ztlm|tichs/.test(gainDb[1]) ? -1 : 1;
    if (target) ops.push({ kind: "gainDb", target, deltaDb: sign * Number(gainDb[3] ?? 2) });
  }

  // Absolute fader set: "set bass to -6 dB", "basa na -6 dB". Checked AFTER
  // the delta (delta verbs never pair with "na"/"to", so no ambiguity).
  const gainAbs =
    /(?:nastav|set)?\s*(?:the\s+)?(drums?|bass|bas\w*|808|lead|synth\w*|chords?|keys?|mix|master)\b\s*(?:na|to)\s*(-?\d+(?:\.\d+)?)\s*db/.exec(
      lower,
    );
  if (gainAbs) {
    const target = firstTarget(gainAbs[1]);
    if (target) ops.push({ kind: "gainDbAbsolute", target, absDb: Number(gainAbs[2]) });
  }

  // Groove swing — NUMERIC only ("swing 60 percent", "swing na 65",
  // "60 % swing", "vypni swing" → 0). Bare "swing it" stays with the groove
  // verb in the production layer; this parser claims only explicit values.
  const swingOff = /(?:vypni|turn off|bez|no)\s+swing/.exec(lower);
  const swingNum =
    /swing\w*\s*(?:na|to|=|:)?\s*(\d{1,3})\s*(?:%|percent\w*)?/.exec(lower) ||
    /(\d{1,3})\s*(?:%|percent\w*)\s+swing/.exec(lower);
  if (swingNum) {
    const percent = Math.max(0, Math.min(100, Number(swingNum[1])));
    ops.push({ kind: "swing", percent });
  } else if (swingOff) {
    ops.push({ kind: "swing", percent: 0 });
  }

  // Transpose: "transpose the lead up one octave", "transpose bass down 3 semitones"
  const transpose =
    /transpose\s+(?:the\s+)?([a-z]+)\s+(up|down|hore|dole)\s+(one|two|three|an)?\s*(octaves?|semitones?|st)\b/.exec(
      lower,
    );
  if (transpose) {
    // "everything/all" resolves to the mix family, but transpose has no
    // mix-wide op — decline rather than silently no-op. Unnamed transposes
    // ("transpose it up an octave") decline too: guessing "lead" used to
    // mutate whatever instruments[0] happened to be via the resolver's old
    // positional fallback. A named-but-absent target fails loudly in the
    // applier instead.
    const named = firstTarget(transpose[1]);
    if (named && named !== "mix") {
      const target = named;
      const dir = /up|hore/.test(transpose[2]) ? 1 : -1;
      const unit = transpose[4];
      const count =
        transpose[3] === "one" || transpose[3] === "an"
          ? 1
          : transpose[3] === "two"
            ? 2
            : transpose[3] === "three"
              ? 3
              : Number(transpose[3] ?? 1);
      const semitones = dir * (/octave/.test(unit) ? 12 * (count || 1) : count || 1);
      ops.push({ kind: "transpose", target, semitones });
    }
  }

  // SK transpose, natural word order: "basu o 3 tony nizsie",
  // "lead hore o 2 semitony", "posun lead hore o 2 semitony". Units: ton =
  // WHOLE tone (2 semitones — the SK musical meaning), polton/semiton = 1,
  // oktava = 12. Named groups — the three word orders have different layouts.
  const transposeSk =
    /(drums?|bass|bas\w*|808|lead|synth\w*|chords?|keys?|bic\w*)\b\s+o\s+(?<count>\d+|dva|tri|styri|pat|sest|sedem|osem|devat|desat)\s+(?<unit>ton\w*|semiton\w*|polton\w*|oktav\w*)\b\s+(?<dir>hore|dole|nizsie|vyssie)/.exec(
      lower,
    ) ||
    /posun\s+(drums?|bass|bas\w*|808|lead|synth\w*|chords?|keys?|bic\w*)\b\s+(?<dir>hore|dole|nizsie|vyssie)\s+o\s+(?<count>\d+|dva|tri|styri|pat|sest|sedem|osem|devat|desat)\s+(?<unit>ton\w*|semiton\w*|polton\w*|oktav\w*)\b/.exec(
      lower,
    );
  if (transposeSk) {
    // Same no-guess rule as the EN branch: a target word is required.
    const named = firstTarget(transposeSk[1]);
    if (named && named !== "mix") {
      const target = named;
      const countWord = transposeSk.groups!.count;
      const count =
        Number(countWord) ||
        ({ dva: 2, tri: 3, styri: 4, pat: 5, sest: 6, sedem: 7, osem: 8, devat: 9, desat: 10 }[countWord] as
          number | undefined) ||
        1;
      const unitMult = /semiton|polton/.test(transposeSk.groups!.unit)
        ? 1
        : /oktav/.test(transposeSk.groups!.unit)
          ? 12
          : 2;
      const dir = /hore|vyssie/.test(transposeSk.groups!.dir) ? 1 : -1;
      ops.push({ kind: "transpose", target, semitones: dir * count * unitMult });
    }
  }

  // Relative pattern length: "4 bars longer", "o 2 takty kratsie",
  // "dlhsie o 4 takty". 1 bar = 16 steps (4/4 grid), signed by direction.
  const lenRel =
    /(?:o\s+)?(?<count>\d+|dva|tri|styri|two|three|four)\s+(?:takty|taktov|takte|bars?)\s+(?<dir>dlhsie|dlhsi|kratsie|kratsi|longer|shorter)/.exec(
      lower,
    ) ||
    /(?<dir>dlhsie|dlhsi|kratsie|kratsi|longer|shorter)\s+o\s+(?<count>\d+|dva|tri|styri|two|three|four)\s+(?:takty|taktov|takte|bars?)/.exec(
      lower,
    );
  if (lenRel) {
    const count =
      Number(lenRel.groups!.count) ||
      ({ dva: 2, tri: 3, styri: 4, two: 2, three: 3, four: 4 }[lenRel.groups!.count] as number | undefined) ||
      1;
    const down = /krats|shorter/.test(lenRel.groups!.dir);
    ops.push({ kind: "patternLengthDelta", bars: down ? -count : count });
  }

  // Pattern length: "pattern length to 32", "length to 64"
  const length = /(?:pattern\s+)?length\s*(?:to|=|:)?\s*(\d{1,3})\b/.exec(lower);
  if (length) {
    const steps = Number(length[1]);
    if ([16, 32, 64, 128, 256].includes(steps)) ops.push({ kind: "patternLength", steps });
  }

  if (ops.length === 0) return null;
  const label = ops
    .map((op) => {
      if (op.kind === "tempo") return `tempo ${op.bpm}`;
      if (op.kind === "key") return `key ${op.key}`;
      if (op.kind === "mute") return `${op.value ? "mute" : "unmute"} ${op.target}`;
      if (op.kind === "solo") return `solo ${op.target}`;
      if (op.kind === "pan") return `pan ${op.target} ${op.value.toFixed(2)}`;
      if (op.kind === "gainDb") return `${op.deltaDb > 0 ? "+" : ""}${op.deltaDb} dB ${op.target}`;
      if (op.kind === "transpose") return `transpose ${op.target} ${op.semitones > 0 ? "+" : ""}${op.semitones} st`;
      if (op.kind === "addTrack") {
        return op.trackKind === "drum" ? "add drum track" : `add ${op.instrument} track`;
      }
      if (op.kind === "removeTrack") return `delete ${op.target} track`;
      if (op.kind === "renameTrack") return `rename ${op.target} → "${op.name}"`;
      if (op.kind === "duplicateTrack") return `duplicate ${op.target} track`;
      if (op.kind === "gainDbAbsolute") return `${op.target} fader na ${op.absDb} dB`;
      if (op.kind === "swing") return `swing ${op.percent} %`;
      if (op.kind === "patternLengthDelta") return `length ${op.bars > 0 ? "+" : ""}${op.bars} bars`;
      return `length ${op.steps}`;
    })
    .join(", ");
  return { label, ops };
}

// ── TRANSPORT — bare-word runtime commands (not document state) ─────────────

export type TransportAction = "play" | "pause" | "stop" | "metronomeOn" | "metronomeOff" | "loopOn" | "loopOff";

/**
 * Transport commands are accepted as BARE WORDS ONLY ("stop", "play",
 * "pauza", "metronome on"). "stop the beat" is a generation prompt, not a
 * transport command — anchoring the whole text keeps the transport out of
 * prompt space. Transport is runtime state (the Transport service), not
 * project state: no command, no undo — dispatch is the whole operation.
 */
export function parseTransportIntent(text: string): TransportAction | null {
  if (
    !/^\s*(?:please\s+|prosím\s+|prosim\s+)?(?:play|stop|pause|hraj|hrať|start|štart|pauza|pauzu|zastav|stoj|(?:metronome|metronom)(?:\s+(?:on|off|zapni|vypni))?|(?:loop|cykluj|cyklus)(?:\s+(?:on|off|zapni|vypni))?|(?:zapni|vypni)\s+(?:loop|cyklus))\s*(?:please|prosím|prosim)?\s*[.!]?\s*$/i.test(
      text,
    )
  ) {
    return null;
  }
  const lower = text
    .toLowerCase()
    .trim()
    // politeness wraps the verb on either side — dispatch on the bare verb
    // ("please play" used to fall through the play branch into the stop
    // catch-all and STOPPED playback instead)
    .replace(/^(?:please|prosím|prosim)\s+/, "")
    .replace(/\s+(?:please|prosím|prosim)$/, "");
  // the SK verb-first loop form carries its direction in the stripped verb —
  // read on/off BEFORE stripping ("zapni loop" → loopOn)
  const onWord = /\bon\b|\bzapni/.test(lower);
  const offWord = /\boff\b|\bvypni/.test(lower);
  const verbFirstLoop = /^(?:zapni|vypni)\s+(?:loop|cyklus)/.test(lower);
  if (verbFirstLoop) return onWord ? "loopOn" : "loopOff";
  if (/^metronom/.test(lower)) {
    if (onWord) return "metronomeOn";
    if (offWord) return "metronomeOff";
    return null; // bare "metronome" — on or off? decline
  }
  if (/^(?:loop|cykluj|cyklus)/.test(lower)) {
    if (onWord) return "loopOn";
    if (offWord) return "loopOff";
    return null; // bare "loop" — on or off? decline
  }
  if (/^(?:play|hraj|hrať|start|štart)/.test(lower)) return "play";
  if (/^(?:pause|pauza|pauzu)/.test(lower)) return "pause";
  return "stop"; // stop / zastav / stoj
}

// ── SELECT — explicit track selection (UI state, not document state) ────────

/**
 * "select the bass" → the bass family track. Bare-word anchored like
 * transport. Selection lives in the SelectionStore (UI state — no undo,
 * no document mutation); the panel resolves the family to a track id and
 * selects it. "the mix"/pad families are not selectable lanes → declined.
 */
export function parseSelectIntent(text: string): ExactTarget | null {
  const m = /^\s*(?:select|vyber)\s+(?:the\s+)?([a-z-]+)\s*[.!]?\s*$/i.exec(
    text.normalize("NFD").replace(/[\u0300-\u036f]/g, ""),
  );
  if (!m) return null;
  const target = firstTarget(m[1]);
  if (!target || target === "mix") return null;
  return target;
}

// ── SAVE / EXPORT / RECORD — bare-word app commands ─────────────────────────

export type ExportFormat = "wav" | "mp3";

/**
 * "save" / "ulož projekt" → flush the autosave lifecycle (persistence
 * side-effect, not document state). Anchored to the whole text so
 * "save the whales" stays a prompt.
 */
export function parseSaveIntent(text: string): boolean {
  return (
    /^\s*(?:please\s+)?save(?:\s+(?:the\s+)?(?:project|it))?\s*[.!]?\s*$/i.test(text) ||
    /^\s*(?:please\s+)?ulo[zž](?:i[ťt])?(?:\s+(?:to|it|projekt))?\s*[.!]?\s*$/i.test(text)
  );
}

/**
 * "export wav" / "exportuj mp3" / "bounce" / "export the project as mp3" /
 * bare "export" → the master-bounce format. Bare "export"/"bounce" defaults
 * to WAV (the master delivery format — a bounded, documented default).
 * Execution is the async render+encode+download pipeline the export panel
 * drives; parsing stays pure.
 */
export function parseExportIntent(text: string): ExportFormat | null {
  const m =
    /^\s*(?:please\s+)?(?:export(?:uj)?|bounce)\s*(?:the\s+)?(?:project\s+)?(?:as\s+|do\s+|to\s+)?(wav|mp3)?\s*[.!]?\s*$/i.exec(
      text,
    );
  if (!m) return null;
  return (m[1]?.toLowerCase() as ExportFormat) ?? "wav";
}

/**
 * "record" / "rec" / "record pattern" / "nahrávaj" → arm the pattern
 * recorder; "stop recording" → disarm (the transport stop path ends the
 * take either way). Recording is runtime service state
 * (`patternRecorder.setArmed`) — the arming is the whole operation; takes
 * land through the recorder's own ONE-undo-frame lifecycle.
 */
export function parseRecordIntent(text: string): { arm: boolean } | null {
  const lower = text.toLowerCase();
  if (
    /^\s*(?:please\s+)?(?:rec|record(?:\s+(?:the\s+)?(?:pattern|take))?)\s*[.!]?\s*$|^\s*(?:please\s+)?start\s+recording\s*[.!]?\s*$|^\s*nahr[áa]vaj\s*[.!]?\s*$/i.test(
      lower,
    )
  ) {
    return { arm: true };
  }
  if (/^\s*stop\s+recording\s*[.!]?\s*$|^\s*(?:prestav|zrus)\s+nahr[áa]vanie\s*[.!]?\s*$/i.test(lower)) {
    return { arm: false };
  }
  return null;
}
