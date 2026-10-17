import { describe, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { ArrangementPanel } from "../src/ui/ArrangementPanel";
import { ProjectStore } from "../src/store/ProjectStore";
import { SelectionStore } from "../src/store/SelectionStore";
import { ServicesContext, SelectionContext } from "../src/ui/context";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addArrangementClip, deleteArrangementClip } from "../src/commands/commands";
import { mockServices } from "./helpers";
import type { Services } from "../src/services";

/**
 * Scratch DOM census — MEASURE step for D (virtualization).
 * Counts rendered elements for N scene clips across B bars.
 */

describe("arrangement DOM census (scratch)", () => {
  it("counts elements for 26 / 104 / 520 clips", () => {
    for (const clips of [26, 104, 520]) {
      let doc = createProjectFromTemplate("house");
      for (const c of [...doc.arrangement.clips]) doc = deleteArrangementClip(doc, c.id).execute(doc);
      const sceneId = doc.scenes[0]!.id;
      const step = clips === 520 ? 4 : Math.max(4, Math.ceil(1024 / clips));
      for (let i = 0; i < clips; i += 1) {
        doc = addArrangementClip(doc, sceneId, i * step, 4).execute(doc);
      }
      const project = new ProjectStore(doc);
      const services = { ...mockServices(doc), store: project } as unknown as Services;
      const selection = new SelectionStore();
      const t0 = process.hrtime.bigint();
      const utils = render(
        createElement(
          ServicesContext.Provider,
          { value: services },
          createElement(SelectionContext.Provider, { value: selection }, createElement(ArrangementPanel)),
        ),
      );
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const total = utils.container.querySelectorAll("*").length;
      const clipEls = utils.container.querySelectorAll(".arr-clip").length;
      const barEls = utils.container.querySelectorAll(".arr-bar").length;
      const gridCells = utils.container.querySelectorAll(".arr-grid-cell, .arr-lane-cell").length;
      console.log(
        `[dom-census] clips=${clips} elements=${total} clipEls=${clipEls} barEls=${barEls} cells=${gridCells} ms=${ms.toFixed(0)}`,
      );
      utils.unmount();
      cleanup();
    }
  });
});
