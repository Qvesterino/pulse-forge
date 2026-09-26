import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { renderWithContext } from "../helpers";
import { normalizeIntent } from "../../src/intent/normalize";
import { lastGeneration, rememberGeneration } from "../../src/intent/session-context";
import type { SongBuild } from "../../src/intent/song";
import type { ProjectDocument } from "../../src/project-model/types";

const songDraftMocks = vi.hoisted(() => ({
  renderSong: vi.fn(),
  previewLoudness: vi.fn(),
  appliedBuilds: [] as unknown[],
}));

vi.mock("../../src/intent/audition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intent/audition")>();
  return { ...actual, renderSongAuditionBuffer: songDraftMocks.renderSong };
});

vi.mock("../../src/intent/loudness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intent/loudness")>();
  return { ...actual, measurePreviewLoudness: songDraftMocks.previewLoudness };
});

vi.mock("../../src/intent/ranking-v3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intent/ranking-v3")>();
  return { ...actual, rerankTopBySound: vi.fn(async (_doc, bank) => [...bank]) };
});

vi.mock("../../src/intent/song", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intent/song")>();
  return {
    ...actual,
    applySongCommand: (doc: ProjectDocument, build: SongBuild) => {
      songDraftMocks.appliedBuilds.push(build);
      return actual.applySongCommand(doc, build);
    },
  };
});

describe("IntentPanel", () => {
  it("renders the textarea and disabled GENERATE button initially", () => {
    renderWithContext(<IntentPanel />);
    const textarea = screen.getByLabelText(/Intent description/i);
    expect(textarea).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /GENERATE/i }) as HTMLButtonElement;
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it("typing into the textarea enables the GENERATE button", () => {
    renderWithContext(<IntentPanel />);
    const textarea = screen.getByLabelText(/Intent description/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "dark techno at 140" } });
    const btn = screen.getByRole("button", { name: /GENERATE/i });
    expect(btn).not.toBeDisabled();
  });

  it("typing a recognized intent shows detected keywords", () => {
    renderWithContext(<IntentPanel />);
    const textarea = screen.getByLabelText(/Intent description/i);
    fireEvent.change(textarea, { target: { value: "dark house at 124 bpm" } });
    const detected = screen.getByLabelText(/Detected keywords/i);
    expect(detected.textContent).not.toBeNull();
    expect(detected.textContent!.length).toBeGreaterThan(0);
  });

  it("updates the understood brief and generation input after an inline BPM correction", async () => {
    renderWithContext(<IntentPanel />);
    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "dark trap at 142" } });
    fireEvent.click(screen.getByText(/^142 BPM/));

    const bpmInput = screen.getByLabelText("Nové BPM");
    fireEvent.change(bpmInput, { target: { value: "128" } });
    fireEvent.keyDown(bpmInput, { key: "Enter" });

    expect(screen.getByText(/128 BPM/)).toBeInTheDocument();
    expect(screen.queryByText(/^142 BPM/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
    await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });
    expect(await screen.findByLabelText("Stav kreatívnych smerov")).toBeInTheDocument();
    expect(lastGeneration()?.intent.bpmRange).toEqual([128, 128]);
  }, 40000);

  it("unprotects a role in the effective brief, including the last protected role", () => {
    renderWithContext(<IntentPanel />);
    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "keep my bass" } });
    expect(screen.getByText(/ponechám existujúce: basu/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Prestať chrániť bass" }));

    expect(screen.queryByText(/ponechám existujúce: basu/)).toBeNull();
    expect(screen.getByRole("button", { name: "Generovať bicie" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Generovať basu" })).toHaveAttribute("aria-pressed", "true");
  });

  it("blocks generation for an unresolved role conflict", async () => {
    renderWithContext(<IntentPanel />);
    fireEvent.change(screen.getByLabelText(/Intent description/i), {
      target: { value: "no drums, add kick" },
    });
    expect(screen.getByLabelText("Rozpory v zadaní")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));

    expect(await screen.findByText(/zadanie si protirečí/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^USE$/ })).toBeNull();
  });

  it("blocks SONG generation for the same unresolved role conflict", async () => {
    renderWithContext(<IntentPanel />);
    fireEvent.change(screen.getByLabelText(/Intent description/i), {
      target: { value: "no drums, add kick" },
    });

    fireEvent.click(screen.getByRole("button", { name: /♪ SONG/i }));

    expect(await screen.findByText(/zadanie si protirečí/i)).toBeInTheDocument();
    expect(screen.queryByText(/full-song preview ready/i)).toBeNull();
  });

  it("resolves a prohibited full-beat scope by editing roles and sends that correction to generation", async () => {
    renderWithContext(<IntentPanel />);
    fireEvent.change(screen.getByLabelText(/Intent description/i), {
      target: { value: "no bass, full beat" },
    });
    expect(screen.getByLabelText("Rozpory v zadaní")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Generovať lead" }));

    expect(screen.queryByLabelText("Rozpory v zadaní")).toBeNull();
    expect(screen.getByRole("button", { name: "Generovať basu" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
    await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });
    expect(lastGeneration()?.intent.roles).toEqual(["drums", "chords"]);
  }, 40000);

  it("invalidates an auditioned candidate bank when the producer edits generation roles", async () => {
    renderWithContext(<IntentPanel />);
    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "dark trap" } });
    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
    await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });

    fireEvent.click(screen.getByRole("button", { name: "Generovať akordy" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /^USE$/ })).toBeNull());
    expect(screen.getByRole("button", { name: "Generovať akordy" })).toHaveAttribute("aria-pressed", "true");
  }, 40000);

  it("replays a history prompt only after its text and brief state are loaded", async () => {
    renderWithContext(<IntentPanel />);
    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "dark trap at 140" } });
    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
    await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });

    const history = within(screen.getByLabelText("Prompt history"));
    fireEvent.click(history.getAllByRole("button", { name: "dark trap at 140" })[0]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^USE$/ })).toBeNull());
    await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });
    expect(lastGeneration()?.intent.genre).toBe("trap");
  }, 40000);

  it("removes an older candidate bank when the current prompt becomes conflicting", async () => {
    renderWithContext(<IntentPanel />);
    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "dark trap 140" } });
    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
    await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });

    fireEvent.change(screen.getByLabelText(/Intent description/i), {
      target: { value: "no drums, add kick" },
    });

    expect(screen.getByLabelText("Rozpory v zadaní")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^USE$/ })).toBeNull());
  }, 40000);

  it("resolves preserve-vs-addition by unprotecting the whole role", () => {
    renderWithContext(<IntentPanel />);
    fireEvent.change(screen.getByLabelText(/Intent description/i), {
      target: { value: "keep my kick but add snare" },
    });
    expect(screen.getByLabelText("Rozpory v zadaní")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Prestať chrániť drums" }));

    expect(screen.queryByLabelText("Rozpory v zadaní")).toBeNull();
    expect(screen.queryByText(/ponechám existujúce: bicie/)).toBeNull();
  });

  it("renders the INTENT header", () => {
    renderWithContext(<IntentPanel />);
    expect(screen.getByText(/INTENT/i)).toBeInTheDocument();
  });

  it("does not re-apply a session candidate from another project", async () => {
    const rendered = renderWithContext(<IntentPanel />);
    const doc = rendered.services.store.getDoc();
    const pattern = doc.patterns[0];
    const intent = normalizeIntent({ genre: "house", seed: "foreign-session" });
    rememberGeneration({
      text: "house",
      intent,
      candidates: [
        { index: 0, pattern, intent },
        { index: 1, pattern: { ...pattern, id: `${pattern.id}-second` }, intent },
      ],
      appliedIndex: null,
      docId: "another-project",
      at: 0,
    });

    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "ten druhý" } });
    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/patrí inému projektu/i);
    expect(rendered.services.store.execute).not.toHaveBeenCalled();
    rememberGeneration({ text: "", intent, candidates: [], appliedIndex: null, docId: doc.id, at: 0 });
  });

  it("releases the generating state when a targeted section revision has no matching section", async () => {
    renderWithContext(<IntentPanel />);
    fireEvent.change(screen.getByLabelText(/Intent description/i), {
      target: { value: "make bridge more energic" },
    });
    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));

    expect(await screen.findByText(/no bridge section in the project/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "GENERATE" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /♪ SONG/i })).toBeEnabled();
  });
});

describe("IntentPanel — Remix-DNA MUTATE", () => {
  it("forks the current beat into a stamped child project", () => {
    const rendered = renderWithContext(<IntentPanel />);
    const before = rendered.services.store.getDoc();
    fireEvent.click(screen.getByRole("button", { name: /MUTATE/i }));
    const replaceDoc = rendered.services.store.replaceDoc as ReturnType<typeof vi.fn>;
    expect(replaceDoc).toHaveBeenCalledTimes(1);
    const child = replaceDoc.mock.calls[0][0] as ProjectDocument;
    expect(child.id).not.toBe(before.id);
    expect(child.lineage?.parentId).toBe(before.id);
    expect(child.lineage?.rootId).toBe(before.id);
    expect(child.lineage?.depth).toBe(1);
    expect(screen.getByRole("status")).toHaveTextContent(/Mutate #1/);
  });

  it("second mutate in the session makes a distinct sibling", () => {
    const rendered = renderWithContext(<IntentPanel />);
    const before = rendered.services.store.getDoc();
    const replaceDoc = rendered.services.store.replaceDoc as ReturnType<typeof vi.fn>;
    fireEvent.click(screen.getByRole("button", { name: /MUTATE/i }));
    fireEvent.click(screen.getByRole("button", { name: /MUTATE/i }));
    expect(replaceDoc).toHaveBeenCalledTimes(2);
    const first = replaceDoc.mock.calls[0][0] as ProjectDocument;
    const second = replaceDoc.mock.calls[1][0] as ProjectDocument;
    // Same parent both times (mock store never swaps), different takes: the
    // vary seeds carry the sibling index, so the rolls cannot coincide.
    expect(first.lineage?.parentId).toBe(before.id);
    expect(second.lineage?.parentId).toBe(before.id);
    const seedsOf = (d: ProjectDocument) => d.patterns.map((p) => p.assist?.seed ?? null);
    expect(seedsOf(first)).not.toEqual(seedsOf(second));
  });
});

describe("IntentPanel — A3 share moment", () => {
  async function generateAndUse() {
    renderWithContext(<IntentPanel />);
    const textarea = screen.getByLabelText(/Intent description/i);
    fireEvent.change(textarea, { target: { value: "dark trap 140" } });
    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
    // Generation is real (deterministic local provider) — wait for candidates.
    const useButtons = await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });
    const candidateBank = screen.getByLabelText("Candidate bank");
    expect(screen.getByLabelText("Candidate ranking explanation")).toHaveTextContent(/hudobnej odlišnosti/i);
    expect(within(candidateBank).queryByText(/^\d+%$/)).not.toBeInTheDocument();
    fireEvent.click(useButtons[0]);
    await waitFor(() => expect(screen.getByText(/Yours\. Share it:/i)).toBeInTheDocument());
  }

  it("reveals Publish / Copy-link CTA after USE", async () => {
    await generateAndUse();
    expect(screen.getByRole("button", { name: /PUBLISH TO GALLERY/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /COPY LINK/i })).toBeInTheDocument();
    // Capability degradation: jsdom has no MediaRecorder → the VIDEO button
    // must be ABSENT, not broken (same guard the ExportPanel uses).
    expect(screen.queryByRole("button", { name: /^VIDEO$/ })).toBeNull();
  }, 40000);

  it("hides the share row when a new generation starts", async () => {
    await generateAndUse();
    const textarea = screen.getByLabelText(/Intent description/i);
    fireEvent.change(textarea, { target: { value: "hard techno 145" } });
    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
    expect(screen.queryByText(/Yours\. Share it:/i)).toBeNull();
  }, 40000);

  it("copy link falls back to a manual dialog and reports it honestly when clipboard is unavailable", async () => {
    await generateAndUse();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    fireEvent.click(screen.getByRole("button", { name: /COPY LINK/i }));
    await waitFor(() => expect(screen.getByText(/Share link shown/i)).toBeInTheDocument());
    expect(screen.queryByText(/link copied/i)).toBeNull();
    expect(promptSpy).toHaveBeenCalled();
  }, 40000);
});

describe("IntentPanel — coherent song directions", () => {
  it("keeps USE bound to the exact full-song lane that finished audition rendering", async () => {
    const samples = new Float32Array(8192).fill(0.025);
    const makeBuffer = () =>
      ({
        numberOfChannels: 2,
        length: samples.length,
        sampleRate: 44100,
        getChannelData: () => samples,
      }) as unknown as AudioBuffer;
    let finishSelectedRender: (buffer: AudioBuffer) => void = () => {
      throw new Error("selected song render was not requested");
    };

    songDraftMocks.appliedBuilds.length = 0;
    songDraftMocks.renderSong.mockReset();
    songDraftMocks.renderSong
      .mockImplementationOnce(async () => makeBuffer())
      .mockImplementationOnce(
        () =>
          new Promise<AudioBuffer>((resolve) => {
            finishSelectedRender = resolve;
          }),
      );
    songDraftMocks.previewLoudness.mockReset();
    songDraftMocks.previewLoudness.mockImplementation(async () => ({
      measured: null,
      target: -14,
      currentTrim: 0,
      recommendedTrim: null,
      recommendation: {
        goal: "-14 LUFS",
        evidence: "meranie sa nepodarilo",
        trimDb: null,
        affected: ["master (loudnessTrimDb)"],
        tradeOff: "",
        withinTarget: false,
      },
    }));

    const rendered = renderWithContext(<IntentPanel />);
    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "ambient 100 BPM" } });
    fireEvent.click(screen.getByRole("button", { name: /^♪ SONG$/ }));

    const directions = await screen.findByLabelText("Full-song directions", {}, { timeout: 20000 });
    const laneButton = within(directions)
      .getAllByRole("button")
      .find((button) => /^Use (SAFE|PERSONAL|EXPERIMENTAL)/i.test(button.getAttribute("aria-label") ?? ""));
    expect(laneButton).toBeDefined();
    if (!laneButton) return;
    await waitFor(() => expect(laneButton).toBeEnabled());
    fireEvent.click(laneButton);

    await waitFor(() => expect(songDraftMocks.renderSong).toHaveBeenCalledTimes(2));
    const useButton = screen.getByRole("button", { name: "USE SONG" });
    expect(useButton).toBeDisabled();
    finishSelectedRender(makeBuffer());
    await waitFor(() => expect(useButton).toBeEnabled());

    const lane = laneButton
      .getAttribute("aria-label")
      ?.match(/^Use (SAFE|PERSONAL|EXPERIMENTAL)/i)?.[1]
      ?.toLowerCase();
    expect(lane).toBeDefined();
    const auditionedBuild = songDraftMocks.appliedBuilds.at(-1) as SongBuild | undefined;
    const selectedAlternative = auditionedBuild?.alternatives.find((alternative) => alternative.lane === lane);
    expect(auditionedBuild?.sections.map((section) => section.pattern.id)).toEqual(
      selectedAlternative?.sections.map((section) => section.pattern.id),
    );

    fireEvent.click(useButton);
    await waitFor(() => expect(screen.queryByLabelText("Song draft preview")).toBeNull());
    expect(songDraftMocks.appliedBuilds.at(-1)).toBe(auditionedBuild);
    expect(rendered.services.store.execute).toHaveBeenCalled();
  }, 40000);
});
