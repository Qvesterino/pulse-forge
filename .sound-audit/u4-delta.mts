import { computeDocDelta, applyDocDelta } from "../src/commands/docDelta";
const a: any = { ap: "x", list: [1,2] };
const b: any = { ap: "y", list: [1,2,3] };
const delta = computeDocDelta(a, b);
console.log("ops", JSON.stringify(delta.ops));
const undone = applyDocDelta(b, delta.undoOps ?? delta.ops);
console.log("undone", JSON.stringify(undone));
