import { parsePresetIntent } from "../src/intent/preset-intent";
for (const t of ["load the trance preset on the lead", "načítaj preset techno na leade", "load preset trance", "load preset zz-never-exists"]) {
  let r: unknown;
  try {
    r = parsePresetIntent(t);
  } catch (e) {
    r = `THREW: ${(e as Error).message}`;
  }
  console.log(JSON.stringify(t), "→", typeof r === "object" ? JSON.stringify(r)?.slice(0, 140) : r);
}
