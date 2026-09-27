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
