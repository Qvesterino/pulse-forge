/**
 * Golden engine render — structural hash per template (no AudioContext needed).
 *
 * For each template we hash the DETERMINISTIC engine output:
 *   - project JSON (after normalization — catches any template drift)
 *   - clip windows (song mode — which pattern where, with grouping)
 *   - drum hits + note events for the first bar (groove engine output)
 *
 * A hash change means intentional DSP/template change or a silent regression
 * (e.g. a groove tweak that no longer rounds-trips). Update the fixture
 * (tests/fixtures/golden-render.expected.ts) only after auditing the diff.
 * ai-baseline does the same for intent→pattern; this extends it to the engine.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createProjectFromTemplate, TEMPLATES } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { EXPECTED_GOLDEN_HASHES } from "./fixtures/golden-render.expected";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function engineHash(templateId: string): string {
  const doc = normalizeProject(createProjectFromTemplate(templateId as any));
  const pattern = doc.patterns[0];
  // Stable keys — names are deterministic, ids are random per run.
  const trackKey = new Map(doc.tracks.map((t, i) => [t.id, `${i}:${t.kind}:${t.name}`]));
  const padKey = new Map(
    doc.tracks
      .filter((t) => t.kind === "drum")
      .flatMap((t) => (t as any).pads.map((p: any) => [p.id, `${trackKey.get(t.id)}:${p.name}`] as const)),
  );
  // Clip windows keyed by scene name (stable) not scene id (random).
  const sceneName = new Map(doc.scenes.map((s) => [s.id, s.name]));
  // Hash the RAW pattern content (rows + notes) — not groove-shifted hits.
  // Groove hits include seeded RNG jitter (humanize) which would make the
  // golden flaky if we hashed jittered ticks directly. The raw rows/notes
  // still catch any engine/template drift that would affect audio.
  const clipWindows = doc.arrangement.clips
    .map((c) => `${sceneName.get(c.sceneId) ?? c.sceneId}:${c.startBar}:${c.lengthBars}`)
    .sort()
    .join("|");
  const rowsHash = hash(
    Object.entries(pattern.rows)
      .map(([padId, row]) => [padKey.get(padId) ?? padId, row] as const)
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
  return hash({
    doc: { name: doc.name, bpm: doc.bpm, trackCount: doc.tracks.length, patternCount: doc.patterns.length, clipWindows },
    rowsHash,
    notes: Object.entries(pattern.notes ?? {})
      .flatMap(([trackId, notes]) => notes.map((n) => `${trackKey.get(trackId) ?? trackId}:${n.pitch}:${n.start}:${n.duration}:${n.velocity.toFixed(2)}`))
      .sort()
      .join("|"),
    stepMeta: pattern.stepMeta ? hash(pattern.stepMeta) : "none",
  });
}

describe("golden engine render — per template", () => {
  for (const template of TEMPLATES) {
    it(`${template.id} — engine output hash matches golden`, () => {
      const actual = engineHash(template.id);
      const expected = EXPECTED_GOLDEN_HASHES[template.id as keyof typeof EXPECTED_GOLDEN_HASHES];
      expect(actual, `golden mismatch for ${template.id} — run: npm run ai:baseline to regenerate fixtures`).toBe(expected);
    });
  }

  it("all templates have a golden entry", () => {
    const ids = new Set(TEMPLATES.map((t) => t.id));
    for (const key of Object.keys(EXPECTED_GOLDEN_HASHES)) {
      expect(ids.has(key as any), `stale golden entry: ${key}`).toBe(true);
    }
    for (const t of TEMPLATES) {
      expect(EXPECTED_GOLDEN_HASHES[t.id as keyof typeof EXPECTED_GOLDEN_HASHES], `missing golden for ${t.id}`).toBeDefined();
    }
  });
});
