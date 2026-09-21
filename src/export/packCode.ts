import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { normalizePadKeyMap } from "../shared/pad-keys-data";
import { THEME_PRESETS, type ThemeState } from "../shared/theme-data";
import type { KitPadCapture } from "../commands/commands";

/**
 * PACK share codes: kit + pad keymap + theme in ONE token — a producer's
 * whole performance setup travels as a single string (PFPACK1:).
 *
 * Installing applies binds + theme immediately and saves the kit into the
 * user kit library (applying the kit to a drum track stays a conscious click
 * in the KIT list — it replaces samples).
 *
 * Codes are UNTRUSTED input: every field is validated/clamped, so a tampered
 * token yields at worst a legal setup.
 */

export const PACK_CODE_PREFIX = "PFPACK1:";

/** One pooled groove travelling inside a pack (installed back into the pool). */
export interface SharedPackGroove {
  name: string;
  timing: number[];
  accent: number[];
}

/** One scene of an arrangement sketch: drum rows keyed by KIT PAD INDEX. */
export interface SharedPackSceneSketch {
  name: string;
  role?: string;
  intensity?: number;
  steps: number;
  /** pad index → hex velocity string, one char per step ("0"–"f", 0 = off). */
  rows: string[];
}

/** A whole arrangement skeleton: scenes + where their clips land on the timeline. */
export interface SharedPackSketch {
  bpm?: number;
  scenes: SharedPackSceneSketch[];
  clips: { scene: number; startBar: number; lengthBars: number }[];
}

export interface SharedPack {
  kitName?: string;
  kitPads?: KitPadCapture[];
  binds?: string[];
  theme?: ThemeState;
  grooves?: SharedPackGroove[];
  sketch?: SharedPackSketch;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : fallback;

function sanitizeKitPads(raw: unknown): KitPadCapture[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const pads: KitPadCapture[] = [];
  const seen = new Set<number>();
  for (const p of raw as Record<string, unknown>[]) {
    const idx = num(p.idx, -1, 0, 15);
    if (!Number.isInteger(idx) || seen.has(idx)) continue;
    seen.add(idx);
    pads.push({
      idx,
      assetId: typeof p.assetId === "string" && p.assetId.length <= 200 ? p.assetId : null,
      synth: null,
      gain: num(p.gain, 1, 0, 2),
      pan: num(p.pan, 0, -1, 1),
      chokeGroup: p.chokeGroup === null || p.chokeGroup === undefined ? null : Math.round(num(p.chokeGroup, 0, 0, 16)),
      pitch: num(p.pitch, 0, -36, 36),
    });
  }
  return pads.length > 0 ? pads : undefined;
}

function sanitizeBinds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const normalized = normalizePadKeyMap(raw);
  // Reject payloads that are pure garbage (normalize fills invalid slots with
  // defaults, so a legal-looking map always comes back — that is fine).
  return normalized.every((k) => typeof k === "string") ? normalized : undefined;
}

function sanitizeTheme(raw: unknown): ThemeState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const t = raw as Partial<ThemeState>;
  const known = THEME_PRESETS.some((p) => p.id === t.preset);
  return {
    preset: known ? (t.preset as string) : THEME_PRESETS[0].id,
    hue: typeof t.hue === "number" && Number.isFinite(t.hue) ? clamp(Math.round(t.hue), 0, 359) : null,
    scale: typeof t.scale === "number" && Number.isFinite(t.scale) ? clamp(t.scale, 0.8, 1.3) : 1,
    compact: t.compact === true,
    reduceMotion: t.reduceMotion === true,
  };
}

const PACK_GROOVE_LIMIT = 8;
const PACK_SCENE_LIMIT = 16;
const PACK_CLIP_LIMIT = 64;
const PACK_STEPS_LIMIT = 64;

function sanitizeGrooves(raw: unknown): SharedPackGroove[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const grooves: SharedPackGroove[] = [];
  for (const g of raw.slice(0, PACK_GROOVE_LIMIT) as Record<string, unknown>[]) {
    if (typeof g !== "object" || g === null) continue;
    const timing = sanitizeCurve(g.timing, -1, 1);
    const accent = sanitizeCurve(g.accent, 0, 1);
    if (!timing || !accent || timing.length !== accent.length) continue;
    grooves.push({
      name: typeof g.name === "string" && g.name.trim() ? g.name.trim().slice(0, 40) : "Groove",
      timing,
      accent,
    });
  }
  return grooves.length > 0 ? grooves : undefined;
}

function sanitizeCurve(raw: unknown, min: number, max: number): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 128) return undefined;
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    out.push(clamp(v, min, max));
  }
  return out;
}

function sanitizeHexRow(raw: unknown, steps: number): string {
  if (typeof raw !== "string") return "";
  const hex = raw.replace(/[^0-9a-fA-F]/g, "");
  return hex.slice(0, steps).toLowerCase();
}

function sanitizeSketch(raw: unknown): SharedPackSketch | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const s = raw as Partial<SharedPackSketch> & Record<string, unknown>;
  if (!Array.isArray(s.scenes)) return undefined;
  const scenes: SharedPackSceneSketch[] = [];
  for (const sc of s.scenes.slice(0, PACK_SCENE_LIMIT)) {
    if (typeof sc !== "object" || sc === null) continue;
    const steps = Math.round(num(sc.steps, 16, 1, PACK_STEPS_LIMIT));
    const rows = Array.isArray(sc.rows) ? (sc.rows as unknown[]).slice(0, 16).map((r) => sanitizeHexRow(r, steps)) : [];
    if (!rows.some((r) => /[^0]/.test(r))) continue; // skip fully-empty scenes
    scenes.push({
      name: typeof sc.name === "string" && sc.name.trim() ? sc.name.trim().slice(0, 40) : `Scene ${scenes.length + 1}`,
      role: typeof sc.role === "string" ? sc.role.slice(0, 12) : undefined,
      intensity:
        typeof sc.intensity === "number" && Number.isFinite(sc.intensity) ? clamp(sc.intensity, 0, 1) : undefined,
      steps,
      rows,
    });
  }
  if (scenes.length === 0) return undefined;
  const clips: SharedPackSketch["clips"] = [];
  if (Array.isArray(s.clips)) {
    for (const c of s.clips.slice(0, PACK_CLIP_LIMIT) as Record<string, unknown>[]) {
      if (typeof c !== "object" || c === null) continue;
      // Out-of-range scene indices are rejected, not clamped — a clamped clip
      // would silently re-point at the wrong scene.
      const scene = typeof c.scene === "number" && Number.isInteger(c.scene) ? c.scene : -1;
      if (scene < 0 || scene >= scenes.length) continue;
      const startBar = Math.round(num(c.startBar, 0, 0, 999));
      const lengthBars = Math.round(num(c.lengthBars, 1, 1, 64));
      if (!clips.some((x) => x.scene === scene && x.startBar === startBar)) {
        clips.push({ scene, startBar, lengthBars });
      }
    }
  }
  return {
    bpm: typeof s.bpm === "number" && Number.isFinite(s.bpm) ? clamp(Math.round(s.bpm), 20, 300) : undefined,
    scenes,
    clips,
  };
}

export function encodePackCode(pack: SharedPack): string {
  return PACK_CODE_PREFIX + compressToEncodedURIComponent(JSON.stringify(pack));
}

export function decodePackCode(code: string): SharedPack | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PACK_CODE_PREFIX)) return null;
  try {
    const json = decompressFromEncodedURIComponent(trimmed.slice(PACK_CODE_PREFIX.length));
    if (!json) return null;
    const raw = JSON.parse(json) as Partial<SharedPack>;
    const pack: SharedPack = {};
    if (typeof raw.kitName === "string" && raw.kitName.trim()) pack.kitName = raw.kitName.trim().slice(0, 60);
    const pads = sanitizeKitPads(raw.kitPads);
    if (pads) {
      pack.kitPads = pads;
      pack.kitName = pack.kitName ?? "Shared Pack";
    }
    const binds = sanitizeBinds(raw.binds);
    if (binds) pack.binds = binds;
    const theme = sanitizeTheme(raw.theme);
    if (theme) pack.theme = theme;
    const grooves = sanitizeGrooves(raw.grooves);
    if (grooves) pack.grooves = grooves;
    const sketch = sanitizeSketch(raw.sketch);
    if (sketch) pack.sketch = sketch;
    // At least one meaningful part must survive.
    if (!pack.kitPads && !pack.binds && !pack.theme && !pack.grooves && !pack.sketch) return null;
    return pack;
  } catch {
    return null;
  }
}
