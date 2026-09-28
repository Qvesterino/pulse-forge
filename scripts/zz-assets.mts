import { FACTORY_ASSETS } from "../src/sample-library/manifest";
const prefixes = ["factory.kick","factory.snare","factory.hat","factory.clap","factory.rim","factory.perc","factory.tom","factory.shaker","factory.ride","factory.wood","factory.cowbell","factory.piano","factory.marimba","factory.steel","factory.brass","factory.strings","factory.accordion","factory.trumpet"];
for (const p of prefixes) {
  const ids = FACTORY_ASSETS.filter((a) => a.id.startsWith(p)).map((a)=>a.id);
  if (ids.length) console.log(p + ": " + ids.join(", "));
}
