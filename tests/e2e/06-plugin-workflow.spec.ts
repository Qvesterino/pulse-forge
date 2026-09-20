import { expect, test } from "playwright/test";
import { clickPanelAction, openHouseTemplate } from "./_helpers";

test.describe("06 — plugin workflow", () => {
  test("PRISM insert, configure, bypass, undo/redo, and transport remain usable", async ({ page }) => {
    await openHouseTemplate(page);

    await test.step("insert and mount PRISM editor", async () => {
      await clickPanelAction(page, "FX");
      await expect(page.locator(".devices-panel")).toBeVisible();
      await page.locator(".devices-add-effect").first().selectOption("fxeq");
      await expect(page.locator(".fx-device").first()).toBeVisible();
      // The DEV dock intentionally hides rack collapse controls in its
      // device-editor mode; assert the actual plugin surface instead.
      await expect(page.locator('.fxeq-panel[aria-label="PRISM multiband editor"]')).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("configure sidechain, A/B snapshots, undo/redo, and morph", async () => {
      const source = page.locator(".fx-sidechain-picker select").first();
      await expect(source.locator('option:not([value=""])').first()).toBeAttached();
      await source.selectOption({ index: 1 });
      const selectedSource = await source.inputValue();
      expect(selectedSource).not.toBe("");

      const ab = page.locator(".fxeq-panel .effect-ab").first();
      await ab.locator('button:has-text("STORE")').click();
      await expect(ab.locator('button:has-text("A•")')).toBeVisible();

      const gain = page.locator('.fxeq-panel [role="slider"][aria-label="B1 GAIN"]').first();
      await ab.getByRole("button", { name: "B", exact: true }).click();
      const before = await gain.getAttribute("aria-valuenow");
      const box = await gain.boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error("PRISM gain control has no browser box");
      await gain.dispatchEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: box.x + box.width * 0.45,
        clientY: box.y + box.height / 2,
      });
      // Let React commit the drag state before moving, matching the real
      // pointer gesture used by the browser smoke test.
      await page.waitForTimeout(60);
      for (let i = 1; i <= 5; i += 1) {
        const ratio = 0.45 + (0.82 - 0.45) * (i / 5);
        await gain.dispatchEvent("pointermove", {
          button: 0,
          pointerId: 1,
          clientX: box.x + box.width * ratio,
          clientY: box.y + box.height / 2,
        });
      }
      await page.waitForTimeout(120);
      await gain.dispatchEvent("pointerup", {
        button: 0,
        pointerId: 1,
        clientX: box.x + box.width * 0.82,
        clientY: box.y + box.height / 2,
      });
      await expect.poll(() => gain.getAttribute("aria-valuenow")).not.toBe(before);
      const after = await gain.getAttribute("aria-valuenow");

      await ab.locator('button:has-text("STORE")').click();
      await expect(ab.locator('button:has-text("B•")')).toBeVisible();
      await page.locator('[aria-label="Undo PRISM parameter edit"]').first().click();
      await expect.poll(() => gain.getAttribute("aria-valuenow")).toBe(before);
      await page.locator('[aria-label="Redo PRISM parameter edit"]').first().click();
      await expect.poll(() => gain.getAttribute("aria-valuenow")).toBe(after);

      const morph = page.locator('input[aria-label="PRISM morph A to B"]').first();
      await expect(morph).toBeEnabled();
      const morphBefore = await morph.inputValue();
      await morph.focus();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => morph.inputValue()).not.toBe(morphBefore);
    });

    await test.step("bypass is undoable and transport still responds", async () => {
      await page.locator('button[title="Bypass effect"]').first().click();
      await expect(page.locator(".fx-device.bypassed").first()).toBeVisible();
      await page.keyboard.press("Control+z");
      await expect(page.locator(".fx-device:not(.bypassed)").first()).toBeVisible();

      await page.locator('button[title="Play / Pause (Space)"]').first().click();
      await page.waitForTimeout(250);
      await page.locator('button.btn-stop[title="Stop"]').first().click();
      await expect(page.locator('button[title="Play / Pause (Space)"]').first()).toBeVisible();
    });
  });
});
