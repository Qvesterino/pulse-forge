import { expect, test } from "playwright/test";
import { clickPanelAction, completeOnboardingTourIfPresent } from "./_helpers";

test("MIDI clip move, resize, trim and Piano Roll gestures work in desktop browsers", async ({ page, browserName }) => {
  test.skip(
    browserName === "webkit",
    "Windows WebKit build has no Web Audio and KYX shows its unsupported-browser screen",
  );
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem("pf-onboarded", "1");
    localStorage.setItem("pf-intent-opened", "1");
  });
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".project-browser", { timeout: 60_000 });

  const fixture = await page.evaluate(async () => {
    const load = (specifier: string) => import(/* @vite-ignore */ specifier);
    const [templates, commands, schema, types, repository] = await Promise.all([
      load("/src/project-model/templates.ts"),
      load("/src/commands/commands.ts"),
      load("/src/project-model/schema.ts"),
      load("/src/project-model/types.ts"),
      load("/src/persistence/ProjectRepository.ts"),
    ]);
    const { createProjectFromTemplate } = templates;
    const { addMidiClip } = commands;
    const { createInstrumentTrackModel } = schema;
    const { BAR_TICKS } = types;
    const { ProjectRepository } = repository;
    const base = createProjectFromTemplate("empty");
    const instrument = createInstrumentTrackModel("808", 1);
    const project = {
      ...base,
      name: "Cross-browser MIDI gesture acceptance",
      tracks: [...base.tracks, instrument],
      arrangement: { ...base.arrangement, clips: [], audioClips: [], midiClips: [], automationClips: [] },
    };
    const first = addMidiClip(project, instrument.id, base.activePatternId, 0, BAR_TICKS).execute(project);
    const second = addMidiClip(first, instrument.id, base.activePatternId, 4 * BAR_TICKS, BAR_TICKS).execute(first);
    await new ProjectRepository().save(second);
    return { projectName: second.name };
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".project-browser", { timeout: 60_000 });
  await page.locator(".pb-row-name").filter({ hasText: fixture.projectName }).click();
  await page.waitForSelector(".btn-mode", { timeout: 120_000 });
  await completeOnboardingTourIfPresent(page);
  await page.locator(".btn-mode").click();
  await expect(page.locator(".btn-mode")).toHaveText("SONG");
  await clickPanelAction(page, "ARR");
  await page.locator(".arr-lane-scroll").scrollIntoViewIfNeeded();

  const movedFrom = page.getByRole("button", { name: /bar 5, shared source pattern used by 2 placements/ });
  await expect(movedFrom).toBeVisible();
  const moveBox = await movedFrom.boundingBox();
  expect(moveBox).not.toBeNull();
  if (!moveBox) throw new Error("MIDI move target has no visible bounds");
  const moveX = moveBox.x + moveBox.width / 2;
  const moveY = moveBox.y + moveBox.height / 2;
  await page.mouse.move(moveX, moveY);
  await page.mouse.down();
  await page.mouse.move(moveX + 30, moveY, { steps: 3 });
  await page.mouse.up();

  const movedClip = page.getByRole("button", { name: /bar 6, shared source pattern used by 2 placements/ });
  await expect(movedClip).toBeVisible();
  await expect(movedFrom).toHaveCount(0);

  const resizeBox = await movedClip.boundingBox();
  expect(resizeBox).not.toBeNull();
  if (!resizeBox) throw new Error("MIDI resize target has no visible bounds");
  const resizeX = resizeBox.x + resizeBox.width - 3;
  const resizeY = resizeBox.y + resizeBox.height / 2;
  await page.mouse.move(resizeX, resizeY);
  await page.mouse.down();
  await page.mouse.move(resizeX + 30, resizeY, { steps: 3 });
  await page.mouse.up();
  await expect(movedClip).toHaveAttribute("title", /3840 ticks/);

  const trimBox = await movedClip.boundingBox();
  expect(trimBox).not.toBeNull();
  if (!trimBox) throw new Error("MIDI trim target has no visible bounds");
  const trimX = trimBox.x + 3;
  const trimY = trimBox.y + trimBox.height / 2;
  await page.mouse.move(trimX, trimY);
  await page.mouse.down();
  await page.mouse.move(trimX + 30, trimY, { steps: 3 });
  await page.mouse.up();
  const trimmedClip = page.getByRole("button", { name: /bar 7, shared source pattern used by 2 placements/ });
  await expect(trimmedClip).toHaveAttribute("title", /1920 ticks/);
  await expect(movedClip).toHaveCount(0);

  await trimmedClip.dblclick();
  await expect(page.locator(".pianoroll-wrap.pr-fullscreen")).toBeVisible();
});
