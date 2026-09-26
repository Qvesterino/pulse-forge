import { readFileSync } from "node:fs";
import { buildFamilies } from "./tests/domain-goldens/harness";

const families = buildFamilies([]);
for (const family of families) {
  const committed = JSON.parse(readFileSync(`tests/domain-goldens/${family.file}`, "utf8"));
  if (family.cases.length !== committed.cases.length) {
    console.log(`COUNT MISMATCH ${family.file}: computed ${family.cases.length} vs committed ${committed.cases.length}`);
    const computedNames = family.cases.map((c) => c.name);
    const committedNames = committed.cases.map((c) => c.name);
    for (let i = 0; i < Math.max(computedNames.length, committedNames.length); i++) {
      if (computedNames[i] !== committedNames[i]) {
        console.log(`  first name diff at ${i}:`);
        console.log("   computed:", computedNames[i]);
        console.log("   committed:", committedNames[i]);
        break;
      }
    }
    continue;
  }
  for (let i = 0; i < family.cases.length; i++) {
    if (JSON.stringify(family.cases[i]) !== JSON.stringify(committed.cases[i])) {
      console.log(`CASE DIFF ${family.file}[${i}]: ${family.cases[i].name}`);
      break;
    }
  }
}
