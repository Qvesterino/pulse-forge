import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
const nexusKey = "node_modules/@audiotool/nexus";
const lockPackages = lock.packages;
if (!lockPackages || !lockPackages[nexusKey]) {
  throw new Error("@audiotool/nexus is missing from package-lock.json; cannot assemble its distribution notices.");
}

function resolveDependency(fromKey, name) {
  const segments = fromKey.split("/");
  while (true) {
    const candidate = segments.length > 0 ? [...segments, "node_modules", name].join("/") : `node_modules/${name}`;
    if (lockPackages[candidate]) return candidate;
    if (segments.length === 0) break;
    segments.pop();
  }
  return null;
}

const pending = [nexusKey];
const included = new Set();
while (pending.length > 0) {
  const key = pending.pop();
  if (!key || included.has(key)) continue;
  const entry = lockPackages[key];
  if (!entry) throw new Error(`Missing locked package entry for ${key}.`);
  included.add(key);
  for (const dependency of Object.keys(entry.dependencies ?? {})) {
    const resolved = resolveDependency(key, dependency);
    if (!resolved) throw new Error(`Cannot resolve ${dependency} required by ${key}.`);
    pending.push(resolved);
  }
}

const outputDir = path.join(repoRoot, "dist", "third-party-licenses");
await mkdir(outputDir, { recursive: true });
const noticeLines = [
  "Third-party software included in KYX",
  "",
  "This directory contains the license texts for @audiotool/nexus and its locked runtime dependency closure.",
  "The Nexus 0.0.19 npm metadata declares MIT, while its published LICENSE file says Apache License 2.0.",
  "KYX preserves the actual published LICENSE text and treats the SDK conservatively as Apache-2.0 pending clarification.",
  "",
];

for (const key of [...included].sort()) {
  const entry = lockPackages[key];
  const packageDir = path.join(repoRoot, key);
  const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  const filenames = await readdir(packageDir);
  const licenseFiles = filenames.filter((filename) => /^(license|licence|copying)(\.|$)/i.test(filename));
  noticeLines.push(
    `${packageJson.name}@${entry.version} — declared license: ${String(packageJson.license ?? "unspecified")}`,
  );
  if (licenseFiles.length === 0) {
    noticeLines.push("  Upstream npm tarball contains no license text file; SPDX metadata retained above.");
  }
  for (const filename of licenseFiles.sort()) {
    const source = path.join(packageDir, filename);
    const destinationName = `${packageJson.name.replaceAll("/", "__")}@${entry.version}-${filename}`;
    await copyFile(source, path.join(outputDir, destinationName));
    const text = await readFile(source, "utf8");
    if (key === nexusKey && filename.toLowerCase() === "license" && !text.trimStart().startsWith("Apache License")) {
      throw new Error("The published Nexus LICENSE content changed; review licensing before shipping.");
    }
    noticeLines.push(`  See ${destinationName}`);
  }
  noticeLines.push("");
}

await writeFile(path.join(outputDir, "NOTICE.txt"), `${noticeLines.join("\n")}\n`, "utf8");
