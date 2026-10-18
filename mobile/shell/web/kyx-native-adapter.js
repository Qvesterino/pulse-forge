/**
 * Spike adapter: Capacitor plugin -> window.kyxNative (ADR 0052).
 *
 * Inject this BEFORE the app's first module script (onPageStarted / a shell
 * preload hook). The web contract validates method shapes; if the plugin is
 * missing or a method rejects, the normal PWA fallback remains active.
 *
 * The native plugin is a skeleton in this spike; every method rejects until
 * the MIDI/SAF/service/focus implementation lands. Do not claim support before
 * a real-device acceptance run.
 */
(function installKyxNativeBridge() {
  const Capacitor = window.Capacitor;
  const plugin = Capacitor && Capacitor.Plugins && Capacitor.Plugins.KyxNative;
  if (!plugin) return;

  const listener = (eventName, callback) => {
    let handle = null;
    let removed = false;
    try {
      handle = plugin.addListener(eventName, callback);
    } catch {
      return () => {};
    }
    return () => {
      if (removed) return;
      removed = true;
      Promise.resolve(handle)
        .then((h) => h && h.remove && h.remove())
        .catch(() => {});
    };
  };

  window.kyxNative = {
    platform: "android",
    midi: {
      listInputs: () => plugin.listMidiInputs().then((r) => (r && r.ports) || []),
      listOutputs: () => plugin.listMidiOutputs().then((r) => (r && r.ports) || []),
      send: (outputId, data) => plugin.sendMidi({ outputId, data }),
      subscribe: (callback) =>
        listener("midi", (event) => {
          if (event && typeof event.inputId === "string" && Array.isArray(event.data)) callback(event);
        }),
      onStateChange: (callback) => listener("midiState", callback),
    },
    files: {
      pickDocuments: (options) => plugin.pickDocuments(options || {}).then((r) => (r && r.files) || []),
      saveDocument: (payload) => plugin.saveDocument(payload),
    },
    audioSession: {
      acquire: (reason) => plugin.acquireAudioSession({ reason }),
      release: (reason) => plugin.releaseAudioSession({ reason }),
      subscribeFocus: (callback) =>
        listener("audioFocus", (event) => {
          if (event && typeof event.focused === "boolean") callback(event.focused);
        }),
    },
  };
})();
