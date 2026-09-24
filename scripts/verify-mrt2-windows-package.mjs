import process from "node:process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { verifyWindowsMrt2Manifest } = require("../desktop/mrt2-windows-assets.cjs");
const root = fileURLToPath(new URL("..", import.meta.url));

const hostPath = process.env.KYX_MRT2_WINDOWS_HOST;
const modelRoot = process.env.KYX_MRT2_WINDOWS_MODEL_ROOT;
const manifestPath = process.env.KYX_MRT2_WINDOWS_MANIFEST;
if (!hostPath || !modelRoot || !manifestPath) {
  throw new Error(
    "Set KYX_MRT2_WINDOWS_HOST, KYX_MRT2_WINDOWS_MODEL_ROOT and KYX_MRT2_WINDOWS_MANIFEST before verification",
  );
}
const hostScriptPath =
  process.env.KYX_MRT2_WINDOWS_HOST_SCRIPT ?? path.join(root, "companion", "mrt2-windows", "kyx_mrt2_windows_host.py");
const result = await verifyWindowsMrt2Manifest({ hostPath, hostScriptPath, modelRoot, manifestPath });
if (!result.ok) {
  console.error(JSON.stringify(result, null, 2));
  throw new Error("MRT2 Windows package verification failed");
}
console.log(JSON.stringify(result, null, 2));
