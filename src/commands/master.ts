import type { Command } from "./types";
import type { MasterConfig, ProjectDocument } from "../project-model/types";
import { clamp } from "../shared/ids";

/**
 * Master bus, track sends and return tracks.
 */
/* ---------------- master / sends / returns ---------------- */

/**
 * MATCH EQ apply ("znej ako ref"): install the measured corrective curve on
 * the master (one undo). The curve comes from `computeMatchEqCurve`
 * (src/intent/match-eq.ts) — this command only carries it into the document
 * so live and offline render the same correction. `null` clears the stage.
 */
export function applyMasterMatchEqCommand(
  doc: ProjectDocument,
  curve: { low: number; lowMid: number; highMid: number; high: number } | null,
  /**
   * Reference loudness trim (reference conditioning wave) — the level half
   * of "znej ako ref", derived from the reference's own BS.1770 loudness
   * (see match-eq.referenceLoudnessTrim). Clamped ±6 like the per-genre
   * trim; undefined leaves the existing trim untouched.
   */
  loudnessTrimDb?: number,
): Command {
  const clamp6 = (v: number): number => Math.max(-6, Math.min(6, Number.isFinite(v) ? v : 0));
  const matchEq = curve
    ? {
        low: clamp6(curve.low),
        lowMid: clamp6(curve.lowMid),
        highMid: clamp6(curve.highMid),
        high: clamp6(curve.high),
      }
    : undefined;
  const fmt = (v: number): string => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
  const parts: string[] = [];
  if (matchEq)
    parts.push(`Match EQ ${fmt(matchEq.low)}/${fmt(matchEq.lowMid)}/${fmt(matchEq.highMid)}/${fmt(matchEq.high)} dB`);
  if (loudnessTrimDb !== undefined) parts.push(`loudness ${fmt(loudnessTrimDb)} dB`);
  const label = parts.length > 0 ? parts.join(" · ") : "Match EQ off";
  const command = setMasterConfig(doc, {
    ...(matchEq ? { matchEq } : {}),
    ...(loudnessTrimDb !== undefined ? { loudnessTrimDb: clamp6(loudnessTrimDb) } : {}),
  });
  return { ...command, label };
}

export function setMasterConfig(doc: ProjectDocument, patch: Partial<MasterConfig>): Command {
  const prev = { ...doc.master };
  return {
    type: "setMasterConfig",
    label: "Edit master chain",
    execute: (d) => ({ ...d, master: { ...d.master, ...patch } }),
    undo: (d) => ({ ...d, master: prev }),
    applyToYDoc: (yMap) => {
      const master = yMap.get("master") as any;
      if (master)
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) master.set(k, v);
        }
    },
  };
}

export function setTrackSend(doc: ProjectDocument, trackId: string, returnId: string, level: number): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  const prev = track.sends[returnId] ?? 0;
  const clamped = clamp(level, 0, 1.5);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) => (t.id === trackId ? { ...t, sends: { ...t.sends, [returnId]: v } } : t)),
  });
  return {
    type: "setTrackSend",
    label: "Set send level",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("id") === trackId) {
          (t.get("sends") as any).set(returnId, clamped);
          break;
        }
      }
    },
  };
}

export function setReturnGain(doc: ProjectDocument, returnId: string, gain: number): Command {
  const prev = doc.returns.find((r) => r.id === returnId)?.gain ?? 0.9;
  const clamped = clamp(gain, 0, 1.5);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    returns: d.returns.map((r) => (r.id === returnId ? { ...r, gain: v } : r)),
  });
  return {
    type: "setReturnGain",
    label: "Set return gain",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const returns = yMap.get("returns") as any;
      for (let i = 0; i < returns.length; i++) {
        const r = returns.get(i);
        if (r.get("id") === returnId) {
          r.set("gain", clamped);
          break;
        }
      }
    },
  };
}
