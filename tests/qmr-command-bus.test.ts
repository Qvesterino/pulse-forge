import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  QMR_COMMAND_EVENT,
  QMR_COMMAND_RESPONSE_EVENT,
  listenForCommands,
  type QmrCommandResponseDetail,
  type QmrHostCommand,
  type QmrHostCommandResult,
} from "../src/interop/qmrCommandBus";

/**
 * QMR COMMAND BUS — the host side of the ecosystem command channel.
 *
 * The HUD (the sibling monorepo's @qvester/qmr-hud) dispatches into the host
 * app over `qmr:command` and waits for a `qmr:command-response` ack matched
 * by requestId. KYX is the HOST, so it owns this channel outright
 * (src/interop/qmrCommandBus.ts) — it used to BORROW the HUD's own copy,
 * which made KYX's build depend on a second repository and killed five CI
 * jobs on 2026-10-28.
 *
 * These specs pin the protocol, and the last one pins it against the sibling
 * itself: if the ecosystem side ever renames an event, this goes red instead
 * of the chip silently disconnecting.
 */

const repoRoot = path.resolve(__dirname, "..");

function dispatchCommand(detail: { requestId: string; appId: string; command: QmrHostCommand }): void {
  window.dispatchEvent(new CustomEvent(QMR_COMMAND_EVENT, { detail }));
}

/** Resolve with the ack for this requestId (or reject on timeout). */
function awaitAck(requestId: string, timeoutMs = 1000): Promise<QmrHostCommandResult> {
  return new Promise((resolveAck, rejectAck) => {
    const timer = setTimeout(() => {
      window.removeEventListener(QMR_COMMAND_RESPONSE_EVENT, onResponse);
      rejectAck(new Error(`no ack for ${requestId}`));
    }, timeoutMs);
    const onResponse = (event: Event): void => {
      const detail = (event as CustomEvent<QmrCommandResponseDetail>).detail;
      if (!detail || detail.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener(QMR_COMMAND_RESPONSE_EVENT, onResponse);
      resolveAck(detail.result);
    };
    window.addEventListener(QMR_COMMAND_RESPONSE_EVENT, onResponse);
  });
}

describe("QMR command bus (host side)", () => {
  it("answers a command addressed to this app with the handler's result", async () => {
    const seen: QmrHostCommand[] = [];
    const teardown = listenForCommands("pulse_forge", (command) => {
      seen.push(command);
      return { ok: true, message: "done" };
    });

    const ack = awaitAck("req-1");
    dispatchCommand({ requestId: "req-1", appId: "pulse_forge", command: { type: "edit.undo" } });

    await expect(ack).resolves.toEqual({ ok: true, message: "done" });
    expect(seen).toEqual([{ type: "edit.undo" }]);
    teardown();
  });

  it("ignores a command addressed to another app (and never acks it)", async () => {
    const teardown = listenForCommands("pulse_forge", () => ({ ok: true }));
    let acked = false;
    const onResponse = (): void => {
      acked = true;
    };
    window.addEventListener(QMR_COMMAND_RESPONSE_EVENT, onResponse);

    dispatchCommand({ requestId: "req-2", appId: "some_other_app", command: { type: "edit.undo" } });
    await new Promise((r) => setTimeout(r, 20));

    expect(acked).toBe(false);
    window.removeEventListener(QMR_COMMAND_RESPONSE_EVENT, onResponse);
    teardown();
  });

  it("acks { ok: true } when the handler returns nothing (handled, no result)", async () => {
    const teardown = listenForCommands("pulse_forge", () => undefined);
    const ack = awaitAck("req-3");
    dispatchCommand({ requestId: "req-3", appId: "pulse_forge", command: { type: "edit.redo" } });
    await expect(ack).resolves.toEqual({ ok: true });
    teardown();
  });

  it("acks { ok: false, message } when the handler throws", async () => {
    const teardown = listenForCommands("pulse_forge", () => {
      throw new Error("tool exploded");
    });
    const ack = awaitAck("req-4");
    dispatchCommand({ requestId: "req-4", appId: "pulse_forge", command: { type: "kyx_song" } });
    await expect(ack).resolves.toEqual({ ok: false, message: "tool exploded" });
    teardown();
  });

  it("awaits an async handler before acking", async () => {
    const teardown = listenForCommands("pulse_forge", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, message: "late" };
    });
    const ack = awaitAck("req-5");
    dispatchCommand({ requestId: "req-5", appId: "pulse_forge", command: { type: "edit.undo" } });
    await expect(ack).resolves.toEqual({ ok: true, message: "late" });
    teardown();
  });

  it("the teardown removes the listener (the app stops answering)", async () => {
    let calls = 0;
    const teardown = listenForCommands("pulse_forge", () => {
      calls += 1;
      return { ok: true };
    });
    dispatchCommand({ requestId: "req-6", appId: "pulse_forge", command: { type: "edit.undo" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);

    teardown();
    dispatchCommand({ requestId: "req-7", appId: "pulse_forge", command: { type: "edit.undo" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
  });

  it("the sibling's command bus declares the SAME event names (protocol drift guard)", () => {
    const siblingRoot = process.env.QVESTER_SIBLING_ROOT ?? path.join(repoRoot, "..", "QVESTER_LANDING_PAGE");
    const siblingBus = path.join(siblingRoot, "packages", "qmr-hud", "src", "command-bus.ts");
    if (!existsSync(siblingBus)) {
      // No sibling checkout here (CI, a clean clone). The literals above are
      // the contract; the sibling side cannot be compared from this tree.
      expect(QMR_COMMAND_EVENT).toBe("qmr:command");
      expect(QMR_COMMAND_RESPONSE_EVENT).toBe("qmr:command-response");
      return;
    }
    const text = readFileSync(siblingBus, "utf8");
    expect(text).toMatch(new RegExp(`QMR_COMMAND_EVENT\\s*=\\s*['"\`]${QMR_COMMAND_EVENT}['"\`]`));
    expect(text).toMatch(new RegExp(`QMR_COMMAND_RESPONSE_EVENT\\s*=\\s*['"\`]${QMR_COMMAND_RESPONSE_EVENT}['"\`]`));
  });
});
