/**
 * Build the optional Windows MRT2 companion from the protocol-first Python
 * source. This is intentionally opt-in: PyInstaller and the JAX wheel are
 * platform/driver-specific and are not npm dependencies.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = path.join(root, "companion", "mrt2-windows", "kyx_mrt2_windows_host.py");
const outputDir = path.join(root, "build", "mrt2-windows");
const workDir = path.join(root, "build", ".pyinstaller-mrt2-windows");
const executable = path.join(outputDir, "kyx-mrt2-windows-host.exe");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? `code ${code}`})`));
    });
  });
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The Windows MRT2 companion must be built on Windows x64.");
}
if (!existsSync(source)) throw new Error(`Missing companion source: ${source}`);

await mkdir(outputDir, { recursive: true });
await mkdir(workDir, { recursive: true });
console.log("• verify magenta_rt + JAX are installed before packaging");
await run("python", [
  "-c",
  "import importlib.util; missing = [name for name in ('magenta_rt', 'jax', 'jaxlib') if importlib.util.find_spec(name) is None]; raise SystemExit('Missing Windows MRT2 runtime modules: ' + ', '.join(missing)) if missing else None",
]);
console.log("• build KYX Windows MRT2 companion with the local Python environment");
await run("python", [
  "-m",
  "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onefile",
  "--name",
  "kyx-mrt2-windows-host",
  "--distpath",
  outputDir,
  "--workpath",
  workDir,
  "--specpath",
  workDir,
  "--collect-all",
  "magenta_rt",
  "--collect-submodules",
  "jax",
  "--hidden-import",
  "jaxlib",
  source,
]);
if (!existsSync(executable)) throw new Error(`PyInstaller completed without producing ${executable}`);
console.log("• ready: " + executable);
console.log("  Copy it to resources/mrt2-windows/ before packaging the Windows desktop app.");
