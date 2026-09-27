/**
 * Bundle the PCM playback processor (ADR 0018 wave 3) into public/.
 *
 * Same esbuild contract as build-core-worklets.mjs: hierarchical file from
 * public/ in dev and dist, TS import bundled in, IIFE entry.
 */
import { build } from "esbuild";

await build({
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  logLevel: "warning",
  entryPoints: ["src/audio-worklets/pcm-playback-processor.js"],
  outfile: "public/pcm-playback-worklet.js",
  banner: {
    js: "/* KYX PCM playback worklet — generated. Do not edit. */",
  },
});
