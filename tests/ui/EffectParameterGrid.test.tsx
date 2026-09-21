/**
 * `EffectParameterGrid` is the parameter panel shared by every flagship effect
 * family. It decides between a `<select>` (when `options` is provided or
 * `kind === "toggle"`) and a `<Slider>` (continuous params), and falls back to
 * the param's `default` when the current value is missing or unknown.
 *
 * The interesting edge cases are:
 *  - empty `params` → empty render
 *  - missing value in `values` → falls back to `default`
 *  - value not in `options` → falls back to `default` (no crash, no `<option>`
 *    is left without its value being selectable)
 *  - toggle without explicit options → synthesises Off/On
 *  - `onChange` payload is `(paramId, Number(value))` — even when the value
 *    comes from a slider that yields floats
 */
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EffectParameterGrid } from "../../src/ui/EffectParameterGrid";
import { renderWithContext } from "../helpers";
import type { ParamDef } from "../../src/effects/types";

describe("EffectParameterGrid", () => {
  it("renders nothing for an empty params array", () => {
    const { container } = renderWithContext(
      <EffectParameterGrid family="tone" params={[]} values={{}} onChange={() => {}} paged={false} />,
    );
    // The wrapper div exists but contains no slider/select controls.
    expect(container.querySelector(".fx-device-params")).toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("renders a Slider for a continuous param", () => {
    const params: ParamDef[] = [{ id: "drive", label: "Drive", min: 0, max: 100, default: 50 }];
    renderWithContext(
      <EffectParameterGrid family="dynamics" params={params} values={{}} onChange={() => {}} paged={false} />,
    );
    expect(screen.getByRole("slider", { name: /Drive/ })).toBeInTheDocument();
  });

  it("renders a select for a toggle param even without explicit options", () => {
    // Toggle params without `options` get a synthesised Off/On pair.
    const params: ParamDef[] = [{ id: "active", label: "Bypass", min: 0, max: 1, default: 0, kind: "toggle" }];
    renderWithContext(
      <EffectParameterGrid family="tone" params={params} values={{}} onChange={() => {}} paged={false} />,
    );
    const select = screen.getByRole("combobox", { name: /Bypass/ });
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Off" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "On" })).toBeInTheDocument();
  });

  it("renders a select for a param with explicit options", () => {
    const params: ParamDef[] = [
      {
        id: "shape",
        label: "Shape",
        min: 0,
        max: 2,
        default: 0,
        options: [
          { value: 0, label: "Soft" },
          { value: 1, label: "Hard" },
          { value: 2, label: "Clip" },
        ],
      },
    ];
    renderWithContext(
      <EffectParameterGrid family="dynamics" params={params} values={{}} onChange={() => {}} paged={false} />,
    );
    expect(screen.getByRole("combobox", { name: /Shape/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Soft" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Hard" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Clip" })).toBeInTheDocument();
  });

  it("falls back to default when the value is missing from values map", () => {
    const params: ParamDef[] = [
      {
        id: "shape",
        label: "Shape",
        min: 0,
        max: 2,
        default: 1,
        options: [
          { value: 0, label: "Soft" },
          { value: 1, label: "Hard" },
          { value: 2, label: "Clip" },
        ],
      },
    ];
    renderWithContext(
      <EffectParameterGrid family="dynamics" params={params} values={{}} onChange={() => {}} paged={false} />,
    );
    const select = screen.getByRole("combobox", { name: /Shape/ }) as HTMLSelectElement;
    // No entry for `shape` → default (1) is shown as the active option.
    expect(select.value).toBe("1");
  });

  it("falls back to default when the value is not in the options list", () => {
    // A poisoned value (5) that no option matches must not crash and must not
    // select a non-existent option. Falling back to default keeps the UI sane
    // and is what the user expects when external state desyncs.
    const params: ParamDef[] = [
      {
        id: "shape",
        label: "Shape",
        min: 0,
        max: 2,
        default: 0,
        options: [
          { value: 0, label: "Soft" },
          { value: 1, label: "Hard" },
          { value: 2, label: "Clip" },
        ],
      },
    ];
    renderWithContext(
      <EffectParameterGrid family="dynamics" params={params} values={{ shape: 5 }} onChange={() => {}} paged={false} />,
    );
    const select = screen.getByRole("combobox", { name: /Shape/ }) as HTMLSelectElement;
    expect(select.value).toBe("0");
  });

  it("emits onChange with the param id and the numeric value", async () => {
    const onChange = vi.fn();
    const params: ParamDef[] = [
      {
        id: "shape",
        label: "Shape",
        min: 0,
        max: 2,
        default: 0,
        options: [
          { value: 0, label: "Soft" },
          { value: 1, label: "Hard" },
        ],
      },
    ];
    const user = userEvent.setup();
    renderWithContext(
      <EffectParameterGrid family="dynamics" params={params} values={{}} onChange={onChange} paged={false} />,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: /Shape/ }), "1");
    expect(onChange).toHaveBeenCalledWith("shape", 1);
  });

  it("renders the paged class when paged=true", () => {
    const params: ParamDef[] = [{ id: "drive", label: "Drive", min: 0, max: 100, default: 50 }];
    const { container } = renderWithContext(
      <EffectParameterGrid family="tone" params={params} values={{}} onChange={() => {}} paged />,
    );
    expect(container.querySelector(".fx-device-params.is-paged")).toBeInTheDocument();
  });

  it("omits the paged class when paged=false", () => {
    const params: ParamDef[] = [{ id: "drive", label: "Drive", min: 0, max: 100, default: 50 }];
    const { container } = renderWithContext(
      <EffectParameterGrid family="tone" params={params} values={{}} onChange={() => {}} paged={false} />,
    );
    const wrapper = container.querySelector(".fx-device-params");
    expect(wrapper).toBeInTheDocument();
    expect(wrapper?.classList.contains("is-paged")).toBe(false);
  });

  it("exposes the family via data-family for scoped CSS", () => {
    const params: ParamDef[] = [{ id: "drive", label: "Drive", min: 0, max: 100, default: 50 }];
    const { container } = renderWithContext(
      <EffectParameterGrid family="space" params={params} values={{}} onChange={() => {}} paged={false} />,
    );
    expect(container.querySelector('.fx-device-params[data-family="space"]')).toBeInTheDocument();
  });

  it("handles a mix of continuous and toggle params in the same grid", () => {
    const params: ParamDef[] = [
      { id: "drive", label: "Drive", min: 0, max: 100, default: 50 },
      { id: "active", label: "Bypass", min: 0, max: 1, default: 0, kind: "toggle" },
    ];
    renderWithContext(
      <EffectParameterGrid family="dynamics" params={params} values={{}} onChange={() => {}} paged={false} />,
    );
    expect(screen.getByRole("slider", { name: /Drive/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Bypass/ })).toBeInTheDocument();
  });
});