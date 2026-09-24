import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createWindowsMrt2Manifest, verifyWindowsMrt2Manifest } = require("../desktop/mrt2-windows-assets.cjs") as {
  createWindowsMrt2Manifest: (options: Record<string, string>) => Record<string, unknown>;
  verifyWindowsMrt2Manifest: (options: Record<string, string>) => Promise<Record<string, unknown>>;
};

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kyx-mrt2-assets-"));
  const modelRoot = path.join(root, "model");
  const hostPath = path.join(root, "kyx-mrt2-windows-host.exe");
  const manifestPath = path.join(root, "manifest.json");
  mkdirSync(path.join(modelRoot, "resources", "musiccoca"), { recursive: true });
  mkdirSync(path.join(modelRoot, "checkpoints"), { recursive: true });
  writeFileSync(path.join(modelRoot, "resources", "musiccoca", "text_encoder.tflite"), Buffer.from("resource"));
  writeFileSync(path.join(modelRoot, "checkpoints", "mrt2_small.safetensors"), Buffer.from("checkpoint"));
  writeFileSync(hostPath, Buffer.from("host-binary"));
  return { modelRoot, hostPath, manifestPath };
}

describe("MRT2 Windows package manifest", () => {
  it("creates and verifies fixed companion/model hashes with license metadata", async () => {
    const paths = fixture();
    const manifest = createWindowsMrt2Manifest(paths);
    expect(manifest).toMatchObject({ version: 1, providerId: "mrt2" });
    const result = await verifyWindowsMrt2Manifest(paths);
    expect(result).toMatchObject({
      ok: true,
      modelFileCount: 2,
      runtimeLicense: "Apache-2.0",
      modelLicense: "CC-BY-4.0",
    });
  });

  it("rejects tampered companion and model files", async () => {
    const paths = fixture();
    createWindowsMrt2Manifest(paths);
    writeFileSync(paths.hostPath, Buffer.from("tampered-host"));
    writeFileSync(path.join(paths.modelRoot, "checkpoints", "mrt2_small.safetensors"), Buffer.from("tampered-model"));
    const result = await verifyWindowsMrt2Manifest(paths);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining(["companion: SHA-256 does not match manifest"]));
    expect((result.errors as string[]).some((error) => error.includes("mrt2_small.safetensors"))).toBe(true);
    expect(readFileSync(paths.manifestPath, "utf8")).toContain('"modelLicense": "CC-BY-4.0"');
  });
});
