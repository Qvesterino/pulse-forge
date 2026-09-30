import type { Command } from "../commands/types";
import type { ArrangementClip, ProjectDocument, Scene, SceneRole } from "../project-model/types";
import { effectWordIn } from "./mix";
import {
  addArrangementClip,
  autoArrangeSong,
  createScene,
  deleteArrangementClip,
  deleteScene,
  duplicateSceneAsVariation,
  moveArrangementClip,
  resizeArrangementClip,
  setSceneRole,
  snapshot,
} from "../commands/commands";

/**
 * ARRANGE WORDS — natural-language arrangement editing over an EXISTING beat.
 *
 * "shorten the intro to 4 bars and add a break before the drop" becomes a
 * list of deterministic arrangement operations applied as ONE undoable
 * command. No provider, no network — a keyword parser with EN + SK synonyms,
 * resolved against the live document (scenes carry roles; older scenes
 * infer from names).
 *
 * Etiquette: ops only touch scenes/clips the sentence names. After every
 * apply, clips are RELAID OUT contiguously in scene order (sections play
 * back-to-back), so adds/removes/resizes ripple the timeline instead of
 * leaving holes or overlaps.
 */

export type ArrangeRole = SceneRole;

export type ArrangeOp =
  | { op: "resize"; sceneId: string; role: SceneRole | null; name: string; bars: number }
  | { op: "addRole"; role: ArrangeRole; beforeSceneId: string | null }
  | { op: "remove"; sceneId: string; role: SceneRole | null; name: string }
  | { op: "duplicate"; sceneId: string; role: SceneRole | null; name: string }
  | { op: "reorder"; sceneId: string; dir: "earlier" | "later" }
  | { op: "autoArrange" };

export interface ParsedArrange {
  ops: ArrangeOp[];
  /** Clauses the parser could not map — surfaced in the UI. */
  unrecognized: string[];
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * Diacritics break \b boundaries and stems ("skrátiť" does not contain
 * "skrát" because of the ť/t mismatch) — normalize once, match ASCII.
 */
export function deaccent(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const ROLE_SYNONYMS: Array<[ArrangeRole, RegExp]> = [
  ["intro", /\b(intro|uvod)\b/],
  ["build", /\b(build|build-?up|buildup|riser|stavb)/],
  // Songwriting roles are FIRST-CLASS now (A2 v2) — "chorus" no longer falls
  // back to drop and "bridge" no longer to break.
  ["chorus", /\b(chorus|hook|refren)\b/],
  ["verse", /\b(verse|zloh)/],
  ["bridge", /\b(bridge|most|mostik)\b/],
  ["drop", /\bdrop\b/],
  ["break", /\b(break|breakdown|brejk)\b/],
  ["outro", /\b(outro|ending|zaver|koncovka)\b/],
  ["fill", /\b(fill|veto)\b/],
];

const ORDINALS: Array<[number, RegExp]> = [
  [0, /\b(first|1st|prvy|prva)/],
  [1, /\b(second|2nd|druhy|druha)/],
  [2, /\b(third|3rd|treti|tretia)/],
  [3, /\b(fourth|4th|stverty|stverta|piaty)/],
];

const VERBS = {
  resizeShorter: /\b(shorten|tighten|trim|shorter|skrat)/,
  resizeLonger: /\b(extend|lengthen|stretch|longer|grow|predlz|rozsir)/,
  makeSize: /\b(make|set|turn)/,
  add: /\b(add|insert|put|pridaj|prida|vloz|daj)\b/,
  remove: /\b(remove|delete|take out|strip|odstra|odstran|vymaz|vyhod)\b/,
  duplicate: /\b(duplicate|double|copy|zdvoj|skopir|opakuj)\b/,
  move: /\b(move|shift|push|posun)/,
  arrange: /\b(arrange|usporiadaj|usporiad|into a song|do pesnicky|do piesne)/,
};

const clipPattern = /\b(\d{1,3})\s*(?:bar|bars|takt|takty|taktov)/;

function hasTo(text: string): boolean {
  return /\bto\b|\bna\b/.test(text);
}

function firstNumber(text: string): number | null {
  const m = clipPattern.exec(text);
  return m ? Math.max(1, Math.min(64, Number(m[1]))) : null;
}

function rolesIn(text: string): ArrangeRole[] {
  const found: ArrangeRole[] = [];
  for (const [role, re] of ROLE_SYNONYMS) if (re.test(text)) found.push(role);
  return found;
}

function ordinalIn(text: string): number | null {
  for (const [index, re] of ORDINALS) if (re.test(text)) return index;
  if (/\b(last|final|posledn)/.test(text)) return -1;
  return null;
}

function verbHits(text: string, re: RegExp): boolean {
  return re.test(text);
}

// ── Target resolution against the live document ─────────────────────────────

function sceneRoleOf(scene: Scene): SceneRole | null {
  if (scene.role) return scene.role;
  return roleFromName(scene.name);
}

function roleFromName(name: string): SceneRole | null {
  const n = deaccent(name);
  for (const [role, re] of ROLE_SYNONYMS) if (re.test(n)) return role;
  return null;
}

/** Scenes matching a role, in document order. */
function scenesWithRole(doc: ProjectDocument, role: ArrangeRole): Scene[] {
  return doc.scenes.filter((s) => sceneRoleOf(s) === role);
}

/**
 * Resolve "the drop" / "the second drop" / "the last break" / a scene name
 * to a concrete scene. Returns null when the clause carries no resolvable
 * role or name.
 */
export function resolveSceneTarget(doc: ProjectDocument, clause: string, roles: ArrangeRole[]): Scene | null {
  let nameMatch: Scene | null = null;
  for (const scene of doc.scenes) {
    const n = deaccent(scene.name.trim());
    if (n.length >= 4 && clause.includes(n) && (nameMatch === null || n.length > nameMatch.name.length)) {
      nameMatch = scene;
    }
  }
  if (nameMatch) return nameMatch;

  if (roles.length === 0) return null;
  const role = roles[0];
  const list = scenesWithRole(doc, role);
  if (list.length === 0) return null;
  const ordinal = ordinalIn(clause);
  if (ordinal === null) return list[0];
  if (ordinal === -1) return list[list.length - 1];
  return list[Math.min(ordinal, list.length - 1)];
}

// ── Parser ──────────────────────────────────────────────────────────────────

function splitClauses(text: string): string[] {
  return text
    .split(/[,;.!?]|\bthen\b|\bpotom\b|\band then\b/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Parse free text into deterministic arrangement operations. The doc is the
 * resolution context: role words map to the scenes that actually exist.
 */
export function parseArrangeIntent(text: string, doc: ProjectDocument): ParsedArrange {
  const ops: ArrangeOp[] = [];
  const unrecognized: string[] = [];

  if (verbHits(deaccent(text), VERBS.arrange)) {
    return { ops: [{ op: "autoArrange" }], unrecognized: [] };
  }

  for (const clause of splitClauses(deaccent(text))) {
    if (clause.length === 0) continue;
    const roles = rolesIn(clause);
    const target = resolveSceneTarget(doc, clause, roles);
    const n = firstNumber(clause);
    const toAbsolute = hasTo(clause) && n !== null;

    // ADD a new section with a role ("add a break before the drop").
    // The preposition splits the clause: left of before/after = the NEW
    // section's role, right = the anchor scene.
    if (verbHits(clause, VERBS.add)) {
      // "add a chorus send to the bass" is mixer ROUTING, not a new song
      // section — an add-clause naming a send belongs to the send parser
      // (further down the route order), so the arrange claim stands down.
      if (/\bsend\b/.test(clause) && effectWordIn(clause)) {
        continue;
      }
      const m = /\b(before|after|pred|za)\b/.exec(clause);
      let addPart = clause;
      let anchorPart: string | null = null;
      let anchorSide: "before" | "after" = "after";
      if (m) {
        anchorSide = /before|pred/.test(m[1]) ? "before" : "after";
        addPart = clause.slice(0, m.index);
        anchorPart = clause.slice(m.index + m[0].length);
      }
      const addRoles = rolesIn(addPart);
      if (addRoles.length === 0) {
        unrecognized.push(clause);
        continue;
      }
      let beforeSceneId: string | null = null;
      if (anchorPart) {
        const anchor = resolveSceneTarget(doc, anchorPart, rolesIn(anchorPart));
        if (anchor) {
          if (anchorSide === "before") beforeSceneId = anchor.id;
          else {
            const idx = doc.scenes.findIndex((sc) => sc.id === anchor.id);
            beforeSceneId = idx >= 0 && idx + 1 < doc.scenes.length ? doc.scenes[idx + 1].id : null;
          }
        }
      }
      ops.push({ op: "addRole", role: addRoles[0], beforeSceneId });
      continue;
    }

    if (verbHits(clause, VERBS.remove)) {
      if (target) ops.push({ op: "remove", sceneId: target.id, role: sceneRoleOf(target), name: target.name });
      else unrecognized.push(clause);
      continue;
    }

    if (verbHits(clause, VERBS.duplicate)) {
      if (target) ops.push({ op: "duplicate", sceneId: target.id, role: sceneRoleOf(target), name: target.name });
      else unrecognized.push(clause);
      continue;
    }

    if (verbHits(clause, VERBS.makeSize) && target && n !== null && toAbsolute) {
      ops.push({ op: "resize", sceneId: target.id, role: sceneRoleOf(target), name: target.name, bars: n });
      continue;
    }
    if (verbHits(clause, VERBS.resizeShorter) && target) {
      const cur = sceneBars(doc, target.id);
      ops.push({
        op: "resize",
        sceneId: target.id,
        role: sceneRoleOf(target),
        name: target.name,
        bars: n !== null ? (toAbsolute ? n : Math.max(1, cur - n)) : Math.max(1, Math.ceil(cur / 2)),
      });
      continue;
    }
    if (verbHits(clause, VERBS.resizeLonger) && target) {
      const cur = sceneBars(doc, target.id);
      ops.push({
        op: "resize",
        sceneId: target.id,
        role: sceneRoleOf(target),
        name: target.name,
        bars: n !== null ? (toAbsolute ? n : cur + n) : cur * 2,
      });
      continue;
    }
    if (verbHits(clause, VERBS.makeSize) && target && n !== null) {
      ops.push({ op: "resize", sceneId: target.id, role: sceneRoleOf(target), name: target.name, bars: n });
      continue;
    }

    if (verbHits(clause, VERBS.move) && target) {
      const dir = /\b(earlier|sooner|skôr|skor|hore|up)\b/.test(clause) ? "earlier" : "later";
      ops.push({ op: "reorder", sceneId: target.id, dir });
      continue;
    }

    unrecognized.push(clause);
  }

  return { ops, unrecognized };
}

function sceneBars(doc: ProjectDocument, sceneId: string): number {
  const clips = doc.arrangement.clips.filter((c) => c.sceneId === sceneId);
  if (clips.length === 0) {
    const scene = doc.scenes.find((s) => s.id === sceneId);
    const pattern = doc.patterns.find((p) => p.id === scene?.patternId);
    return Math.max(1, Math.round((pattern?.stepCount ?? 16) / 16));
  }
  return clips.reduce((total, c) => total + c.lengthBars, 0);
}

// ── Executor ────────────────────────────────────────────────────────────────

type DocTransform = (d: ProjectDocument) => ProjectDocument;

/** Contiguous relayout: scenes in document order, clips back-to-back. */
function relayout(d: ProjectDocument): ProjectDocument {
  let bar = 0;
  const nextClips: ProjectDocument["arrangement"]["clips"] = [];
  for (const scene of d.scenes) {
    const clips = d.arrangement.clips.filter((c) => c.sceneId === scene.id).sort((a, b) => a.startBar - b.startBar);
    for (const c of clips) {
      nextClips.push({ ...c, startBar: bar });
      bar += Math.max(1, c.lengthBars);
    }
  }
  return { ...d, arrangement: { ...d.arrangement, clips: nextClips } };
}

function primitiveFor(cur: ProjectDocument, op: ArrangeOp): { do: DocTransform; label: string } {
  switch (op.op) {
    case "resize": {
      const clip = cur.arrangement.clips.find((c) => c.sceneId === op.sceneId);
      if (!clip) return { do: (d) => d, label: "resize (no clip — skipped)" };
      const cmd = resizeArrangementClip(cur, clip.id, op.bars);
      return { do: cmd.execute, label: `resize → ${op.bars} bars` };
    }
    case "addRole": {
      return {
        do: (d) => {
          let next = createScene(d, `${op.role[0].toUpperCase()}${op.role.slice(1)} (KYX)`).execute(d);
          const newScene = next.scenes[next.scenes.length - 1];
          next = setSceneRole(next, newScene.id, op.role).execute(next);
          if (op.beforeSceneId) {
            const idx = next.scenes.findIndex((s) => s.id === op.beforeSceneId);
            if (idx >= 0) {
              const without = next.scenes.filter((s) => s.id !== newScene.id);
              without.splice(idx, 0, newScene);
              next = { ...next, scenes: without };
            }
          }
          // Append past the arrangement end — the relayout moves the clip
          // into scene order (addArrangementClip throws on overlaps).
          const endBar = next.arrangement.clips.reduce((mx, c) => Math.max(mx, c.startBar + c.lengthBars), 0);
          next = addArrangementClip(next, newScene.id, endBar, 4).execute(next);
          return next;
        },
        label: `add ${op.role} section`,
      };
    }
    case "remove": {
      return {
        do: (d) => {
          let next = d;
          for (const clip of d.arrangement.clips.filter((c) => c.sceneId === op.sceneId)) {
            next = deleteArrangementClip(next, clip.id).execute(next);
          }
          return deleteScene(next, op.sceneId).execute(next);
        },
        label: `remove ${op.name}`,
      };
    }
    case "duplicate": {
      return {
        do: (d) => {
          const next = duplicateSceneAsVariation(d, op.sceneId).execute(d);
          // duplicateSceneAsVariation appends the copy — move it right after
          // the source in the scene chain so the relayout plays it next.
          const copy = next.scenes[next.scenes.length - 1];
          if (copy && copy.id !== op.sceneId) {
            const without = next.scenes.filter((s) => s.id !== copy.id);
            const srcIdx = without.findIndex((s) => s.id === op.sceneId);
            without.splice(srcIdx + 1, 0, copy);
            return { ...next, scenes: without };
          }
          return next;
        },
        label: `duplicate ${op.name}`,
      };
    }
    case "reorder": {
      return {
        do: (d) => {
          const from = d.scenes.findIndex((s) => s.id === op.sceneId);
          const to = Math.max(0, Math.min(d.scenes.length - 1, op.dir === "earlier" ? from - 1 : from + 1));
          if (from < 0 || to === from) return d;
          const scenes = [...d.scenes];
          const [moved] = scenes.splice(from, 1);
          scenes.splice(to, 0, moved);
          return { ...d, scenes };
        },
        label: `reorder ${op.dir}`,
      };
    }
    case "autoArrange": {
      return { do: (d) => autoArrangeSong(d).execute(d), label: "auto-arrange into a song" };
    }
  }
}

/**
 * Compile parsed ops into ONE undoable command: execution folds each op's
 * transform over the live document and finishes with the contiguous
 * relayout; undo restores the whole pre-arrangement document.
 */
export function applyArrangeOps(doc: ProjectDocument, ops: ArrangeOp[]): Command {
  if (ops.length === 0) throw new Error("No arrangement operations to apply");
  const steps: Array<{ label: string; run: DocTransform }> = [];
  let cursor = doc;
  for (const op of ops) {
    const prim = primitiveFor(cursor, op);
    cursor = prim.do(cursor);
    steps.push({ label: prim.label, run: prim.do });
  }
  const next = relayout(cursor);
  return snapshot("arrangeWords", `Arrange: ${steps.map((st) => st.label).join(" → ")}`, doc, next);
}

// ── CLIP WORDS — clip-level trim/copy/move/delete at ABSOLUTE positions ─────

/**
 * Clip-level arrangement asks ("copy the intro clip to bar 5", "trim the
 * clip at bar 5 to 2 bars", "delete the clip at bar 9"). Unlike scene ops,
 * these PRESERVE absolute positions — no contiguous relayout — because the
 * user is placing copies at explicit bars, not reshaping a back-to-back
 * song form. Overlaps fail with the commands' own explicit errors.
 *
 * A clip is referenced by a scene role ("the intro clip"), by position
 * ("the clip at bar 3") or by ordinal ("the second clip"). A copy needs an
 * explicit destination ("to bar N") — a destination-less copy stays with the
 * scene-variation duplicate path.
 */

export type ClipArrangeOp =
  | { op: "copyClip"; clipId: string; toBar: number }
  | { op: "moveClip"; clipId: string; toBar: number }
  | { op: "resizeClip"; clipId: string; bars: number }
  | { op: "deleteClip"; clipId: string };

const CLIP_WORD = /\bclips?\b|\bklip/;

/** Destination position: "to bar 16" / "na takt 16" → 0-based bar index. */
function destBarIn(clause: string): number | null {
  const m = /\b(?:to|na)\s+(?:the\s+)?(?:bar|takt(?:e|u|ov|y)?)\s*(\d{1,3})/.exec(clause);
  return m ? Math.max(0, Number(m[1]) - 1) : null;
}

/** Source position reference: "the clip at bar 3" → the clip covering bar 2. */
function clipAtBar(clips: ArrangementClip[], clause: string): ArrangementClip | null {
  const m = /\b(?:at\s+bar|bar|takt(?:e|u|ov|y)?)\s+(\d{1,3})/.exec(clause);
  if (!m) return null;
  const bar = Math.max(0, Number(m[1]) - 1);
  return clips.find((c) => bar >= c.startBar && bar < c.startBar + c.lengthBars) ?? null;
}

function resolveClipTarget(doc: ProjectDocument, clause: string, clips: ArrangementClip[]): ArrangementClip | null {
  const byPosition = clipAtBar(clips, clause);
  if (byPosition) return byPosition;
  for (const role of rolesIn(clause)) {
    for (const scene of scenesWithRole(doc, role)) {
      const clip = clips.find((c) => c.sceneId === scene.id);
      if (clip) return clip;
    }
  }
  const ordinal = ordinalIn(clause);
  if (ordinal !== null && clips.length > 0) {
    const index = ordinal === -1 ? clips.length - 1 : Math.min(ordinal, clips.length - 1);
    return clips[index];
  }
  return null;
}

/**
 * Role/at-bar clip resolution for the local intent model adapter (the model
 * emits a clip REF — a role word or a bar number — never an internal id).
 * Returns the resolved clip id or null when nothing matches; no guessing.
 */
export function resolveClipRef(doc: ProjectDocument, ref: string, atBar?: number): string | null {
  const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
  if (clips.length === 0) return null;
  if (atBar != null && Number.isFinite(atBar)) {
    const bar = Math.max(0, Math.floor(atBar) - 1); // model/user bars are 1-based
    const byPosition = clips.find((c) => bar >= c.startBar && bar < c.startBar + c.lengthBars);
    if (byPosition) return byPosition.id;
  }
  const byRef = resolveClipTarget(doc, ref, clips);
  return byRef?.id ?? null;
}

/**
 * Parse clip-level ops. Null unless the text names CLIPS and at least one
 * clause resolves to a full op (verb + resolvable clip + required number).
 * A destination-less copy or a numberless trim deliberately returns null —
 * the scene-level arrange path (variation duplicate / half-size resize) is
 * the nearest interpretation for those, and it already exists.
 */
export function parseClipArrangeIntent(text: string, doc: ProjectDocument): ClipArrangeOp[] | null {
  const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
  if (clips.length === 0) return null;
  const ops: ClipArrangeOp[] = [];
  for (const raw of splitClauses(deaccent(text))) {
    const clause = raw.replace(/\b(?:to|na)\s+(?:the\s+)?(?:bar|takt(?:e|u|ov|y)?)\s*\d{1,3}/, " "); // strip the destination so it never resolves as the SOURCE clip
    if (!CLIP_WORD.test(clause)) continue;
    const clip = resolveClipTarget(doc, clause, clips);
    if (!clip) continue;
    const n = firstNumber(clause);
    const dest = destBarIn(raw);
    if (verbHits(clause, VERBS.duplicate)) {
      if (dest !== null) ops.push({ op: "copyClip", clipId: clip.id, toBar: dest });
      continue;
    }
    if (verbHits(clause, VERBS.move)) {
      if (dest !== null) ops.push({ op: "moveClip", clipId: clip.id, toBar: dest });
      continue;
    }
    if (verbHits(clause, VERBS.remove)) {
      ops.push({ op: "deleteClip", clipId: clip.id });
      continue;
    }
    if (
      (verbHits(clause, VERBS.resizeShorter) ||
        verbHits(clause, VERBS.resizeLonger) ||
        verbHits(clause, VERBS.makeSize)) &&
      n !== null
    ) {
      ops.push({ op: "resizeClip", clipId: clip.id, bars: n });
    }
  }
  return ops.length > 0 ? ops : null;
}

/**
 * Execute clip ops as ONE undoable command over the canonical clip commands
 * (add/move/resize/delete — each overlap-checked). NO relayout: absolute
 * positions survive. Returns null when every op lost its clip (the
 * arrangement changed under the request) — the caller surfaces it.
 */
export function applyClipArrangeOps(doc: ProjectDocument, ops: ClipArrangeOp[]): Command | null {
  if (ops.length === 0) return null;
  let cursor = doc;
  const labels: string[] = [];
  for (const op of ops) {
    const clip = cursor.arrangement.clips.find((c) => c.id === op.clipId);
    if (!clip) return null; // arrangement changed under the request — refuse
    if (op.op === "copyClip") {
      cursor = addArrangementClip(cursor, clip.sceneId, op.toBar, clip.lengthBars).execute(cursor);
      labels.push(`copy → bar ${op.toBar + 1}`);
    } else if (op.op === "moveClip") {
      cursor = moveArrangementClip(cursor, op.clipId, op.toBar).execute(cursor);
      labels.push(`move → bar ${op.toBar + 1}`);
    } else if (op.op === "resizeClip") {
      cursor = resizeArrangementClip(cursor, op.clipId, op.bars).execute(cursor);
      labels.push(`resize → ${op.bars} bars`);
    } else {
      cursor = deleteArrangementClip(cursor, op.clipId).execute(cursor);
      labels.push("delete clip");
    }
  }
  if (cursor === doc) return null;
  return snapshot("clipWords", `Clips: ${labels.join(", ")}`, doc, cursor);
}
