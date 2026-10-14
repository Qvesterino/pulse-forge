/**
 * Bundle the stock AudioWorklet processors into self-contained modules.
 *
 * Vite turns `new URL("./core-processor.js", import.meta.url)` into a data URL
 * in a production bundle. That is unsafe for an AudioWorklet entry which has
 * relative imports: a data URL has no hierarchical base, so Chrome rejects
 * every `./sidechain-processor.js` import. Keep the two-module loader contract
 * while serving real hierarchical files from public/ in both dev and dist.
 * The bounded generative PCM sink is emitted as a third, on-demand module.
 */
import { build } from "esbuild";

const shared = {
  bundle: true,
  format: "iife",
  target: "es2022",
  // Emit compact modules to keep studio-startup and on-demand worklet parsing
  // quick. DSP sources remain readable and testable.
  minify: true,
  logLevel: "warning",
};

await build({
  ...shared,
  entryPoints: ["src/audio-worklets/bitcrusher-processor.js"],
  outfile: "public/bitcrusher-worklet.js",
  banner: {
    js: "/* KYX core bitcrusher worklet — generated. Do not edit. */",
  },
});

await build({
  ...shared,
  entryPoints: ["src/audio-worklets/core-processor.js"],
  outfile: "public/core-worklet.js",
  banner: {
    js: "/* KYX core AudioWorklet bundle — generated. Do not edit. */",
  },
});

await build({
  ...shared,
  entryPoints: ["src/audio-worklets/generative-player-processor.js"],
  outfile: "public/generative-player-worklet.js",
  banner: {
    js: "/* KYX on-demand generative player worklet — generated. Do not edit. */",
  },
});

console.log(
  "[core-worklets] bundles written to public/bitcrusher-worklet.js, public/core-worklet.js, and public/generative-player-worklet.js",
);
