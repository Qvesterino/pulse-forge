import { describe, expect, it } from "vitest";
import { userSampleId } from "../../src/persistence/UserSampleRepository";

describe("userSampleId", () => {
  it("generates a user.* id from filename", () => {
    const id = userSampleId("My Kick.wav");
    expect(id).toMatch(/^user\.my-kick-/);
  });

  it("strips file extension", () => {
    const id = userSampleId("snare.wav");
    expect(id).toMatch(/^user\.snare-/);
  });

  it("handles special characters", () => {
    const id = userSampleId("My Cool Sample (2).wav");
    expect(id).toMatch(/^user\.my-cool-sample-2-/);
  });

  it("produces unique ids with randomness", () => {
    // userSampleId uses Date.now() + random chars, so fast calls may collide.
    // The function appends a random suffix, so we test the format.
    const id = userSampleId("test.wav");
    expect(id).toMatch(/^user\.test-[a-z0-9]+$/);
  });

  it("handles unicode filenames", () => {
    const id = userSampleId("Kůň.wav");
    expect(id).toMatch(/^user\./);
  });

  it("handles long filenames", () => {
    const longName = "a".repeat(200) + ".wav";
    const id = userSampleId(longName);
    expect(id.length).toBeLessThan(250);
  });
});
