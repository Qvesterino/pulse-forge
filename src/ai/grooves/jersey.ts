import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Jersey club grooves — the bouncy triple-kick swing (kick on 1, &-of-2,
 * &-of-3), clap backbeat, 8th hats. 134–142 BPM club energy.
 *
 * Pad indices (default kit): 0 kick, 2 kick alt, 4 snare, 6 clap, 8 hat
 * closed, 10 hat open.
 */
export const JERSEY_GROOVES: GrooveData[] = decodeGrooves([
  // ── Club classic (triple-kick bounce) ──────────────────
  {
    id: "jersey.club",
    genre: "jersey",
    name: "Club",
    bpm: [134, 142],
    swing: 0.12,
    activePads: [0, 2, 4, 6, 8],
    patterns: [
      {
        0: "g0O6EaH",
        2: "gdu",
        4: "g4HcH",
        6: "g2q7qeq",
        8: "g0q2n4q6n8qancqen",
      },
      {
        0: "g0O6E8uaH",
        4: "g4HcHek",
        6: "g2q5naqfn",
        8: "g0q2n4q6n8qancqenfk",
      },
    ],
  },
  // ── Bounce (harder swing, denser kicks) ────────────────
  {
    id: "jersey.bounce",
    genre: "jersey",
    name: "Bounce",
    bpm: [136, 144],
    swing: 0.16,
    activePads: [0, 2, 4, 6, 8, 10],
    patterns: [
      {
        0: "g0O3s6E9uaH",
        2: "g8q",
        4: "g4HcH",
        6: "g1n7qbneq",
        8: "g0s1d2q3d4s5d6q7d8s9daqbdcsddeqfh",
        10: "g6k",
      },
    ],
  },
  // ── Flip (sparser, chop-friendly) ──────────────────────
  {
    id: "jersey.flip",
    genre: "jersey",
    name: "Flip",
    bpm: [134, 140],
    swing: 0.1,
    activePads: [0, 4, 6, 8],
    patterns: [
      {
        0: "g0O6EaHeu",
        4: "g4HcH",
        6: "g3q8qfq",
        8: "g0n4n8ncnek",
      },
    ],
  },
  // ── Baltimore (the parent sound — "Think"/"Sing Sing" break stomp: hard
  // breakbeat kick, BIG snare on 2+4, chopped-vocal call blips. Rod Lee /
  // K-Swift / Debonair Samir pocket, 125-135) ──
  {
    id: "jersey.baltimore",
    genre: "jersey",
    name: "Baltimore",
    bpm: [125, 135],
    swing: 0.06,
    activePads: [0, 4, 8, 10, 15],
    patterns: [
      {
        0: "g0O6BaE",
        4: "g4OcO",
        8: "g0q2n4q6n8qancqen",
        10: "ges",
        15: "g2n7kanfk",
      },
      {
        0: "g0O3q6B8Kes",
        4: "g4OcKfk",
        8: "g0q2n4q6n8qanbkcqen",
        15: "g2nanek",
      },
      // Stomp variation — the kick doubles into the snare (the club shout)
      {
        0: "g0O4u6B8Ocueu",
        4: "g4OcOen",
        8: "g0q2n3k4q6n8qanbkcqenfk",
        15: "g2n7nanfk",
      },
    ],
  },
]);
