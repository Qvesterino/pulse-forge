import { describe, it } from "vitest";
import { MODEL_ACTIONS, validateModelAction } from "../src/intent/model-schema";

describe("tmp schema", () => {
  it("prints", () => {
    // eslint-disable-next-line no-console
    console.log("[schema]", "complaintIntent" in MODEL_ACTIONS, Object.keys(MODEL_ACTIONS).length);
    const action = { kind: "complaintIntent", complaint: "noPunch", family: "kick" };
    // eslint-disable-next-line no-console
    console.log("[validate]", JSON.stringify(validateModelAction(action)));
  });
});
