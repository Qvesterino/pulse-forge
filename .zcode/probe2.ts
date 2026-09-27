import { artistMixProfileFromDeep, normalizeArtistSlug, getArtistProfile } from "./src/intent/artist-profiles";
import { deepProfileToArtistMix } from "./src/intent/artist-profiles";
console.log("slug:", normalizeArtistSlug("metro boomin"));
const p = getArtistProfile("metro-boomin");
console.log("profile?", !!p);
console.log("tonalBalance:", p?.master.tonalBalance);
console.log("derived:", JSON.stringify(deepProfileToArtistMix(p!)));
console.log("fromDeep:", JSON.stringify(artistMixProfileFromDeep("metro boomin")));
