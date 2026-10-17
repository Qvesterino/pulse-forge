import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import {
  buildRenderManifest,
  hashPcmChannels,
  manifestToIxml,
  parseRenderManifestFromWav,
} from "../src/export/renderManifest";
import { encodeShareCode } from "../src/export/shareCode";
import { encodeWav } from "../src/rendering/wav";
import type { WavBitDepth } from "../src/rendering/wav";
// @ts-expect-error — the verifier is plain JS by design (zero-dep CLI, no types).
import * as verifier from "../tools/kyx-verify/kyx-verify.mjs";

/**
 * KYX REPRODUCIBILITY PROTOCOL — CONFORMANCE.
 *
 * The verifier is deliberately a SEPARATE, dependency-free implementation, so
 * the load-bearing claim is that it and the app cannot drift: every spec here
 * runs against bytes produced by the real encoder and the real manifest
 * builder, and the parser is compared field-for-field with the app's parser.
 * The 32-bit spec is the real integrity check — the hash is recomputed from
 * the file's own samples.
 */

const SR = 44100;

interface VerifierApi {
  readWavChunks(
    bytes: Uint8Array,
  ): { fmt: unknown; ixml: string | null; data: { offset: number; size: number } | null } | null;
  parseWavManifest(bytes: Uint8Array): unknown;
  verdictFor(bytes: Uint8Array): { status: string; manifest: unknown; recomputedHash: string | null };
  verifyFile(
    bytes: Uint8Array,
    options: { file?: string; expect?: string; shareCode?: string },
  ): Promise<{
    status: string;
    shareCode?: { checked: boolean; matched?: boolean; reason?: string };
    expectation?: { matched: boolean };
  }>;
  exitCodeFor(report: unknown): number;
  projectIdFromShareCode(code: string): Promise<{ ok: boolean; id?: string | null; reason?: string }>;
}

const cli = verifier as unknown as VerifierApi;

function makeBuffer(phase = 0): AudioBuffer {
  const length = 4096;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    left[i] = Math.sin(i * 0.01) * 0.5;
    right[i] = Math.cos(i * 0.013 + phase) * 0.4;
  }
  return {
    numberOfChannels: 2,
    length,
    sampleRate: SR,
    duration: length / SR,
    getChannelData: (channel: number) => (channel === 0 ? left : right),
  } as unknown as AudioBuffer;
}

async function stampedWav(bitDepth: WavBitDepth, doc = createDefaultProject()) {
  const buffer = makeBuffer();
  const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
  const renderHash = await hashPcmChannels(channels);
  const manifest = buildRenderManifest({
    doc,
    scope: "master",
    mode: "song",
    sampleRate: SR,
    bitDepth,
    durationSec: buffer.duration,
    renderHash,
    date: new Date("2026-10-17T00:00:00.000Z"),
  });
  return { bytes: new Uint8Array(encodeWav(buffer, bitDepth, { ixml: manifestToIxml(manifest) })), manifest, doc };
}

describe("protocol conformance — the verifier and the app agree on the same bytes", () => {
  it("parses every stamped WAV identically to the app's parser", async () => {
    for (const bitDepth of [16, 24, 32] as const) {
      const { bytes, manifest } = await stampedWav(bitDepth);
      expect(cli.parseWavManifest(bytes)).toEqual(manifest);
      expect(cli.parseWavManifest(bytes)).toEqual(parseRenderManifestFromWav(bytes));
    }
  });

  it("agrees on the defensively rejected inputs too", async () => {
    const { bytes } = await stampedWav(32);
    const truncated = bytes.subarray(0, 50);
    expect(cli.parseWavManifest(truncated)).toBeNull();
    expect(parseRenderManifestFromWav(truncated)).toBeNull();
    expect(cli.parseWavManifest(new Uint8Array(4))).toBeNull();
    expect(parseRenderManifestFromWav(new Uint8Array(4))).toBeNull();
  });
});

describe("protocol conformance — what the file alone can prove", () => {
  it("VERIFIES a 32-bit float master: the hash is recomputed from the file's own samples", async () => {
    const { bytes, manifest } = await stampedWav(32);
    const verdict = cli.verdictFor(bytes);
    expect(verdict.status).toBe("pcm-verified");
    expect(verdict.recomputedHash).toBe(manifest.hash.value);
    expect(cli.exitCodeFor(verdict)).toBe(0);
  });

  it("DETECTS a modified file: one flipped byte in the audio is a mismatch", async () => {
    const { bytes } = await stampedWav(32);
    const chunks = cli.readWavChunks(bytes)!;
    const tampered = new Uint8Array(bytes);
    tampered[chunks.data!.offset + 40] = tampered[chunks.data!.offset + 40]! ^ 0xff;
    const verdict = cli.verdictFor(tampered);
    expect(verdict.status).toBe("pcm-mismatch");
    expect(cli.exitCodeFor(verdict)).toBe(2);
  });

  it("refuses to fake-verify quantized files (16/24-bit cannot self-verify)", async () => {
    for (const bitDepth of [16, 24] as const) {
      const { bytes } = await stampedWav(bitDepth);
      const verdict = cli.verdictFor(bytes);
      expect(verdict.status).toBe("quantized");
      expect(verdict.recomputedHash).toBeNull();
      expect(cli.exitCodeFor(verdict)).toBe(0); // readable, not a failure
    }
  });

  it("reports a hash-less export honestly instead of passing it", async () => {
    const doc = createDefaultProject();
    const buffer = makeBuffer();
    const manifest = buildRenderManifest({
      doc,
      scope: "master",
      mode: "song",
      sampleRate: SR,
      bitDepth: 32,
      durationSec: buffer.duration,
      renderHash: null,
    });
    const bytes = new Uint8Array(encodeWav(buffer, 32, { ixml: manifestToIxml(manifest) }));
    const verdict = cli.verdictFor(bytes);
    expect(verdict.status).toBe("hash-unavailable");
    expect(cli.exitCodeFor(verdict)).toBe(1);
  });

  it("reports a WAV with no manifest as such", async () => {
    const bytes = new Uint8Array(encodeWav(makeBuffer(), 16));
    expect(cli.verdictFor(bytes).status).toBe("no-manifest");
  });
});

describe("protocol conformance — expectations and share codes", () => {
  it("honours --expect as a hard check", async () => {
    const { bytes, manifest } = await stampedWav(32);
    const ok = await cli.verifyFile(bytes, { expect: manifest.hash.value! });
    expect(ok.expectation?.matched).toBe(true);
    expect(cli.exitCodeFor(ok)).toBe(0);

    const bad = await cli.verifyFile(bytes, { expect: "0".repeat(64) });
    expect(bad.expectation?.matched).toBe(false);
    expect(cli.exitCodeFor(bad)).toBe(2);
  });

  it("links a file to a share code — and says so when the token is another project", async () => {
    const doc = createDefaultProject();
    const { bytes } = await stampedWav(32, doc);
    const code = encodeShareCode(doc);

    const matching = await cli.verifyFile(bytes, { shareCode: code });
    expect(matching.shareCode).toMatchObject({ checked: true, matched: true });

    const otherCode = encodeShareCode(createDefaultProject());
    const foreign = await cli.verifyFile(bytes, { shareCode: otherCode });
    expect(foreign.shareCode).toMatchObject({ checked: true, matched: false });
    expect(cli.exitCodeFor(foreign)).toBe(2);
  });

  it("degrades a garbage share code to an honest skip, never to a pass", async () => {
    const { bytes } = await stampedWav(32);
    const report = await cli.verifyFile(bytes, { shareCode: "not-a-real-token" });
    expect(report.shareCode?.checked).toBe(false);
    expect(report.shareCode?.reason).toBeTruthy();
    // A skipped check is not a failure of the file.
    expect(cli.exitCodeFor(report)).toBe(0);
  });
});

describe("protocol conformance — the CLI itself", () => {
  it("runs as a process: exit 0 with VERIFIED for a stamped master", async () => {
    const { bytes } = await stampedWav(32);
    const dir = mkdtempSync(join(tmpdir(), "kyx-verify-"));
    const file = join(dir, "master.wav");
    writeFileSync(file, bytes);

    const output = execFileSync(process.execPath, ["tools/kyx-verify/kyx-verify.mjs", file], { encoding: "utf8" });
    expect(output).toContain("KYX REPRODUCIBILITY REPORT");
    expect(output).toContain("VERIFIED");
    expect(output).toContain("ai receipts");
  }, 30_000);

  it("runs as a process: exit 2 for a modified file", async () => {
    const { bytes } = await stampedWav(32);
    const chunks = cli.readWavChunks(bytes)!;
    const tampered = new Uint8Array(bytes);
    tampered[chunks.data!.offset + 8] = tampered[chunks.data!.offset + 8]! ^ 0xff;
    const dir = mkdtempSync(join(tmpdir(), "kyx-verify-"));
    const file = join(dir, "tampered.wav");
    writeFileSync(file, tampered);

    let exitCode = 0;
    let output = "";
    try {
      output = execFileSync(process.execPath, ["tools/kyx-verify/kyx-verify.mjs", file, "--json"], { encoding: "utf8" });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      exitCode = failure.status ?? -1;
      output = failure.stdout ?? "";
    }
    expect(exitCode).toBe(2);
    expect(JSON.parse(output)).toMatchObject({ status: "pcm-mismatch" });
  }, 30_000);
});
