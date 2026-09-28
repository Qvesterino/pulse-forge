/*
 * KYX CLAP player (ADR 0016, audio-hosting wave) — loads ONE .clap by DLL
 * path, instantiates its first plugin, activates it and runs a bounded
 * number of process() cycles with silent input, emitting the plugin's
 * stereo float32 output as ADR 0018 frames on stdout. Same transport
 * contract pcm-gen proved out; the Node side reuses PcmPipeSource as-is.
 *
 * This is the minimal REAL hosting path: DllGetClassObject-free, spec
 * default stereo I/O (no audio-ports extension assumed), no extensions
 * queried, an empty input event queue and a discard sink for output events.
 * Parameter/state/GUI extensions are later waves.
 *
 * Usage: clap-player --dll <path> [--seconds 2] [--rate 48000] [--block 480]
 * Exit:  0 = ran (plugin errors reported as JSON frames), 3 = env, 4 = usage.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "clap/clap.h"
#include "clap/ext/params.h"

static void writeFrame(FILE *out, unsigned char type, unsigned long seq, const void *payload, unsigned long len) {
  unsigned char header[16];
  header[0] = 'K';
  header[1] = 'Y';
  header[2] = 'X';
  header[3] = 'P';
  header[4] = type;
  header[5] = 0;
  header[6] = 0;
  header[7] = 0;
  memcpy(header + 8, &seq, 4);
  memcpy(header + 12, &len, 4);
  fwrite(header, 1, sizeof(header), out);
  if (len > 0) fwrite(payload, 1, len, out);
  fflush(out);
}

static void writeJsonFrame(FILE *out, unsigned char type, const char *json) {
  writeFrame(out, type, 0, json, (unsigned long)strlen(json));
}

/* ---- host stub: identity only, no extensions ---- */

static const void *CLAP_ABI hostGetExtension(const struct clap_host *host, const char *extensionId) {
  (void)host;
  (void)extensionId;
  return NULL;
}

static void CLAP_ABI hostRequestNoop(const struct clap_host *host) {
  (void)host;
}

static const clap_host_t HOST = {
    .clap_version = CLAP_VERSION_INIT,
    .host_data = NULL,
    .name = "KYX",
    .vendor = "KYX (Pulse Forge)",
    .url = "",
    .version = "1.0.0",
    .get_extension = hostGetExtension,
    .request_restart = hostRequestNoop,
    .request_process = hostRequestNoop,
    .request_callback = hostRequestNoop,
};

/* ---- event queues: one optional PARAM_VALUE in, discard out ---- */

static void CLAP_ABI outEventsTryPush(const struct clap_output_events *list, const clap_event_header_t *event) {
  (void)list;
  (void)event;
}

/* Input queue: zero or one queued PARAM_VALUE event (--set), delivered at
   sample 0 of the first process call. */
static clap_event_param_value_t g_paramEvent;
static int g_paramEventQueued = 0;

static uint32_t CLAP_ABI inEventsSize(const struct clap_input_events *list) {
  (void)list;
  return g_paramEventQueued ? 1 : 0;
}

static const clap_event_header_t *CLAP_ABI inEventsGet(const struct clap_input_events *list, uint32_t index) {
  (void)list;
  if (index != 0 || !g_paramEventQueued) return NULL;
  return &g_paramEvent.header;
}

static clap_input_events_t g_inEvents = {NULL, inEventsSize, inEventsGet};
static clap_output_events_t g_outEvents = {NULL, outEventsTryPush};

int main(int argc, char **argv) {
  const wchar_t *dllPath = NULL;
  double seconds = 2;
  long rate = 48000;
  long block = 480;
  int realtime = 0;
  int queuedParam = 0;
  double queuedParamValue = 0;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--realtime") == 0) {
      realtime = 1;
      continue;
    }
    if (i + 1 >= argc) break;
    if (strcmp(argv[i], "--dll") == 0) {
      const int w = MultiByteToWideChar(CP_UTF8, 0, argv[i + 1], -1, NULL, 0);
      if (w <= 0 || w >= MAX_PATH) return 4;
      wchar_t *wide = (wchar_t *)malloc(sizeof(wchar_t) * w);
      MultiByteToWideChar(CP_UTF8, 0, argv[i + 1], -1, wide, w);
      dllPath = wide;
      i++;
    } else if (strcmp(argv[i], "--seconds") == 0) {
      seconds = atof(argv[i + 1]);
      i++;
    } else if (strcmp(argv[i], "--rate") == 0) {
      rate = atol(argv[i + 1]);
      i++;
    } else if (strcmp(argv[i], "--block") == 0) {
      block = atol(argv[i + 1]);
      i++;
    } else if (strcmp(argv[i], "--set") == 0) {
      queuedParamValue = atof(argv[i + 1]);
      queuedParam = 1;
      i++;
    }
  }
  if (!dllPath || seconds <= 0 || seconds > 3600 || block < 16 || block > 8192 || rate < 8000 || rate > 192000) {
    fprintf(stderr, "usage: clap-player --dll <path> [--seconds N] [--rate HZ] [--block N]\n");
    return 4;
  }
  if (_setmode(_fileno(stdout), _O_BINARY) == -1) return 3;
  /* --realtime paces blocks like a driver clock — the listening path needs
     realtime delivery, not a burst. 1 ms timer resolution keeps Sleep honest. */
  if (realtime) timeBeginPeriod(1);

  HMODULE module = LoadLibraryW(dllPath);
  if (!module) {
    fprintf(stderr, "clap-player: LoadLibraryW failed (gle=%lu)\n", (unsigned long)GetLastError());
    return 2;
  }
  const clap_plugin_entry_t *entry =
      (const clap_plugin_entry_t *)(void *)GetProcAddress(module, "clap_entry");
  if (!entry) {
    fprintf(stderr, "clap-player: no clap_entry export\n");
    return 2;
  }
  if (!clap_version_is_compatible(entry->clap_version)) {
    fprintf(stderr, "clap-player: incompatible CLAP version\n");
    return 3;
  }
  if (!entry->init("")) {
    fprintf(stderr, "clap-player: clap_entry.init refused\n");
    return 3;
  }

  const clap_plugin_factory_t *factory =
      (const clap_plugin_factory_t *)entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
  if (!factory || factory->get_plugin_count(factory) < 1) {
    writeJsonFrame(stdout, 2, "{\"error\":\"no-plugins\"}");
    entry->deinit();
    FreeLibrary(module);
    return 0;
  }
  const clap_plugin_descriptor_t *desc = factory->get_plugin_descriptor(factory, 0);
  const clap_plugin_t *plugin = factory->create_plugin(factory, &HOST, desc->id);
  if (!plugin || !plugin->init || !plugin->process) {
    writeJsonFrame(stdout, 2, "{\"error\":\"instantiate-failed\"}");
    entry->deinit();
    FreeLibrary(module);
    return 0;
  }
  if (!plugin->init(plugin)) {
    writeJsonFrame(stdout, 2, "{\"error\":\"plugin-init-failed\"}");
    entry->deinit();
    FreeLibrary(module);
    return 0;
  }

  if (!plugin->activate(plugin, (double)rate, 1, 8192)) {
    writeJsonFrame(stdout, 2, "{\"error\":\"activate-failed\"}");
    plugin->destroy(plugin);
    entry->deinit();
    FreeLibrary(module);
    return 0;
  }

  char event[160];
  snprintf(event, sizeof(event),
           "{\"rate\":%ld,\"channels\":2,\"blockFrames\":%ld,\"plugin\":\"%s\"}", rate, block,
           desc->id ? desc->id : "?");
  writeJsonFrame(stdout, 2, event);

  /* Params extension: list them (bounded) and build the queued --set event. */
  const clap_plugin_params_t *params =
      (const clap_plugin_params_t *)plugin->get_extension(plugin, CLAP_EXT_PARAMS);
  if (params) {
    const uint32_t paramCount = params->count(plugin);
    char paramsJson[2048];
    unsigned long pos = 0;
    pos += (unsigned long)snprintf(paramsJson + pos, sizeof(paramsJson) - pos, "{\"params\":[");
    for (uint32_t p = 0; p < paramCount && p < 32; p++) {
      clap_param_info_t info;
      if (!params->get_info(plugin, p, &info)) continue;
      pos += (unsigned long)snprintf(paramsJson + pos, sizeof(paramsJson) - pos,
                                     "%s{\"id\":%lu,\"name\":\"%s\",\"min\":%.1f,\"max\":%.1f,\"default\":%.1f}",
                                     p > 0 ? "," : "", (unsigned long)info.id, info.name, info.min_value,
                                     info.max_value, info.default_value);
      if (queuedParam && p == 0) {
        memset(&g_paramEvent, 0, sizeof(g_paramEvent));
        g_paramEvent.header.size = sizeof(clap_event_param_value_t);
        g_paramEvent.header.time = 0;
        g_paramEvent.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
        g_paramEvent.header.type = CLAP_EVENT_PARAM_VALUE;
        g_paramEvent.header.flags = 0;
        g_paramEvent.param_id = info.id;
        g_paramEvent.cookie = info.cookie;
        g_paramEvent.note_id = -1;
        g_paramEvent.port_index = -1;
        g_paramEvent.channel = -1;
        g_paramEvent.key = -1;
        g_paramEvent.value = queuedParamValue;
        g_paramEventQueued = 1;
      }
    }
    pos += (unsigned long)snprintf(paramsJson + pos, sizeof(paramsJson) - pos, "]}");
    writeJsonFrame(stdout, 2, paramsJson);
  }

  /* Stereo float32 output buffers, silent input, empty event queues. */
  float buffers[2][8192];
  float *interleaved = (float *)malloc(sizeof(float) * 8192 * 2);
  if (!interleaved) return 3;
  clap_audio_buffer_t outputs[2];
  for (long ch = 0; ch < 2; ch++) {
    outputs[ch].data32 = buffers[ch];
    outputs[ch].data64 = NULL;
    outputs[ch].channel_count = 1;
    outputs[ch].latency = 0;
    outputs[ch].constant_mask = 0;
  }
  const unsigned long totalFrames = (unsigned long)((double)rate * seconds);
  unsigned long written = 0;
  unsigned long seq = 0;
  int64_t steady = 0;

  plugin->start_processing(plugin);
  while (written < totalFrames) {
    unsigned long frames = totalFrames - written;
    if (frames > (unsigned long)block) frames = (unsigned long)block;
    clap_process_t process;
    memset(&process, 0, sizeof(process));
    process.steady_time = steady;
    process.frames_count = (uint32_t)frames;
    process.transport = NULL; /* free-running host: the plugin synthesizes */
    process.audio_inputs = NULL;
    process.audio_inputs_count = 0;
    process.audio_outputs = outputs;
    process.audio_outputs_count = 2;
    process.in_events = &g_inEvents;
    process.out_events = &g_outEvents;

    const clap_process_status status = plugin->process(plugin, &process);
    if (status == CLAP_PROCESS_ERROR) break;
    /* Interleave L/R into one frame block (ADR 0018 PCM is interleaved). */
    for (unsigned long n = 0; n < frames; n++) {
      interleaved[n * 2] = buffers[0][n];
      interleaved[n * 2 + 1] = buffers[1][n];
    }
    writeFrame(stdout, 1, seq++, interleaved, (unsigned long)(sizeof(float) * frames * 2));
    written += frames;
    steady += (int64_t)frames;
    if (realtime) Sleep((DWORD)((double)frames / rate * 1000.0 + 0.5));
  }
  plugin->stop_processing(plugin);
  plugin->deactivate(plugin);
  plugin->destroy(plugin);

  char stats[128];
  snprintf(stats, sizeof(stats), "{\"framesWritten\":%lu,\"blocksWritten\":%lu}", written, seq);
  writeJsonFrame(stdout, 3, stats);
  writeJsonFrame(stdout, 4, "{}");
  fflush(stdout);
  if (realtime) timeEndPeriod(1);

  free(interleaved);
  entry->deinit();
  FreeLibrary(module);
  return 0;
}
