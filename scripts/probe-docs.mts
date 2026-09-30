import { createProjectFromTemplate } from "../src/project-model/templates";
const house = createProjectFromTemplate("house");
console.log("house scenes:", house.scenes.map((s) => `${s.name}/${s.role ?? "-"}/${s.id}`).join("  "));
console.log("house clips:", house.arrangement.clips.map((c) => `${c.id}@${c.startBar}+${c.lengthBars}`).join("  "));
