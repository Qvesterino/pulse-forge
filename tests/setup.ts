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
// Guarded: specs that opt into `@vitest-environment node` (SDK/HTTP wire
// tests) have no DOM globals at all.
if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
}

// jsdom does not implement blob object URLs; the export paths (and any
// downloadBlob user) need them to reach the download step in tests. The
// revoke is a tracked no-op — production revokes on a 5 s safety timer
// (AGENTS.md gotcha), which has no meaning for a fake URL.
if (typeof URL !== "undefined" && typeof URL.createObjectURL !== "function") {
  let blobCounter = 0;
  URL.createObjectURL = (obj: Blob | MediaSource) => `blob:jsdom-${++blobCounter}-${obj?.size ?? 0}`;
  URL.revokeObjectURL = () => {};
}

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
