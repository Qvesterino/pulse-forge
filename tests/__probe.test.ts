import { describe, it } from "vitest";
import { parseParamIntent, paramPlanLines, paramMovePreview } from "../src/intent/param-intent";
import { parseSelectedAudioClipFadeIntent, parseClipArrangeIntent } from "../src/intent/arrangeWords";
import { routeIntentText } from "../src/intent/route";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

const CASES = [
  "slightly lower compressor threshold on the drums",
  "much faster compressor attack on the drums",
  "slightly slower compressor release on the drums",
  "lower filter cutoff on the lead",
  "higher filter Q on the lead",
  "wider widener width on the chords",
  "set the compressor threshold to -20 dB on the drums",
  "set compressor attack to 5 ms on the drums",
  "set the filter cutoff to 12 kHz on the lead",
  "set the filter Q to 2.5 on the lead",
  "set the widener width to 50% on the chords",
  "set the compressor threshold to -20 on the drums",
  "lower the compressor threshold",
  "more attack on the snare",
];

describe("probe", () => {
  it("prints param parses", () => {
    const doc = testDoc();
    for (const text of CASES) {
      const intent = parseParamIntent(text);
      const preview = intent ? paramMovePreview(intent, paramDefault(intent)) : null;
      console.log(
        JSON.stringify({
          text,
          kind: routeIntentText(text, doc).kind,
          intent: intent
            ? `${intent.role}:${intent.effectType}.${intent.paramId} ${intent.mode} lvl=${intent.degree?.level ?? "-"} value=${intent.value ?? "-"} pct=${intent.percent ?? "-"} targets=${intent.targets.join("+")}`
            : null,
          preview,
          plan: intent ? paramPlanLines(intent, doc) : null,
        }),
      );
    }
  });

  it("prints fade parses", () => {
    const doc = testDoc();
    const clip = { id: "clip-1", trackId: "t", bufferId: "b", startBar: 0, lengthBars: 8, offsetSec: 0, trimStart: 0, trimEnd: 0, gain: 1, fadeIn: 0, fadeOut: 1, stretchRate: 1, reverse: false };
    const withClip: ProjectDocument = {
      ...doc,
      bpm: 120,
      arrangement: { ...doc.arrangement, clips: [], audioClips: [clip] },
    };
    for (const text of [
      "fade out the selected clip much longer",
      "fade out the selected clip slightly shorter",
      "fade in the selected clip slightly",
      "fade in the selected clip as short as possible",
      "fade in the selected clip as long as possible",
      "fade out the selected clip a little longer",
      "fade out the selected clip over 2 s",
      "fade the selected clip slightly",
    ]) {
      const ops = parseSelectedAudioClipFadeIntent(text, withClip, "clip-1");
      console.log(JSON.stringify({ text, ops }));
    }
    console.log(JSON.stringify({ clipArrange: parseClipArrangeIntent("fade out the selected clip much longer", withClip) }));
  });
});

function paramDefault(intent: NonNullable<ReturnType<typeof parseParamIntent>>): number {
  switch (intent.effectType) {
    case "compressor":
      return intent.paramId === "threshold" ? -18 : intent.paramId === "attack" ? 0.01 : 0.2;
    case "svFilter":
      return intent.paramId === "cutoff" ? 2000 : 0.3;
    case "haasWidener":
      return 0.7;
    case "saturation":
      return intent.paramId === "tone" ? 6000 : 0.4;
    default:
      return 0.5;
  }
}
