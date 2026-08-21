import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(cb, 16) as unknown as number);
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
