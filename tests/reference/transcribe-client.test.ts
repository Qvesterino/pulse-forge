import { describe, expect, it } from "vitest";
import { transcribeTrackAsync } from "../../src/reference/reference-client";
import { transcribeTrack } from "../../src/reference/transcribe";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../unsuno/golden-synth";

/**
 * The async transcription client must agree with the sync core exactly
 * (same deterministic result) and honor abort without throwing. In jsdom
 * there is no module Worker, so both calls take the same sync path — the
 * worker branch is exercised in browsers via the real panel flow.
 */
describe("transcribeTrackAsync", () => {
  it("matches the sync core on the golden house track", async () => {
    const pcm = renderGoldenTrack(goldenTracks()[0]);
    const sections = [
      { role: "a", startSec: 0, endSec: 4 },
      { role: "b", startSec: 4, endSec: 8 },
    ];
    const asyncResult = await transcribeTrackAsync(pcm, GOLDEN_SAMPLE_RATE, { sections });
    const syncResult = transcribeTrack(pcm, GOLDEN_SAMPLE_RATE, { sections });
    expect(asyncResult).toEqual(syncResult);
  });
  it("pre-aborted signal resolves (with the deterministic result), never hangs", async () => {
    const pcm = renderGoldenTrack(goldenTracks()[1]);
    const controller = new AbortController();
    controller.abort();
    const result = await transcribeTrackAsync(pcm, GOLDEN_SAMPLE_RATE, { signal: controller.signal });
    expect(result.tempo?.bpm).toBeGreaterThan(0);
  });
});
