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
  /** Zero-based occurrence among this device type on the track; omitted when unique. */
  instanceIndex?: number;
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
  const totals = new Map<MasterDeviceType, number>();
  for (const fx of track.effects) {
    if ((AB_DEVICES as string[]).includes(fx.type)) {
      const type = fx.type as MasterDeviceType;
      totals.set(type, (totals.get(type) ?? 0) + 1);
    }
  }

  const occurrences = new Map<MasterDeviceType, number>();
  const devices: AbDeviceState[] = [];
  for (const fx of track.effects) {
    if (!(AB_DEVICES as string[]).includes(fx.type)) continue;
    const type = fx.type as MasterDeviceType;
    const instanceIndex = occurrences.get(type) ?? 0;
    occurrences.set(type, instanceIndex + 1);
    devices.push({
      trackId: track.id,
      trackName: track.name,
      fxId: fx.id,
      type,
      ...(totals.get(type)! > 1 ? { instanceIndex } : {}),
      params: { ...fx.params },
      outputTrimDb: fx.outputTrimDb ?? null,
    });
  }
  return devices;
}

/** Parameter-level diff; stable IDs survive reordering and per-type order survives ID churn. */
export interface AbDiffRow {
  device: string;
  track: string;
  param: string;
  a: number | null;
  b: number | null;
  instanceIndex?: number;
  presenceChange?: "missing-in-current" | "new-in-current";
}

export function diffSnapshots(a: AbSnapshot, b: AbSnapshot): AbDiffRow[] {
  const familyKey = (d: AbDeviceState) => JSON.stringify([d.trackId, d.type]);
  const remaining = new Map<string, AbDeviceState[]>();
  for (const device of b.devices) {
    const key = familyKey(device);
    const matches = remaining.get(key) ?? [];
    matches.push(device);
    remaining.set(key, matches);
  }

  const rows: AbDiffRow[] = [];
  for (const da of a.devices) {
    const matches = remaining.get(familyKey(da)) ?? [];
    let matchIndex = da.fxId ? matches.findIndex((candidate) => candidate.fxId === da.fxId) : -1;
    if (matchIndex < 0) {
      const instanceIndex = da.instanceIndex ?? 0;
      matchIndex = matches.findIndex((candidate) => (candidate.instanceIndex ?? 0) === instanceIndex);
    }
    const db = matchIndex >= 0 ? matches.splice(matchIndex, 1)[0] : undefined;
    if (!db) {
      rows.push({
        device: da.type,
        track: da.trackName,
        param: "device",
        a: 1,
        b: null,
        ...(da.instanceIndex === undefined ? {} : { instanceIndex: da.instanceIndex }),
        presenceChange: "missing-in-current",
      });
      continue;
    }
    const instanceIndex = da.instanceIndex ?? db.instanceIndex;
    const rowIdentity = instanceIndex === undefined ? {} : { instanceIndex };
    const ids = new Set([...Object.keys(da.params), ...Object.keys(db.params)]);
    for (const param of ids) {
      const av = da.params[param];
      const bv = db.params[param];
      if (av !== bv) {
        rows.push({ device: da.type, track: da.trackName, param, a: av ?? null, b: bv ?? null, ...rowIdentity });
      }
    }
    if (da.outputTrimDb !== db.outputTrimDb)
      rows.push({
        device: da.type,
        track: da.trackName,
        param: "outputTrimDb",
        a: da.outputTrimDb,
        b: db.outputTrimDb,
        ...rowIdentity,
      });
  }
  for (const matches of remaining.values()) {
    for (const db of matches) {
      rows.push({
        device: db.type,
        track: db.trackName,
        param: "device",
        a: null,
        b: 1,
        ...(db.instanceIndex === undefined ? {} : { instanceIndex: db.instanceIndex }),
        presenceChange: "new-in-current",
      });
    }
  }
  return rows;
}

/** Read-back text for one snapshot (the compare table body). */
export function snapshotSummary(s: AbSnapshot): string {
  const trims = s.devices
    .filter((d) => d.outputTrimDb != null && d.outputTrimDb !== 0)
    .map(
      (d) =>
        `${d.trackName}/${d.type}${d.instanceIndex === undefined ? "" : ` #${d.instanceIndex + 1}`} ${d.outputTrimDb! > 0 ? "+" : ""}${d.outputTrimDb!.toFixed(1)} dB`,
    );
  return `${s.name}: ${s.devices.length} device(s)${trims.length > 0 ? ` · trims ${trims.join(", ")}` : ""}`;
}
