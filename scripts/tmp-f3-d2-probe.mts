// F3/D2 probe: why does lead-only generation produce empty notes?
import { testDoc } from "../tests/fixtures/doc";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { generatePattern } from "../src/ai/generator";
import { generateMultiVoice } from "../src/intent/multi-voice";
import { instrumentTargets, instrumentTrackForRole } from "../src/ai/role-targets";

const doc = testDoc();
console.log("doc tracks:", doc.tracks.map((t) => `${t.kind}:${t.name}`).join(", "));
const input = normalizeIntent({ genre: "techno", seed: "gate-explicit BPM + genre", roles: ["lead"] });
const plan = planGeneration(input, doc);
console.log("plan options roles:", plan.options.roles, "| stepCount:", plan.options.length);
const pattern = generatePattern(doc, plan.options);
const noteCounts = Object.entries(pattern.notes ?? {}).map(([k, v]) => `${k.slice(-8)}:${v.length}`);
console.log("generatePattern rows:", Object.keys(pattern.rows).length, "notes:", noteCounts.join(",") || "NONE");

const seedNumber = (parseInt(String(plan.options.seed).slice(-8), 36) || 42) >>> 0;
const mv = generateMultiVoice(doc, plan.options.genre, seedNumber, plan.options.length, null, 0.7, 0.3, 0.5, 0.5, undefined, undefined, plan.options.progression);
console.log("multiVoice lengths: bass", mv.bass.length, "chord", mv.chord.length, "lead", mv.lead.length);
console.log("instrumentTargets:", instrumentTargets(doc, plan.options.instrumentTrackIds).length);
console.log("lead track:", instrumentTrackForRole(doc, "lead", plan.options.instrumentTrackIds)?.name ?? "NONE");
console.log("progression option:", plan.options.progression ?? "undefined");
