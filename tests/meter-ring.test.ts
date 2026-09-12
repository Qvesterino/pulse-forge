import { describe, expect, it } from "vitest";
import { MeterRing } from "../src/audio-engine/MeterRing";

function approxEqual(a: Float32Array, b: ArrayLike<number>, tol = 1e-6): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > tol) return false;
  }
  return true;
}

describe("MeterRing — ring buffer for the master meter pipeline", () => {
  it("push appends samples up to capacity and exposes them via lastN", () => {
    const ring = new MeterRing(16);
    expect(ring.length).toBe(0);
    expect(ring.capacity).toBe(16);

    ring.push(new Float32Array([1, 2, 3, 4, 5]));
    expect(ring.length).toBe(5);
    expect(approxEqual(ring.lastN(5), [1, 2, 3, 4, 5])).toBe(true);
    expect(approxEqual(ring.lastN(3), [3, 4, 5])).toBe(true);
    // Asking for more than size returns the full ring (no padding).
    expect(approxEqual(ring.lastN(100), [1, 2, 3, 4, 5])).toBe(true);
  });

  it("overwrites the oldest samples when capacity is exceeded (no splice, no alloc)", () => {
    const ring = new MeterRing(8);
    ring.push(new Float32Array([1, 2, 3, 4, 5]));
    ring.push(new Float32Array([6, 7, 8, 9, 10]));
    // After 10 samples pushed into capacity 8: only the last 8 are kept
    // in chronological order — [3, 4, 5, 6, 7, 8, 9, 10].
    expect(ring.length).toBe(8);
    expect(approxEqual(ring.lastN(8), [3, 4, 5, 6, 7, 8, 9, 10])).toBe(true);
    expect(approxEqual(ring.lastN(3), [8, 9, 10])).toBe(true);
  });

  it("handles a wrap-around push that spans the end of the backing buffer", () => {
    // Capacity 8, push 3 (length 3) → start=0, size=3.
    // Push 7 more → size=8, start=2, layout = [3,4,5,6,7,8,9,_] in
    // chronological order (the 2 oldest of the 10 pushed are dropped).
    // Push 5 more → size still 8, start=7 (wrapped): chronological
    // content = [_, _, _, _, _, _, _, 8, 9, 10, 11, 12] → last 8 are
    // [5, 6, 7, 8, 9, 10, 11, 12]. The lastN copy has to stitch across
    // the wrap boundary.
    const ring = new MeterRing(8);
    ring.push(new Float32Array([1, 2, 3]));
    ring.push(new Float32Array([4, 5, 6, 7, 8, 9, 10]));
    ring.push(new Float32Array([11, 12, 13, 14, 15]));
    expect(ring.length).toBe(8);
    expect(approxEqual(ring.lastN(8), [8, 9, 10, 11, 12, 13, 14, 15])).toBe(true);
    expect(approxEqual(ring.lastN(4), [12, 13, 14, 15])).toBe(true);
  });

  it("keeps only the trailing `capacity` samples when the input is bigger than the ring", () => {
    const ring = new MeterRing(4);
    ring.push(new Float32Array([1, 2, 3, 4, 5, 6, 7]));
    expect(ring.length).toBe(4);
    expect(approxEqual(ring.lastN(4), [4, 5, 6, 7])).toBe(true);
  });

  it("ignores empty pushes and lastN(0) returns an empty Float32Array", () => {
    const ring = new MeterRing(4);
    ring.push(new Float32Array(0));
    expect(ring.length).toBe(0);
    expect(ring.lastN(0).length).toBe(0);
    expect(ring.lastN(5).length).toBe(0);
  });

  it("reset clears the ring but keeps the backing buffer allocated", () => {
    const ring = new MeterRing(4);
    ring.push(new Float32Array([1, 2, 3]));
    expect(ring.length).toBe(3);
    const bufBefore = (ring as unknown as { buf: Float32Array }).buf;
    ring.reset();
    expect(ring.length).toBe(0);
    // Backing buffer is reused (no realloc).
    expect((ring as unknown as { buf: Float32Array }).buf).toBe(bufBefore);
    expect(ring.lastN(4).length).toBe(0);
    // After reset the ring is reusable — pushes start fresh.
    ring.push(new Float32Array([9, 8, 7]));
    expect(approxEqual(ring.lastN(3), [9, 8, 7])).toBe(true);
  });

  it("rejects invalid capacity", () => {
    expect(() => new MeterRing(0)).toThrow();
    expect(() => new MeterRing(-1)).toThrow();
    expect(() => new MeterRing(1.5)).toThrow();
    expect(() => new MeterRing(Number.NaN)).toThrow();
  });

  it("defends the production meter contract: 2048-sample chunks accumulate to exactly capacity over many pushes", () => {
    // Real production shape: 2048-sample chunks pushed into a ring sized
    // for 3.2 s at 96 kHz (307 200 capacity). After 150 pushes we expect
    // length = min(150 * 2048, 307200) = 300 000; the trailing 2 048
    // samples should match the last pushed chunk.
    const ring = new MeterRing(307200);
    const chunk = new Float32Array(2048);
    for (let i = 0; i < chunk.length; i++) chunk[i] = i;
    for (let i = 0; i < 150; i++) ring.push(chunk);
    expect(ring.length).toBe(150 * 2048);
    const tail = ring.lastN(2048);
    expect(tail.length).toBe(2048);
    expect(approxEqual(tail, chunk)).toBe(true);
  });
});
