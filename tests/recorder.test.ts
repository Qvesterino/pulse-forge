import { describe, expect, it } from "vitest";
import { extensionForMime, pickMimeType } from "../src/audio-engine/recorder";

describe("pickMimeType", () => {
  it("returns the first supported candidate in order", () => {
    const picked = pickMimeType(["audio/webm;codecs=opus", "audio/mp4"], (type) => type.startsWith("audio/webm"));
    expect(picked).toBe("audio/webm;codecs=opus");
  });

  it("skips unsupported entries", () => {
    const picked = pickMimeType(["audio/webm", "audio/ogg;codecs=opus"], (type) => type.includes("ogg"));
    expect(picked).toBe("audio/ogg;codecs=opus");
  });

  it("returns null when nothing is supported", () => {
    expect(pickMimeType(["audio/webm", "audio/mp4"], () => false)).toBeNull();
  });
});

describe("extensionForMime", () => {
  it("maps recorder mime types onto file extensions", () => {
    expect(extensionForMime("audio/webm;codecs=opus")).toBe(".webm");
    expect(extensionForMime("audio/ogg;codecs=opus")).toBe(".ogg");
    expect(extensionForMime("audio/mp4")).toBe(".m4a");
    expect(extensionForMime("audio/mpeg")).toBe(".mp3");
    expect(extensionForMime("")).toBe(".webm");
  });
});
