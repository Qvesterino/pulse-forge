/**
 * SFZ PARSER (shared) — state-machine parser for the SFZ v1 opcode subset
 * KYX needs for multisample import: <control> default_path, <global>/<group>
 * carry-over, <region> sample/lokey/hikey/pitch_keycenter/lovel/hivel.
 *
 * Handles both SFZ layout styles: opcodes on the header line AND opcodes on
 * their own lines after the header (VSCO2 CE uses the latter). Group/global
 * opcodes carry over to subsequent regions per the SFZ spec. `//` comments
 * are stripped. Unknown headers/keys are ignored (forward compatibility).
 *
 * Pure — no fs, no fetch. Used by the converter scripts AND the in-app
 * user SFZ import.
 */

export interface SfzRegion {
  /** Region sample path — relative, may contain backslashes/spaces. */
  sample: string;
  lokey: number;
  hikey: number;
  /** Natural root of the sample (unshifted playback key). */
  keycenter: number;
  lovel: number;
  hivel: number;
}

export interface SfzDocument {
  defaultPath: string;
  regions: SfzRegion[];
}

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function parseSfz(text: string): SfzDocument {
  const bs = String.fromCharCode(92);
  let defaultPath = "";
  // The value may contain spaces ("Cello Section") — capture to EOL.
  for (const m of text.matchAll(/default_path\s*=\s*(.+?)\s*$/gm)) {
    defaultPath = m[1].split(bs).join("/");
  }
  const regions: SfzRegion[] = [];
  let ops: Record<string, string> = {};
  let current: "control" | "global" | "group" | "region" | null = null;

  const flushRegion = () => {
    if (current !== "region" || typeof ops.sample !== "string" || ops.sample === "") return;
    regions.push({
      sample: ops.sample.split(bs).join("/"),
      lokey: num(ops.lokey, 0),
      hikey: num(ops.hikey, 127),
      keycenter: num(ops.pitch_keycenter, num(ops.lokey, 60)),
      lovel: num(ops.lovel, 0),
      hivel: num(ops.hivel, 127),
    });
  };

  const readOpcodes = (line: string) => {
    for (const m of line.matchAll(/([\w.-]+)=("[^"]*"|\S+)/g)) {
      ops[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;
    const header = /<\s*(control|global|group|region|curve)\s*>(.*)/.exec(line);
    if (header) {
      flushRegion();
      current = header[1] as typeof current;
      // Opcodes may share the header line (<region> sample=foo.wav).
      readOpcodes(header[2]);
      continue;
    }
    readOpcodes(line.split("//")[0]);
  }
  flushRegion();
  return { defaultPath, regions };
}
