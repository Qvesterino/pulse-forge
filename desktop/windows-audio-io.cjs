const crypto = require("node:crypto");
const path = require("node:path");

const SESSION_SCRIPT = path.join(__dirname, "windows-audio-session-host.cjs");
const STOP_TIMEOUT_MS = 1_500;
const KILL_EXIT_TIMEOUT_MS = 1_500;

function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Windows audio request must be an object");
  if (value.backend !== "wasapi-shared") throw new Error("Only shared-mode WASAPI is available");
  for (const key of ["inputEndpointId", "outputEndpointId"]) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0 || value[key].length > 2_048)
      throw new Error(`${key} must be an exact endpoint ID`);
  }
  if (!Number.isSafeInteger(value.sampleRateHz) || value.sampleRateHz < 8_000 || value.sampleRateHz > 384_000)
    throw new Error("sampleRateHz must be an integer between 8000 and 384000");
  if (!Number.isSafeInteger(value.periodFrames) || value.periodFrames < 128 || value.periodFrames > 8_192)
    throw new Error("periodFrames must be an integer between 128 and 8192");
  for (const key of ["inputChannelMap", "outputChannelMap"]) {
    const map = value[key];
    if (
      !Array.isArray(map) ||
      map.length < 1 ||
      map.length > 2 ||
      map.some((channel) => !Number.isSafeInteger(channel) || channel < 0 || channel > 31) ||
      new Set(map).size !== map.length
    )
      throw new Error(`${key} must contain one or two unique hardware channel indexes`);
  }
  if (value.outputChannelMap.length !== 2) throw new Error("The KYX master output needs a stereo channel pair");
  if (value.exclusiveAcknowledged !== false)
    throw new Error("Shared mode cannot request exclusive-mode acknowledgement");
  return {
    backend: "wasapi-shared",
    inputEndpointId: value.inputEndpointId,
    outputEndpointId: value.outputEndpointId,
    sampleRateHz: value.sampleRateHz,
    periodFrames: value.periodFrames,
    inputChannelMap: [...value.inputChannelMap],
    outputChannelMap: [...value.outputChannelMap],
    exclusiveAcknowledged: false,
  };
}

function ringCapacityFramesForPeriod(periodFrames) {
  if (!Number.isSafeInteger(periodFrames) || periodFrames < 128 || periodFrames > 8_192)
    throw new Error("periodFrames must be an integer between 128 and 8192");
  const minimumFrames = periodFrames * 4;
  let capacityFrames = 1;
  while (capacityFrames < minimumFrames) capacityFrames *= 2;
  return capacityFrames;
}

function registerWindowsAudioIoHandlers(ipcMain, options = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("Electron ipcMain is required");
  const utilityProcess = options.utilityProcess;
  const MessageChannelMain = options.MessageChannelMain;
  const isTrustedSender = options.isTrustedSender ?? (() => false);
  if (!utilityProcess || typeof utilityProcess.fork !== "function")
    throw new Error("Electron utilityProcess is required");
  if (typeof MessageChannelMain !== "function") throw new Error("Electron MessageChannelMain is required");
  const sessions = new Map();
  const senderCleanup = new Map();

  function watchSender(webContents) {
    if (!webContents || senderCleanup.has(webContents.id)) return;
    const cleanup = () => {
      senderCleanup.delete(webContents.id);
      void stopOwned(webContents.id);
    };
    senderCleanup.set(webContents.id, cleanup);
    webContents.once("destroyed", cleanup);
  }

  function waitForExit(session) {
    if (session.exited) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let gracefulTimer;
      let killTimer;
      let settled = false;
      const cleanup = () => {
        clearTimeout(gracefulTimer);
        clearTimeout(killTimer);
        session.host.removeListener?.("exit", onExit);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onExit = () => {
        session.exited = true;
        finish();
      };
      session.host.once("exit", onExit);
      gracefulTimer = setTimeout(() => {
        if (session.exited) {
          finish();
          return;
        }
        try {
          session.host.kill();
        } catch (error) {
          fail(new Error(`Could not terminate the Windows audio utility: ${String(error)}`));
          return;
        }
        if (session.exited) {
          finish();
          return;
        }
        killTimer = setTimeout(() => {
          if (session.exited) finish();
          else fail(new Error("Windows audio utility did not exit after termination was requested"));
        }, KILL_EXIT_TIMEOUT_MS);
      }, STOP_TIMEOUT_MS);
    });
  }

  async function stopSession(session) {
    if (session.stopping) return session.stopPromise;
    session.stopping = true;
    session.stopPromise = (async () => {
      try {
        session.host.postMessage({ type: "stop", sessionId: session.id });
      } catch {
        if (!session.exited) session.host.kill();
      }
      await waitForExit(session);
      sessions.delete(session.id);
    })().catch((error) => {
      session.stopping = false;
      session.stopPromise = null;
      throw error;
    });
    return session.stopPromise;
  }

  async function stopOwned(senderId) {
    const owned = [...sessions.values()].filter((session) => session.senderId === senderId);
    await Promise.all(owned.map((session) => stopSession(session)));
    const sender = owned[0]?.sender;
    const cleanup = senderCleanup.get(senderId);
    if (cleanup) {
      sender?.removeListener?.("destroyed", cleanup);
      senderCleanup.delete(senderId);
    }
  }

  async function start(event, payload) {
    if (!isTrustedSender(event)) throw new Error("Windows audio sessions are only available to the trusted KYX window");
    const request = validateRequest(payload);
    await stopOwned(event.sender.id);
    const id = crypto.randomUUID();
    const host = utilityProcess.fork(SESSION_SCRIPT, [], { cwd: __dirname });
    const session = {
      id,
      senderId: event.sender.id,
      sender: event.sender,
      host,
      exited: false,
      stopping: false,
      stopPromise: null,
    };
    sessions.set(id, session);
    watchSender(event.sender);
    const onHostMessage = (message) => {
      if (
        !message ||
        typeof message !== "object" ||
        message.type !== "windows-audio-session-stage" ||
        message.sessionId !== id ||
        typeof message.stage !== "string" ||
        message.stage.length === 0 ||
        message.stage.length > 256
      )
        return;
      try {
        event.sender.postMessage("kyx:audio:windows-session-stage", { sessionId: id, stage: message.stage });
      } catch {
        /* A closing window cannot receive diagnostic progress. */
      }
    };
    host.on("message", onHostMessage);
    host.once("exit", () => {
      host.removeListener("message", onHostMessage);
      session.exited = true;
      sessions.delete(id);
    });
    const { port1, port2 } = new MessageChannelMain();
    try {
      host.postMessage({ type: "start", sessionId: id, request }, [port1]);
      event.sender.postMessage("kyx:audio:windows-session-port", { sessionId: id }, [port2]);
    } catch (error) {
      try {
        port1.close();
        port2.close();
      } catch {
        /* transfer may already have closed the sender's port */
      }
      await stopSession(session);
      throw error;
    }
    return { status: "starting", sessionId: id };
  }

  ipcMain.handle("kyx:audio:windows-start", start);
  ipcMain.handle("kyx:audio:windows-stop", async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Windows audio sessions are only available to the trusted KYX window");
    const id = payload && typeof payload.sessionId === "string" ? payload.sessionId : "";
    const session = sessions.get(id);
    if (!session || session.senderId !== event.sender.id) return { status: "stopped" };
    await stopSession(session);
    return { status: "stopped" };
  });

  return {
    stopAll: async () => Promise.all([...sessions.values()].map((session) => stopSession(session))),
    activeSessions: () => [...sessions.keys()],
  };
}

module.exports = { registerWindowsAudioIoHandlers, ringCapacityFramesForPeriod, validateRequest };
