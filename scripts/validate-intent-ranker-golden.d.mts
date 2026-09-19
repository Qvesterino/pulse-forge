export interface GoldenValidationResult {
  errors: string[];
  matchedGroups: number;
  matchedCandidates: number;
}

export function validateGoldenPreferences(
  golden: unknown,
  groups: Array<{ groupKey: string; candidates: Array<{ index: number }> }>,
): GoldenValidationResult;
