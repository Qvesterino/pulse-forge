import type { InstrumentKind, MusicalKey } from "../project-model/types";
import { MUSICAL_KEYS } from "../project-model/types";

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
  | { kind: "transpose"; target: ExactTarget; semitones: number }
  | { kind: "patternLength"; steps: number }
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
  [/\bbass\b|\b808\b|\bbasa\b/i, "bass"],
  [/\blead\b|\bsynth(?:esizer)?\b|\bsynt\u00e9z/i, "lead"],
  [/\bchords?\b|\bkeys?\b|\bakord/i, "chords"],
  [/\b(?:the )?mix\b|\bmaster\b|\bv\u0161etko\b/i, "mix"],
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

export function parseExactIntent(text: string): ExactIntentPlan | null {
  const lower = text.toLowerCase();
  const ops: ExactOp[] = [];

  // Tempo: "set tempo to 142", "142 bpm", "tempo 138"
  const tempo = /(?:tempo|bpm)\s*(?:to|=|:)?\s*(\d{1,3})\b/.exec(lower) ?? /\b(\d{1,3})\s*bpm\b/.exec(lower);
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
  const muteMatch = /\b(mute|st\u00eds)\s+(?:the\s+)?([a-z-]+)\b/.exec(lower);
  const unmuteMatch = /\b(unmute|zapni)\s+(?:the\s+)?([a-z-]+)\b/.exec(lower);
  const soloMatch = /\b(solo)\s+(?:the\s+)?([a-z-]+)\b/.exec(lower);
  if (unmuteMatch) {
    const target = firstTarget(unmuteMatch[2], true);
    if (target) ops.push({ kind: "mute", target, value: false });
  } else if (muteMatch) {
    const target = firstTarget(muteMatch[2], true);
    if (target) ops.push({ kind: "mute", target, value: true });
  }
  if (soloMatch) {
    const target = firstTarget(soloMatch[1] + " " + soloMatch[2], true);
    if (target) ops.push({ kind: "solo", target, value: true });
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
    if (target && Number.isFinite(pct)) {
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

  // Gain dB delta: "lower drums by 2 dB", "boost the mix by 1.5 dB"
  const gainDb =
    /(lower|reduce|drop|cut|raise|boost|increase)\s+(?:the\s+)?(drums?|bass|808|lead|synth|chords?|keys?|mix|master)\b(?:\s+by\s+)?\s*(\d+(?:\.\d+)?)?\s*db/.exec(
      lower,
    );
  if (gainDb) {
    const target = firstTarget(gainDb[2]);
    const sign = /lower|reduce|drop|cut/.test(gainDb[1]) ? -1 : 1;
    if (target) ops.push({ kind: "gainDb", target, deltaDb: sign * Number(gainDb[3] ?? 2) });
  }

  // Transpose: "transpose the lead up one octave", "transpose bass down 3 semitones"
  const transpose =
    /transpose\s+(?:the\s+)?([a-z]+)\s+(up|down|hore|dole)\s+(one|two|three|an)?\s*(octaves?|semitones?|st)\b/.exec(
      lower,
    );
  if (transpose) {
    const target = firstTarget(transpose[1]) ?? "lead";
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
      return `length ${op.steps}`;
    })
    .join(", ");
  return { label, ops };
}

// ── TRANSPORT — bare-word runtime commands (not document state) ─────────────

export type TransportAction = "play" | "pause" | "stop" | "metronomeOn" | "metronomeOff";

/**
 * Transport commands are accepted as BARE WORDS ONLY ("stop", "play",
 * "pauza", "metronome on"). "stop the beat" is a generation prompt, not a
 * transport command — anchoring the whole text keeps the transport out of
 * prompt space. Transport is runtime state (the Transport service), not
 * project state: no command, no undo — dispatch is the whole operation.
 */
export function parseTransportIntent(text: string): TransportAction | null {
  if (
    !/^\s*(?:please\s+)?(?:play|stop|pause|hraj|hrať|start|štart|pauza|pauzu|zastav|stoj|(?:metronome|metronom)(?:\s+(?:on|off|zapni|vypni))?)\s*[.!]?\s*$/i.test(
      text,
    )
  ) {
    return null;
  }
  const lower = text.toLowerCase().trim();
  if (/^metronom/.test(lower)) {
    if (/\bon\b|\bzapni|\bstart/.test(lower)) return "metronomeOn";
    if (/\boff\b|\bvypni/.test(lower)) return "metronomeOff";
    return null; // bare "metronome" — on or off? decline
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
