import type { DeviceState } from "../project-model/types";

export interface EffectAbState {
  slots: { A?: Record<string, number>; B?: Record<string, number> };
  active: "A" | "B";
}

function readState(deviceState?: DeviceState): EffectAbState {
  if (
    deviceState?.kind !== "effect-ab-v1" ||
    typeof deviceState.data !== "object" ||
    deviceState.data === null ||
    Array.isArray(deviceState.data)
  ) {
    return { slots: {}, active: "A" };
  }
  const raw = deviceState.data as { slots?: unknown; active?: unknown };
  const slots: EffectAbState["slots"] = {};
  if (typeof raw.slots === "object" && raw.slots !== null && !Array.isArray(raw.slots)) {
    for (const slot of ["A", "B"] as const) {
      const candidate = (raw.slots as Record<string, unknown>)[slot];
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
      const clean: Record<string, number> = {};
      for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
      }
      if (Object.keys(clean).length > 0) slots[slot] = clean;
    }
  }
  // The active slot may intentionally be empty while the user is preparing
  // a second variation. Only recall requires a stored snapshot.
  const active = raw.active === "B" ? "B" : "A";
  return { slots, active };
}

/** Small, plugin-neutral A/B controller for flagship effect snapshots. */
export function EffectAbControls({
  effectName,
  params,
  deviceState,
  onStateChange,
  onLoad,
}: {
  effectName: string;
  params: Record<string, number>;
  deviceState?: DeviceState;
  onStateChange: (state: EffectAbState) => void;
  onLoad: (slot: "A" | "B") => void;
}) {
  const state = readState(deviceState);
  const slots = state.slots;

  const store = (slot: "A" | "B") => onStateChange({ ...state, slots: { ...slots, [slot]: { ...params } } });
  const clear = (slot: "A" | "B") => {
    const nextSlots = { ...slots };
    delete nextSlots[slot];
    onStateChange({ ...state, slots: nextSlots });
  };
  const copy = (from: "A" | "B", to: "A" | "B") => {
    if (!slots[from]) return;
    onStateChange({ ...state, slots: { ...slots, [to]: { ...slots[from] } } });
  };
  const load = (slot: "A" | "B") => {
    if (slot === state.active) return;
    if (!slots[slot]) {
      onStateChange({ ...state, active: slot });
      return;
    }
    onLoad(slot);
  };

  return (
    <div className="effect-ab" aria-label={effectName + " A/B compare"}>
      <div className="effect-ab-label">A/B</div>
      {(["A", "B"] as const).map((slot) => (
        <button
          key={slot}
          type="button"
          className={"btn btn-small" + (state.active === slot ? " active" : "")}
          aria-pressed={state.active === slot}
          title={slots[slot] ? "Load slot " + slot : "Slot " + slot + " (empty — use STORE)"}
          onClick={() => load(slot)}
        >
          {slot}
          {slots[slot] ? "•" : ""}
        </button>
      ))}
      <button
        type="button"
        className="btn btn-small"
        title={"Store current " + effectName + " settings in slot " + state.active}
        onClick={() => store(state.active)}
      >
        STORE
      </button>
      <button
        type="button"
        className="btn btn-small"
        title="Copy slot A to slot B"
        aria-label="Copy A to B"
        disabled={!slots.A}
        onClick={() => copy("A", "B")}
      >
        A → B
      </button>
      <button
        type="button"
        className="btn btn-small"
        title="Copy slot B to slot A"
        aria-label="Copy B to A"
        disabled={!slots.B}
        onClick={() => copy("B", "A")}
      >
        B → A
      </button>
      <button
        type="button"
        className="btn btn-small btn-danger"
        title={"Clear slot " + state.active}
        aria-label={"Clear slot " + state.active}
        disabled={!slots[state.active]}
        onClick={() => clear(state.active)}
      >
        CLEAR
      </button>
      <span className="effect-ab-status" role="status">
        {state.active} ACTIVE · {slots[state.active] ? "STORED" : "EMPTY"}
      </span>
    </div>
  );
}
