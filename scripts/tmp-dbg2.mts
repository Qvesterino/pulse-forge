import { parseReviseIntent } from "../src/intent/route";
import { parseComplaintIntent } from "../src/intent/complaints";
import { parseExactIntent } from "../src/intent/exact";
console.log("revise energetickejsie:", JSON.stringify(parseReviseIntent("energetickejsie")));
console.log("complaint nic:", JSON.stringify(parseComplaintIntent("nic sa nedeje v drope")));
console.log("complaint kick mrtvy:", JSON.stringify(parseComplaintIntent("kick je mrtvy")));
console.log("exact posun oktavu:", JSON.stringify(parseExactIntent("posun basu o oktavu nizsie"))?.slice(0, 200));
