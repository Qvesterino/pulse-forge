import { describe, expect, it } from "vitest";
import {
  projectFingerprint,
  similarityAdvisory,
  sourceFingerprintFromTranscription,
} from "../../src/analysis/similarity-advisory";
import { transcribeTrack } from "../../src/reference/transcribe";
import { unsunoCommand } from "../../src/reference/unsuno";
import { normalizeProject } from "../../src/project-model/schema";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ProjectStore } from "../../src/store/ProjectStore";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "./golden-synth";

const SR = GOLDEN_SAMPLE_RATE;

describe("similarity advisory — numerical composition overlap", () => {
  const house = goldenTracks()[0];
  const transcription = transcribeTrack(renderGoldenTrack(house), SR, { separation: "off" });
  const source = sourceFingerprintFromTranscription(transcription);

  it("a project rebuilt FROM the transcription scores high (≥ 0.75)", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const sections = [0, 1].map((i) => ({
      role: i === 0 ? "intro" : "drop",
      startSec: i * 4 * (240 / 126),
      endSec: (i + 1) * 4 * (240 / 126),
    }));
    store.execute(unsunoCommand(store.doc, { transcription, sections }).command!);
    const verdict = similarityAdvisory(source, projectFingerprint(normalizeProject(store.doc)));
    expect(verdict.overall).toBeGreaterThanOrEqual(0.75);
    expect(verdict.verdict).toMatch(/identická|odvodené/);
    // every measured component carries the disclaimer
    expect(verdict.disclaimer).toMatch(/NIE je právna/);
  });

  it("an empty project scores low — nothing survives", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const verdict = similarityAdvisory(source, projectFingerprint(normalizeProject(store.doc)));
    expect(verdict.overall).toBeLessThan(0.3);
    expect(verdict.verdict).toMatch(/prepracované/);
  });

  it("components absent on BOTH sides are excluded, not counted as zero", () => {
    const drumsOnlySource = {
      bpm: 126,
      drumSlots: source.drumSlots,
      chordPcs: [],
      bassPcs: [],
    };
    const drumsOnlyProject = {
      drumSlots: source.drumSlots,
      chordPcs: [],
      bassPcs: [],
    };
    const verdict = similarityAdvisory(drumsOnlySource, drumsOnlyProject);
    expect(verdict.harmony).toBeNull();
    expect(verdict.bass).toBeNull();
    expect(verdict.drums).not.toBeNull();
    expect(verdict.overall).toBe(1);
  });

  it("a half-identical drum pattern lands mid-band", () => {
    const source = { bpm: 126, drumSlots: { kick: [0, 4, 8, 12], snare: [], hat: [] }, chordPcs: [], bassPcs: [] };
    const project = { drumSlots: { kick: [0, 4, 8, 13], snare: [], hat: [] }, chordPcs: [], bassPcs: [] };
    const verdict = similarityAdvisory(source, project);
    expect(verdict.overall).toBeGreaterThan(0.2);
    expect(verdict.overall).toBeLessThan(0.9);
  });

  it("determinism: same inputs → identical verdict", () => {
    const project = projectFingerprint(normalizeProject(new ProjectStore(createProjectFromTemplate("house")).doc));
    expect(similarityAdvisory(source, project)).toEqual(similarityAdvisory(source, project));
  });
});
