import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = path.join(
  root,
  ".sft",
  "venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);
const testPath = path.join(root, "scripts", "test-creative-task-sft-safety.py");

if (!existsSync(python)) {
  process.stderr.write(`Creative SFT Python environment is missing: ${python}\n`);
  process.exit(2);
}

const result = spawnSync(python, [testPath], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error) {
  process.stderr.write(`Could not start creative SFT self-test: ${result.error.message}\n`);
  process.exit(2);
}
process.exit(result.status ?? 2);
