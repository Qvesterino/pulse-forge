#!/usr/bin/env node
/**
 * KYX REPRODUCIBILITY PROTOCOL — reference verifier (v1).
 *
 * Reads the provenance manifest this DAW stamps into a WAV's `iXML` chunk and
 * reports what can be proven about the file, WITHOUT needing the app, a
 * browser, or a network:
 *
 *   1. PROVENANCE   — which project, which render settings, which AI models
 *                     produced the mix (a machine-readable paper trail).
 *   2. FILE INTEGRITY — for 32-bit float WAVs the data chunk IS the rendered
 *                     PCM, so the manifest's SHA-256 is recomputed from the
 *                     file's own bytes. A mismatch means the audio was
 *                     modified after export.
 *   3. REPRODUCTION — the hash + settings are the recipe for a bit-exact
 *                     re-render (open the project in KYX, export, compare).
 *
 * ZERO DEPENDENCIES on purpose: the protocol is only worth something if an
 * outsider can check a file with `node tools/kyx-verify.mjs file.wav`. The
 * optional `--share-code` check uses the same lz-string package the app uses
 * and degrades HONESTLY ("skipped") when it is not installed — never a fake
 * pass. `tests/kyx-verify.test.ts` pins that this parser and the app's parser
 * agree on the same bytes, so the two implementations cannot drift silently.
 *
 * Exit codes:  0 verified / readable manifest · 1 no usable manifest ·
 *              2 integrity or expectation MISMATCH.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const KYX_MANIFEST_FORMAT = "kyx-render-manifest/1";
export const KYX_IXML_TAG = "KYX";

// Decompression-bomb caps for --share-code (same discipline as the app):
// a token is untrusted input and URLs can carry megabytes.
const MAX_SHARE_CODE_CHARS = 2_000_000;
const MAX_SHARE_CODE_DECOMPRESSED_CHARS = 8_000_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function tagAt(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * Walk a RIFF/WAVE byte stream and extract the chunks this protocol needs.
 * Defensive by construction: truncated sizes, odd chunks and non-WAV input
 * return null instead of throwing (this parses user-supplied files).
 */
export function readWavChunks(bytes) {
  try {
    if (bytes.byteLength < 12) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (tagAt(bytes, 0) !== "RIFF" || tagAt(bytes, 8) !== "WAVE") return null;
    let cursor = 12;
    let fmt = null;
    let ixml = null;
    let data = null;
    while (cursor + 8 <= bytes.byteLength) {
      const id = tagAt(bytes, cursor);
      const size = view.getUint32(cursor + 4, true);
      const body = cursor + 8;
      if (body + size > bytes.byteLength) return null; // truncated file
      if (id === "fmt ") {
        fmt = {
          formatCode: view.getUint16(body, true),
          channels: view.getUint16(body + 2, true),
          sampleRate: view.getUint32(body + 4, true),
          bitsPerSample: view.getUint16(body + 14, true),
        };
      } else if (id === "iXML") {
        ixml = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(body, body + size));
      } else if (id === "data") {
        data = { offset: body, size };
      }
      cursor = body + size + (size % 2); // word alignment
    }
    return { fmt, ixml, data };
  } catch {
    return null;
  }
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Parse the manifest JSON out of an iXML payload, or null when absent/invalid. */
export function manifestFromIxml(ixml) {
  if (typeof ixml !== "string") return null;
  const start = ixml.indexOf(`<${KYX_IXML_TAG}>`);
  const end = ixml.indexOf(`</${KYX_IXML_TAG}>`);
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(unescapeXml(ixml.slice(start + KYX_IXML_TAG.length + 2, end)));
    if (parsed == null || typeof parsed !== "object") return null;
    if (parsed.format !== KYX_MANIFEST_FORMAT) return null;
    if (typeof parsed.project?.id !== "string" || typeof parsed.project?.name !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The manifest of a WAV file, or null when the file carries none. */
export function parseWavManifest(bytes) {
  const chunks = readWavChunks(bytes);
  if (!chunks) return null;
  return manifestFromIxml(chunks.ixml);
}

/**
 * Recompute the manifest's PCM hash from a 32-bit float WAV, exactly the way
 * the app computed it: SHA-256 per channel (de-interleaved, byte-preserved),
 * then SHA-256 over [channelCount LE u32 | digest0 | digest1 | …].
 *
 * Returns null for integer PCM (16/24-bit): those samples are quantized and
 * dithered, so they are NOT the hashed float render — claiming to verify them
 * would be a lie. They can only be verified by re-rendering the project.
 */
export function pcmHashFromWav(bytes, chunks) {
  try {
    if (!chunks?.fmt || !chunks?.data) return null;
    const { channels, bitsPerSample } = chunks.fmt;
    if (bitsPerSample !== 32 || channels < 1 || channels > 64) return null;
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frameBytes = channels * 4;
    const frames = Math.floor(chunks.data.size / frameBytes);
    if (frames <= 0) return null;
    const channelBytes = Buffer.alloc(frames * 4);
    const digests = [];
    for (let channel = 0; channel < channels; channel += 1) {
      for (let frame = 0; frame < frames; frame += 1) {
        const from = chunks.data.offset + frame * frameBytes + channel * 4;
        buffer.copy(channelBytes, frame * 4, from, from + 4);
      }
      digests.push(sha256(channelBytes));
    }
    const folded = Buffer.alloc(4 + digests.length * 32);
    folded.writeUInt32LE(channels, 0);
    digests.forEach((digest, index) => digest.copy(folded, 4 + index * 32));
    return sha256(folded).toString("hex");
  } catch {
    return null;
  }
}

/** The strongest claim this file alone can support. */
export function verdictFor(bytes) {
  const chunks = readWavChunks(bytes);
  const manifest = manifestFromIxml(chunks?.ixml);
  if (!manifest) return { status: "no-manifest", manifest: null, recomputedHash: null };
  if (manifest.hash?.value == null) return { status: "hash-unavailable", manifest, recomputedHash: null };
  const recomputed = pcmHashFromWav(bytes, chunks);
  if (recomputed == null) {
    return { status: "quantized", manifest, recomputedHash: null };
  }
  return {
    status: recomputed === manifest.hash.value ? "pcm-verified" : "pcm-mismatch",
    manifest,
    recomputedHash: recomputed,
  };
}

/**
 * Decode a share token far enough to compare its project identity with the
 * manifest. Uses the app's own lz-string package; when it is not installed the
 * check is SKIPPED with a reason instead of pretending.
 */
export async function projectIdFromShareCode(code) {
  if (typeof code !== "string" || code.length === 0) return { ok: false, reason: "empty share code" };
  if (code.length > MAX_SHARE_CODE_CHARS) return { ok: false, reason: "share code exceeds the 2 M character cap" };
  let lz;
  try {
    lz = await import("lz-string");
  } catch {
    return { ok: false, reason: "lz-string is not installed — run `npm install` in the KYX repo to enable this check" };
  }
  try {
    const json = lz.decompressFromEncodedURIComponent(code);
    if (!json) return { ok: false, reason: "share code did not decompress" };
    if (json.length > MAX_SHARE_CODE_DECOMPRESSED_CHARS) {
      return { ok: false, reason: "decompressed payload exceeds the 8 M character cap" };
    }
    const parsed = JSON.parse(json);
    if (parsed == null || typeof parsed !== "object") return { ok: false, reason: "share code is not a project" };
    return {
      ok: true,
      id: typeof parsed.id === "string" ? parsed.id : null,
      name: typeof parsed.name === "string" ? parsed.name : null,
    };
  } catch {
    return { ok: false, reason: "share code is not valid" };
  }
}

export function exitCodeFor(report) {
  if (report.status === "pcm-mismatch") return 2;
  if (report.expectation && !report.expectation.matched) return 2;
  if (report.shareCode && report.shareCode.checked && !report.shareCode.matched) return 2;
  if (report.status === "no-manifest" || report.status === "hash-unavailable") return 1;
  return 0;
}

const STATUS_TEXT = {
  "pcm-verified": {
    line: "VERIFIED — the audio in this file matches its own manifest (PCM hash recomputed from the file).",
    tone: "",
  },
  "pcm-mismatch": {
    line: "MISMATCH — the file's PCM does NOT match its manifest. The audio was modified after export (or written by another tool).",
    tone: "!",
  },
  quantized: {
    line: "READABLE — 16/24-bit files store quantized samples, so the manifest hash describes the pre-quantization render and cannot be recomputed from this file. Verify by re-rendering the project in KYX.",
    tone: "",
  },
  "hash-unavailable": {
    line: "READABLE — the export ran without WebCrypto, so this file carries no render hash. Its provenance is informative, not provable.",
    tone: "",
  },
  "no-manifest": {
    line: "NO MANIFEST — this WAV carries no KYX provenance (no valid iXML payload).",
    tone: "!",
  },
};

export function formatReport(report) {
  const lines = [];
  const { manifest } = report;
  lines.push("KYX REPRODUCIBILITY REPORT");
  lines.push(`file            ${report.file ?? "(stdin)"}`);
  lines.push(`status          ${report.status}`);
  if (manifest) {
    lines.push(`format          ${manifest.format} · rendered ${manifest.renderedAt}`);
    lines.push(`project         "${manifest.project.name}" (${manifest.project.id})`);
    lines.push(
      `deliverable     ${manifest.scope}${manifest.label ? ` "${manifest.label}"` : ""} · ${manifest.mode} · ` +
        `${manifest.sampleRate} Hz · ${manifest.bitDepth}-bit · ${manifest.durationSec}s`,
    );
    lines.push(
      `render hash     ${manifest.hash?.value ?? "(none)"}` +
        (report.recomputedHash ? ` · recomputed from file: ${report.recomputedHash}` : ""),
    );
    if (manifest.settings) {
      const s = manifest.settings;
      lines.push(
        `settings        mode=${s.mode}${s.quality ? ` quality=${s.quality}` : ""}` +
          `${s.masterProcessing !== undefined ? ` masterProcessing=${s.masterProcessing}` : ""}` +
          `${s.tailSeconds !== undefined ? ` tailSeconds=${s.tailSeconds}` : ""}`,
      );
    }
    const counts = manifest.counts ?? {};
    lines.push(
      `ai receipts     ${counts.aiAssets ?? 0} asset(s) · ${counts.aiPatterns ?? 0} pattern(s) · ${counts.aiTracks ?? 0} track(s)`,
    );
    for (const asset of manifest.aiAssets ?? []) {
      lines.push(
        `  · asset "${asset.name}" — ${asset.providerId}/${asset.modelId}${asset.prompt ? ` · "${asset.prompt}"` : ""}`,
      );
    }
    for (const pattern of manifest.aiPatterns ?? []) {
      lines.push(`  · pattern "${pattern.patternName}" — ${pattern.engineId} seed ${pattern.seed}`);
    }
    for (const track of manifest.aiTracks ?? []) {
      lines.push(`  · track "${track.trackName}" — ${track.providerId}/${track.modelId} (${track.style})`);
    }
  }
  if (report.expectation) {
    lines.push(
      `expect          ${report.expectation.matched ? "MATCH" : "MISMATCH"} — expected ${report.expectation.expected}, got ${report.expectation.actual ?? "(none)"}`,
    );
  }
  if (report.shareCode) {
    lines.push(
      report.shareCode.checked
        ? `share code      ${report.shareCode.matched ? "MATCH — this file was rendered from that project" : "MISMATCH — the token is a different project"}` +
            (report.shareCode.matched ? "" : ` (token project "${report.shareCode.name}" ${report.shareCode.id})`)
        : `share code      SKIPPED — ${report.shareCode.reason}`,
    );
  }
  lines.push(`verdict         ${STATUS_TEXT[report.status]?.line ?? report.status}`);
  return lines.join("\n");
}

export async function verifyFile(bytes, options = {}) {
  const verdict = verdictFor(bytes);
  const report = { ...verdict, file: options.file };
  if (options.expect) {
    const actual = verdict.manifest?.hash?.value ?? null;
    report.expectation = { expected: options.expect, actual, matched: actual === options.expect };
  }
  if (options.shareCode) {
    const decoded = await projectIdFromShareCode(options.shareCode);
    if (!decoded.ok) {
      report.shareCode = { checked: false, reason: decoded.reason };
    } else {
      const manifestId = verdict.manifest?.project?.id ?? null;
      report.shareCode = {
        checked: true,
        matched: decoded.id != null && decoded.id === manifestId,
        id: decoded.id,
        name: decoded.name,
      };
    }
  }
  return report;
}

function parseArgs(argv) {
  const options = { file: null, json: false, printIxml: false, expect: null, shareCode: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--print-ixml") options.printIxml = true;
    else if (arg === "--expect") options.expect = argv[++i] ?? null;
    else if (arg === "--share-code") options.shareCode = argv[++i] ?? null;
    else if (!arg.startsWith("--")) options.file = arg;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.file) {
    console.error(
      "usage: node tools/kyx-verify.mjs <file.wav> [--json] [--expect <sha256>] [--share-code <token>] [--print-ixml]",
    );
    process.exit(1);
  }
  let bytes;
  try {
    bytes = readFileSync(options.file);
  } catch (error) {
    console.error(`cannot read ${options.file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (options.printIxml) {
    const ixml = readWavChunks(bytes)?.ixml;
    if (!ixml) {
      console.error("no iXML chunk in this file");
      process.exit(1);
    }
    console.log(ixml);
    return;
  }
  const report = await verifyFile(bytes, {
    file: options.file,
    ...(options.expect ? { expect: options.expect } : {}),
    ...(options.shareCode ? { shareCode: options.shareCode } : {}),
  });
  if (options.json) {
    const { manifest, ...rest } = report;
    console.log(JSON.stringify({ ...rest, manifest }, null, 2));
  } else {
    console.log(formatReport(report));
  }
  process.exit(exitCodeFor(report));
}

// Only run as a CLI — importing this module (tests) must not execute anything.
if (process.argv[1] && process.argv[1].endsWith("kyx-verify.mjs")) {
  await main();
}
