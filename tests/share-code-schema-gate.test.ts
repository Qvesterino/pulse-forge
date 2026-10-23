import { describe, expect, it } from "vitest";
import { decodeShareCode, encodeShareCode } from "../src/export/shareCode";
import { SCHEMA_VERSION } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * A SHARE LINK USES THE SAME SCHEMA GATE AS A FILE.
 *
 * Two import routes read the same document. The file route
 * (`src/export/project-io.ts`) has always used `migrateProject`, which
 * refuses a document from a NEWER build and stamps the version back. The
 * share route used `normalizeProject`, which does neither: it only checked
 * the SHAPE.
 *
 * The consequence was not a cosmetic difference. A share link from a newer
 * build opened in an older client, was persisted with the future
 * `schemaVersion`, and the project then VANISHED from the library on the next
 * boot: `repo.load` migrates, the version gate throws, and the project is not
 * listed any more (it only shows up under "incompatible").
 *
 * The test drives the real encoder and decoder — the share code is the
 * transport, so the version is in the payload.
 */

const house = (): ProjectDocument => createProjectFromTemplate("house");

describe("the share route uses the schema gate", () => {
  it("a document from a NEWER build is refused", () => {
    const doc = { ...house(), schemaVersion: SCHEMA_VERSION + 1 };
    const decoded = decodeShareCode(encodeShareCode(doc));
    expect(decoded, "a share link from a newer build must not open").toBeNull();
  });

  it("an OLDER document is migrated and stamped with the current version", () => {
    const doc = { ...house(), schemaVersion: SCHEMA_VERSION - 5 };
    const decoded = decodeShareCode(encodeShareCode(doc));
    expect(decoded, "an older share link must still open").not.toBeNull();
    expect(decoded!.schemaVersion, "the opened document must carry the current schema version").toBe(
      SCHEMA_VERSION,
    );
  });

  it("a current document round-trips", () => {
    const doc = house();
    const decoded = decodeShareCode(encodeShareCode(doc));
    expect(decoded).not.toBeNull();
    expect(decoded!.schemaVersion).toBe(SCHEMA_VERSION);
  });
});
