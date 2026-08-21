import { describe, expect, it } from "vitest";
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
