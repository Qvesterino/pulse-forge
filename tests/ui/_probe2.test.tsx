import { useLayoutEffect, useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

interface Snapshot {
  when: string;
  connected: boolean;
  rootInDom: boolean;
}

/**
 * At the instant the overlay's autoFocus input receives focus: is the element
 * in the document, and is the overlay root already in the document (findable
 * by a data attribute)? A layout effect reports separately, after the commit,
 * whether the `ref` prop has been assigned by then.
 *
 * The answer decides whether an "is this focus inside the overlay" check can
 * rely on `useRef` (attached via the `ref` prop) or must not.
 */
function Harness({ log }: { log: (s: Snapshot) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (ref.current) log({ when: "layout-effect(ref attached)", connected: ref.current.isConnected, rootInDom: true });
  });
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        trigger
      </button>
      {open && (
        <div role="dialog" aria-label="probe" ref={ref} data-probe-root="1">
          <input aria-label="inner" autoFocus />
        </div>
      )}
    </div>
  );
}

describe("probe: autoFocus vs ref attach vs DOM attach ordering", () => {
  it("reports what is observable at autoFocus time", async () => {
    const seen: Snapshot[] = [];
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      seen.push({
        when: `focusin:${el.tagName}`,
        connected: el.isConnected,
        rootInDom: Boolean(document.querySelector("[data-probe-root]")),
      });
    };
    document.addEventListener("focusin", onFocusIn);

    render(<Harness log={(s) => seen.push(s)} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "trigger" }));

    console.log("SNAPSHOTS:", JSON.stringify(seen, null, 1));
    document.removeEventListener("focusin", onFocusIn);
    expect(seen.length).toBeGreaterThan(0);
  });
});
