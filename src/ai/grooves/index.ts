import type { GrooveData } from '../types';
import { HOUSE_GROOVES } from './house';
import { TECHNO_GROOVES } from './techno';
import { TRAP_GROOVES } from './trap';
import { AMBIENT_GROOVES } from './ambient';

export const GROOVE_LIBRARY: readonly GrooveData[] = [
  ...HOUSE_GROOVES,
  ...TECHNO_GROOVES,
  ...TRAP_GROOVES,
  ...AMBIENT_GROOVES,
];

/** Get all groove styles for a genre */
export function getGroovesForGenre(genre: GrooveData['genre']): readonly GrooveData[] {
  return GROOVE_LIBRARY.filter(g => g.genre === genre);
}

/** Get a specific groove by id */
export function getGrooveById(id: string): GrooveData | undefined {
  return GROOVE_LIBRARY.find(g => g.id === id);
}

/** Get all style names for a genre */
export function getStyleNamesForGenre(genre: GrooveData['genre']): string[] {
  return getGroovesForGenre(genre).map(g => g.name);
}
