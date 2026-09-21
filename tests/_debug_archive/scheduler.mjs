import { createDefaultProject, normalizeProject } from "./src/project-model/schema.ts";
import { getDrumTrack, BAR_TICKS, STEP_TICKS } from "./src/project-model/types.ts";
import { Transport } from "./src/transport/Transport.ts";

const base = createDefaultProject();
const drum = getDrumTrack(base);
const trackId = drum.id;
const stepCount = 32;
const pattern32 = {
  ...base.patterns[0],
  stepCount,
  rows: Object.fromEntries(
    drum.pads.map((pad) => [pad.id, new Array(stepCount).fill(0).map((_, i) => base.patterns[0].rows[pad.id][i] ?? 0)]),
  ),
};
const scene = base.scenes[0];
const doc = normalizeProject({
  ...base,
  patterns: [pattern32],
  arrangement: { clips: [{ id: "clip-late", sceneId: scene.id, startBar: 4, lengthBars: 4 }] },
  automation: [
    {
      id: "auto-pan",
      target: { kind: "trackPan", trackId },
      points: [
        { tick: 0, value: 0 },
        { tick: STEP_TICKS * 16, value: 0.5 },
      ],
    },
  ],
});

let audioTime = 10;
const transport = new Transport({ now: () => audioTime }, doc.bpm);
transport.play(0);
audioTime = 10.025;

const windowStartTick = Math.max(0, transport.position);
const HORIZON_SECONDS = 0.12;
const horizon = audioTime + HORIZON_SECONDS;
const windowEnd = transport.tickAt(horizon);
const windowStart = windowStartTick;
console.log("windowStart:", windowStart, "windowEnd:", windowEnd);

const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
let automationCtx = null;
for (const clip of clips) {
  const clipStart = clip.startBar * BAR_TICKS;
  const clipEnd = clipStart + clip.lengthBars * BAR_TICKS;
  const s = Math.max(windowStart, clipStart);
  const e = Math.min(windowEnd, clipEnd);
  console.log("main loop clip:", clip.id, "s:", s, "e:", e, "continue:", e <= s);
  if (e <= s) continue;
}
console.log("after main loop, automationCtx:", automationCtx);
if (!automationCtx) {
  const covering = clips.find((c) => {
    const cs = c.startBar * BAR_TICKS;
    return windowStart >= cs && windowStart < cs + c.lengthBars * BAR_TICKS;
  });
  console.log("covering:", covering ? covering.id : null);
  if (covering) {
    const scene = doc.scenes.find((sc) => sc.id === covering.sceneId);
    const pattern = scene ? doc.patterns.find((p) => p.id === scene.patternId) : undefined;
    const patternTicks = pattern ? STEP_TICKS * pattern.stepCount : STEP_TICKS * 16;
    automationCtx = { base: covering.startBar * BAR_TICKS, patternTicks };
    console.log("automationCtx set:", automationCtx);
  }
}
console.log("final automationCtx:", automationCtx);
