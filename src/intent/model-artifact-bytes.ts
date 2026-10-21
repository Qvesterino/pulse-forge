/**
 * The bytes of a TEXT artifact AS THE REPOSITORY STORES THEM.
 *
 * `.gitattributes` normalizes every text file to LF (`* text=auto eol=lf`), so
 * a checkout on any platform holds LF bytes — while the file that PRODUCED an
 * artifact on a Windows dev machine may still hold CRLF. A digest taken over
 * the raw on-disk bytes is therefore a property of ONE machine, not of the
 * artifact: no fresh clone, no CI runner, and no build produced elsewhere can
 * satisfy it.
 *
 * That is not a theoretical problem. The intent model's vocab pin was written
 * over a CRLF file, so the committed pin matched the dev machine and NOTHING
 * else: every clean checkout failed the artifact lock with a hash mismatch.
 *
 * Every digest of a text artifact goes through here, so the pin means the same
 * thing on every machine. Binary artifacts (the .onnx weights) are deliberately
 * outside this rule — `.gitattributes` marks them `-text`, so git never
 * rewrites their bytes and the raw digest is already machine-independent.
 */
export function repositoryTextBytes(bytes: Uint8Array): Uint8Array {
  let hasCarriageReturn = false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d) {
      hasCarriageReturn = true;
      break;
    }
  }
  // LF-only input is already the repository form — return it untouched.
  if (!hasCarriageReturn) return bytes;

  const normalized = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    // CRLF -> LF. A lone CR is left alone: it is not a line ending git rewrites.
    if (byte === 0x0d && bytes[i + 1] === 0x0a) continue;
    normalized[length++] = byte;
  }
  return normalized.subarray(0, length);
}
