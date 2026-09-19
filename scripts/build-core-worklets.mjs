/**
 * Bundle the stock AudioWorklet processors into self-contained modules.
 *
 * Vite turns `new URL("./core-processor.js", import.meta.url)` into a data URL
 * in a production bundle. That is unsafe for an AudioWorklet entry which has
 * relative imports: a data URL has no hierarchical base, so Chrome rejects
 * every `./sidechain-processor.js` import. Keep the two-module loader contract
 * while serving real hierarchical files from public/ in both dev and dist.
 */
import { build } from "esbuild";

const shared = {
  bundle: true,
  format: "iife",
  target: "es2022",
  // These stock processors load during studio startup; emit compact modules
  // so worklet parsing stays quick and the shipped core bundle stays within
  // its explicit release budget. DSP sources remain readable and testable.
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

console.log("[core-worklets] bundles written to public/bitcrusher-worklet.js and public/core-worklet.js");
