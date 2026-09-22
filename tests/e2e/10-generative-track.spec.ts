import { test, expect } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

test.describe("10 — MRT2 generative track", () => {
  test("adds the track and exposes the safe localhost companion surface", async ({ page }) => {
    await openHouseTemplate(page);

    await page.locator('select[aria-label="Add track"]').selectOption("generative");

    const generativeTab = page.getByRole("tab", { name: /Generative 1 \(Generative track\)/ });
    await expect(generativeTab).toBeVisible();
    await generativeTab.click();

    await expect(page.getByRole("heading", { name: "MRT2 GENERATIVE" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "LOCAL MRT2 COMPANION" })).toBeVisible();
    await expect(page.getByText(/LIVE · UNAVAILABLE/)).toBeVisible();
    await expect(page.getByText(/Provider does not support realtime playback/)).toBeVisible();
    await expect(page.locator('input[placeholder="ws://127.0.0.1:8765"]')).toHaveValue("ws://127.0.0.1:8765");

    // The first browser session has no native MRT2 host. The UI must expose
    // that state without attempting to connect or leaking a remote endpoint.
    await expect(page.getByText("mrt2 / mrt2_small")).toBeVisible();
  });
});
