/**
 * Fixed-path Windows MRT2 package manifest helpers.
 *
 * The manifest is generated/verified outside the renderer. It covers the
 * helper executable and every regular file under the model root's resources,
 * models and checkpoints directories. Symlinks are rejected so a package
 * cannot hash one path and execute/read another through a link.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MRT2_WINDOWS_MANIFEST_VERSION = 1;
const MODEL_ASSET_DIRECTORIES = ["resources", "models", "checkpoints"];
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function sha256FileSync(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function relativeAssetPath(root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("MRT2 asset path escapes the model root");
  }
  return relative;
}

function collectRegularFiles(root, directory) {
  const base = path.join(root, directory);
  if (!fs.existsSync(base)) return [];
  const result = [];
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`MRT2 asset symlink is not allowed: ${current}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
      return;
    }
    if (!stat.isFile()) throw new Error(`MRT2 asset is not a regular file: ${current}`);
    result.push({
      path: relativeAssetPath(root, current),
      bytes: stat.size,
      sha256: sha256FileSync(current),
    });
  };
  visit(base);
  return result;
}

function collectRegularFilePaths(root, directory) {
  const base = path.join(root, directory);
  if (!fs.existsSync(base)) return [];
  const result = [];
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`MRT2 asset symlink is not allowed: ${current}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
      return;
    }
    if (!stat.isFile()) throw new Error(`MRT2 asset is not a regular file: ${current}`);
    result.push(relativeAssetPath(root, current));
  };
  visit(base);
  return result;
}

function isAllowedAssetPath(value) {
  return MODEL_ASSET_DIRECTORIES.some((directory) => value.startsWith(`${directory}/`));
}

function createWindowsMrt2Manifest({ hostPath, hostScriptPath, modelRoot, manifestPath, attribution } = {}) {
  if (typeof hostPath !== "string" || !hostPath) throw new Error("MRT2 Windows host path is required");
  if (typeof modelRoot !== "string" || !modelRoot) throw new Error("MRT2 Windows model root is required");
  const hostStat = fs.lstatSync(hostPath);
  if (!hostStat.isFile() || hostStat.isSymbolicLink()) throw new Error("MRT2 Windows host must be a regular file");
  const files = MODEL_ASSET_DIRECTORIES.flatMap((directory) => collectRegularFiles(modelRoot, directory)).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  if (!files.length) throw new Error("MRT2 Windows model root contains no manifestable assets");
  const manifest = {
    version: MRT2_WINDOWS_MANIFEST_VERSION,
    providerId: "mrt2",
    companion: { file: path.basename(hostPath), bytes: hostStat.size, sha256: sha256FileSync(hostPath) },
    modelRoot: {
      files,
      runtimeLicense: "Apache-2.0",
      modelLicense: "CC-BY-4.0",
      attribution:
        attribution ??
        "Google Magenta RealTime 2; source and model attribution: https://github.com/magenta/magenta-realtime",
    },
  };
  if (hostScriptPath) {
    const scriptStat = fs.lstatSync(hostScriptPath);
    if (!scriptStat.isFile() || scriptStat.isSymbolicLink()) {
      throw new Error("MRT2 WSL host script must be a regular file");
    }
    manifest.wslHostScript = {
      file: path.basename(hostScriptPath),
      bytes: scriptStat.size,
      sha256: sha256FileSync(hostScriptPath),
    };
  }
  const serialized = JSON.stringify(manifest, null, 2) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("MRT2 Windows manifest is too large");
  }
  if (manifestPath) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, serialized, "utf8");
  }
  return manifest;
}

function readManifest(manifestPath) {
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("MRT2 Windows manifest must be a regular file");
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error("MRT2 Windows manifest is too large");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("MRT2 Windows manifest is invalid JSON");
  }
  if (!value || typeof value !== "object" || value.version !== MRT2_WINDOWS_MANIFEST_VERSION) {
    throw new Error("MRT2 Windows manifest version is unsupported");
  }
  if (value.providerId !== "mrt2" || !value.companion || !value.modelRoot) {
    throw new Error("MRT2 Windows manifest identity is invalid");
  }
  if (!Array.isArray(value.modelRoot.files) || value.modelRoot.files.length === 0) {
    throw new Error("MRT2 Windows manifest contains no model files");
  }
  for (const entry of value.modelRoot.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !entry.path ||
      !isAllowedAssetPath(entry.path) ||
      entry.path.includes("\\") ||
      entry.path.startsWith("/") ||
      entry.path.includes("../") ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error("MRT2 Windows manifest contains an invalid model file entry");
    }
  }
  if (
    typeof value.companion.file !== "string" ||
    value.companion.file !== path.basename(value.companion.file) ||
    !/^[a-f0-9]{64}$/u.test(value.companion.sha256) ||
    !Number.isSafeInteger(value.companion.bytes) ||
    value.companion.bytes < 0 ||
    typeof value.modelRoot.runtimeLicense !== "string" ||
    typeof value.modelRoot.modelLicense !== "string" ||
    typeof value.modelRoot.attribution !== "string"
  ) {
    throw new Error("MRT2 Windows manifest package metadata is invalid");
  }
  if (
    value.wslHostScript !== undefined &&
    (!value.wslHostScript ||
      typeof value.wslHostScript.file !== "string" ||
      value.wslHostScript.file !== "kyx_mrt2_windows_host.py" ||
      !Number.isSafeInteger(value.wslHostScript.bytes) ||
      value.wslHostScript.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(value.wslHostScript.sha256))
  ) {
    throw new Error("MRT2 Windows manifest WSL host script metadata is invalid");
  }
  return value;
}

async function verifyWindowsMrt2Manifest({ hostPath, hostScriptPath, modelRoot, manifestPath } = {}) {
  if (typeof hostPath !== "string" || !hostPath) throw new Error("MRT2 Windows host path is required");
  if (typeof modelRoot !== "string" || !modelRoot) throw new Error("MRT2 Windows model root is required");
  if (typeof manifestPath !== "string" || !manifestPath) throw new Error("MRT2 Windows manifest path is required");
  const manifest = readManifest(manifestPath);
  const errors = [];
  const hostStat = (() => {
    try {
      const stat = fs.lstatSync(hostPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
      return stat;
    } catch (error) {
      errors.push(`companion: ${error instanceof Error ? error.message : "missing"}`);
      return null;
    }
  })();
  if (hostStat) {
    if (path.basename(hostPath) !== manifest.companion.file) errors.push("companion: filename does not match manifest");
    if (hostStat.size !== manifest.companion.bytes) errors.push("companion: byte length does not match manifest");
    if ((await sha256File(hostPath)) !== manifest.companion.sha256)
      errors.push("companion: SHA-256 does not match manifest");
  }
  if (manifest.wslHostScript) {
    if (!hostScriptPath) {
      errors.push("WSL companion: host script path is required by the manifest");
    } else {
      try {
        const scriptStat = fs.lstatSync(hostScriptPath);
        if (!scriptStat.isFile() || scriptStat.isSymbolicLink()) throw new Error("not a regular file");
        if (path.basename(hostScriptPath) !== manifest.wslHostScript.file) {
          errors.push("WSL companion: filename does not match manifest");
        }
        if (scriptStat.size !== manifest.wslHostScript.bytes) {
          errors.push("WSL companion: byte length does not match manifest");
        }
        if (sha256FileSync(hostScriptPath) !== manifest.wslHostScript.sha256) {
          errors.push("WSL companion: SHA-256 does not match manifest");
        }
      } catch (error) {
        errors.push(`WSL companion: ${error instanceof Error ? error.message : "missing"}`);
      }
    }
  } else if (hostScriptPath) {
    errors.push("WSL companion: host script is not listed in the manifest");
  }
  const seen = new Set();
  for (const entry of manifest.modelRoot.files) {
    if (seen.has(entry.path)) {
      errors.push(`model: duplicate manifest path ${entry.path}`);
      continue;
    }
    seen.add(entry.path);
    const filePath = path.resolve(modelRoot, entry.path);
    const rootPath = path.resolve(modelRoot) + path.sep;
    if (!filePath.startsWith(rootPath)) {
      errors.push(`model: path escapes root ${entry.path}`);
      continue;
    }
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
      if (stat.size !== entry.bytes) errors.push(`model: byte length mismatch ${entry.path}`);
      if ((await sha256File(filePath)) !== entry.sha256) errors.push(`model: SHA-256 mismatch ${entry.path}`);
    } catch (error) {
      errors.push(`model: ${entry.path} — ${error instanceof Error ? error.message : "missing"}`);
    }
  }
  try {
    const listed = new Set(manifest.modelRoot.files.map((entry) => entry.path));
    for (const directory of MODEL_ASSET_DIRECTORIES) {
      for (const actualPath of collectRegularFilePaths(modelRoot, directory)) {
        if (!listed.has(actualPath)) errors.push(`model: unlisted asset ${actualPath}`);
      }
    }
  } catch (error) {
    errors.push(`model: asset tree — ${error instanceof Error ? error.message : "invalid"}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    modelFileCount: manifest.modelRoot.files.length,
    runtimeLicense: manifest.modelRoot.runtimeLicense,
    modelLicense: manifest.modelRoot.modelLicense,
    attribution: manifest.modelRoot.attribution,
    ...(manifest.wslHostScript ? { wslHostScript: manifest.wslHostScript } : {}),
  };
}

function verifyWindowsMrt2HostScript({ hostScriptPath, manifestPath } = {}) {
  if (typeof hostScriptPath !== "string" || !hostScriptPath) throw new Error("MRT2 WSL host script path is required");
  if (typeof manifestPath !== "string" || !manifestPath) throw new Error("MRT2 Windows manifest path is required");
  const manifest = readManifest(manifestPath);
  if (!manifest.wslHostScript) return { ok: false, error: "WSL host script is not listed in the manifest" };
  try {
    const stat = fs.lstatSync(hostScriptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    if (path.basename(hostScriptPath) !== manifest.wslHostScript.file)
      throw new Error("filename does not match manifest");
    if (stat.size !== manifest.wslHostScript.bytes) throw new Error("byte length does not match manifest");
    if (sha256FileSync(hostScriptPath) !== manifest.wslHostScript.sha256)
      throw new Error("SHA-256 does not match manifest");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid host script" };
  }
}

module.exports = {
  MRT2_WINDOWS_MANIFEST_VERSION,
  MODEL_ASSET_DIRECTORIES,
  createWindowsMrt2Manifest,
  readManifest,
  verifyWindowsMrt2Manifest,
  verifyWindowsMrt2HostScript,
};
