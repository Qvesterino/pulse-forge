import { describe, it } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { testDoc } from "./fixtures/doc";

const CASES = [
  "stop",
  "undo that",
  "how loud is the mix",
  "the lead is harsh",
  "the bass is quieter than the lead",
  "much faster compressor attack on the drums",
  "lower filter cutoff on the lead",
  "set compressor attack to 5 ms on the drums",
  "even less reverb on the bass",
  "lower the drums by 2 db",
  "turn down the bass",
  "more reverb on the pads",
  "make the bass warmer",
  "make the mix brighter",
  "set tempo to 140",
  "tempo 140",
  "make it 140 bpm",
  "shorten the intro to 2 bars",
  "mute the drums",
  "select the bass",
  "more reverb send on the lead",
  "bypass the delay on the lead",
  "set the drop intensity to 80%",
  "make the reverb tail a little longer",
  "a beat that is dark and warm",
  "make a beat that is dark and warm",
  "more swing on the drums",
  "automate the bass volume",
  "add a marker at bar 8",
];

describe("probe", () => {
  it("prints precedence winners", () => {
    const house = testDoc();
    const scene = createProjectFromTemplate("scene-score");
    for (const text of CASES) {
      const route = routeIntentText(text, house);
      const routeScene = routeIntentText(text, scene);
      console.log(`${text} => ${route.kind} | scene:${routeScene.kind}`);
    }
  });
});
