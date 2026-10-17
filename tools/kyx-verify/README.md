# kyx-verify

Reference verifier for the **KYX Reproducibility Protocol** — reads the
provenance manifest a KYX export stamps into a WAV's `iXML` chunk and reports
what can be proven about the file. **Zero dependencies, offline, no app, no
browser, no network.**

```bash
npx kyx-verify beat-master.wav
npx kyx-verify beat-master.wav --json
npx kyx-verify beat-master.wav --expect <sha256>
npx kyx-verify beat-master.wav --share-code <token>
npx kyx-verify beat-master.wav --print-ixml
```

## What it reports

| Level           | Needs         | Result                                                                    |
| --------------- | ------------- | ------------------------------------------------------------------------- |
| Provenance read | the file      | project, render settings and AI receipts (provider, model, input hashes)   |
| File integrity  | the file (32f)| `pcm-verified` / `pcm-mismatch` — the manifest's SHA-256 RECOMPUTED from the file's own samples |
| Reproduction    | KYX + project | re-render with the stamped settings and compare hashes, bit-exact          |

**A match proves the same PCM was produced — nothing about authorship, ownership
or licensing.** A mismatch does not prove tampering on its own: the project or
the render settings may have changed since the file was written. 16/24-bit files
store quantized samples, so they report `quantized` rather than pretending —
only the float render can be hashed back.

## Exit codes

| Code | Meaning                                                                                     |
| ---- | ------------------------------------------------------------------------------------------- |
| `0`  | readable manifest; integrity verified, quantized, or a check honestly skipped                |
| `1`  | no usable manifest, or an export without a render hash                                       |
| `2`  | **mismatch** — modified 32-bit-float audio, a failed `--expect`, or a share code for another project |

## `--share-code`

Compares the token's project id with the manifest's. It uses the same
`lz-string` package the KYX app uses; when that package is not installed the
check reports `SKIPPED` with the reason instead of pretending to pass:

```bash
npm install lz-string   # optional, only enables --share-code
```

## The format is documented

The manifest (`kyx-render-manifest/1`), the hashing definition (per-channel
SHA-256 folded with the channel count, bit-depth-independent) and the container
placement are specified in the KYX repository:
`docs/KYX-REPRODUCIBILITY-PROTOCOL.md`.

Conformance is pinned there too: the verifier and the app's own parser are
asserted to agree field-for-field on the same bytes, a single flipped byte is
detected, and the CLI itself is run as a process with the exit codes above.

## License

MIT.
