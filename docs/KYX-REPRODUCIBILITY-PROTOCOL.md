# KYX Reproducibility Protocol (v1)

> A file exported by this DAW carries proof of what it is: which project
> rendered it, with which settings, which AI models are in the mix — and, for
> 32-bit float masters, a hash of the audio itself that **you can recompute
> from the file**, without the app, a browser, or a network.

The reference verifier is the `kyx-verify` package (`tools/kyx-verify/` in this repository; zero dependencies, Node ≥ 18).

```bash
npx kyx-verify beat-master.wav
npx kyx-verify beat-master.wav --json
npx kyx-verify beat-master.wav --expect <sha256>
npx kyx-verify beat-master.wav --share-code <token>
```

## 1. What a match proves — and what it does not

| Claim                                                     | Proven by                              |
| --------------------------------------------------------- | -------------------------------------- |
| The audio in this file is exactly what its manifest says  | 32-bit float masters (`pcm-verified`)  |
| This file was rendered from project X                     | `--share-code` linking                 |
| This is the recipe that reproduces the render bit-exactly | manifest `settings` + `hash`           |
| Which AI models/providers/inputs are in the mix           | `aiAssets` / `aiPatterns` / `aiTracks` |

Explicitly **not** proven: authorship, ownership, licensing, or that a render
is musically final. A hash match proves the same PCM was produced — nothing
about who produced it. A mismatch does **not** prove tampering on its own: the
project or the render settings may simply have changed since the file was
written (that is what KYX's own `VERIFY LAST EXPORT` reports on).

## 2. The manifest (format `kyx-render-manifest/1`)

JSON, embedded in the WAV's `iXML` chunk (section 3). Fields:

| Field                                     | Meaning                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `format`                                  | `"kyx-render-manifest/1"` — the version gate; unknown formats are rejected                                  |
| `renderedAt`                              | ISO timestamp of the render                                                                                 |
| `project`                                 | `{ id, name }` — the document identity (no other project content leaks out)                                 |
| `scope`                                   | `master` \| `stems` \| `track`, with an optional `label` (e.g. `"drums stem"`)                              |
| `mode`                                    | the play mode rendered (`song` \| `pattern`)                                                                |
| `sampleRate` / `bitDepth` / `durationSec` | the delivered format                                                                                        |
| `settings`                                | the **reproduction recipe**: `quality`, `masterProcessing`, `tailSeconds`                                   |
| `hash`                                    | `{ algorithm: "SHA-256" \| null, scope: "float32-pcm-le", value }`                                          |
| `counts`                                  | track/pattern totals + how many AI receipts follow                                                          |
| `aiAssets`                                | generated audio actually placed on the timeline: provider, model, input hash, source hash, truncated prompt |
| `aiPatterns`                              | generated patterns: engine id + version, seed, genre, output content hash                                   |
| `aiTracks`                                | generative tracks: provider, model, style kind                                                              |

`hash.value` is `null` when the export ran without WebCrypto (an insecure
context). That is recorded rather than faked — a file without a hash is
readable but not provable.

## 3. Container: where the manifest lives

The payload is a `BWFXML` document containing a single `<KYX>` element whose
text is the JSON (XML-escaped):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<BWFXML><KYX>{...json...}</KYX></BWFXML>
```

It is written as an `iXML` RIFF chunk **between `bext` and `data`**, so
streaming readers meet the metadata before the audio. RIFF word alignment
applies: an odd-length payload is followed by one zero pad byte. A WAV without
the chunk is byte-identical to what the exporter produced before this protocol
existed (pinned by tests).

## 4. The hash definition

`hash.value` is a SHA-256 over the **rendered float32 PCM**, defined so that it
is independent of the delivered bit depth and cannot collide across channel
layouts:

1. for each channel, in channel order: SHA-256 over that channel's bytes
   (little-endian float32, contiguous, in sample order);
2. fold: SHA-256 over `u32le(channelCount) ‖ digest₀ ‖ digest₁ ‖ …`.

Deliberately **not** included: bit depth, dither, filenames, timestamps,
project names. The artistically meaningful content is the float render, so a
24-bit master of the same render verifies as a match, while a mono and a
dual-mono render of identical samples never collide.

Consequence for verification: a **32-bit float** WAV's `data` chunk holds
exactly those bytes, so the hash is recomputable from the file (integrity
check). **16/24-bit** files store quantized, dithered samples — they are not
the hashed render, and the verifier says `quantized` rather than pretending.

## 5. Verification levels

| Level           | Needs          | Result                                                             |
| --------------- | -------------- | ------------------------------------------------------------------ |
| Provenance read | the file       | project, settings and AI receipts are parsed and printed           |
| File integrity  | the file (32f) | `pcm-verified` / `pcm-mismatch` (hash recomputed from the samples) |
| Reproduction    | KYX + project  | re-render with the stamped `settings`, compare hashes, bit-exact   |

Reproduction flow: open the project (share code or local), **VERIFY LAST
EXPORT** in the export panel — or run `npm run taste:benchmark` for the
deterministic-core baseline — and compare the resulting hash with the file's.

## 6. Reference verifier

`npx kyx-verify <file.wav> [--json] [--expect <sha256>] [--share-code <token>] [--print-ixml]`

| Exit code | Meaning                                                                                   |
| --------- | ----------------------------------------------------------------------------------------- |
| `0`       | readable manifest; integrity verified, quantized or skipped                               |
| `1`       | no usable manifest, or an export without a hash                                           |
| `2`       | **mismatch**: tampered 32f audio, failed `--expect`, or the share code is another project |

The share-code check compares the token's project id with the manifest's. It
uses the same `lz-string` package the app uses; when that package is not
installed the check reports `SKIPPED` with the reason — never a pass.

## 7. Conformance & versioning

- `tests/kyx-verify.test.ts` builds files with the **real encoder and manifest
  builder**, then pins: the verifier and the app's parser agree field-for-field
  on valid, truncated and hostile inputs; 32f integrity verifies; a single
  flipped byte is detected; quantized/hash-less files are labelled honestly;
  and the CLI itself runs as a process with the exit codes above.
- Need a file to try it on, without opening the app?
  `npm run verify:wav:fixture -- /tmp/stamped.wav` writes one with the app's own
  encoder, then `npx kyx-verify /tmp/stamped.wav` must report `VERIFIED`.
- The verifier is a separate, dependency-free implementation on purpose. The
  equivalence test is what keeps the two from drifting; treat a failure there
  as a protocol break, not a test fix.
- Versioning: the `format` string is the gate. A future `kyx-render-manifest/2`
  adds fields; readers reject formats they do not know rather than guessing.
