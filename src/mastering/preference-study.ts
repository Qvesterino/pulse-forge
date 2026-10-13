import { IncrementalSha256 } from "./sha256";

function sha256Text(value: string): string {
  const digest = new IncrementalSha256();
  digest.update(new TextEncoder().encode(value));
  return digest.digestHex();
}

export function createStudyRandomToken(byteLength = 32): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 64)
    throw new Error("Study tokens must contain between 16 and 64 random bytes.");
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function")
    throw new Error("Secure local random numbers are unavailable in this browser.");
  const bytes = cryptoApi.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function createStudyPairId(): string {
  return `pair-${createStudyRandomToken(16)}`;
}

export function createStudyReviewerHash(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("Each listener must use a stable 64-digit anonymous code.");
  return sha256Text(`kyx-mastering-reviewer-v1\0${normalized}`);
}

/** Salted locally so the exported pair cannot expose the project's revision digest directly. */
export function createStudySourceMixHash(sourceRevisionId: string, localSalt: string): string {
  if (
    typeof sourceRevisionId !== "string" ||
    sourceRevisionId.length === 0 ||
    sourceRevisionId.length > 512 ||
    !/^[0-9a-f]{64}$/.test(localSalt)
  )
    throw new Error("Study source identity is invalid.");
  return sha256Text(`kyx-mastering-source-v1\0${localSalt}\0${sourceRevisionId}`);
}
