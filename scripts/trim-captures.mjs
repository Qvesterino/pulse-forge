/**
 * Find where real content starts in each capture and re-trim the clips so
 * the black lead-in (Playwright starts recording on about:blank, before
 * the app has navigated) is removed.
 *
 * Playwright's recorder begins at context creation, so every clip opens
 * with several seconds of black while the page loads. Scene trim windows
 * should not have to know about that, so the clips are cut here instead.
 *
 * Usage: node scripts/trim-captures.mjs
 */
import { execFileSync } from "node:child_process";
import { readdirSync, renameSync, statSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// The captures live in the QVESTER landing-page repo, not next to this
// script, so the directory is an argument rather than a relative guess.
const DIR_ARG = process.argv.indexOf("--dir");
const CAPTURES =
  DIR_ARG !== -1 ? resolve(process.argv[DIR_ARG + 1]) : resolve(HERE, "../remotion/audiotool-demo/assets/captures");

/**
 * Fraction of pixels above a luma threshold — a "is there an actual UI here?"
 * probe. Averaging is useless on a dark theme: the KYX studio averages ~15/255
 * everywhere, including the black lead-in, so an average threshold never
 * separates them. Counting bright pixels does.
 */
function contentRatio(file, second) {
  const out = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-ss",
      String(second),
      "-frames:v",
      "1",
      "-vf",
      "scale=320:180,format=gray",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  let bright = 0;
  for (const b of out) if (b > 40) bright += 1;
  return bright / out.length;
}

const durationOf = (file) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());

for (const name of readdirSync(CAPTURES).filter((f) => f.endsWith(".webm"))) {
  const file = resolve(CAPTURES, name);
  const dur = durationOf(file);

  // Probe on a 1s grid until the frame shows real UI pixels.
  let firstContent = 0;
  for (let t = 0; t < dur - 1; t += 1) {
    if (contentRatio(file, t) > 0.01) {
      firstContent = t;
      break;
    }
  }

  // Keep a little lead so the transition into content is not abrupt.
  const start = Math.max(0, firstContent - 0.6);
  const keep = Math.max(1, dur - start - 0.8);

  // Write the trimmed clip beside the original: renameSync across drives
  // fails with EXDEV on Windows, and the temp dir is on C: while the
  // captures are on D:.
  const staged = resolve(CAPTURES, `.trim-${name}`);
  const before = statSync(file).size;
  execFileSync("ffmpeg", [
    "-y",
    "-ss",
    start.toFixed(2),
    "-i",
    file,
    "-t",
    keep.toFixed(2),
    "-c:v",
    "libvpx",
    "-b:v",
    "4M",
    staged,
  ]);
  const after = statSync(staged).size;
  rmSync(file, { force: true });
  renameSync(staged, file);

  console.log(
    `${name.padEnd(28)} ${dur.toFixed(1)}s  black lead ${firstContent.toFixed(0)}s -> trimmed to ${keep.toFixed(1)}s  ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`,
  );
}

console.log("\ntrim windows are now relative to the start of real content.");
