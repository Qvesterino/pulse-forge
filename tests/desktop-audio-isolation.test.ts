import { describe, expect, it } from "vitest";

const { withAudioIsolationHeaders } = require("../desktop/audio-isolation.cjs") as {
  withAudioIsolationHeaders(response: Response): Response;
};

describe("desktop audio isolation response policy", () => {
  it("adds cross-origin isolation headers while preserving the app response", async () => {
    const source = new Response("KYX desktop", {
      status: 200,
      headers: { "Content-Type": "text/html", "X-KYX-Test": "preserved" },
    });

    const result = withAudioIsolationHeaders(source);

    expect(result.status).toBe(200);
    expect(result.headers.get("Content-Type")).toBe("text/html");
    expect(result.headers.get("X-KYX-Test")).toBe("preserved");
    expect(result.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(result.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(await result.text()).toBe("KYX desktop");
    expect(source.headers.get("Cross-Origin-Embedder-Policy")).toBeNull();
  });
});
