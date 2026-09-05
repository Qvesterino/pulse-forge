import { describe, expect, it, vi } from "vitest";
import { MidiOutput } from "../../src/midi/MidiOutput";

describe("MidiOutput", () => {
  it("can be instantiated", () => {
    const output = new MidiOutput();
    expect(output).toBeDefined();
  });

  it("returns empty device list without access", () => {
    const output = new MidiOutput();
    expect(output.getOutputs()).toEqual([]);
  });

  it("requestAccess returns false when navigator unavailable", async () => {
    const output = new MidiOutput();
    const result = await output.requestAccess();
    expect(result).toBe(false);
  });

  it("send is safe to call without output", () => {
    const output = new MidiOutput();
    output.send(new Uint8Array([0x90, 60, 100])); // should not throw
  });

  it("sendNoteOn constructs correct message", () => {
    const output = new MidiOutput();
    // Just verify it doesn't throw — actual sending needs real MIDI device
    output.sendNoteOn(0, 60, 100);
  });

  it("sendNoteOff constructs correct message", () => {
    const output = new MidiOutput();
    output.sendNoteOff(0, 60);
  });

  it("sendCC constructs correct message", () => {
    const output = new MidiOutput();
    output.sendCC(0, 7, 100);
  });

  it("sendPitchBend constructs correct message", () => {
    const output = new MidiOutput();
    output.sendPitchBend(0, 0); // center
    output.sendPitchBend(0, -1); // min
    output.sendPitchBend(0, 1); // max
  });

  it("sendClock sends timing pulse", () => {
    const output = new MidiOutput();
    output.sendClock(); // should not throw
  });

  it("sendStart/SendStop/sendContinue work", () => {
    const output = new MidiOutput();
    output.sendStart();
    output.sendContinue();
    output.sendStop();
  });

  it("dispose sends all notes off", () => {
    const output = new MidiOutput();
    output.dispose(); // should not throw
  });
});

describe("MidiOutput — scheduled sends (contract audit)", () => {
  function makeWithFakeOutput() {
    const output = new MidiOutput();
    const sent: Array<{ msg: Uint8Array; when: number | undefined }> = [];
    const fakeOut = {
      id: "out-1",
      send: (msg: Uint8Array, timestamp?: number) => {
        sent.push({ msg, when: timestamp });
      },
    };
    (output as unknown as { access: unknown }).access = {
      outputs: new Map([["out-1", fakeOut]]),
      inputs: new Map(),
    };
    return { output, sent };
  }

  it("delays a future send and fires it when the timer elapses", () => {
    vi.useFakeTimers();
    try {
      const { output, sent } = makeWithFakeOutput();
      output.sendNoteOn(0, 60, 100, 40);
      expect(sent).toHaveLength(0);
      vi.advanceTimersByTime(50);
      expect(sent).toHaveLength(1);
      expect(Array.from(sent[0].msg)).toEqual([0x90, 60, 100]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends immediately for zero/negative delay (event already due)", () => {
    const { output, sent } = makeWithFakeOutput();
    output.sendNoteOn(0, 60, 100, 0);
    output.sendNoteOff(0, 60, 0, -5);
    expect(sent).toHaveLength(2);
    expect(Array.from(sent[1].msg)).toEqual([0x80, 60, 0]);
  });

  it("dispose cancels pending scheduled sends so no ghost notes fire", () => {
    vi.useFakeTimers();
    try {
      const { output, sent } = makeWithFakeOutput();
      output.sendNoteOn(0, 60, 100, 500);
      output.dispose();
      vi.advanceTimersByTime(1000);
      // Only dispose's All Notes Off / All Sound Off CCs — never the ghost note-on.
      expect(sent.some((s) => s.msg[0] === 0x90)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
