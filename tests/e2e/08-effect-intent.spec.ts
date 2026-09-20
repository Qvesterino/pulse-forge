import { expect, test } from "playwright/test";
import { clickPanelAction, openHouseTemplate } from "./_helpers";

test.describe("08 — Effect Intent Engine", () => {
  test("offline proposal audition, apply, undo/redo, and project reload", async ({ page }) => {
    await openHouseTemplate(page);
    await clickPanelAction(page, "FX");

    await page.locator(".devices-add-effect").first().selectOption("reverb");
    const reverb = page.locator(".fx-device").filter({ hasText: "Reverb" }).first();
    await expect(reverb).toBeVisible();
    const decay = reverb.getByRole("slider", { name: "DECAY" });
    const controlPages = reverb.getByRole("group", { name: "Reverb parameter pages" });
    await controlPages.getByRole("button", { name: "Next control page" }).click();
    const mix = reverb.getByRole("slider", { name: "MIX" });
    const beforeMix = await mix.getAttribute("aria-valuenow");
    expect(beforeMix).not.toBeNull();
    await controlPages.getByRole("button", { name: "Previous control page" }).click();
    const before = await decay.getAttribute("aria-valuenow");
    expect(before).not.toBeNull();

    // A user gesture builds/resumes the real browser audio graph before the
    // context goes offline, so this proves the local-only workflow rather than
    // accidentally depending on lazy network-loaded audio assets.
    await page.locator('button[title="Play / Pause (Space)"]').first().click();
    await expect(page.locator('button.btn-stop[title="Stop"]').first()).toBeVisible();
    await page.waitForTimeout(250);
    await page.locator('button.btn-stop[title="Stop"]').first().click();
    await page.context().setOffline(true);

    await reverb.getByRole("button", { name: /Ask FX/ }).click();
    await page.getByLabel("Čo chceš zmeniť?").fill("more space");
    await page.getByRole("button", { name: "Navrhnúť zmenu" }).click();
    await expect(reverb.locator(".effect-intent-summary")).toHaveText("Reverb: viac priestoru");
    await expect(reverb.getByRole("button", { name: "Apply zmeny" })).toBeVisible();

    const intensity = reverb.getByRole("slider", { name: "Intenzita návrhu" });
    await intensity.focus();
    await intensity.press("End");
    await expect(reverb.getByText("100 %", { exact: true })).toBeVisible();
    await reverb.getByRole("checkbox", { name: "Zahrnúť MIX" }).uncheck();

    await reverb.getByRole("button", { name: "Vypočuť" }).click();
    await expect(reverb.getByRole("button", { name: "Zastaviť preview" })).toBeVisible();
    await expect(decay).toHaveAttribute("aria-valuenow", before!);
    await reverb.getByRole("button", { name: "Zastaviť preview" }).click();
    await expect(decay).toHaveAttribute("aria-valuenow", before!);
    await controlPages.getByRole("button", { name: "Next control page" }).click();
    await expect(mix).toHaveAttribute("aria-valuenow", beforeMix!);
    await controlPages.getByRole("button", { name: "Previous control page" }).click();

    await reverb.getByRole("button", { name: "Apply zmeny" }).click();
    await expect.poll(() => decay.getAttribute("aria-valuenow")).not.toBe(before);
    await controlPages.getByRole("button", { name: "Next control page" }).click();
    await expect(mix).toHaveAttribute("aria-valuenow", beforeMix!);
    await controlPages.getByRole("button", { name: "Previous control page" }).click();
    const applied = await decay.getAttribute("aria-valuenow");
    await expect(page.locator(".command-toast")).toContainText("FX intent");
    await expect(page.locator('button[aria-label="Undo"]')).toBeEnabled();

    await page.locator('button[aria-label="Undo"]').click();
    await expect(decay).toHaveAttribute("aria-valuenow", before!);
    await controlPages.getByRole("button", { name: "Next control page" }).click();
    await expect(mix).toHaveAttribute("aria-valuenow", beforeMix!);
    await controlPages.getByRole("button", { name: "Previous control page" }).click();
    await page.locator('button[aria-label="Redo"]').click();
    await expect(decay).toHaveAttribute("aria-valuenow", applied!);
    await controlPages.getByRole("button", { name: "Next control page" }).click();
    await expect(mix).toHaveAttribute("aria-valuenow", beforeMix!);
    await controlPages.getByRole("button", { name: "Previous control page" }).click();

    await page.context().setOffline(false);
    await page.waitForTimeout(300);
    await page.waitForTimeout(1500); // let local autosave settle before reload
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(page.locator(".project-browser")).toBeVisible({ timeout: 30_000 });
    const continueCard = page.locator(".pb-continue-card").first();
    if (await continueCard.count()) await continueCard.click();
    else await page.locator('.pb-row button:has-text("OPEN")').first().click();
    await expect(page.locator(".sequencer")).toBeVisible({ timeout: 30_000 });
    const devicePanel = page.locator(".devices-panel");
    if (!(await devicePanel.isVisible().catch(() => false))) await clickPanelAction(page, "FX");
    await expect(devicePanel).toBeVisible();
    await expect(page.locator(".fx-device").filter({ hasText: "Reverb" }).first()).toBeVisible();
    await expect(page.locator(".fx-device").filter({ hasText: "Reverb" }).first().getByRole("slider", { name: "DECAY" })).toHaveAttribute(
      "aria-valuenow",
      applied!,
    );
  });

  test("EQ brightness mapping remains available in a fresh offline project", async ({ page }) => {
    await openHouseTemplate(page);
    await clickPanelAction(page, "FX");
    await page.context().setOffline(true);
    await page.locator(".devices-add-effect").first().selectOption("eq");

    const eq = page.locator(".fx-device").last();
    await expect(eq).toBeVisible();
    await eq.getByRole("button", { name: /Ask FX/ }).click();
    await expect(eq.getByLabel("Čo chceš zmeniť?")).toBeVisible();
    await eq.getByLabel("Čo chceš zmeniť?").fill("brighter");
    await eq.getByRole("button", { name: "Navrhnúť zmenu" }).click();

    await expect(eq.locator(".effect-intent-summary")).toHaveText("EQ: jasnejšie");
    await expect(eq.locator(".effect-intent-change strong")).toHaveText("HIGH SHELF");
    await expect(eq.getByRole("button", { name: "Apply zmeny" })).toBeVisible();
  });
});
