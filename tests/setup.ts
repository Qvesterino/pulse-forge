import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(cb, 16) as unknown as number);
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

// jsdom does not implement pointer capture — stub it so pointer-event based
// components (PatternBar drag, PianoRoll, Slider, DragNumber, etc.) don't throw.
HTMLElement.prototype.setPointerCapture = vi.fn();
HTMLElement.prototype.releasePointerCapture = vi.fn();
