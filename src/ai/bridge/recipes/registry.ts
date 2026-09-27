/**
 * Recipe registry — the single source of truth for "what can the bridge do".
 *
 * Lookup order:
 *   1. Exact intentPattern match against the user's normalised prompt.
 *   2. First-match-wins (recipes are listed most-specific first).
 *
 * Future recipes (drums more aggressive, pop template, Daron Malakian guitar,
 * …) plug in here without touching the executor or the mockProvider.
 */

import type { Recipe } from "../types";
import { snaresVsHatesRecipe } from "./snaresVsHates";
import { punchierDrumsRecipe } from "./punchierDrums";
import { spaciousBassRecipe } from "./spaciousBass";

export const RECIPES: readonly Recipe[] = [snaresVsHatesRecipe, punchierDrumsRecipe, spaciousBassRecipe];

/**
 * Match a (normalised, lowercased) user prompt against the recipe set.
 * Returns the first recipe whose intentPatterns include a regex that matches.
 *
 * @returns the matched recipe, or null if nothing fits. The mockProvider
 *          turns a `null` match into a `no-recipe-match` BridgeExecutionError
 *          so the UI can show "I don't know how to do that yet" instead of
 *          silently swallowing the request.
 */
export function findRecipe(prompt: string): Recipe | null {
  const normalised = prompt.toLowerCase().trim();
  if (!normalised) return null;

  for (const recipe of RECIPES) {
    for (const pattern of recipe.intentPatterns) {
      // Intent patterns are simple regexes — escape if a future recipe wants
      // literal matching.
      const re = new RegExp(pattern, "i");
      if (re.test(normalised)) return recipe;
    }
  }
  return null;
}

/**
 * Direct ID lookup for tests and for the UI's "Apply previous suggestion"
 * shortcut (which knows the recipeId it wants to re-run).
 */
export function getRecipe(id: string): Recipe | null {
  return RECIPES.find((r) => r.id === id) ?? null;
}
