import { describe, expect, it } from "vitest";
import { encodeShareCode, decodeShareCode, shareAppUrl, embedUrl, embedSnippet } from "../../src/export/shareCode";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { setBpm, setProjectName } from "../../src/commands/commands";

describe("shareCode — round-trip", () => {
  it("encodes a project and decodes it back losslessly (normalized)", () => {
    const doc = createProjectFromTemplate("house");
    const edited = setProjectName(setBpm(doc, 133).execute(doc), "Viral Beat").execute(setBpm(doc, 133).execute(doc));
    const code = encodeShareCode(edited);
    const decoded = decodeShareCode(code);
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe("Viral Beat");
    expect(decoded!.bpm).toBe(133);
    expect(decoded!.tracks.length).toBe(edited.tracks.length);
    expect(decoded!.patterns.length).toBe(edited.patterns.length);
  });

  it("produces a URL-safe token (no characters needing escape)", () => {
    const code = encodeShareCode(createProjectFromTemplate("trap"));
    expect(code).toMatch(/^[A-Za-z0-9+*-]+$/); // lz-string URI-component alphabet
  });

  it("compresses meaningfully vs raw JSON", () => {
    const doc = createProjectFromTemplate("scene-score");
    const raw = JSON.stringify(doc).length;
    const code = encodeShareCode(doc).length;
    // ~2× on project JSON (ids/base36 strings carry entropy) — a share URL
    // lands in single-digit kB, well inside browser/chat limits.
    expect(code).toBeLessThan(raw / 1.8);
  });

  it("rejects garbage input as null (no throw)", () => {
    expect(decodeShareCode("")).toBeNull();
    expect(decodeShareCode("not-a-real-code-!!!")).toBeNull();
    // Valid compression of non-project JSON must also be rejected.
    expect(decodeShareCode(encodeShareCode({ nope: true } as never))).toBeNull();
  });
});

describe("shareCode — URL helpers", () => {
  it("shareAppUrl carries the token in ?import=", () => {
    expect(shareAppUrl("abc", "https://forge.app")).toBe("https://forge.app/?import=abc");
  });

  it("embedUrl carries the token in the hash", () => {
    expect(embedUrl("abc", "https://forge.app")).toBe("https://forge.app/embed/#p=abc");
  });

  it("embedSnippet is a paste-ready iframe", () => {
    const snippet = embedSnippet("https://forge.app/embed/#p=abc");
    expect(snippet).toContain('<iframe src="https://forge.app/embed/#p=abc"');
    expect(snippet).toContain('title="Pulse Forge beat"');
  });
});
