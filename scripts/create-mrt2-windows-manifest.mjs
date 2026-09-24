import process from "node:process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createWindowsMrt2Manifest } = require("../desktop/mrt2-windows-assets.cjs");
const root = fileURLToPath(new URL("..", import.meta.url));

const hostPath = process.env.KYX_MRT2_WINDOWS_HOST;
const modelRoot = process.env.KYX_MRT2_WINDOWS_MODEL_ROOT;
const manifestPath = process.env.KYX_MRT2_WINDOWS_MANIFEST;
if (!hostPath || !modelRoot || !manifestPath) {
  throw new Error(
    "Set KYX_MRT2_WINDOWS_HOST, KYX_MRT2_WINDOWS_MODEL_ROOT and KYX_MRT2_WINDOWS_MANIFEST before creating a manifest",
  );
}
const hostScriptPath =
  process.env.KYX_MRT2_WINDOWS_HOST_SCRIPT ?? path.join(root, "companion", "mrt2-windows", "kyx_mrt2_windows_host.py");
const manifest = createWindowsMrt2Manifest({ hostPath, hostScriptPath, modelRoot, manifestPath });
console.log(`MRT2 Windows manifest written: ${manifestPath} (${manifest.modelRoot.files.length} model files)`);
