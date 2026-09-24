import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { verifyWindowsMrt2Manifest } = require("../desktop/mrt2-windows-assets.cjs");

const hostPath = process.env.KYX_MRT2_WINDOWS_HOST;
const modelRoot = process.env.KYX_MRT2_WINDOWS_MODEL_ROOT;
const manifestPath = process.env.KYX_MRT2_WINDOWS_MANIFEST;
if (!hostPath || !modelRoot || !manifestPath) {
  throw new Error(
    "Set KYX_MRT2_WINDOWS_HOST, KYX_MRT2_WINDOWS_MODEL_ROOT and KYX_MRT2_WINDOWS_MANIFEST before verification",
  );
}
const result = await verifyWindowsMrt2Manifest({ hostPath, modelRoot, manifestPath });
if (!result.ok) {
  console.error(JSON.stringify(result, null, 2));
  throw new Error("MRT2 Windows package verification failed");
}
console.log(JSON.stringify(result, null, 2));
