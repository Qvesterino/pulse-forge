import { describe, it } from "vitest";
import { MAX_ARRANGEMENT_CLIP_BARS, normalizeProject } from "../src/project-model/schema";
import { addAudioClip, resizeAudioClip } from "../src/commands/audioClips";
import { testDoc } from "../tests/fixtures/doc";

describe("mechanism probe", () => {
  it("what does normalizeProject actually do with an oversized audio clip?", () => {
    const base = testDoc();
    const doc = addAudioClip(base, base.tracks[0]!.id, "buf-test", 0, 4, {}).execute(base);
    const clipId = doc.arrangement.audioClips![0]!.id;

    // 1. normalizer on a hand-forged oversized clip
    const forged: any = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: doc.arrangement.audioClips!.map((c) => ({ ...c, lengthBars: 20000 })),
      },
    };
    try {
      const out = normalizeProject(forged);
      console.log(`PROBE normalize(20000) -> OK, clips=${out.arrangement.audioClips?.length}`);
    } catch (e) {
      console.log(`PROBE normalize(20000) -> THREW: ${(e as Error).message}`);
      console.log(`PROBE stack: ${((e as Error).stack ?? "").split("\n").slice(1, 6).join(" | ")}`);
    }

    // 2. the real command path, as the store runs it: command THEN normalize
    const resized = resizeAudioClip(doc, clipId, 20000).execute(doc);
    console.log(`PROBE command stored lengthBars=${resized.arrangement.audioClips![0]!.lengthBars} (cap=${MAX_ARRANGEMENT_CLIP_BARS})`);
    try {
      const out = normalizeProject(resized);
      console.log(`PROBE normalize(command output) -> OK, clips=${out.arrangement.audioClips?.length}`);
    } catch (e) {
      console.log(`PROBE normalize(command output) -> THREW: ${(e as Error).message}`);
    }
  });
});