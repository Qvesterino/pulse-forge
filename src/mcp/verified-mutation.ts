import type { ProjectDocument } from "../project-model/types";
import { summarizeDocumentChange } from "./intent-readback";
import type { McpToolResult } from "./tools";

/**
 * ONE PLACE WHERE A MUTATION BECOMES A CLAIM.
 *
 * The MCP surface has ~90 mutation sites. Each one used to describe WHAT IT WAS
 * ASKED TO DO — "pasted 3 clips", "mix applied (12 decisions)", "one undo
 * step" — and nothing verified what landed. The agent was told a knob moved
 * and never saw the number, the track, or the target that did not resolve.
 *
 * This helper is the choke point: it runs AFTER the tool's own handler and
 * BEFORE the result leaves the surface, so no handler can forget it and no
 * handler has to know about it.
 *
 * Three corrections, one shape — a mutation that happened (or did not) and a
 * report that has to describe it:
 *
 *  1. THE UNDO CLAIM IS A CLAIM ABOUT THE STACK — and the stack knows. "one
 *     undo step" is corrected to "folded into the previous undo step" when the
 *     stack did not grow. A tool cannot promise an undo step it did not make.
 *  2. A SUCCESS WITH AN IDENTICAL DOCUMENT IS NOT A SUCCESS. The document is
 *     the truth; the handler's optimism is not. The `mutated` flag and the
 *     data envelope follow the document.
 *  3. A SUCCESS WITHOUT A READ-BACK GETS ONE. When the handler's own text
 *     carries no value transition and no read-back, the structural summary of
 *     the document change is appended — so the agent sees WHAT MOVED, not
 *     only what was asked.
 *
 * The handler's OWN read-back is left alone: a value-level verification
 * ("mix 0.30→0.46 on Bass") knows more than the structural summary, and the
 * summary would only blur it.
 */

/** "one undo step" — in any of the shapes the surface uses. */
const UNDO_CLAIM = /one undo step(?: in KYX)?/i;
/**
 * The same claim, ready for replacement. A SEPARATE constant on purpose: a
 * global regex carries `lastIndex` between `test()` calls, so one shared
 * object would make the detection alternate true/false from call to call.
 */
const UNDO_CLAIM_ALL = /one undo step(?: in KYX)?/gi;
/** A text that already tells the agent what landed. */
const VERIFICATION = /→|->|read-?back|verification/i;

export interface VerifiedMutationInput {
  /** The document as it was BEFORE the tool ran. */
  before: ProjectDocument;
  /** The document as it is AFTER the tool ran. */
  after: ProjectDocument;
  /** The undo stack depth before / after the tool ran. */
  undoDepthBefore: number;
  undoDepthAfter: number;
  /** The result the handler produced. */
  result: McpToolResult;
  /**
   * FALSE for the tools that write OUTSIDE the project document — the user
   * sample library, the runtime, the export file, the checkpoint repository.
   * For those the document is not the witness of the mutation, so an
   * unchanged document says nothing about whether the work happened.
   */
  documentMutation?: boolean;
  /**
   * TRUE for a REPLAY of an earlier call (audit F-06).
   *
   * The replay reports the ORIGINAL outcome — the ledger already verified
   * that call against the document when it happened, and the requestId names
   * ONE logical operation. The gate's "nothing changed" rewrite would
   * contradict it (the replay's `mutated: true` describes the original call,
   * not this one), so the gate checks the envelope and leaves the outcome
   * alone. The replay's PRESENT rides in its own `current` field.
   */
  replay?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The handler's narration without the undo claim — the claim is corrected
 *  separately, and a correction must not leave a contradiction behind. */
function withoutUndoClaim(text: string): string {
  return text
    .replace(UNDO_CLAIM_ALL, "")
    .replace(/\s*[-—]\s*$/, "")
    .trim();
}

export function verifiedMutation(input: VerifiedMutationInput): McpToolResult {
  const { before, after, undoDepthBefore, undoDepthAfter, result } = input;
  // An error or a non-mutation claims nothing; there is nothing to verify.
  if (result.mutated !== true || result.isError === true) return result;
  // A REPLAY is not a fresh mutation — its outcome was verified when it
  // happened. The gate leaves it alone (see `replay`).
  if (input.replay === true) return result;

  const documentMutation = input.documentMutation !== false;
  const documentChanged = before !== after;
  const undoGrew = undoDepthAfter > undoDepthBefore;
  const undoShrank = undoDepthAfter < undoDepthBefore;
  /**
   * NOTHING HAPPENED — the document is identical AND no undo step was
   * recorded. Both halves matter: a command that RAN and simply produced the
   * same content (a restore to the state that was already there) is still a
   * real, undoable operation, and the agent must not be told it did nothing.
   */
  const nothingHappened = !documentChanged && !undoGrew;

  let text = result.text;
  let mutated = true;

  // 1. THE UNDO CLAIM IS A CLAIM ABOUT THE STACK — and the stack knows.
  // A stack that SHRANK means the tool undid something (kyx_undo, redo); its
  // claim about the stack is not the same claim and must not be corrected.
  if (!undoShrank && UNDO_CLAIM.test(text)) {
    if (nothingHappened) {
      // An undo step that restores an identical document is not a step.
      text = withoutUndoClaim(text);
    } else if (!undoGrew) {
      // The change landed but folded into the previous undo step.
      text = text.replace(UNDO_CLAIM_ALL, "folded into the previous undo step");
    }
  }

  if (nothingHappened && documentMutation) {
    // 2. A SUCCESS THAT DID NOTHING IS NOT A SUCCESS. The handler said it
    // changed something; the document says nothing changed and the stack
    // recorded no step. The document wins — and the truth comes FIRST, with
    // the handler's narration framed as what it REPORTED (the report may
    // still carry measurements the agent needs, e.g. a loudness reading).
    text = `nothing changed (the document is identical); no undo step — reported: ${text}`;
    mutated = false;
  } else if (documentChanged && !VERIFICATION.test(text)) {
    // 3. A SUCCESS WITHOUT A READ-BACK GETS ONE.
    const summary = summarizeDocumentChange(before, after);
    const detail = summary.lines.length > 0 ? summary.lines.join("; ") : "document metadata changed";
    text = `${text} — read-back: ${detail}`;
  }

  if (mutated === result.mutated) return { ...result, text };
  return {
    ...result,
    text,
    mutated: false,
    ...(result.stage == null ? { stage: "noop" as const } : {}),
    data: isPlainObject(result.data)
      ? { ...result.data, status: "unchanged", changed: false }
      : { status: "unchanged", changed: false },
  };
}
