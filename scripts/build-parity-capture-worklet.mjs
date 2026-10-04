/**
 * Bundle the live↔offline parity capture processor into public/.
 *
 * Same esbuild contract as build-core-worklets.mjs: hierarchical file from
 * public/ in dev and dist, IIFE entry. Test-only processor (used by the
 * browser release gate to null-test the live master against the offline
 * render), but shipped in `public/` so the dev server and the production
 * preview can both load it without a special bundler path.
 */
import { build } from "esbuild";

await build({
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  logLevel: "warning",
  entryPoints: ["src/audio-worklets/capture-processor.js"],
  outfile: "public/parity-capture-worklet.js",
  banner: {
    js: "/* KYX live/offline parity capture worklet — generated. Do not edit. */",
  },
});

console.log("[parity-capture] bundle written to public/parity-capture-worklet.js");
