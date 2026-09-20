import { describe, expect, it } from "vitest";
import { parseSectionRequests } from "../src/intent/sections";

describe("debug", () => {
  it("mostika/zaver", () => {
    for (const s of ["techno bez mostika", "no zaver", "bez mostiku", "bez mostik", "no outro"]) {
      console.log(s, "=>", JSON.stringify(parseSectionRequests(s)));
    }
    expect(true).toBe(true);
  });
});
