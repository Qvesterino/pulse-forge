/*
 * KYX CLAP tone fixture (ADR 0016 wave: audio hosting) — a VALID plugin that
 * MAKES SOUND: process() synthesizes 0.25·sin(2π·440·t/48000) on every
 * output channel using the host's steady_time as the absolute sample index,
 * exactly the signal pcm-gen emits. That makes the whole hosting pipeline
 * (instantiate → activate → process → frames) verifiable byte-for-byte
 * against the same formula, with zero third-party plugins.
 *
 * Audio-ports extension is deliberately NOT implemented: the spec's default
 * (stereo in/out, float32) is what a minimal host assumes, and this fixture
 * doubles as the proof that the default path works.
 */
#include <math.h>
#include <string.h>

#include "clap/clap.h"

static const char *const TONE_FEATURES[] = {
    CLAP_PLUGIN_FEATURE_UTILITY,
    CLAP_PLUGIN_FEATURE_AUDIO_EFFECT,
    NULL,
};

static const clap_plugin_descriptor_t TONE_DESCRIPTOR = {
    .clap_version = CLAP_VERSION_INIT,
    .id = "org.kyx.test.clap-tone",
    .name = "KYX CLAP Tone",
    .vendor = "KYX (Pulse Forge)",
    .url = "",
    .manual_url = "",
    .support_url = "",
    .version = "1.0.0",
    .description = "Deterministic 440 Hz stereo tone for hosting acceptance",
    .features = TONE_FEATURES,
};

static double TONE_RATE = 48000.0;

static const clap_plugin_descriptor_t *tone_descriptor(const struct clap_plugin_factory *factory, uint32_t index) {
  (void)factory;
  return index == 0 ? &TONE_DESCRIPTOR : NULL;
}

static uint32_t CLAP_ABI tone_count(const struct clap_plugin_factory *factory) {
  (void)factory;
  return 1;
}

static bool CLAP_ABI tone_init(const struct clap_plugin *plugin);
static void CLAP_ABI tone_noop_plugin(const struct clap_plugin *plugin);
static bool CLAP_ABI tone_activate(const struct clap_plugin *plugin, double sample_rate, uint32_t min_frames,
                                   uint32_t max_frames);
static clap_process_status CLAP_ABI tone_process(const struct clap_plugin *plugin, const clap_process_t *process);
static const void *CLAP_ABI tone_get_extension(const struct clap_plugin *plugin, const char *id);

static const clap_plugin_t TONE_PLUGIN = {
    .desc = &TONE_DESCRIPTOR,
    .init = tone_init,
    .destroy = tone_noop_plugin,
    .activate = tone_activate,
    .deactivate = tone_noop_plugin,
    .start_processing = tone_noop_plugin,
    .stop_processing = tone_noop_plugin,
    .process = tone_process,
    .get_extension = tone_get_extension,
    .on_main_thread = tone_noop_plugin,
};

static const clap_plugin_t *CLAP_ABI tone_create_plugin(const clap_plugin_factory_t *factory, const clap_host_t *host,
                                                        const char *plugin_id) {
  (void)factory;
  (void)host;
  return strcmp(plugin_id, TONE_DESCRIPTOR.id) == 0 ? &TONE_PLUGIN : NULL;
}

static const void *CLAP_ABI tone_get_factory(const char *factory_id) {
  if (strcmp(factory_id, CLAP_PLUGIN_FACTORY_ID) == 0) {
    static const clap_plugin_factory_t FACTORY = {
        .get_plugin_count = tone_count,
        .get_plugin_descriptor = tone_descriptor,
        .create_plugin = tone_create_plugin,
    };
    return &FACTORY;
  }
  return NULL;
}

static bool tone_init(const struct clap_plugin *plugin) {
  (void)plugin;
  return true;
}

static void tone_noop_plugin(const struct clap_plugin *plugin) {
  (void)plugin;
}

static bool tone_activate(const struct clap_plugin *plugin, double sample_rate, uint32_t min_frames,
                          uint32_t max_frames) {
  (void)plugin;
  (void)min_frames;
  (void)max_frames;
  if (sample_rate <= 0) return false;
  TONE_RATE = sample_rate;
  return true;
}

static clap_process_status CLAP_ABI tone_process(const struct clap_plugin *plugin, const clap_process_t *process) {
  (void)plugin;
  if (!process || !process->audio_outputs || process->audio_outputs_count < 1) return CLAP_PROCESS_CONTINUE;
  const int64_t steady = process->steady_time >= 0 ? process->steady_time : 0;
  const double step = 6.283185307179586476925286766559 * 440.0 / TONE_RATE;
  for (uint32_t ch = 0; ch < process->audio_outputs_count; ch++) {
    float *out = process->audio_outputs[ch].data32;
    if (!out) continue;
    for (uint32_t n = 0; n < process->frames_count; n++) {
      out[n] = (float)(0.25 * sin(step * (double)(steady + (int64_t)n)));
    }
  }
  return CLAP_PROCESS_CONTINUE;
}

static const void *CLAP_ABI tone_get_extension(const struct clap_plugin *plugin, const char *id) {
  (void)plugin;
  (void)id;
  return NULL;
}

static bool tone_entry_init(const char *plugin_path) {
  (void)plugin_path;
  return true;
}

static void tone_entry_noop(void) {}

__declspec(dllexport) const clap_plugin_entry_t clap_entry = {
    .clap_version = CLAP_VERSION_INIT,
    .init = tone_entry_init,
    .deinit = tone_entry_noop,
    .get_factory = tone_get_factory,
};
