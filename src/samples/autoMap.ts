import type { SampleLayer } from "../project-model/types";
import { hashString } from "../shared/rng";

/**
 * Auto-mapping for multi-sample sampler imports (Kontakt-lite ergonomics).
 *
 * File names are parsed for a note token — `kick_C2.wav`, `stab F#4.wav`,
 * `Piano.C4.aif`, `keyD#5` — and the samples spread across the keyboard as
 * keyzones. Optional `v32`, `vel90` or `velocity127` tokens create velocity
 * windows. Names that differ only by a trailing `-1 / _2 / .3` counter form
 * round-robin groups (overlapping windows at the same keyzone/velocity).
 *
 * - Every parsed note becomes a keyzone; zones are disjoint and ordered by
 *   pitch, with the outer zones extending to MIDI 0/127 so nothing is
 *   unplayable. Existing keyzone semantics keep each zone starting at its
 *   root note (except the first zone, which starts at MIDI 0).
 * - Explicit velocity centers become touching windows. An RR group inside a
 *   note/velocity emits N layers with identical windows — the engine's
 *   overlapping-window rule treats them as deterministic round-robin.
 * - Samples with no note token fall back to a single full-range layer
 *   (classic single-sample mode is untouched).
 */

export interface NamedSample {
  sampleId: string;
  /** File name (or any label) — parsed for a note token and RR counter. */
  name: string;
}

const NOTE_RE = /(?:^|[_\-\s.]|key)([A-Ga-g])([#b]?)(\d{1,2})(?=$|[_\-\s.])/;
const RR_RE = /[-_.\s](\d{1,2})$/;
const VELOCITY_RE = /(?:^|[_\-\s.])(velocity|vel|v)[_-]?(\d{1,3})(?:%?)(?=$|[_\-\s.])/i;

const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** MIDI note from a parsed token, or null when the name carries no note. */
export function parseSampleNote(name: string): number | null {
  const base = name.replace(/\.[a-z0-9]+$/i, "");
  const m = NOTE_RE.exec(base);
  if (!m) return null;
  let semi = SEMITONE[m[1].toUpperCase()];
  if (m[2] === "#") semi += 1;
  if (m[2] === "b") semi -= 1;
  const octave = Number(m[3]);
  if (octave > 9) return null;
  return (octave + 1) * 12 + semi;
}

/** Parse an explicit velocity token (`v32`, `vel90`, `velocity127`) as 0..1. */
export function parseSampleVelocity(name: string): number | null {
  const base = name.replace(/\.[a-z0-9]+$/i, "");
  const m = VELOCITY_RE.exec(base);
  if (!m) return null;
  const raw = Number(m[2]);
  if (!Number.isFinite(raw) || raw < 0 || raw > 127) return null;
  return raw / 127;
}

/** Group key for round-robin detection: name minus its trailing counter. */
export function rrGroupKey(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, "");
  return base.replace(RR_RE, "").toLowerCase();
}

function stableLayerId(sampleId: string, index: number, minPitch?: number, maxPitch?: number): string {
  return `layer.auto.${hashString(`${sampleId}|${index}|${minPitch ?? ""}|${maxPitch ?? ""}`).toString(36)}`;
}

/**
 * Build velocity layers from a multi-sample file list. Deterministic: the
 * same input list always produces the same layer order.
 */
export function autoMapVelocityLayers(samples: NamedSample[]): SampleLayer[] {
  if (samples.length === 0) return [];

  // Group by RR key first (names differing only by a trailing counter).
  const groups = new Map<string, NamedSample[]>();
  for (const sample of samples) {
    const key = rrGroupKey(sample.name);
    const list = groups.get(key);
    if (list) list.push(sample);
    else groups.set(key, [sample]);
  }

  // One entry per distinct note/velocity (or a full-range bucket for untagged
  // files); each entry collects its RR members.
  interface Zone {
    pitch: number | null;
    velocity: number | null;
    members: NamedSample[];
  }
  const zones = new Map<string, Zone>();
  let untagged: Zone | null = null;
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, unsortedMembers] of orderedGroups) {
    const members = [...unsortedMembers].sort(
      (a, b) => a.name.localeCompare(b.name) || a.sampleId.localeCompare(b.sampleId),
    );
    const pitch = parseSampleNote(members[0].name);
    const velocity = parseSampleVelocity(members[0].name);
    if (pitch === null) {
      if (!untagged) untagged = { pitch: null, velocity: null, members: [] };
      untagged.members.push(...members);
      continue;
    }
    const velocityKey = velocity === null ? "full" : velocity.toFixed(6);
    const zoneKey = `${pitch}|${velocityKey}`;
    const zone = zones.get(zoneKey);
    if (zone) zone.members.push(...members);
    else zones.set(zoneKey, { pitch, velocity, members });
  }

  const layers: SampleLayer[] = [];
  const sorted = [...zones.values()].sort(
    (a, b) => (a.pitch ?? 0) - (b.pitch ?? 0) || (a.velocity ?? 0) - (b.velocity ?? 0),
  );
  const pitches = [...new Set(sorted.map((zone) => zone.pitch as number))].sort((a, b) => a - b);

  for (const pitch of pitches) {
    const pitchZones = sorted.filter((zone) => zone.pitch === pitch);
    const centers = pitchZones
      .map((zone) => zone.velocity)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    const hasVelocity = centers.length > 0;
    pitchZones.forEach((zone) => {
      const pitchIndex = pitches.indexOf(pitch);
      const minPitch = pitchIndex === 0 ? 0 : pitch;
      const maxPitch = pitchIndex === pitches.length - 1 ? 127 : pitches[pitchIndex + 1] - 1;
      let min = 0;
      let max = 1;
      if (hasVelocity && zone.velocity !== null) {
        const vi = centers.indexOf(zone.velocity);
        min = vi === 0 ? 0 : (centers[vi - 1] + zone.velocity) / 2;
        max = vi === centers.length - 1 ? 1 : (zone.velocity + centers[vi + 1]) / 2;
      }
      for (const member of zone.members) {
        layers.push({
          id: stableLayerId(member.sampleId, layers.length, minPitch, maxPitch),
          sampleId: member.sampleId,
          min,
          max,
          minPitch,
          maxPitch,
        });
      }
    });
  }

  if (untagged) {
    for (const member of untagged.members) {
      layers.push({
        id: stableLayerId(member.sampleId, layers.length),
        sampleId: member.sampleId,
        min: 0,
        max: 1,
      });
    }
  }

  return layers;
}
