/** Opaque identity for one store-owned undo transaction. */
export type UndoFrameToken = object;

/** Raised when a command cannot safely join or start an undo transaction. */
export class UndoFrameConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndoFrameConflictError";
  }
}

export function createUndoFrameToken(): UndoFrameToken {
  return Object.freeze({});
}
