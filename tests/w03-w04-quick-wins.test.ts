import { describe, expect, it, vi, afterEach } from "vitest";
import { createWebSpeechCapture, isWebSpeechSupported } from "../src/intent/stt-web-speech";
import { ARTIST_PROFILES, PROFILE_GENRE_SLOTS, ENGINE_GENRE_UNION } from "../src/intent/artist-profiles";

/**
 * W0.3 + W0.4 (intent-killer-feature-plan quick wins).
 *
 * W0.3: the browser-native Web Speech capture is the preferred STT
 * provider (zero download; Chromium/Edge), with the PCM capture + Whisper
 * path as the honest fallback. The capture contract must hold: start →
 * result events → stopAndTranscribe resolves the transcript; errors
 * resolve null, never a fabricated text.
 *
 * W0.4: every artist profile's descriptive genre value is either inside
 * the engine union or documented in PROFILE_GENRE_SLOTS — no silent
 * fallback anywhere.
 */

interface FakeRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

let lastFake: FakeRecognition | null = null;

function installFakeSpeech(): void {
  lastFake = {
    lang: "",
    continuous: false,
    interimResults: false,
    start: vi.fn(() => {
      // recognition.start() is synchronous here; real browsers fire
      // CUMULATIVE result snapshots — the fake only fires what each test
      // delivers (an empty early snapshot would wipe interim state, which
      // real recognizers never do mid-utterance).
    }),
    stop: vi.fn(() => {
      setTimeout(() => lastFake?.onend?.(), 0);
    }),
    onresult: null,
    onerror: null,
    onend: null,
  };
  (window as unknown as Record<string, unknown>).SpeechRecognition = vi.fn(() => lastFake);
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
});

describe("W0.3 — Web Speech capture", () => {
  it("unsupported browser → create() returns null (honest fallback to Whisper path)", () => {
    expect(isWebSpeechSupported()).toBe(false);
    expect(createWebSpeechCapture()).toBeNull();
  });

  it("start → final results → stopAndTranscribe resolves the transcript", async () => {
    installFakeSpeech();
    const capture = createWebSpeechCapture("sk-SK");
    expect(capture).not.toBeNull();
    expect(await capture!.start()).toBe(true);
    expect(capture!.active).toBe(true);
    expect(lastFake!.lang).toBe("sk-SK");
    // Real recognizers fire CUMULATIVE snapshots and finalize per phrase —
    // two distinct phrases must join with a space (the module bug this test
    // pins: a naive `final += text` glued them together).
    lastFake!.onresult?.({
      results: [
        { 0: { transcript: "dark rolling techno" }, isFinal: true },
        { 0: { transcript: "at 140" }, isFinal: true },
      ],
    });
    const text = await capture!.stopAndTranscribe();
    expect(text).toBe("dark rolling techno at 140");
    expect(lastFake!.stop).toHaveBeenCalled();
  });

  it("interim-only speech still resolves (never loses the words)", async () => {
    installFakeSpeech();
    const capture = createWebSpeechCapture()!;
    await capture.start();
    // The user stops before any phrase finalized — only interim results
    // exist. stopAndTranscribe must return the words, not null.
    lastFake!.onresult?.({ results: [{ 0: { transcript: "tight drums" }, isFinal: false }] });
    const text = await capture!.stopAndTranscribe();
    expect(text).toBe("tight drums");
  }, 10_000);

  it("recognition error → null transcript (never fabricated)", async () => {
    installFakeSpeech();
    const capture = createWebSpeechCapture()!;
    await capture.start();
    lastFake!.onerror?.({ error: "not-allowed" });
    expect(await capture!.stopAndTranscribe()).toBeNull();
  });

  it("unsupported: start/stopAndTranscribe resolve null through the same contract", async () => {
    // The PCM+Whisper fallback owns unsupported browsers — the Web Speech
    // module itself returns null capture, so the panel falls back.
    expect(createWebSpeechCapture()).toBeNull();
  });
});

describe("W0.4 — artist genre slots: no silent fallback", () => {
  it("every profile's genre value is in-union OR documented in PROFILE_GENRE_SLOTS", () => {
    const undocumented: Array<{ slug: string; genre: string }> = [];
    for (const [slug, profile] of Object.entries(ARTIST_PROFILES)) {
      for (const genre of profile.genres) {
        if (ENGINE_GENRE_UNION.has(genre)) continue;
        if (PROFILE_GENRE_SLOTS[genre]) continue;
        undocumented.push({ slug, genre });
      }
    }
    expect(undocumented, "out-of-union genre values missing from the slot table").toEqual([]);
  });

  it("every slot entry maps to a VALID engine genre (the nearest is real)", () => {
    for (const [value, slot] of Object.entries(PROFILE_GENRE_SLOTS)) {
      expect(ENGINE_GENRE_UNION.has(slot.nearest), `${value} → nearest "${slot.nearest}" must be an engine genre`).toBe(
        true,
      );
      expect(slot.reason.length, `${value} needs a documented reason`).toBeGreaterThan(20);
    }
  });

  it("every documented slot is actually USED by some profile (no dead documentation)", () => {
    const used = new Set<string>();
    for (const profile of Object.values(ARTIST_PROFILES)) {
      for (const genre of profile.genres) {
        if (!ENGINE_GENRE_UNION.has(genre)) used.add(genre);
      }
    }
    for (const value of Object.keys(PROFILE_GENRE_SLOTS)) {
      expect(used.has(value), `slot "${value}" documented but no profile uses it`).toBe(true);
    }
  });
});
