/**
 * ARTIST SIGNATURE SEEDING — an artist profile's `signature.sound` and `vibe`
 * become the BASE of the semantic conditioning vector, with the user's own
 * words pulling it the same way an installed audio reference does.
 *
 * Precedent this mirrors: `AUDIO_REF_TEXT_PULL` in semantic-conditioning.ts.
 * An audio reference IS the intent and the words steer ±25% ("ten beat ale
 * tvrdší" leans the reference harder instead of being ignored). The artist
 * signature works the same way, one layer down — "travis scott type beat"
 * seeds the chain with the sound description from the profile, and whatever
 * else the user typed steers it:
 *
 *   "travis scott type beat"          -> artist signature, minimal pull
 *   "travis scott type beat darker"   -> artist signature pulled darker
 *   "travis scott type beat but phonk" -> artist signature pulled phonk
 *
 * Why the description rather than the artist NAME: the conditioning model is
 * a MiniLM sentence encoder projected through a fixed PCA. Feeding it
 * "Travis Scott" would embed a proper noun the encoder has no useful musical
 * geometry for; feeding it "AUTO-TUNE-heavy lead vocals, long-decay 808 with
 * heavy sub sustain, dark cinematic pads" embeds the actual sonic content the
 * prior was trained to act on. The profile's `signature.sound` +
 * `signature.samples` + `vibe` are exactly that description, already written
 * and already curated.
 *
 * Layering (each layer is a no-op when the previous one is absent, and the
 * whole chain is inert for an intent with no matched artist):
 *
 *   artist signature  (BASE)
 *     x AUDIO_REF pull (a WAV reference overrides the artist — it is the
 *                       more specific statement of intent)
 *     x SIGNATURE_PULL (user words)
 *     x user style blend (blendSemantic, unchanged)
 */
import type { ArtistProfile } from "./artist-profiles";

/**
 * With an artist signature as the base, the user's typed words still pull it
 * this much (0..1). Lower than the intent would get on its own so the artist
 * stays the dominant signal while the words remain audible — the same
 * relationship AUDIO_REF_TEXT_PULL (0.25) has to its base.
 *
 * An artist-only prompt ("travis scott type beat", no extra steer words)
 * therefore lands very near the pure signature vector, and a strongly
 * re-aimed prompt ("... but make it a happy bouncy riddim") can still pull it
 * most of the way to the typed text.
 */
export const ARTIST_SIGNATURE_PULL = 0.35;

/** Cap the seeding text so a long profile cannot dominate the encoder's
 *  300-character window (MAX_TEXT_LENGTH in semantic-conditioning.ts). */
const MAX_SIGNATURE_TEXT = 220;

/**
 * Build the encoder input for an artist profile. Ordered most-defining
 * first so the truncation above never cuts the signature: `sound` is the
 * sonic core, `samples` names the source material, `vibe` is the feeling
 * words that push the embedding toward the right emotional region.
 */
export function artistSignatureText(profile: ArtistProfile): string {
  const parts: string[] = [];
  if (profile.signature.sound.length) parts.push(profile.signature.sound.join(", "));
  if (profile.signature.samples.length) parts.push(profile.signature.samples.join(", "));
  if (profile.vibe.length) parts.push(profile.vibe.join(", "));
  return parts.join(". ").slice(0, MAX_SIGNATURE_TEXT);
}

/**
 * Short, stable token for cache keys and diagnostics — the profile slug plus
 * the day it was last curated, so editing a profile's signature invalidates
 * anything memoized from the old text.
 */
export function artistSignatureSignature(profile: ArtistProfile): string {
  return `${profile.slug}@${profile.lastUpdated}`;
}

/** True when this profile carries enough text to be worth embedding. */
export function hasArtistSignature(profile: ArtistProfile | null | undefined): profile is ArtistProfile {
  if (!profile) return false;
  return profile.signature.sound.length > 0 || profile.vibe.length > 0;
}

/**
 * The artist's tempo window, or null when the profile declares no usable
 * range. This is a CONSTRAINT for the existing groove-BPM resolution, not a
 * value: `resolveBpm(groove.bpm, requested)` still picks the number, the
 * artist range only decides whether that number is allowed to land there.
 */
export function artistBpmHint(profile: ArtistProfile | null | undefined): [number, number] | null {
  const range = profile?.signature.bpm.typical;
  if (!range) return null;
  const [lo, hi] = range;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (lo <= 0 || hi < lo) return null;
  return [lo, hi];
}

/**
 * The half-time reading of the artist's tempo, when the profile declares one.
 * Purely informational — surfaced on the plan for a UI tempo readout, never
 * used to derive the actual BPM (the half-time feel comes from the groove).
 */
export function artistHalfTimeHint(profile: ArtistProfile | null | undefined): [number, number] | null {
  const range = profile?.signature.bpm.halfTime;
  if (!range) return null;
  const [lo, hi] = range;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) return null;
  return [lo, hi];
}

/**
 * Keys the artist habitually works in. Deliberately NOT auto-applied: the
 * profile's `keys` is descriptive prose in several entries ("varies — A minor,
 * F minor, D minor, A♭ major all common", "keyless / synthetic atonal
 * moments") and a plan-level hint that cannot be parsed into a MusicalKey is
 * better surfaced to the caller than guessed at. A caller with a real key
 * vocabulary can use this to prefer a matching one; the song builder
 * consumes it for exactly that.
 */
export function artistKeyHint(profile: ArtistProfile | null | undefined): readonly string[] {
  return profile?.signature.keys ?? [];
}

/**
 * Parse the profile's `keys` prose into musical-root candidates the song
 * builder can choose from. Returns [] for the entries that name no concrete
 * root ("keyless / synthetic atonal moments", "varies — …") so a caller can
 * distinguish "no preference" from "this specific key".
 *
 * Matches a leading note name, optionally followed by minor/major. Roots are
 * normalized to the pitch-class spelling the engine uses (A B C D E F G plus
 * the accidentals the profiles actually name: ♭ and # are folded onto their
 * nearest common spelling rather than being invented).
 */
const ROOT_PATTERN = /\b(A|B|C|D|E|F|G)([#b]?)\s*(minor|min|major|maj|majr|minr)?/gi;

export function artistKeyCandidates(profile: ArtistProfile | null | undefined): readonly string[] {
  const keys = artistKeyHint(profile);
  if (!keys.length) return [];
  const found = new Set<string>();
  for (const entry of keys) {
    ROOT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ROOT_PATTERN.exec(entry)) !== null) {
      const [, root, accidental, qualityRaw] = match;
      // Only the FIRST root in an entry is a real preference; "G minor" is a
      // key, but "and 6-10 kHz air" would otherwise match stray letters.
      if (found.size > 0 && keys.indexOf(entry) > 0) break;
      const quality = /min/i.test(qualityRaw ?? "") ? "minor" : "major";
      found.add(`${root}${accidental ?? ""} ${quality}`);
    }
  }
  return [...found];
}
