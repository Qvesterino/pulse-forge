import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createWindowsMrt2Manifest, readManifest, verifyWindowsMrt2Manifest, verifyWindowsMrt2HostScript } =
  require("../desktop/mrt2-windows-assets.cjs") as {
    createWindowsMrt2Manifest: (options: Record<string, string>) => Record<string, unknown>;
    readManifest: (manifestPath: string) => Record<string, unknown>;
    verifyWindowsMrt2Manifest: (options: Record<string, string>) => Promise<Record<string, unknown>>;
    verifyWindowsMrt2HostScript: (options: Record<string, string>) => Record<string, unknown>;
  };

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kyx-mrt2-assets-"));
  const modelRoot = path.join(root, "model");
  const hostPath = path.join(root, "kyx-mrt2-windows-host.exe");
  const hostScriptPath = path.join(root, "kyx_mrt2_windows_host.py");
  const manifestPath = path.join(root, "manifest.json");
  mkdirSync(path.join(modelRoot, "resources", "musiccoca"), { recursive: true });
  mkdirSync(path.join(modelRoot, "checkpoints"), { recursive: true });
  writeFileSync(path.join(modelRoot, "resources", "musiccoca", "text_encoder.tflite"), Buffer.from("resource"));
  writeFileSync(path.join(modelRoot, "checkpoints", "mrt2_small.safetensors"), Buffer.from("checkpoint"));
  writeFileSync(hostPath, Buffer.from("host-binary"));
  writeFileSync(hostScriptPath, Buffer.from("host-script"));
  return { modelRoot, hostPath, hostScriptPath, manifestPath };
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

  it("rejects unlisted model files and manifest paths outside the managed asset roots", async () => {
    const paths = fixture();
    createWindowsMrt2Manifest(paths);
    writeFileSync(path.join(paths.modelRoot, "resources", "unexpected.bin"), Buffer.from("extra"));
    const result = await verifyWindowsMrt2Manifest(paths);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("model: unlisted asset resources/unexpected.bin");

    const manifest = readManifest(paths.manifestPath) as {
      modelRoot: { files: Array<Record<string, unknown>> };
    };
    manifest.modelRoot.files[0]!.path = "outside/asset.bin";
    writeFileSync(paths.manifestPath, JSON.stringify(manifest), "utf8");
    expect(() => readManifest(paths.manifestPath)).toThrow(/invalid model file entry/u);
  });

  it("pins and verifies the optional WSL host script independently", async () => {
    const paths = fixture();
    createWindowsMrt2Manifest(paths);
    expect(verifyWindowsMrt2HostScript(paths)).toEqual({ ok: true });
    writeFileSync(paths.hostScriptPath, Buffer.from("tampered-script"));
    expect(verifyWindowsMrt2HostScript(paths)).toMatchObject({
      ok: false,
      error: "byte length does not match manifest",
    });
    expect(await verifyWindowsMrt2Manifest(paths)).toMatchObject({ ok: false });
  });
});
