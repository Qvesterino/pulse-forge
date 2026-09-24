import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createWindowsMrt2Manifest } = require("../desktop/mrt2-windows-assets.cjs");

const hostPath = process.env.KYX_MRT2_WINDOWS_HOST;
const modelRoot = process.env.KYX_MRT2_WINDOWS_MODEL_ROOT;
const manifestPath = process.env.KYX_MRT2_WINDOWS_MANIFEST;
if (!hostPath || !modelRoot || !manifestPath) {
  throw new Error(
    "Set KYX_MRT2_WINDOWS_HOST, KYX_MRT2_WINDOWS_MODEL_ROOT and KYX_MRT2_WINDOWS_MANIFEST before creating a manifest",
  );
}
const manifest = createWindowsMrt2Manifest({ hostPath, modelRoot, manifestPath });
console.log(`MRT2 Windows manifest written: ${manifestPath} (${manifest.modelRoot.files.length} model files)`);
