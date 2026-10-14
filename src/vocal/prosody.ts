/**
 * LYRICS→PROSODY (W2 of the vocal campaign, 2026-10-12) — text → syllables
 * → a singable rhythmic grid + melodic shaping.
 *
 * The prosody rules a singer follows without thinking:
 *   - every syllable gets A note (never two notes on one syllable, never a
 *     swallowed syllable);
 *   - stressed syllables land ON the beat and start the note early
 *     (durational accent — the oldest prosody rule there is);
 *   - unstressed syllables ride shorter, after the beat;
 *   - line breaks breathe (a rest before the next line);
 *   - the line's LAST syllable holds longer (the phrase tail).
 *
 * Pure: text in → a syllable timeline out. The consumer shapes an existing
 * melody to the timeline (see shapeMelodyToLyrics) — this module never
 * invents pitches.
 */

export interface Syllable {
  /** The syllable as written (without leading/trailing punctuation). */
  text: string;
  /** 0-based line index. */
  line: number;
  /** Position within the line (0-based). */
  index: number;
  /** Simple lexical stress guess (EN: heuristic; SK: penultimate default). */
  stressed: boolean;
}

export interface SyllableTimeline {
  syllables: Syllable[];
  lines: string[];
  /** Per-line syllable counts (for the consumer's phrase grid). */
  lineCounts: number[];
}

/** Split one word into approximate syllables (vowel-group method, EN+SK). */
export function splitWordSyllables(word: string): string[] {
  // Vowel groups (a syllable = consonant run + vowel group), EN+SK vowels.
  const vowelGroups: RegExp = /[aeiouyáäčéíĺľňóôŕšťúýž]{1,2}/gi;
  const groups: Array<{ start: number; end: number }> = [];
  for (const match of word.matchAll(vowelGroups)) {
    groups.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  if (groups.length === 0) return [word];
  if (groups.length === 1) return [word];
  const cuts: number[] = [0];
  for (let i = 0; i < groups.length - 1; i++) {
    // Cut in the consonant run between two vowel groups — lean toward the
    // next syllable (the onset rule: CV preferred over VC).
    const mid = Math.floor((groups[i].end + groups[i + 1].start) / 2);
    cuts.push(Math.max(groups[i].end, mid));
  }
  cuts.push(word.length);
  const syllables: string[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const part = word.slice(cuts[i], cuts[i + 1]);
    if (part.length > 0) syllables.push(part);
  }
  return syllables.length > 0 ? syllables : [word];
}

/** Strip punctuation, keep words. */
function wordsOf(line: string): string[] {
  return line
    .replace(/[^\p{L}\p{N}'’\- ]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * Text → syllable timeline. Empty lines ARE line breaks (breath marks).
 */
export function buildSyllableTimeline(lyrics: string): SyllableTimeline {
  const lines = lyrics.split(/\r?\n/).map((line) => line.trim());
  const syllables: Syllable[] = [];
  const lineCounts: number[] = [];
  const keptLines: string[] = [];
  let lineIndex = 0;
  for (const line of lines) {
    const words = wordsOf(line);
    if (words.length === 0) continue; // blank line — breath, not a line
    keptLines.push(line);
    let index = 0;
    for (const word of words) {
      const parts = splitWordSyllables(word.toLowerCase());
      for (const part of parts) {
        // Stress heuristic: EN content words tend to stress the FIRST
        // syllable; longer SK-style words lean penultimate. One clean rule
        // covering both: a monosyllable is always stressed; inside a word,
        // the first syllable of an ≤3-syllable word is stressed, longer
        // words stress the penultimate.
        let stressed = parts.length === 1;
        if (!stressed) stressed = index === (parts.length <= 3 ? 0 : parts.length - 2);
        syllables.push({ text: part, line: lineIndex, index, stressed });
        index += 1;
      }
    }
    lineCounts.push(index);
    lineIndex += 1;
  }
  return { syllables, lines: keptLines, lineCounts };
}

// ── Timeline → singable grid ────────────────────────────────────────────────

export interface ProsodyNote {
  /** Step in the song grid (16ths). */
  startStep: number;
  /** Duration in 16th steps (≥1). */
  durationSteps: number;
  /** The syllable this note sings. */
  syllable: string;
  /** Durational accent — stressed syllables land louder. */
  velocity: number;
  /** Line index (the consumer groups phrases by it). */
  line: number;
  /** The syllable's stress guess — the shaper's pitch choice reads it. */
  stressed: boolean;
}

export interface ProsodyGrid {
  notes: ProsodyNote[];
  /** Default phrase span in steps (2 bars); dense lines expand in whole bars. */
  lineSteps: number;
  /** Total lines the grid covers. */
  lineCount: number;
  /** Total timeline length in steps, including any dense-line expansions. */
  totalSteps: number;
}

const LINE_STEPS = 32; // 2 bars per lyric line — the pop default
const BEAT_STEPS = 4;

/**
 * The syllable timeline → a SINGABLE grid. Ordinary lyric lines get 2 bars;
 * dense lines expand in 2-bar blocks so every syllable has a note instead of
 * silently truncating a fast phrase. Syllables are evenly distributed across
 * the phrase, stress is expressed in velocity and (where space permits) beat
 * placement, and each line's last syllable holds to its phrase tail.
 */
export function buildProsodyGrid(timeline: SyllableTimeline): ProsodyGrid {
  const notes: ProsodyNote[] = [];
  let cursor = 0;
  for (let line = 0; line < timeline.lineCounts.length; line++) {
    const lineStart = cursor;
    const count = timeline.lineCounts[line] ?? 0;
    if (count <= 0) continue;
    const lineSteps = Math.max(LINE_STEPS, Math.min(256, Math.ceil(count / LINE_STEPS) * LINE_STEPS));
    const syllablesOfLine = timeline.syllables.filter((syl) => syl.line === line);
    const starts: number[] = [];
    let previousStart = lineStart - 1;
    for (let i = 0; i < syllablesOfLine.length; i++) {
      const syl = syllablesOfLine[i];
      if (!syl) continue;
      const rawStart = lineStart + Math.floor((i * lineSteps) / syllablesOfLine.length);
      let start = rawStart;
      if (syl.stressed) {
        const beat = lineStart + Math.round((rawStart - lineStart) / BEAT_STEPS) * BEAT_STEPS;
        const nextRaw =
          i + 1 < syllablesOfLine.length
            ? lineStart + Math.floor(((i + 1) * lineSteps) / syllablesOfLine.length)
            : lineStart + lineSteps;
        if (beat > previousStart && beat < nextRaw) start = beat;
      }
      start = Math.max(previousStart + 1, Math.min(lineStart + lineSteps - 1, start));
      starts.push(start);
      previousStart = start;
    }

    for (let i = 0; i < syllablesOfLine.length; i++) {
      const syl = syllablesOfLine[i];
      const startStep = starts[i];
      if (!syl || startStep === undefined) continue;
      const isLast = i === syllablesOfLine.length - 1;
      const nextStart = starts[i + 1] ?? lineStart + lineSteps;
      const available = Math.max(1, nextStart - startStep);
      const duration = isLast
        ? Math.max(2, available)
        : Math.max(1, Math.round(available * (syl.stressed ? 0.8 : 0.6)));
      const velocity = syl.stressed ? 0.85 : 0.6;
      notes.push({
        startStep,
        durationSteps: duration,
        syllable: syl.text,
        velocity,
        line,
        stressed: syl.stressed,
      });
    }
    cursor = lineStart + lineSteps;
  }
  return { notes, lineSteps: LINE_STEPS, lineCount: timeline.lineCounts.length, totalSteps: cursor };
}

/**
 * SHAPE an existing melody to the prosody grid: keep the melody's PITCH
 * language (it is the song's identity), adopt the grid's TIME and
 * VELOCITY (the lyrics' rhythm becomes the melody's rhythm). Note counts
 * reconcile: extra melody notes beyond the grid are dropped; extra grid
 * notes reuse the melody's last pitch contour step-wise.
 */
export function shapeMelodyToLyrics(
  melody: Array<{ pitch: number; velocity: number }>,
  grid: ProsodyGrid,
): Array<{ pitch: number; startStep: number; durationSteps: number; velocity: number; syllable: string }> {
  if (melody.length === 0 || grid.notes.length === 0) return [];
  const shaped: Array<{ pitch: number; startStep: number; durationSteps: number; velocity: number; syllable: string }> =
    [];
  for (let i = 0; i < grid.notes.length; i++) {
    const slot = grid.notes[i];
    // Walk the melody's CONTOUR: scale the melody index across the grid so
    // long lyrics sample the whole melody and short lyrics use its head.
    const melodyIndex = Math.min(melody.length - 1, Math.floor((i / grid.notes.length) * melody.length));
    const contourIndex = Math.min(melody.length - 1, melodyIndex + 1);
    const rising = melody[contourIndex].pitch >= melody[melodyIndex].pitch;
    // Stressed syllables take the contour note; unstressed pass through it.
    const pitch = slot.stressed || rising ? melody[melodyIndex].pitch : melody[contourIndex].pitch;
    shaped.push({
      pitch,
      startStep: slot.startStep,
      durationSteps: slot.durationSteps,
      velocity: slot.velocity,
      syllable: slot.syllable,
    });
  }
  return shaped;
}
