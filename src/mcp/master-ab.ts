/**
 * MASTER A/B SNAPSHOTS (mastering wave) — the workflow backbone: save the
 * WHOLE mastering state of a bus (every ZENIT/APEKS/ŠÍRKA/PRÚD instance's
 * params + output trim), compare snapshots parameter-by-parameter with a
 * level-match hint, and restore any snapshot as ONE undoable step.
 *
 * The classic mastering trap this kills: louder always sounds better, so
 * without level-matched A/B you are judging loudness, not tone. The compare
 * diff therefore reports each snapshot's output trim — restore + a trim
 * offset is the level-matched comparison path (a full loudness-matched
 * monitor bus is the follow-up, not this tool's promise).
 *
 * Pure planner + executor helpers; the snapshot store lives in the MCP
 * session (same lifecycle as kyx_checkpoint), never in the project document.
 */

export type MasterDeviceType = "zenit" | "apeks" | "sirka" | "prud";

export interface AbDeviceState {
  trackId: string;
  trackName: string;
  fxId: string;
  type: MasterDeviceType;
  params: Record<string, number>;
  outputTrimDb: number | null;
}

export interface AbSnapshot {
  name: string;
  savedAt: string;
  devices: AbDeviceState[];
}

export const AB_DEVICES: MasterDeviceType[] = ["zenit", "apeks", "sirka", "prud"];

/** Collect the mastering state of one track (instances in chain order). */
export function collectDevices(track: {
  id: string;
  name: string;
  effects: { id: string; type: string; params: Record<string, number>; outputTrimDb?: number }[];
}): AbDeviceState[] {
  return track.effects
    .filter((fx): fx is typeof fx & { type: MasterDeviceType } => (AB_DEVICES as string[]).includes(fx.type))
    .map((fx) => ({
      trackId: track.id,
      trackName: track.name,
      fxId: fx.id,
      type: fx.type,
      params: { ...fx.params },
      outputTrimDb: fx.outputTrimDb ?? null,
    }));
}

/** Parameter-level diff of two snapshots (same devices matched by type+track). */
export interface AbDiffRow {
  device: string;
  track: string;
  param: string;
  a: number | null;
  b: number | null;
}

export function diffSnapshots(a: AbSnapshot, b: AbSnapshot): AbDiffRow[] {
  const key = (d: AbDeviceState) => `${d.trackId}::${d.type}`;
  const bMap = new Map(b.devices.map((d) => [key(d), d]));
  const rows: AbDiffRow[] = [];
  for (const da of a.devices) {
    const db = bMap.get(key(da));
    if (!db) continue;
    const ids = new Set([...Object.keys(da.params), ...Object.keys(db.params)]);
    for (const param of ids) {
      const av = da.params[param];
      const bv = db.params[param];
      if (av !== bv) rows.push({ device: da.type, track: da.trackName, param, a: av ?? null, b: bv ?? null });
    }
    if (da.outputTrimDb !== db.outputTrimDb)
      rows.push({
        device: da.type,
        track: da.trackName,
        param: "outputTrimDb",
        a: da.outputTrimDb,
        b: db.outputTrimDb,
      });
  }
  return rows;
}

/** Read-back text for one snapshot (the compare table body). */
export function snapshotSummary(s: AbSnapshot): string {
  const trims = s.devices
    .filter((d) => d.outputTrimDb != null && d.outputTrimDb !== 0)
    .map((d) => `${d.trackName}/${d.type} ${d.outputTrimDb! > 0 ? "+" : ""}${d.outputTrimDb!.toFixed(1)} dB`);
  return `${s.name}: ${s.devices.length} device(s)${trims.length > 0 ? ` · trims ${trims.join(", ")}` : ""}`;
}
