import type { Command } from "../commands/types";
import type { ProjectDocument } from "../project-model/types";
import {
  addAutomationLane,
  addAutomationPoint,
  addMarker,
  removeMarker,
  setGroove,
  snapshot,
} from "../commands/commands";

/**
 * STUDIO WORDS — groove/swing, gain automation ramps and markers.
 *
 * Three producer asks the exact layer doesn't cover, all doc-mutating and
 * ONE undo step each:
 *
 *   groove   — "more swing", "tighter groove", "more human", "swing 60%"
 *   automate — "automate the volume from 0 to 100 through the intro"
 *              (track-gain ramp lane over the named span)
 *   marker   — "add a marker at bar 8", "delete the marker at bar 8"
 *
 * All numbers are HUMAN units (percent, bars) — the adapters translate to
 * engine units exactly like the model-schema contract. Value clamps:
 * groove 0..1, gain percent 0..100 → gain 0..1, bars ≥ 1.
 */

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

// ── Groove / swing ──────────────────────────────────────────────────────────

export interface GrooveIntent {
  /** swing up/down, humanize up/down, or absolute swing set */
  direction: "swingUp" | "swingDown" | "humanizeUp" | "humanizeDown" | "tighter" | "set";
  /** percent for direction "set" (swing 60% → 0.6) */
  percent?: number;
}

const GROOVE_WORD = /\bgroove\b|\bswing\b|\bhumaniz|\bhuman\b|\bswingu\b|\bgroovu\b/;

export function parseGrooveIntent(text: string): GrooveIntent | null {
  if (!GROOVE_WORD.test(text)) return null;
  // absolute swing: the number DIRECTLY after the groove word ("swing 60%")
  // is an explicit set — no set-verb needed, the position is the intent
  const absolute = /\b(?:swing|groove)\s*(?:to|=|na)?\s*(\d{1,3})\s*%?/.exec(text);
  if (absolute) {
    return { direction: "set", percent: Math.max(0, Math.min(100, Number(absolute[1]))) };
  }
  if (/\btight(?:er|en)\b|\bpevnejsi\b|\bpevnej\b/.test(text)) return { direction: "tighter" };
  if (/\bhumaniz|\bmore human\b|\bzyv\n? human\b/.test(text)) return { direction: "humanizeUp" };
  if (/\b(?:more|viac)\b.*\bswing|(?<!\w)swing.*\b(?:more|viac)\b/.test(text)) return { direction: "swingUp" };
  if (/\b(?:less|less swing|menej)\b.*\bswing|\bswing\b.*\bless\b/.test(text)) return { direction: "swingDown" };
  // bare "more groove"/"viac swingu" leans swing (the audible ask)
  if (/\bmore groove\b|\bviac groovu\b|\bviac swingu\b/.test(text)) return { direction: "swingUp" };
  return null;
}

export function applyGrooveIntent(doc: ProjectDocument, intent: GrooveIntent): Command {
  const groove = doc.groove ?? { swing: 0, humanizeTiming: 0, humanizeVelocity: 0 };
  const step = 0.1;
  switch (intent.direction) {
    case "swingUp":
      return setGroove(doc, { swing: clamp01((groove.swing ?? 0) + step) });
    case "swingDown":
      return setGroove(doc, { swing: clamp01((groove.swing ?? 0) - step) });
    case "humanizeUp":
      return setGroove(doc, { humanizeTiming: clamp01((groove.humanizeTiming ?? 0) + step) });
    case "humanizeDown":
      return setGroove(doc, { humanizeTiming: clamp01((groove.humanizeTiming ?? 0) - step) });
    case "tighter":
      // tighter = less swing AND less timing looseness, one step
      return setGroove(doc, {
        swing: clamp01((groove.swing ?? 0) - step),
        humanizeTiming: clamp01((groove.humanizeTiming ?? 0) - step),
      });
    case "set":
      return setGroove(doc, { swing: clamp01(((intent.percent ?? 0) / 100) * 1) });
  }
}

/** Read-back: the resulting groove line. */
export function grooveReadback(after: ProjectDocument): string {
  const g = after.groove;
  if (!g) return "";
  const pct = (value: number): number => Math.round(value * 100);
  return `swing ${pct(g.swing ?? 0)}% · humanize ${pct(g.humanizeTiming ?? 0)}%`;
}

// ── Automation ramp (track gain) ────────────────────────────────────────────

export interface AutomateIntent {
  trackId: string;
  fromPercent: number;
  toPercent: number;
}

const AUTOMATE_ASK =
  /\bautomate\b\s+(?:the\s+)?(?:([a-z-]+)\s+)?(?:volume|gain|level)\s+(?:of\s+(?:the\s+)?[a-z-]+\s+)?(?:from\s+(\d{1,3})\s*(?:%)?\s*)?to\s+(\d{1,3})\s*(?:%)?\b/i;

/**
 * "automate the volume from 0 to 100 through the intro" — a track-GAIN ramp
 * lane spanning the named role's clips (or the whole arrangement when no
 * role is named). Values are human percent (0..100 → gain 0..1). One lane +
 * two points (start/end of the span), ONE undo step.
 */
export function parseAutomateIntent(text: string): AutomateIntent | null {
  const m = AUTOMATE_ASK.exec(text);
  if (!m) return null;
  const to = Number(m[3]);
  if (!Number.isFinite(to)) return null;
  const from = m[2] != null ? Number(m[2]) : 100;
  return {
    trackId: m[1] ?? "",
    fromPercent: Math.max(0, Math.min(100, from)),
    toPercent: Math.max(0, Math.min(100, to)),
  };
}

export function applyAutomateIntent(
  doc: ProjectDocument,
  intent: AutomateIntent,
  span: { startTick: number; endTick: number } | null,
): Command | null {
  // target track: the named family, else the first track (explicit "volume"
  // without a target on a project with one lane is unambiguous enough)
  const family = intent.trackId;
  const track =
    doc.tracks.find(
      (t) =>
        t.kind !== "group" &&
        (family === "" ||
          ["bass", "808", "logdrum"].includes(t.kind === "instrument" ? t.instrument : "") ||
          new RegExp(`\\b${family}\\b`, "i").test(t.name) ||
          (family === "drums" && t.kind === "drum")),
    ) ?? doc.tracks.find((t) => t.kind !== "group");
  if (!track) return null;
  const PPQ = 480;
  const bar = 4 * PPQ;
  const startTick = span?.startTick ?? 0;
  const endTick =
    span?.endTick ??
    Math.max(bar, doc.arrangement.clips.reduce((mx, c) => Math.max(mx, c.startBar + c.lengthBars), 1) * bar);
  let next = addAutomationLane(doc, { kind: "trackGain", trackId: track.id }).execute(doc);
  const lane = next.automation[next.automation.length - 1];
  next = addAutomationPoint(next, lane.id, startTick, intent.fromPercent / 100).execute(next);
  next = addAutomationPoint(next, lane.id, endTick, intent.toPercent / 100).execute(next);
  return snapshot(
    "applyAutomateIntent",
    `Automate ${track.name} gain ${intent.fromPercent}%→${intent.toPercent}%`,
    doc,
    next,
  );
}

// ── Markers ─────────────────────────────────────────────────────────────────

export interface MarkerIntent {
  action: "add" | "remove";
  bar: number;
  name?: string;
}

const MARKER_ADD = /\b(?:add|pridaj|drop)\s+(?:a\s+)?(?:marker|cue)(?:\s+(?:at|on|na)\s+(?:bar|takt)?\s*(\d{1,3}))?/i;
const MARKER_REMOVE = /\b(?:delete|remove|zmaz|odstran)\s+(?:the\s+)?(?:marker|cue)\s+(?:at\s+)?(?:bar\s+)?(\d{1,3})/i;

export function parseMarkerIntent(text: string): MarkerIntent | null {
  const add = MARKER_ADD.exec(text);
  if (add) {
    const bar = add[1] != null ? Number(add[1]) : 1;
    const name = /\b(?:drop|chorus|break|build|verse|intro|outro)\b/i.exec(text)?.[0];
    return { action: "add", bar: Math.max(1, bar), ...(name != null ? { name } : {}) };
  }
  const remove = MARKER_REMOVE.exec(text);
  if (remove) return { action: "remove", bar: Math.max(1, Number(remove[1])) };
  return null;
}

export function applyMarkerIntent(doc: ProjectDocument, intent: MarkerIntent): Command | null {
  const tick = (intent.bar - 1) * 4 * 480; // 1-based user bar, 4/4
  if (intent.action === "add") {
    return addMarker(doc, { tick, name: intent.name });
  }
  // remove the marker nearest to the named bar (within one bar)
  const target = doc.markers.find((m) => Math.abs(m.tick - tick) < 4 * 480);
  if (!target) return null;
  return removeMarker(doc, target.id);
}

/** Read-back: which markers exist at/near the touched bar. */
export function markerReadback(after: ProjectDocument, intent: MarkerIntent): string {
  const tick = (intent.bar - 1) * 4 * 480;
  const near = after.markers.filter((m) => Math.abs(m.tick - tick) < 4 * 480);
  return near.map((m) => `${m.name}@${Math.round(m.tick / 480 / 4) + 1}`).join(", ");
}

// ── SECTION GROOVE — swing baked into a named section's pattern ─────────────

import type { DrumTrack } from "../project-model/types";
import { resolveSceneTarget, type ArrangeRole } from "./arrangeWords";
import { setStepMeta } from "../commands/commands";

/**
 * "more swing in the drop", "tighter groove on the intro", "swing 65% in the
 * drop" — SECTION-SCOPED groove. The engine applies global swing live from
 * doc.groove (swingOffsetTicks on odd 16ths), so a section ask bakes the
 * DELTA into the section pattern's step metadata instead: odd steps get
 * microtiming (1 unit = MAX_MICRO_TIMING = 0.3 step = 36 ticks, while swing
 * 1.0 delays an odd step by 60 ticks — hence the ×5/3 conversion). Even
 * steps are untouched. ONE undo step via snapshot; even steps and other
 * patterns are never modified.
 */

export interface SectionGrooveIntent {
  role: string;
  direction: "swingUp" | "swingDown" | "tighter" | "set";
  swingPercent?: number;
}

const SECTION_GROOVE_ASK = /\b(?:swing|groove|humaniz\w*|swingu|groovu)\b/i;

const ROLE_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/intro|uvod/, "intro"],
  [/build|stavb/, "build"],
  [/chorus|hook|refren/, "chorus"],
  [/verse|zloh/, "verse"],
  [/bridge|most/, "bridge"],
  [/drop/, "drop"],
  [/break|brejk/, "break"],
  [/outro|zaver|koncovka/, "outro"],
  [/fill|veto/, "fill"],
];

export function parseSectionGrooveIntent(text: string): SectionGrooveIntent | null {
  if (!SECTION_GROOVE_ASK.test(text)) return null;
  // the role must be a NAMED SPAN, not the object of another verb
  let role: string | null = null;
  for (const [re, name] of ROLE_WORDS) {
    if (re.test(text)) {
      role = name;
      break;
    }
  }
  if (!role) return null;
  // scoped connector: "in|on|through the drop", "na dropu", "v intro"
  if (!/\b(?:in|on|through|na|v|cez|po)\b/i.test(text)) return null;
  // competing scene ops must not be hijacked ("remove the drop" stays arrange)
  if (/\b(?:remove|delete|duplicate|shorten|extend|add)\b/i.test(text)) return null;

  const absolute = /\b(?:swing|groove)\s*(?:to|=|na)?\s*(\d{1,3})\s*%?/i.exec(text);
  if (absolute) {
    return { role, direction: "set", swingPercent: Math.max(0, Math.min(100, Number(absolute[1]))) };
  }
  if (/\btight(?:er|en)\b/i.test(text)) return { role, direction: "tighter" };
  if (/\b(?:more|viac)\b/i.test(text)) return { role, direction: "swingUp" };
  if (/\b(?:less|menej)\b/i.test(text)) return { role, direction: "swingDown" };
  return null;
}

/** swing units → stepMeta microtiming units (odd 16ths): ×(60/36) = ×5/3. */
const SWING_TO_MICRO = 5 / 3;
const MICRO_STEP = 0.1 * SWING_TO_MICRO;

export function applySectionGrooveIntent(doc: ProjectDocument, intent: SectionGrooveIntent): Command | null {
  const role = intent.role as ArrangeRole;
  const scene = resolveSceneTarget(doc, intent.role, [role]);
  if (!scene) return null;
  const pattern = doc.patterns.find((p) => p.id === scene.patternId);
  if (!pattern) return null;
  const drumTracks = doc.tracks.filter((t): t is DrumTrack => t.kind === "drum");
  if (drumTracks.length === 0) return null;

  let next = doc;
  let baked = 0;
  for (const track of drumTracks) {
    for (const pad of track.pads) {
      for (let stepIndex = 1; stepIndex < pattern.stepCount; stepIndex += 2) {
        const meta = pattern.stepMeta?.[pad.id]?.[stepIndex];
        const current = meta?.microtiming ?? 0;
        let delta: number;
        if (intent.direction === "set") {
          const target = ((intent.swingPercent ?? 0) / 100) * SWING_TO_MICRO;
          delta = target - current;
        } else if (intent.direction === "swingUp") delta = MICRO_STEP;
        else if (intent.direction === "swingDown") delta = -MICRO_STEP;
        else delta = -MICRO_STEP * 2.5; // tighter
        const clamped = Math.max(-1, Math.min(1, current + delta));
        if (Math.abs(clamped - current) < 0.001) continue;
        const hasVelocity = (pattern.rows[pad.id]?.[stepIndex] ?? 0) > 0;
        if (!hasVelocity && intent.direction !== "set") continue; // only audible steps
        next = setStepMeta(next, pattern.id, pad.id, stepIndex, {
          microtiming: Math.round(clamped * 1000) / 1000,
        }).execute(next);
        baked += 1;
      }
    }
  }
  if (baked === 0) return null;
  return snapshot(
    "applySectionGrooveIntent",
    `Groove ${intent.direction === "set" ? `=${intent.swingPercent}%` : intent.direction} → ${scene.name} (${baked} steps)`,
    doc,
    next,
  );
}

/** Read-back: average baked microtiming on odd steps of the section pattern. */
export function sectionGrooveReadback(after: ProjectDocument, intent: SectionGrooveIntent): string {
  const scene = after.scenes.find((s) => s.name.toLowerCase().includes(intent.role));
  const pattern = after.patterns.find((p) => p.id === scene?.patternId);
  if (!pattern) return "";
  const drum = after.tracks.find((t): t is DrumTrack => t.kind === "drum");
  if (!drum) return "";
  let sum = 0;
  let count = 0;
  for (const pad of drum.pads) {
    for (let stepIndex = 1; stepIndex < pattern.stepCount; stepIndex += 2) {
      sum += Math.abs(pattern.stepMeta?.[pad.id]?.[stepIndex]?.microtiming ?? 0);
      count += 1;
    }
  }
  return count > 0 ? `micro ${Math.round((sum / count) * 1000) / 1000}` : "";
}
