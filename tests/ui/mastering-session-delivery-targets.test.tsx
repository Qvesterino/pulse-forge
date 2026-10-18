import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { Blob as NodeBlob } from "node:buffer";
import { MasteringFileSessionPanel } from "../../src/ui/MasteringFileSessionPanel";
import { MasteringSessionRepository, createMasteringSessionRecord } from "../../src/mastering/sessionStore";
import { mockServices, renderWithContext } from "../helpers";
import { testDoc } from "../fixtures/doc";

/**
 * External-mastering delivery targets (`MasteringFileSessionPanel`) —
 * TARGET LUFS and TRUE PEAK TARGET.
 *
 * Harness notes (this panel had NO committed render test before this audit):
 * the block only renders once `session && draft`, and loading a session runs a
 * real inspect → SHA-256 fingerprint → decode → audit chain. Those three
 * collaborators are mocked here — `decodeMasteringWavBlob`,
 * `isBoundedMasteringWavDecodeAvailable` (jsdom has no bounded WAV decoder, so
 * the panel would otherwise take the browser `decodeAudioData` path) and
 * `fingerprintEncodedMasterAsync` — so the spec enters the REAL field and the
 * REAL `updateDraft`, not a unit around them.
 *
 * MEASURED BEFORE THE FIX (throwaway probe driving this same harness):
 *   empty TARGET LUFS  → -14 became -5   (clamp of Number("") === 0)
 *   empty TRUE PEAK    → -1  became 0 dBTP (clamp of Number("") === 0)
 *
 * `applySettings` persists the draft through `repository.put`, so an emptied
 * field followed by "Apply settings" wrote -5 LUFS-I / 0 dBTP into the STORED
 * session — a +9 dB loudness jump and a disabled true-peak ceiling that
 * survived a reload. Most of these specs are negative assertions: an abandoned
 * edit must write nothing at all.
 */
const SR = 44_100;
const SECONDS = 2;
const LUFS = "External mastering target loudness";
const TP = "External mastering true peak target";

function fakeBuffer(): AudioBuffer {
  const length = SR * SECONDS;
  const data = new Float32Array(length).fill(0.1);
  return {
    numberOfChannels: 2,
    sampleRate: SR,
    duration: SECONDS,
    length,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

vi.mock("../../src/mastering/encodedInspection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mastering/encodedInspection")>();
  return {
    ...actual,
    inspectMasteringReferenceBlob: vi.fn(async () => ({
      channels: 2,
      sampleRate: SR,
      durationSeconds: SECONDS,
      fileSizeBytes: 4,
    })),
    decodeMasteringWavBlob: vi.fn(async () => fakeBuffer()),
    isBoundedMasteringWavDecodeAvailable: vi.fn(() => true),
  };
});

vi.mock("../../src/mastering/fingerprintClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mastering/fingerprintClient")>();
  return { ...actual, fingerprintEncodedMasterAsync: vi.fn(async () => ({ status: "computed", hex: "a".repeat(64) })) };
});

vi.mock("../../src/mastering/analysisClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mastering/analysisClient")>();
  return {
    ...actual,
    analyzeMasterBufferAsync: vi.fn(async () => ({ measurements: { lufsIntegrated: -14, truePeakDb: -1 } })),
  };
});

const SESSION_ID = "audit-session";

async function seedSession() {
  const repository = new MasteringSessionRepository();
  await repository.put(
    createMasteringSessionRecord({
      id: SESSION_ID,
      fileName: "audit-session.wav",
      mimeType: "audio/wav",
      source: new NodeBlob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }) as unknown as Blob,
      sourceHash: "a".repeat(64),
      durationSeconds: SECONDS,
      channels: 2,
      sourceSampleRate: SR,
      sourceBitDepth: 24,
      masterConfig: testDoc().master,
      createdAt: "2026-10-07T12:00:00.000Z",
    }),
  );
  return repository;
}

/** Seed, render the real panel, open the session, and wait for the fields. */
async function openPanel() {
  const repository = await seedSession();
  renderWithContext(<MasteringFileSessionPanel />, { services: mockServices() });
  const picker = await screen.findByLabelText("Saved mastering sessions");
  await waitFor(() => expect((picker as HTMLSelectElement).options.length).toBeGreaterThan(1));
  fireEvent.change(picker, { target: { value: SESSION_ID } });
  await waitFor(() => expect(screen.getByLabelText(LUFS)).toBeInTheDocument(), { timeout: 10_000 });
  return repository;
}

async function dropSessions() {
  const repository = new MasteringSessionRepository();
  for (const session of await repository.list()) await repository.delete(session.id);
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("external-mastering delivery target fields", () => {
  it("an emptied TARGET LUFS field writes nothing (was: -5, a +9 dB jump)", async () => {
    try {
      await openPanel();
      expect(field(LUFS).value).toBe("-14");
      fireEvent.change(field(LUFS), { target: { value: "" } });
      fireEvent.blur(field(LUFS));
      // The stored -14 survives; the abandoned edit is a cancel.
      expect(field(LUFS).value).toBe("-14");
    } finally {
      await dropSessions();
    }
  });

  it("an emptied TRUE PEAK field writes nothing (was: 0 dBTP, ceiling disabled)", async () => {
    try {
      await openPanel();
      expect(field(TP).value).toBe("-1");
      fireEvent.change(field(TP), { target: { value: "" } });
      fireEvent.blur(field(TP));
      expect(field(TP).value).toBe("-1");
    } finally {
      await dropSessions();
    }
  });

  it("does NOT persist a clamped bound after an emptied field", async () => {
    // The end-to-end claim: "Apply settings" used to store the -5 / 0 that the
    // empty field produced. The session record must keep its real values.
    try {
      await openPanel();
      fireEvent.change(field(LUFS), { target: { value: "" } });
      fireEvent.blur(field(LUFS));
      const apply = screen.getByRole("button", { name: "Apply settings" }) as HTMLButtonElement;
      if (apply.disabled) {
        // Nothing dirtied the draft, so there is nothing to persist — the
        // outcome the fix guarantees.
        expect(apply.disabled).toBe(true);
        return;
      }
      await waitFor(() => expect(apply.disabled).toBe(false));
      fireEvent.click(apply);
      await waitFor(async () => {
        const repository = new MasteringSessionRepository();
        const record = (await repository.list()).find((s) => s.id === SESSION_ID);
        expect(record?.configRevision ?? 0).toBe(0);
      });
    } finally {
      await dropSessions();
    }
  });

  it("clamps a TARGET LUFS above the declared maximum", async () => {
    try {
      await openPanel();
      fireEvent.change(field(LUFS), { target: { value: "-1" } });
      fireEvent.blur(field(LUFS));
      expect(field(LUFS).value).toBe("-5");
    } finally {
      await dropSessions();
    }
  });

  it("clamps a TARGET LUFS below the declared minimum", async () => {
    try {
      await openPanel();
      fireEvent.change(field(LUFS), { target: { value: "-99" } });
      fireEvent.blur(field(LUFS));
      expect(field(LUFS).value).toBe("-30");
    } finally {
      await dropSessions();
    }
  });

  it("commits a valid in-range TARGET LUFS", async () => {
    try {
      await openPanel();
      fireEvent.change(field(LUFS), { target: { value: "-16" } });
      fireEvent.blur(field(LUFS));
      expect(field(LUFS).value).toBe("-16");
    } finally {
      await dropSessions();
    }
  });

  it("commits a valid in-range TRUE PEAK target", async () => {
    try {
      await openPanel();
      fireEvent.change(field(TP), { target: { value: "-2" } });
      fireEvent.blur(field(TP));
      expect(field(TP).value).toBe("-2");
    } finally {
      await dropSessions();
    }
  });

  it("keeps the typed digits visible instead of snapping back mid-typing", async () => {
    try {
      await openPanel();
      fireEvent.change(field(LUFS), { target: { value: "-1" } });
      // Still staged locally before the commit.
      expect(field(LUFS).value).toBe("-1");
    } finally {
      await dropSessions();
    }
  });

  it("exposes both fields with their declared numeric contract", async () => {
    try {
      await openPanel();
      expect(field(LUFS)).toHaveAttribute("type", "number");
      expect(Number(field(LUFS).getAttribute("min"))).toBe(-30);
      expect(Number(field(LUFS).getAttribute("max"))).toBe(-5);
      expect(Number(field(TP).getAttribute("min"))).toBe(-6);
      expect(Number(field(TP).getAttribute("max"))).toBe(0);
    } finally {
      await dropSessions();
    }
  });
});
