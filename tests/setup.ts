import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { vi } from "vitest";

// Full-suite runs execute many workers in parallel on shared cores, and the
// 1 s default waitFor/findBy budget intermittently expires while the event
// loop is starved — several distinct tests have flaked this way while always
// passing in isolation (midi-io import, GalleryPage report). 5 s keeps a
// single-test iteration snappy while making the parallel suite stable;
// per-test `{ timeout }` overrides still take precedence.
configure({ asyncUtilTimeout: 5000 });

vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(cb, 16) as unknown as number);
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

// jsdom does not implement pointer capture — stub it so pointer-event based
// components (PatternBar drag, PianoRoll, Slider, DragNumber, etc.) don't throw.
HTMLElement.prototype.setPointerCapture = vi.fn();
HTMLElement.prototype.releasePointerCapture = vi.fn();

// react-window v2 uses ResizeObserver which jsdom doesn't provide.
if (typeof globalThis.ResizeObserver === "undefined") {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}
