package app.kyx.studio

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Spike skeleton for the optional KYX Android shell (ADR 0052).
 *
 * Every method rejects deliberately: this file is the checklist for the native
 * work, not a working MIDI/SAF/foreground-service implementation. Do not ship
 * it, and do not claim support until the acceptance run in
 * mobile/shell/README.md passes on a real device.
 */
@CapacitorPlugin(name = "KyxNative")
class KyxNativePlugin : Plugin() {
    private val notImplemented =
        "KYX shell spike: implement this surface and run the device acceptance matrix before enabling it"

    @PluginMethod
    fun listMidiInputs(call: PluginCall) {
        call.reject(notImplemented)
    }

    @PluginMethod
    fun listMidiOutputs(call: PluginCall) {
        call.reject(notImplemented)
    }

    @PluginMethod
    fun sendMidi(call: PluginCall) {
        // Real implementation: MidiManager output port, bounded byte array,
        // one output thread per port, flush note-offs on disconnect.
        call.reject(notImplemented)
    }

    @PluginMethod
    fun pickDocuments(call: PluginCall) {
        // Real implementation: ACTION_OPEN_DOCUMENT + ActivityResult, return
        // { name, mimeType, bytes } only; never expose raw paths/URIs.
        call.reject(notImplemented)
    }

    @PluginMethod
    fun saveDocument(call: PluginCall) {
        // Real implementation: ACTION_CREATE_DOCUMENT, stream bytes, resolve
        // { saved: true|false, name? } on completion/cancel.
        call.reject(notImplemented)
    }

    @PluginMethod
    fun acquireAudioSession(call: PluginCall) {
        // Real implementation: foreground service (media playback / microphone
        // type) + AUDIOFOCUS_GAIN, refcounted by reason.
        call.reject(notImplemented)
    }

    @PluginMethod
    fun releaseAudioSession(call: PluginCall) {
        call.reject(notImplemented)
    }

    /** Shape for the future MIDI callback; kept here so the contract is visible. */
    fun emitMidi(inputId: String, data: IntArray) {
        val event = JSObject()
        event.put("inputId", inputId)
        event.put("data", data)
        notifyListeners("midi", event)
    }
}
