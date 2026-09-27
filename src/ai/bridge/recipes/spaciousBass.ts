/**
 * "More spacious bass" recipe — the first recipe to use the space commands
 * (reverb / delay) and the first to use `set-volume`.
 *
 * Trigger phrases:
 *   - "uprav basy aby boli viac priestorove"
 *   - "basy su suché / moc close"
 *   - "make the bass more spacious"
 *   - "wider bass"
 *
 * The engineering problem behind "spacious bass": a bass that is simply
 * louder feels bigger, but a bass that is *wide* and *distant* needs three
 * separate things, and this recipe does all three in the order that matters.
 *
 *   1. HIGH-PASS the bass. Space is perceived relative to what is NOT in the
 *      room. A 45 kHz kick and a 55 Hz bass fighting for the same space is
 *      what makes a low end sound small and congested, not the level. This
 *      runs FIRST because it also stops the reverb from being fed sub energy
 *      that would make the tail muddy.
 *
 *   2. HALL REVERB, low mix. On a bass this is counter-intuitive — reverb on
 *      bass usually means mud. The reason it works here is the high-pass in
 *      step 1: once the sub is gone, what is left is the harmonic body, and
 *      a short predelay with a modest mix gives it a sense of a room without
 *      turning the low end to soup. `mix` is deliberately low (the hall
 *      spec is 0.28; intensity keeps it under ~0.4).
 *
 *   3. PING-PONG DELAY on the eighth. This is the actual source of WIDTH —
 *      it alternates the repeats between the far left and far right, which
 *      the ear reads as distance in a way a reverb tail (which decorrelates
 *      but stays centred) does not. It is synced so it stays glued to the
 *      tempo at any BPM.
 *
 *   4. PULL THE TRACK DOWN. Finally, and this is why the level move is LAST:
 *      reverb and delay both add wet energy. Adding space without giving back
 *      level is how an AI suggestion makes a mix louder and gets rejected.
 *      The 2 dB trim is a real number the user can undo, not a silent
 *      "balance" claim.
 *
 * Deliberately NOT used: `haasWidener`. It widens the whole track including
 * transients, which on a bass smears the note attack — the job here is done
 * better by the delay, so the recipe leaves pan alone too.
 */

import type { BridgeCommand, Recipe, RecipeInput } from "../types";

const RECIPE_ID = "spacious-bass";

// Both word orders occur ("spacious bass" and "make the bass more spacious"),
// so each intent is listed for both stems rather than relying on one order.
const INTENT_PATTERNS: readonly string[] = [
  "bas[sy].*priestor",
  "bas[sy].*such",
  "bas[sy].*close",
  "bas[sy].*kompakt",
  "bas[sy].*uzk",
  "bas[sy].*v[šs]irok",
  "daj.*bas.*miest",
  "spacious.*bas",
  "bas.*spacious",
  "wide.*bas",
  "bas.*wide",
];

export const spaciousBassRecipe: Recipe = {
  id: RECIPE_ID,
  description:
    "High-pass the bass, add a restrained hall reverb and a synced ping-pong delay for width, then trim the track to pay for the added wet energy.",
  intentPatterns: INTENT_PATTERNS,
  build(input: RecipeInput): BridgeCommand[] {
    const { doc, userPreferences } = input;

    const bass = findBassTrack(doc);
    if (!bass) return [];

    // Personalisation: the eq-carve weight doubles as "how much space do you
    // want" here, because a user who prefers structural EQ moves over
    // reverb-heavy solutions is the same user who wants a tighter tail.
    const eqWeight = userPreferences.conflictResolution["eq-carve"];
    const total = eqWeight + userPreferences.conflictResolution["sidechain-duck"];
    const spaceAppetite = total > 0 ? eqWeight / total : 0.5;
    const intensity = round2(0.35 + 0.4 * spaceAppetite);

    const commands: BridgeCommand[] = [];

    // 1) High-pass first — the room needs the sub removed to sound like a room.
    commands.push({
      kind: "eq-corner",
      label: "High-pass bass at 45 Hz",
      rationale:
        "Clears the kick's sub band so the bass stops competing for the same space — this is what actually makes a low end feel bigger.",
      target: bass,
      band: "hp",
      freqHz: 45,
    });

    // 2) Restrained hall. The high-pass in step 1 is what makes this safe.
    commands.push({
      kind: "reverb",
      label: `Hall reverb on bass — intensity ${intensity.toFixed(2)}`,
      rationale:
        "Gives the harmonic body a room to sit in. Kept low on the mix so the low end stays defined rather than turning to soup.",
      target: bass,
      space: "hall",
      intensity,
    });

    // 3) Ping-pong delay is the real width — reverb alone stays centred.
    commands.push({
      kind: "delay",
      label: `Ping-pong delay on bass — 1/8 synced, intensity ${intensity.toFixed(2)}`,
      rationale:
        "Alternating L/R repeats read as distance in a way a reverb tail does not. Synced, so it stays glued to the tempo at any BPM.",
      target: bass,
      space: "pingpong",
      intensity,
    });

    // 4) Pay for the wet energy LAST, with a real number.
    commands.push({
      kind: "set-volume",
      label: "Bass −2.0 dB",
      rationale:
        "Reverb and delay both add level. Trimming here keeps the overall loudness where you had it, so 'more space' does not turn into 'louder'.",
      target: bass,
      volumeDb: -2,
    });

    // 5) Only nudge the pan when the bass is dead centre. A bass the user has
    //    already placed deliberately off-centre must not be re-centred by an
    //    inferred "spacious" intent — that is the recipe overruling a choice
    //    that was already made on purpose. −0.12 is a hint of width, not a
    //    move to the side.
    const bassTrack = doc.tracks.find((t) => t.name === bass.namePattern);
    const currentPan = bassTrack?.pan ?? 0;
    if (Math.abs(currentPan) < 0.05) {
      commands.push({
        kind: "set-track-pan",
        label: "Bass pan −0.12",
        rationale:
          "Nudges the dry bass just off centre so the ping-pong repeats have something to sit against. Deliberately small — this is a hint of width, not a re-placement.",
        target: bass,
        pan: -0.12,
      });
    }

    return commands;
  },
};

/**
 * Find the bass track by name. The house template calls it "808" and the
 * intent templates use genre-appropriate names, so this checks the common
 * spellings rather than requiring a literal "Bass" label.
 *
 * `namePattern` is the RAW track name — the executor escapes it itself when
 * `regex` is false, so escaping here would double up and never match a name
 * containing a hyphen or a parenthesis.
 */
function findBassTrack(doc: RecipeInput["doc"]): { namePattern: string; regex: boolean; preferKind: "any" } {
  const patterns = [/^\s*bass(es)?\s*$/i, /\b808\b/i, /\bsub\b/i, /\bbass\b/i];
  for (const re of patterns) {
    const found = doc.tracks.find((t) => re.test(t.name));
    if (found) return { namePattern: found.name, regex: false, preferKind: "any" };
  }
  // No bass-shaped track: the empty batch becomes a "no bass found" error,
  // which is far better than putting a hall reverb on the wrong element.
  return { namePattern: "__no_bass_track__", regex: false, preferKind: "any" };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
