import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5296;
const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.goto(`http://127.0.0.1:${PORT}/studio`, { waitUntil: "domcontentloaded", timeout: 240_000 });
  await page.addScriptTag({
    type: "module",
    content: `
      (async () => {
        try {
          const { createCoreServices, openProject } = await import("/src/services.ts");
          const { createProjectFromTemplate } = await import("/src/project-model/templates.ts");
          const { addMarker } = await import("/src/commands/markers.ts");
          const { flushServicesSave, listSavedProjects, saveProjectAsCopy } = await import("/src/mcp/save-now.ts");
          const core = await createCoreServices();
          const services = await openProject(core, createProjectFromTemplate("house"));
          const doc = services.store.doc;
          const before = doc.markers.length;
          services.store.execute(addMarker(doc, { tick: 0, name: "save-probe" }));
          const saved = await flushServicesSave(services);
          const reloaded = await services.repo.load(doc.id);
          const after = reloaded?.markers.length ?? -1;
          const currentId = doc.id;
          const copy = await saveProjectAsCopy(services, "save-probe copy");
          const copyDoc = copy.projectId ? await services.repo.load(copy.projectId) : null;
          const listed = await listSavedProjects(services);
          await services.closeProject();
          window.__saveProbe = {
            saved,
            before,
            after,
            expected: before + 1,
            copy,
            copyName: copyDoc?.name ?? null,
            currentId,
            listedCurrent: listed.some((project) => project.id === currentId),
            listedCopy: copy.projectId != null && listed.some((project) => project.id === copy.projectId),
          };
        } catch (error) {
          window.__saveProbe = { error: error instanceof Error ? error.stack ?? error.message : String(error) };
        }
      })();
    `,
  });
  await page.waitForFunction(() => window.__saveProbe != null, null, { timeout: 300_000 });
  const result = await page.evaluate(() => window.__saveProbe);
  console.log(JSON.stringify(result, null, 2));
  if (
    !result.saved?.ok ||
    result.after !== result.expected ||
    !result.copy?.ok ||
    result.copyName !== "save-probe copy" ||
    !result.listedCurrent ||
    !result.listedCopy
  ) {
    console.error("[mcp-save-browser] FAIL");
    process.exitCode = 1;
  } else {
    console.log("[mcp-save-browser] PASS — kyx_save flush + save-as copy reached IndexedDB");
  }
} finally {
  await browser.close();
  await server.close();
}
