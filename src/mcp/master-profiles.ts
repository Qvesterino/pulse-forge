/** Compatibility re-exports. The shared delivery contract lives in src/mastering. */
export {
  MASTER_PROFILES,
  CUSTOM_PROFILE,
  evaluateDelivery,
  isMasterProfileId,
  profileFor,
  resolveDeliveryTarget,
  verdictAgainst,
  worstStatus,
} from "../mastering/profiles";
export type { DeliveryCheck as PlatformVerdict, MasterProfile } from "../mastering/profiles";
