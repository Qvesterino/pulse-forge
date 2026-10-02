import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonPath = path.join(
  ROOT,
  ".sft",
  "venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);
const trainerPath = path.join(ROOT, "scripts", "train-creative-task-sft.py");

if (!existsSync(pythonPath)) {
  process.stderr.write(`Creative SFT Python environment is missing: ${pythonPath}\n`);
  process.exit(2);
}

const result = spawnSync(pythonPath, [trainerPath, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) {
  process.stderr.write(`Could not start creative SFT trainer: ${result.error.message}\n`);
  process.exit(2);
}
process.exit(result.status ?? 2);
