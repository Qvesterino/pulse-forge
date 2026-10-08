import {
  isValidPreferenceObservation,
  type AudioPreferenceVector,
  type AudioPreferenceVectorV1,
  type PreferenceObservationV1,
  type PreferenceTask,
} from "./preference-ledger-core";
import { sanitizeProducerMemoryEvent } from "./producer-memory-core";
import { scoreWithPersonalPreferences } from "./personal-ranker";
import { scoreWithPersonalAudioPreferences } from "./audio-personal-ranker";
import { scoreWithSongDramaturgyPreferences } from "./song-dramaturgy-ranker";

const SCORE_TIE_EPSILON = 1e-9;
const MIN_TRAINING_CHOICES = 2;

export interface PersonalPreferenceEvaluationReport {
  inputObservations: number;
  validObservations: number;
  explicitChoiceObservations: number;
  evaluatedComparisons: number;
  evaluationMethod: "legacy-candidate-disjoint" | "chronological-group-holdout";
  trainingComparisons: number;
  trainingGroups: number;
  holdoutGroups: number;
  holdoutStartTime: number | null;
  /** Accuracy on later A/B choices, with exact score ties worth half a point. */
  globalAccuracy: number | null;
  personalAccuracy: number | null;
  personalLift: number | null;
  /** Uses the personalScore captured on the candidate immediately before feedback was recorded. */
  capturedScoreEvaluatedComparisons: number;
  capturedScoreAccuracy: number | null;
  capturedScoreLift: number | null;
  blindPilotComparisons: number;
  blindPilotCapturedScoreAccuracy: number | null;
  blindPilotCapturedScoreLift: number | null;
  blindPilotAssignment: BlindPilotAssignmentSummary;
  songDramaturgyEvaluatedComparisons: number;
  songDramaturgyAccuracy: number | null;
  songDramaturgyLift: number | null;
  audioEvaluatedComparisons: number;
  audioPersonalAccuracy: number | null;
  audioPersonalLift: number | null;
  /** Metrics split by preference task while preserving one shared leakage-safe holdout split. */
  byTask: Record<PreferenceTask, PreferenceTaskEvaluationSummary>;
  /**
   * Conservative bounded-row ranges. Rows can still correlate within a held-out
   * group, so these are diagnostic uncertainty estimates, not population CIs.
   */
  uncertainty95: {
    globalAccuracy: { lower: number; upper: number } | null;
    personalAccuracy: { lower: number; upper: number } | null;
    personalLift: { lower: number; upper: number } | null;
    capturedScoreAccuracy: { lower: number; upper: number } | null;
    capturedScoreLift: { lower: number; upper: number } | null;
    blindPilotCapturedScoreAccuracy: { lower: number; upper: number } | null;
    blindPilotCapturedScoreLift: { lower: number; upper: number } | null;
    songDramaturgyAccuracy: { lower: number; upper: number } | null;
    songDramaturgyLift: { lower: number; upper: number } | null;
  };
  globalScoreVersions: string[];
  skipped: {
    nonDirectionalChoice: number;
    missingGlobalScore: number;
    mixedGlobalScoreVersion: number;
    previouslySeenCandidate: number;
    reusedSession: number;
    reusedLineage: number;
    insufficientPriorChoices: number;
    insufficientHoldoutGroups: number;
    overlappingTimeGroups: number;
    unavailablePersonalModel: number;
  };
  caveat: string;
}

export interface PreferenceTaskEvaluationSummary {
  evaluatedComparisons: number;
  globalAccuracy: number | null;
  personalAccuracy: number | null;
  personalLift: number | null;
  capturedScoreEvaluatedComparisons: number;
  capturedScoreAccuracy: number | null;
  capturedScoreLift: number | null;
  blindPilotComparisons: number;
  blindPilotCapturedScoreAccuracy: number | null;
  blindPilotCapturedScoreLift: number | null;
  blindPilotAssignment: BlindPilotAssignmentSummary;
  songDramaturgyEvaluatedComparisons: number;
  songDramaturgyAccuracy: number | null;
  songDramaturgyLift: number | null;
  audioEvaluatedComparisons: number;
  audioPersonalAccuracy: number | null;
  audioPersonalLift: number | null;
  audioV1EvaluatedComparisons: number;
  audioV1PersonalAccuracy: number | null;
  audioV1PersonalLift: number | null;
  audioV2EvaluatedComparisons: number;
  audioV2PersonalAccuracy: number | null;
  audioV2PersonalLift: number | null;
  audioV2IncrementalLift: number | null;
}

export interface BlindPilotAssignmentSummary {
  /** Responses with an auditable original A/B assignment. */
  assignedComparisons: number;
  globalOnA: number;
  globalOnB: number;
  responseA: number;
  responseB: number;
  responseNeither: number;
  responseBoth: number;
  preferredGlobal: number;
  preferredPersonal: number;
  missingAssignment: number;
}

interface TaskCredits {
  global: number[];
  personal: number[];
  lift: number[];
  capturedScore: number[];
  capturedScoreLift: number[];
  blindPilotScore: number[];
  blindPilotScoreLift: number[];
  blindPilotAssignment: BlindPilotAssignmentSummary;
  songDramaturgy: number[];
  songDramaturgyLift: number[];
  audio: number[];
  audioLift: number[];
  audioV1: number[];
  audioV1Lift: number[];
  audioV2: number[];
  audioV2Lift: number[];
  audioV2IncrementalLift: number[];
}

function emptyTaskCredits(): Record<PreferenceTask, TaskCredits> {
  const create = (): TaskCredits => ({
    global: [],
    personal: [],
    lift: [],
    capturedScore: [],
    capturedScoreLift: [],
    blindPilotScore: [],
    blindPilotScoreLift: [],
    blindPilotAssignment: emptyBlindPilotAssignmentSummary(),
    songDramaturgy: [],
    songDramaturgyLift: [],
    audio: [],
    audioLift: [],
    audioV1: [],
    audioV1Lift: [],
    audioV2: [],
    audioV2Lift: [],
    audioV2IncrementalLift: [],
  });
  return { pattern: create(), section: create(), song: create() };
}

function emptyBlindPilotAssignmentSummary(): BlindPilotAssignmentSummary {
  return {
    assignedComparisons: 0,
    globalOnA: 0,
    globalOnB: 0,
    responseA: 0,
    responseB: 0,
    responseNeither: 0,
    responseBoth: 0,
    preferredGlobal: 0,
    preferredPersonal: 0,
    missingAssignment: 0,
  };
}

function addBlindPilotAssignment(observation: PreferenceObservationV1, summary: BlindPilotAssignmentSummary): void {
  if (observation.study !== "producer-dna-blind-pilot") return;
  const assignment = observation.pilotAssignment;
  if (!assignment) {
    summary.missingAssignment++;
    return;
  }
  summary.assignedComparisons++;
  if (assignment.globalSide === "a") summary.globalOnA++;
  else summary.globalOnB++;
  switch (assignment.displayedChoice) {
    case "a":
      summary.responseA++;
      if (assignment.globalSide === "a") summary.preferredGlobal++;
      else summary.preferredPersonal++;
      break;
    case "b":
      summary.responseB++;
      if (assignment.globalSide === "b") summary.preferredGlobal++;
      else summary.preferredPersonal++;
      break;
    case "neither":
      summary.responseNeither++;
      break;
    case "both":
      summary.responseBoth++;
      break;
  }
}

function aggregateBlindPilotAssignments(credits: Record<PreferenceTask, TaskCredits>): BlindPilotAssignmentSummary {
  const summary = emptyBlindPilotAssignmentSummary();
  for (const task of Object.values(credits)) {
    summary.assignedComparisons += task.blindPilotAssignment.assignedComparisons;
    summary.globalOnA += task.blindPilotAssignment.globalOnA;
    summary.globalOnB += task.blindPilotAssignment.globalOnB;
    summary.responseA += task.blindPilotAssignment.responseA;
    summary.responseB += task.blindPilotAssignment.responseB;
    summary.responseNeither += task.blindPilotAssignment.responseNeither;
    summary.responseBoth += task.blindPilotAssignment.responseBoth;
    summary.preferredGlobal += task.blindPilotAssignment.preferredGlobal;
    summary.preferredPersonal += task.blindPilotAssignment.preferredPersonal;
    summary.missingAssignment += task.blindPilotAssignment.missingAssignment;
  }
  return summary;
}

function meanOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeTaskCredits(
  credits: Record<PreferenceTask, TaskCredits>,
): Record<PreferenceTask, PreferenceTaskEvaluationSummary> {
  const summarize = (task: PreferenceTask): PreferenceTaskEvaluationSummary => {
    const values = credits[task];
    return {
      evaluatedComparisons: values.global.length,
      globalAccuracy: meanOrNull(values.global),
      personalAccuracy: meanOrNull(values.personal),
      personalLift: meanOrNull(values.lift),
      capturedScoreEvaluatedComparisons: values.capturedScore.length,
      capturedScoreAccuracy: meanOrNull(values.capturedScore),
      capturedScoreLift: meanOrNull(values.capturedScoreLift),
      blindPilotComparisons: values.blindPilotScore.length,
      blindPilotCapturedScoreAccuracy: meanOrNull(values.blindPilotScore),
      blindPilotCapturedScoreLift: meanOrNull(values.blindPilotScoreLift),
      blindPilotAssignment: { ...values.blindPilotAssignment },
      songDramaturgyEvaluatedComparisons: values.songDramaturgy.length,
      songDramaturgyAccuracy: meanOrNull(values.songDramaturgy),
      songDramaturgyLift: meanOrNull(values.songDramaturgyLift),
      audioEvaluatedComparisons: values.audio.length,
      audioPersonalAccuracy: meanOrNull(values.audio),
      audioPersonalLift: meanOrNull(values.audioLift),
      audioV1EvaluatedComparisons: values.audioV1.length,
      audioV1PersonalAccuracy: meanOrNull(values.audioV1),
      audioV1PersonalLift: meanOrNull(values.audioV1Lift),
      audioV2EvaluatedComparisons: values.audioV2.length,
      audioV2PersonalAccuracy: meanOrNull(values.audioV2),
      audioV2PersonalLift: meanOrNull(values.audioV2Lift),
      audioV2IncrementalLift: meanOrNull(values.audioV2IncrementalLift),
    };
  };
  return { pattern: summarize("pattern"), section: summarize("section"), song: summarize("song") };
}

interface EvaluationRow {
  observation: PreferenceObservationV1;
  sessionId: string | null;
  lineageId: string | null;
}

function observationKey(observation: PreferenceObservationV1): string {
  return [
    observation.context.key,
    observation.candidateA.contentHash,
    observation.candidateB.contentHash,
    observation.choice,
    observation.reason ?? "",
    observation.songReason ?? "",
  ].join(":");
}

function choiceCredit(scoreA: number, scoreB: number, choice: "a" | "b"): number {
  if (Math.abs(scoreA - scoreB) <= SCORE_TIE_EPSILON) return 0.5;
  return (scoreA > scoreB ? "a" : "b") === choice ? 1 : 0;
}

function recordCapturedScore(
  observation: PreferenceObservationV1,
  credits: Record<PreferenceTask, TaskCredits>,
  allCredits: number[],
  allLifts: number[],
): void {
  const { candidateA, candidateB } = observation;
  if (
    (observation.choice !== "a" && observation.choice !== "b") ||
    candidateA.globalScore === undefined ||
    candidateB.globalScore === undefined ||
    candidateA.personalScore === undefined ||
    candidateB.personalScore === undefined
  ) {
    return;
  }
  const globalCredit = choiceCredit(candidateA.globalScore, candidateB.globalScore, observation.choice);
  const capturedCredit = choiceCredit(candidateA.personalScore, candidateB.personalScore, observation.choice);
  const lift = capturedCredit - globalCredit;
  allCredits.push(capturedCredit);
  allLifts.push(lift);
  credits[observation.context.task].capturedScore.push(capturedCredit);
  credits[observation.context.task].capturedScoreLift.push(lift);
  if (observation.study === "producer-dna-blind-pilot") {
    credits[observation.context.task].blindPilotScore.push(capturedCredit);
    credits[observation.context.task].blindPilotScoreLift.push(lift);
  }
}

function recordSongDramaturgyScore(
  observation: PreferenceObservationV1,
  training: readonly PreferenceObservationV1[],
  credits: Record<PreferenceTask, TaskCredits>,
): void {
  if (
    observation.context.task !== "song" ||
    (observation.choice !== "a" && observation.choice !== "b") ||
    observation.reason !== undefined ||
    observation.songReason === "sound" ||
    observation.songReason === "mix" ||
    observation.candidateA.globalScore === undefined ||
    observation.candidateB.globalScore === undefined
  ) {
    return;
  }
  const candidates = [
    { candidateIndex: 0, ...observation.candidateA },
    { candidateIndex: 1, ...observation.candidateB },
  ];
  const personal = scoreWithSongDramaturgyPreferences(
    candidates,
    [observation.candidateA.globalScore, observation.candidateB.globalScore],
    training,
    observation.context,
  );
  if (!personal) return;
  const globalCredit = choiceCredit(
    observation.candidateA.globalScore,
    observation.candidateB.globalScore,
    observation.choice,
  );
  const personalCredit = choiceCredit(personal.candidates[0]!.score, personal.candidates[1]!.score, observation.choice);
  credits.song.songDramaturgy.push(personalCredit);
  credits.song.songDramaturgyLift.push(personalCredit - globalCredit);
}

interface AudioEvaluationCandidate {
  contentHash: string;
  audioFeatures?: AudioPreferenceVector;
}

function asAudioV1(vector: AudioPreferenceVector): AudioPreferenceVectorV1 {
  return vector.version === "audio.v1" ? vector : { version: "audio.v1", values: vector.values.slice(0, 5) };
}

function projectObservationToAudioV1(observation: PreferenceObservationV1): PreferenceObservationV1 {
  const project = (candidate: PreferenceObservationV1["candidateA"]) => ({
    ...candidate,
    ...(candidate.audioFeatures ? { audioFeatures: asAudioV1(candidate.audioFeatures) } : {}),
  });
  return { ...observation, candidateA: project(observation.candidateA), candidateB: project(observation.candidateB) };
}

/** Score one audio contract while keeping the same symbolic baseline and holdout rows. */
function scoreAudioContract<T extends AudioEvaluationCandidate & { candidateIndex: number }>(
  candidates: readonly T[],
  baseScores: readonly number[],
  observations: readonly PreferenceObservationV1[],
  context: PreferenceObservationV1["context"],
  contract: "audio.v1" | "audio.v2",
): number[] | null {
  if (
    candidates.length < 2 ||
    candidates.length !== baseScores.length ||
    candidates.some((candidate) => !candidate.audioFeatures) ||
    (contract === "audio.v2" && candidates.some((candidate) => candidate.audioFeatures?.version !== "audio.v2"))
  ) {
    return null;
  }
  const featureByHash = new Map(
    candidates.map(
      (candidate) =>
        [
          candidate.contentHash,
          contract === "audio.v1" ? asAudioV1(candidate.audioFeatures!) : candidate.audioFeatures!,
        ] as const,
    ),
  );
  const training = contract === "audio.v1" ? observations.map(projectObservationToAudioV1) : observations;
  return scoreWithPersonalAudioPreferences(candidates, baseScores, featureByHash, training, context);
}

function isAudioV2Pair(a: AudioEvaluationCandidate, b: AudioEvaluationCandidate): boolean {
  return a.audioFeatures?.version === "audio.v2" && b.audioFeatures?.version === "audio.v2";
}

function boundedHoeffdingInterval(
  values: readonly number[],
  lowerBound: number,
  upperBound: number,
): { lower: number; upper: number } | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const radius = (upperBound - lowerBound) * Math.sqrt(Math.log(40) / (2 * values.length));
  return {
    lower: Math.max(lowerBound, mean - radius),
    upper: Math.min(upperBound, mean + radius),
  };
}

/**
 * Evaluate future explicit choices against the score from the non-personal
 * selector captured with each comparison. Training is strictly chronological;
 * ties in timestamps are held out together, and a candidate content hash that
 * appeared in prior data cannot also score as a held-out candidate.
 *
 * This is a diagnostic, not a claim of population-level statistical validity:
 * the local ledger has no prompt/session grouping, so the report states that
 * limitation explicitly.
 */
export function evaluatePersonalPreferences(input: readonly unknown[]): PersonalPreferenceEvaluationReport {
  const rows = input
    .filter(isValidPreferenceObservation)
    .map((observation) => ({ observation, sessionId: null, lineageId: null }));
  return evaluateRows(
    rows,
    input.length,
    "Chronological, candidate-hash-disjoint holdout within the local ledger; legacy observations do not carry session/lineage groups, so this is a diagnostic and not a statistically independent user study.",
  );
}

/**
 * Evaluate the canonical event stream with both candidate-hash and group
 * separation. A session or lineage that contributed earlier evidence can
 * never also contribute a held-out row.
 */
export function evaluateProducerMemoryEvents(input: readonly unknown[]): PersonalPreferenceEvaluationReport {
  const rows: EvaluationRow[] = [];
  for (const value of input) {
    const event = sanitizeProducerMemoryEvent(value);
    if (event?.type === "pairwise-choice" || event?.type === "settled-edit") {
      rows.push({ observation: event.observation, sessionId: event.sessionId, lineageId: event.lineageId });
    }
  }
  return evaluateGroupedEventRows(rows);
}

/**
 * Build connected components over session, lineage and candidate hashes.
 * A component is indivisible: it can train OR be held out, never both. This
 * avoids the optimistic leakage of scoring one row from a session and then
 * feeding later rows from that same session back into the trainer.
 */
function connectedEvaluationGroups(rows: readonly EvaluationRow[]): EvaluationRow[][] {
  const parent = rows.map((_, index) => index);
  const find = (index: number): number => {
    const root = parent[index] ?? index;
    if (root === index) return index;
    const resolved = find(root);
    parent[index] = resolved;
    return resolved;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const firstIndexByToken = new Map<string, number>();
  rows.forEach((row, index) => {
    const tokens = [
      ...(row.sessionId ? [`session:${row.sessionId}`] : []),
      ...(row.lineageId ? [`lineage:${row.lineageId}`] : []),
      `candidate:${row.observation.candidateA.contentHash}`,
      `candidate:${row.observation.candidateB.contentHash}`,
    ];
    for (const token of tokens) {
      const prior = firstIndexByToken.get(token);
      if (prior === undefined) firstIndexByToken.set(token, index);
      else union(index, prior);
    }
  });
  const groups = new Map<number, EvaluationRow[]>();
  rows.forEach((row, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(row);
    groups.set(root, group);
  });
  return [...groups.values()].sort((left, right) => {
    const leftFirst = Math.min(...left.map((row) => row.observation.createdAt));
    const rightFirst = Math.min(...right.map((row) => row.observation.createdAt));
    return (
      leftFirst - rightFirst ||
      observationKey(left[0]!.observation).localeCompare(observationKey(right[0]!.observation))
    );
  });
}

function evaluateGroupedEventRows(rows: readonly EvaluationRow[]): PersonalPreferenceEvaluationReport {
  const groups = connectedEvaluationGroups(rows);
  const holdoutGroupCount = groups.length >= 2 ? Math.max(1, Math.ceil(groups.length * 0.2)) : 0;
  const trainingGroups = groups.slice(0, groups.length - holdoutGroupCount);
  const candidateHoldoutGroups = groups.slice(groups.length - holdoutGroupCount);
  const training = trainingGroups.flat();
  const trainingMaxTime = training.reduce((max, row) => Math.max(max, row.observation.createdAt), -Infinity);
  const holdout = candidateHoldoutGroups.filter((group) =>
    group.every((row) => row.observation.createdAt > trainingMaxTime),
  );
  const overlappingTimeGroups = candidateHoldoutGroups.length - holdout.length;
  const trainable = training.filter((row) => row.observation.choice === "a" || row.observation.choice === "b");
  const holdoutRows = holdout.flat();
  const skipped = {
    nonDirectionalChoice: 0,
    missingGlobalScore: 0,
    mixedGlobalScoreVersion: 0,
    previouslySeenCandidate: 0,
    reusedSession: 0,
    reusedLineage: 0,
    insufficientPriorChoices: 0,
    insufficientHoldoutGroups: groups.length < 2 || holdout.length === 0 ? 1 : 0,
    overlappingTimeGroups,
    unavailablePersonalModel: 0,
  };
  const globalVersions = new Set<string>();
  const globalCredits: number[] = [];
  const personalCredits: number[] = [];
  const pairedLift: number[] = [];
  const capturedScoreCredits: number[] = [];
  const capturedScoreLifts: number[] = [];
  const audioCredits: number[] = [];
  const audioPairedLift: number[] = [];
  const taskCredits = emptyTaskCredits();
  let explicitChoiceObservations = 0;

  for (const row of holdoutRows) {
    const { observation } = row;
    if (observation.source === "edit") continue;
    addBlindPilotAssignment(observation, taskCredits[observation.context.task].blindPilotAssignment);
    if (observation.choice !== "a" && observation.choice !== "b") {
      skipped.nonDirectionalChoice++;
      continue;
    }
    explicitChoiceObservations++;
    const { candidateA, candidateB } = observation;
    if (
      candidateA.globalScore === undefined ||
      candidateB.globalScore === undefined ||
      candidateA.globalScoreVersion === undefined ||
      candidateB.globalScoreVersion === undefined
    ) {
      skipped.missingGlobalScore++;
      continue;
    }
    if (candidateA.globalScoreVersion !== candidateB.globalScoreVersion) {
      skipped.mixedGlobalScoreVersion++;
      continue;
    }
    recordCapturedScore(observation, taskCredits, capturedScoreCredits, capturedScoreLifts);
    recordSongDramaturgyScore(
      observation,
      trainable.map((item) => item.observation),
      taskCredits,
    );
    if (trainable.length < MIN_TRAINING_CHOICES) {
      skipped.insufficientPriorChoices++;
      continue;
    }
    const candidates = [
      { candidateIndex: 0, contentHash: candidateA.contentHash, audioFeatures: candidateA.audioFeatures },
      { candidateIndex: 1, contentHash: candidateB.contentHash, audioFeatures: candidateB.audioFeatures },
    ];
    const features = new Map([
      [candidateA.contentHash, candidateA.features],
      [candidateB.contentHash, candidateB.features],
    ]);
    const symbolicPersonal = scoreWithPersonalPreferences(
      candidates,
      [candidateA.globalScore, candidateB.globalScore],
      features,
      trainable.map((item) => item.observation),
      observation.context,
    );
    const audioFeatures = new Map(
      [candidateA, candidateB]
        .filter((candidate) => candidate.audioFeatures !== undefined)
        .map((candidate) => [candidate.contentHash, candidate.audioFeatures!] as const),
    );
    const symbolicBaseScores = symbolicPersonal?.map((item) => item.score) ?? [
      candidateA.globalScore,
      candidateB.globalScore,
    ];
    const audioPersonal = scoreWithPersonalAudioPreferences(
      candidates,
      symbolicBaseScores,
      audioFeatures,
      trainable.map((item) => item.observation),
      observation.context,
    );
    const audioV1Personal = scoreAudioContract(
      candidates,
      symbolicBaseScores,
      trainable.map((item) => item.observation),
      observation.context,
      "audio.v1",
    );
    const audioV2Personal = isAudioV2Pair(candidateA, candidateB)
      ? scoreAudioContract(
          candidates,
          symbolicBaseScores,
          trainable.map((item) => item.observation),
          observation.context,
          "audio.v2",
        )
      : null;
    const personalScores = audioPersonal ?? symbolicPersonal?.map((item) => item.score) ?? null;
    if (!personalScores) {
      skipped.unavailablePersonalModel++;
      continue;
    }
    const globalCredit = choiceCredit(candidateA.globalScore, candidateB.globalScore, observation.choice);
    const personalCredit = choiceCredit(personalScores[0] ?? 0.5, personalScores[1] ?? 0.5, observation.choice);
    globalCredits.push(globalCredit);
    personalCredits.push(personalCredit);
    pairedLift.push(personalCredit - globalCredit);
    const taskCredit = taskCredits[observation.context.task];
    taskCredit.global.push(globalCredit);
    taskCredit.personal.push(personalCredit);
    taskCredit.lift.push(personalCredit - globalCredit);
    if (audioPersonal) {
      const baseCredit = choiceCredit(symbolicBaseScores[0] ?? 0.5, symbolicBaseScores[1] ?? 0.5, observation.choice);
      const audioCredit = choiceCredit(audioPersonal[0] ?? 0.5, audioPersonal[1] ?? 0.5, observation.choice);
      audioCredits.push(audioCredit);
      audioPairedLift.push(audioCredit - baseCredit);
      taskCredit.audio.push(audioCredit);
      taskCredit.audioLift.push(audioCredit - baseCredit);
    }
    const symbolicCredit = choiceCredit(symbolicBaseScores[0] ?? 0.5, symbolicBaseScores[1] ?? 0.5, observation.choice);
    const audioV1Credit = audioV1Personal
      ? choiceCredit(audioV1Personal[0] ?? 0.5, audioV1Personal[1] ?? 0.5, observation.choice)
      : null;
    const audioV2Credit = audioV2Personal
      ? choiceCredit(audioV2Personal[0] ?? 0.5, audioV2Personal[1] ?? 0.5, observation.choice)
      : null;
    if (audioV1Credit !== null) {
      taskCredit.audioV1.push(audioV1Credit);
      taskCredit.audioV1Lift.push(audioV1Credit - symbolicCredit);
    }
    if (audioV2Credit !== null) {
      taskCredit.audioV2.push(audioV2Credit);
      taskCredit.audioV2Lift.push(audioV2Credit - symbolicCredit);
      if (audioV1Credit !== null) taskCredit.audioV2IncrementalLift.push(audioV2Credit - audioV1Credit);
    }
    globalVersions.add(candidateA.globalScoreVersion);
  }

  const evaluatedComparisons = globalCredits.length;
  const globalAccuracy =
    evaluatedComparisons > 0 ? globalCredits.reduce((sum, credit) => sum + credit, 0) / evaluatedComparisons : null;
  const personalAccuracy =
    evaluatedComparisons > 0 ? personalCredits.reduce((sum, credit) => sum + credit, 0) / evaluatedComparisons : null;
  const personalLift =
    evaluatedComparisons > 0 ? pairedLift.reduce((sum, lift) => sum + lift, 0) / evaluatedComparisons : null;
  const capturedScoreEvaluatedComparisons = capturedScoreCredits.length;
  const capturedScoreAccuracy = meanOrNull(capturedScoreCredits);
  const capturedScoreLift = meanOrNull(capturedScoreLifts);
  const blindPilotScores = Object.values(taskCredits).flatMap((task) => task.blindPilotScore);
  const blindPilotScoreLifts = Object.values(taskCredits).flatMap((task) => task.blindPilotScoreLift);
  const blindPilotComparisons = blindPilotScores.length;
  const blindPilotCapturedScoreAccuracy = meanOrNull(blindPilotScores);
  const blindPilotCapturedScoreLift = meanOrNull(blindPilotScoreLifts);
  const blindPilotAssignment = aggregateBlindPilotAssignments(taskCredits);
  const songDramaturgyScores = taskCredits.song.songDramaturgy;
  const songDramaturgyLifts = taskCredits.song.songDramaturgyLift;
  const audioEvaluatedComparisons = audioCredits.length;
  const audioPersonalAccuracy =
    audioEvaluatedComparisons > 0
      ? audioCredits.reduce((sum, credit) => sum + credit, 0) / audioEvaluatedComparisons
      : null;
  const audioPersonalLift =
    audioEvaluatedComparisons > 0
      ? audioPairedLift.reduce((sum, lift) => sum + lift, 0) / audioEvaluatedComparisons
      : null;
  return {
    inputObservations: rows.length,
    validObservations: rows.length,
    explicitChoiceObservations,
    evaluatedComparisons,
    evaluationMethod: "chronological-group-holdout",
    trainingComparisons: trainable.length,
    trainingGroups: trainingGroups.length,
    holdoutGroups: holdout.length,
    holdoutStartTime: holdoutRows.length > 0 ? Math.min(...holdoutRows.map((row) => row.observation.createdAt)) : null,
    globalAccuracy,
    personalAccuracy,
    personalLift,
    capturedScoreEvaluatedComparisons,
    capturedScoreAccuracy,
    capturedScoreLift,
    blindPilotComparisons,
    blindPilotCapturedScoreAccuracy,
    blindPilotCapturedScoreLift,
    blindPilotAssignment,
    songDramaturgyEvaluatedComparisons: songDramaturgyScores.length,
    songDramaturgyAccuracy: meanOrNull(songDramaturgyScores),
    songDramaturgyLift: meanOrNull(songDramaturgyLifts),
    audioEvaluatedComparisons,
    audioPersonalAccuracy,
    audioPersonalLift,
    byTask: summarizeTaskCredits(taskCredits),
    uncertainty95: {
      globalAccuracy: boundedHoeffdingInterval(globalCredits, 0, 1),
      personalAccuracy: boundedHoeffdingInterval(personalCredits, 0, 1),
      personalLift: boundedHoeffdingInterval(pairedLift, -1, 1),
      capturedScoreAccuracy: boundedHoeffdingInterval(capturedScoreCredits, 0, 1),
      capturedScoreLift: boundedHoeffdingInterval(capturedScoreLifts, -1, 1),
      blindPilotCapturedScoreAccuracy: boundedHoeffdingInterval(blindPilotScores, 0, 1),
      blindPilotCapturedScoreLift: boundedHoeffdingInterval(blindPilotScoreLifts, -1, 1),
      songDramaturgyAccuracy: boundedHoeffdingInterval(songDramaturgyScores, 0, 1),
      songDramaturgyLift: boundedHoeffdingInterval(songDramaturgyLifts, -1, 1),
    },
    globalScoreVersions: [...globalVersions].sort(),
    skipped,
    caveat:
      "Final chronological 20% of connected groups is held out. Events linked by candidate hash, session or lineage are indivisible and never appear in both train and holdout. Groups whose time ranges overlap training are excluded. This remains diagnostic until an opt-in blind pilot.",
  };
}

function evaluateRows(
  rows: readonly EvaluationRow[],
  inputObservations: number,
  caveat: string,
): PersonalPreferenceEvaluationReport {
  const observations = [...rows].sort(
    (a, b) =>
      a.observation.createdAt - b.observation.createdAt ||
      observationKey(a.observation).localeCompare(observationKey(b.observation)),
  );
  const training: PreferenceObservationV1[] = [];
  const seenCandidateHashes = new Set<string>();
  const seenSessionIds = new Set<string>();
  const seenLineageIds = new Set<string>();
  const globalVersions = new Set<string>();
  const skipped = {
    nonDirectionalChoice: 0,
    missingGlobalScore: 0,
    mixedGlobalScoreVersion: 0,
    previouslySeenCandidate: 0,
    reusedSession: 0,
    reusedLineage: 0,
    insufficientPriorChoices: 0,
    insufficientHoldoutGroups: 0,
    overlappingTimeGroups: 0,
    unavailablePersonalModel: 0,
  };
  let explicitChoiceObservations = 0;
  let evaluatedComparisons = 0;
  const globalCredits: number[] = [];
  const personalCredits: number[] = [];
  const pairedLift: number[] = [];
  const capturedScoreCredits: number[] = [];
  const capturedScoreLifts: number[] = [];
  const audioCredits: number[] = [];
  const audioPairedLift: number[] = [];
  const taskCredits = emptyTaskCredits();

  for (let start = 0; start < observations.length;) {
    const timestamp = observations[start]?.observation.createdAt;
    let end = start + 1;
    while (end < observations.length && observations[end]?.observation.createdAt === timestamp) end++;
    const group = observations.slice(start, end);

    for (const row of group) {
      const { observation } = row;
      if (observation.source === "edit") {
        // Corrections are valid training evidence for later explicit choices,
        // but they have no captured global baseline and are not evaluation rows.
        continue;
      }
      addBlindPilotAssignment(observation, taskCredits[observation.context.task].blindPilotAssignment);
      if (observation.choice !== "a" && observation.choice !== "b") {
        skipped.nonDirectionalChoice++;
        continue;
      }
      explicitChoiceObservations++;

      if (row.sessionId && seenSessionIds.has(row.sessionId)) {
        skipped.reusedSession++;
        continue;
      }
      if (row.lineageId && seenLineageIds.has(row.lineageId)) {
        skipped.reusedLineage++;
        continue;
      }

      const { candidateA, candidateB } = observation;
      if (
        candidateA.globalScore === undefined ||
        candidateB.globalScore === undefined ||
        candidateA.globalScoreVersion === undefined ||
        candidateB.globalScoreVersion === undefined
      ) {
        skipped.missingGlobalScore++;
        continue;
      }
      if (candidateA.globalScoreVersion !== candidateB.globalScoreVersion) {
        skipped.mixedGlobalScoreVersion++;
        continue;
      }
      if (seenCandidateHashes.has(candidateA.contentHash) || seenCandidateHashes.has(candidateB.contentHash)) {
        skipped.previouslySeenCandidate++;
        continue;
      }

      recordCapturedScore(observation, taskCredits, capturedScoreCredits, capturedScoreLifts);
      recordSongDramaturgyScore(observation, training, taskCredits);

      const priorChoices = training.filter((item) => item.choice === "a" || item.choice === "b").length;
      if (priorChoices < MIN_TRAINING_CHOICES) {
        skipped.insufficientPriorChoices++;
        continue;
      }

      const pair = [
        { candidateIndex: 0, contentHash: candidateA.contentHash, audioFeatures: candidateA.audioFeatures },
        { candidateIndex: 1, contentHash: candidateB.contentHash, audioFeatures: candidateB.audioFeatures },
      ];
      const features = new Map([
        [candidateA.contentHash, candidateA.features],
        [candidateB.contentHash, candidateB.features],
      ]);
      const symbolicPersonal = scoreWithPersonalPreferences(
        pair,
        [candidateA.globalScore, candidateB.globalScore],
        features,
        training,
        observation.context,
      );
      if (!symbolicPersonal) {
        skipped.unavailablePersonalModel++;
        continue;
      }
      const symbolicScores = symbolicPersonal.map((item) => item.score);
      const audioFeatures = new Map(
        [candidateA, candidateB].flatMap((candidate) =>
          candidate.audioFeatures ? [[candidate.contentHash, candidate.audioFeatures] as const] : [],
        ),
      );
      const audioPersonal = scoreWithPersonalAudioPreferences(
        pair,
        symbolicScores,
        audioFeatures,
        training,
        observation.context,
      );
      const audioV1Personal = scoreAudioContract(pair, symbolicScores, training, observation.context, "audio.v1");
      const audioV2Personal = isAudioV2Pair(candidateA, candidateB)
        ? scoreAudioContract(pair, symbolicScores, training, observation.context, "audio.v2")
        : null;
      const personalScores = audioPersonal ?? symbolicScores;

      const globalCredit = choiceCredit(candidateA.globalScore, candidateB.globalScore, observation.choice);
      const personalCredit = choiceCredit(personalScores[0] ?? 0.5, personalScores[1] ?? 0.5, observation.choice);
      globalCredits.push(globalCredit);
      personalCredits.push(personalCredit);
      pairedLift.push(personalCredit - globalCredit);
      const taskCredit = taskCredits[observation.context.task];
      taskCredit.global.push(globalCredit);
      taskCredit.personal.push(personalCredit);
      taskCredit.lift.push(personalCredit - globalCredit);
      if (audioPersonal) {
        const symbolicCredit = choiceCredit(symbolicScores[0] ?? 0.5, symbolicScores[1] ?? 0.5, observation.choice);
        const audioCredit = choiceCredit(audioPersonal[0] ?? 0.5, audioPersonal[1] ?? 0.5, observation.choice);
        audioCredits.push(audioCredit);
        audioPairedLift.push(audioCredit - symbolicCredit);
        taskCredit.audio.push(audioCredit);
        taskCredit.audioLift.push(audioCredit - symbolicCredit);
      }
      const symbolicCredit = choiceCredit(symbolicScores[0] ?? 0.5, symbolicScores[1] ?? 0.5, observation.choice);
      const audioV1Credit = audioV1Personal
        ? choiceCredit(audioV1Personal[0] ?? 0.5, audioV1Personal[1] ?? 0.5, observation.choice)
        : null;
      const audioV2Credit = audioV2Personal
        ? choiceCredit(audioV2Personal[0] ?? 0.5, audioV2Personal[1] ?? 0.5, observation.choice)
        : null;
      if (audioV1Credit !== null) {
        taskCredit.audioV1.push(audioV1Credit);
        taskCredit.audioV1Lift.push(audioV1Credit - symbolicCredit);
      }
      if (audioV2Credit !== null) {
        taskCredit.audioV2.push(audioV2Credit);
        taskCredit.audioV2Lift.push(audioV2Credit - symbolicCredit);
        if (audioV1Credit !== null) taskCredit.audioV2IncrementalLift.push(audioV2Credit - audioV1Credit);
      }
      globalVersions.add(candidateA.globalScoreVersion);
      evaluatedComparisons++;
    }

    // Outcomes at the same timestamp are not allowed to train one another.
    for (const row of group) {
      const { observation } = row;
      seenCandidateHashes.add(observation.candidateA.contentHash);
      seenCandidateHashes.add(observation.candidateB.contentHash);
      if (row.sessionId) seenSessionIds.add(row.sessionId);
      if (row.lineageId) seenLineageIds.add(row.lineageId);
      if (observation.choice === "a" || observation.choice === "b") training.push(observation);
    }
    start = end;
  }

  const globalAccuracy =
    evaluatedComparisons > 0 ? globalCredits.reduce((sum, credit) => sum + credit, 0) / evaluatedComparisons : null;
  const personalAccuracy =
    evaluatedComparisons > 0 ? personalCredits.reduce((sum, credit) => sum + credit, 0) / evaluatedComparisons : null;
  const personalLift =
    evaluatedComparisons > 0 ? pairedLift.reduce((sum, lift) => sum + lift, 0) / evaluatedComparisons : null;
  const capturedScoreEvaluatedComparisons = capturedScoreCredits.length;
  const capturedScoreAccuracy = meanOrNull(capturedScoreCredits);
  const capturedScoreLift = meanOrNull(capturedScoreLifts);
  const blindPilotScores = Object.values(taskCredits).flatMap((task) => task.blindPilotScore);
  const blindPilotScoreLifts = Object.values(taskCredits).flatMap((task) => task.blindPilotScoreLift);
  const blindPilotComparisons = blindPilotScores.length;
  const blindPilotCapturedScoreAccuracy = meanOrNull(blindPilotScores);
  const blindPilotCapturedScoreLift = meanOrNull(blindPilotScoreLifts);
  const blindPilotAssignment = aggregateBlindPilotAssignments(taskCredits);
  const songDramaturgyScores = taskCredits.song.songDramaturgy;
  const songDramaturgyLifts = taskCredits.song.songDramaturgyLift;
  const audioEvaluatedComparisons = audioCredits.length;
  const audioPersonalAccuracy =
    audioEvaluatedComparisons > 0
      ? audioCredits.reduce((sum, credit) => sum + credit, 0) / audioEvaluatedComparisons
      : null;
  const audioPersonalLift =
    audioEvaluatedComparisons > 0
      ? audioPairedLift.reduce((sum, lift) => sum + lift, 0) / audioEvaluatedComparisons
      : null;
  return {
    inputObservations,
    validObservations: observations.length,
    explicitChoiceObservations,
    evaluatedComparisons,
    evaluationMethod: "legacy-candidate-disjoint",
    trainingComparisons: training.filter((item) => item.choice === "a" || item.choice === "b").length,
    trainingGroups: 0,
    holdoutGroups: 0,
    holdoutStartTime: null,
    globalAccuracy,
    personalAccuracy,
    personalLift,
    capturedScoreEvaluatedComparisons,
    capturedScoreAccuracy,
    capturedScoreLift,
    blindPilotComparisons,
    blindPilotCapturedScoreAccuracy,
    blindPilotCapturedScoreLift,
    blindPilotAssignment,
    songDramaturgyEvaluatedComparisons: songDramaturgyScores.length,
    songDramaturgyAccuracy: meanOrNull(songDramaturgyScores),
    songDramaturgyLift: meanOrNull(songDramaturgyLifts),
    audioEvaluatedComparisons,
    audioPersonalAccuracy,
    audioPersonalLift,
    byTask: summarizeTaskCredits(taskCredits),
    uncertainty95: {
      globalAccuracy: boundedHoeffdingInterval(globalCredits, 0, 1),
      personalAccuracy: boundedHoeffdingInterval(personalCredits, 0, 1),
      personalLift: boundedHoeffdingInterval(pairedLift, -1, 1),
      capturedScoreAccuracy: boundedHoeffdingInterval(capturedScoreCredits, 0, 1),
      capturedScoreLift: boundedHoeffdingInterval(capturedScoreLifts, -1, 1),
      blindPilotCapturedScoreAccuracy: boundedHoeffdingInterval(blindPilotScores, 0, 1),
      blindPilotCapturedScoreLift: boundedHoeffdingInterval(blindPilotScoreLifts, -1, 1),
      songDramaturgyAccuracy: boundedHoeffdingInterval(songDramaturgyScores, 0, 1),
      songDramaturgyLift: boundedHoeffdingInterval(songDramaturgyLifts, -1, 1),
    },
    globalScoreVersions: [...globalVersions].sort(),
    skipped,
    caveat,
  };
}
