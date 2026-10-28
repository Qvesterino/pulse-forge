import { createUndoFrameToken, type UndoFrameToken } from "../../src/store/undoFrame";
import type { McpToolContext } from "../../src/mcp/tools";

/**
 * Attach the ISOLATED project writer to a hand-rolled MCP test context.
 *
 * Since `83ed86d5` ("fix MCP cancellation and batch undo ownership") every MCP
 * write lands through the host's isolated writer (`executeAgentCommand`), and a
 * context that does not expose it has its write REFUSED: "This MCP host does
 * not expose the isolated project writer; the write was refused."
 *
 * A harness that forgets the writer therefore fails for the WRONG reason: the
 * tool refuses, the document does not move, and the assertion blames the tool
 * instead of the harness. This helper keeps the contract honest in tests.
 *
 * The raw write is the harness's own `execute` — the MCP layer wraps it with
 * the stale-write guard, the scope guard and the receipt bookkeeping, and this
 * helper sits UNDER that wrapping, exactly where a host's writer sits.
 *
 * The frame trio is what lets `kyx_batch` own one undo transaction: the batch
 * path refuses to run at all unless the host can open, own and close a frame.
 */
export function withAgentWriter(ctx: McpToolContext): McpToolContext {
  const rawWrite = ctx.execute;
  let openFrame: UndoFrameToken | null = null;
  return {
    ...ctx,
    executeAgentCommand: (command) => rawWrite(command),
    beginOwnedUndoFrame: () => {
      openFrame = createUndoFrameToken();
      return openFrame;
    },
    endOwnedUndoFrame: (token) => {
      if (openFrame === null || openFrame !== token) return false;
      openFrame = null;
      return true;
    },
  };
}
