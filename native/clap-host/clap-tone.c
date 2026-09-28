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
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "clap/clap.h"
#include "clap/ext/params.h"
#include "clap/ext/state.h"

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
static double TONE_FREQ = 440.0;
/* State serialization: the raw little-endian frequency, 8 bytes. */
#define TONE_STATE_BYTES 8
#define TONE_PARAM_FREQ 7001

static void CLAP_ABI tone_apply_param_events(const clap_input_events_t *in) {
  if (!in) return;
  const uint32_t count = in->size(in);
  for (uint32_t i = 0; i < count; i++) {
    const clap_event_header_t *header = in->get(in, i);
    if (!header || header->type != CLAP_EVENT_PARAM_VALUE) continue;
    const clap_event_param_value_t *event = (const clap_event_param_value_t *)header;
    if (event->param_id == TONE_PARAM_FREQ) TONE_FREQ = event->value;
  }
}

static const clap_plugin_descriptor_t *tone_descriptor(const struct clap_plugin_factory *factory, uint32_t index) {
  (void)factory;
  return index == 0 ? &TONE_DESCRIPTOR : NULL;
}

static uint32_t CLAP_ABI tone_count(const struct clap_plugin_factory *factory) {
  (void)factory;
  return 1;
}

static void CLAP_ABI tone_apply_param_events(const clap_input_events_t *in);
static uint32_t CLAP_ABI params_count(const struct clap_plugin *plugin);
static bool CLAP_ABI params_get_info(const struct clap_plugin *plugin, uint32_t index, clap_param_info_t *info);
static bool CLAP_ABI params_get_value(const struct clap_plugin *plugin, clap_id param_id, double *out_value);
static bool CLAP_ABI params_value_to_text(const struct clap_plugin *plugin, clap_id param_id, double value,
                                          char *out_buffer, uint32_t out_buffer_size);
static bool CLAP_ABI params_text_to_value(const struct clap_plugin *plugin, clap_id param_id, const char *text,
                                          double *out_value);
static void CLAP_ABI params_flush(const struct clap_plugin *plugin, const clap_input_events_t *in,
                                  const clap_output_events_t *out);

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
  tone_apply_param_events(process->in_events);
  const int64_t steady = process->steady_time >= 0 ? process->steady_time : 0;
  const double step = 6.283185307179586476925286766559 * TONE_FREQ / TONE_RATE;
  for (uint32_t ch = 0; ch < process->audio_outputs_count; ch++) {
    float *out = process->audio_outputs[ch].data32;
    if (!out) continue;
    for (uint32_t n = 0; n < process->frames_count; n++) {
      out[n] = (float)(0.25 * sin(step * (double)(steady + (int64_t)n)));
    }
  }
  return CLAP_PROCESS_CONTINUE;
}

static uint32_t CLAP_ABI params_count(const struct clap_plugin *plugin) {
  (void)plugin;
  return 1;
}

static bool CLAP_ABI params_get_info(const struct clap_plugin *plugin, uint32_t index, clap_param_info_t *info) {
  (void)plugin;
  if (index != 0 || !info) return false;
  info->id = TONE_PARAM_FREQ;
  info->flags = CLAP_PARAM_IS_AUTOMATABLE;
  info->cookie = NULL;
  snprintf(info->name, sizeof(info->name), "Tone Frequency");
  snprintf(info->module, sizeof(info->module), "tone");
  info->min_value = 50.0;
  info->max_value = 2000.0;
  info->default_value = 440.0;
  return true;
}

static bool CLAP_ABI params_get_value(const struct clap_plugin *plugin, clap_id param_id, double *out_value) {
  (void)plugin;
  if (param_id != TONE_PARAM_FREQ || !out_value) return false;
  *out_value = TONE_FREQ;
  return true;
}

static bool CLAP_ABI params_value_to_text(const struct clap_plugin *plugin, clap_id param_id, double value,
                                          char *out_buffer, uint32_t out_buffer_size) {
  (void)plugin;
  (void)param_id;
  if (!out_buffer || out_buffer_size == 0) return false;
  snprintf(out_buffer, out_buffer_size, "%.1f Hz", value);
  return true;
}

static bool CLAP_ABI params_text_to_value(const struct clap_plugin *plugin, clap_id param_id, const char *text,
                                          double *out_value) {
  (void)plugin;
  if (param_id != TONE_PARAM_FREQ || !text || !out_value) return false;
  *out_value = atof(text);
  return true;
}

static void CLAP_ABI params_flush(const struct clap_plugin *plugin, const clap_input_events_t *in,
                                  const clap_output_events_t *out) {
  (void)plugin;
  (void)out;
  tone_apply_param_events(in);
}

/* ---- state extension: the frequency survives host save/load ---- */

static bool CLAP_ABI state_save(const struct clap_plugin *plugin, const clap_ostream_t *stream) {
  (void)plugin;
  if (!stream || !stream->write) return false;
  /* Little-endian double: the same encoding the host writes to disk. */
  return stream->write(stream, &TONE_FREQ, TONE_STATE_BYTES) == TONE_STATE_BYTES;
}

static bool CLAP_ABI state_load(const struct clap_plugin *plugin, const clap_istream_t *stream) {
  (void)plugin;
  if (!stream || !stream->read) return false;
  double freq = 440.0;
  if (stream->read(stream, &freq, TONE_STATE_BYTES) != TONE_STATE_BYTES) return false;
  /* Reject garbage: the frequency must stay inside the declared range. */
  if (!(freq >= 50.0 && freq <= 2000.0)) return false;
  TONE_FREQ = freq;
  return true;
}

static const void *CLAP_ABI tone_get_extension(const struct clap_plugin *plugin, const char *id) {
  (void)plugin;
  if (strcmp(id, CLAP_EXT_PARAMS) == 0) {
    static const clap_plugin_params_t PARAMS = {
        .count = params_count,
        .get_info = params_get_info,
        .get_value = params_get_value,
        .value_to_text = params_value_to_text,
        .text_to_value = params_text_to_value,
        .flush = params_flush,
    };
    return &PARAMS;
  }
  if (strcmp(id, CLAP_EXT_STATE) == 0) {
    static const clap_plugin_state_t STATE = {
        .save = state_save,
        .load = state_load,
    };
    return &STATE;
  }
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
