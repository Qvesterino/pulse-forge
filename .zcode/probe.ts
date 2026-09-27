import { artistMixProfileFromDeep, normalizeArtistSlug, getArtistProfile } from "./src/intent/artist-profiles";
console.log("slug:", normalizeArtistSlug("travis scott"));
console.log("profile?", !!getArtistProfile(normalizeArtistSlug("travis scott")));
console.log("derived:", JSON.stringify(artistMixProfileFromDeep("travis scott")));
