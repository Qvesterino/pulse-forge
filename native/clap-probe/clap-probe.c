/**
 * KYX CLAP probe (ADR 0016) — out-of-process plugin scanner.
 *
 * Loads ONE .clap binary, walks its clap_plugin_factory and prints one JSON
 * line per discovered plugin descriptor to stdout, then exits. It never
 * instantiates plugins and never processes audio: the crash isolation story
 * (a hostile plugin can only take this process down, not the DAW) is the
 * whole point of living out-of-process. The Node-side manager iterates files
 * so a hung or crashing DLL costs one probe process, killed on timeout.
 *
 * Usage:   clap-probe.exe <path-to-.clap>
 * Stdout:  one JSON object per plugin (UTF-8, escaped per RFC 8259)
 * Stderr:  human diagnostics
 * Exit:    0 = probed (including "factory is empty")
 *          2 = not a CLAP binary (load failure or missing clap_entry)
 *          3 = clap_entry found but version incompatible or init() refused
 *          4 = usage error
 *
 * Windows-only in Wave 1 (mirrors the ADR platform matrix); the macOS side
 * rides the native/mrt2-host pattern later.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "clap/clap.h"

static void print_json_string(const char *s) {
  if (!s) {
    fputs("null", stdout);
    return;
  }
  fputc('"', stdout);
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    switch (*p) {
    case '"':
      fputs("\\\"", stdout);
      break;
    case '\\':
      fputs("\\\\", stdout);
      break;
    case '\b':
      fputs("\\b", stdout);
      break;
    case '\f':
      fputs("\\f", stdout);
      break;
    case '\n':
      fputs("\\n", stdout);
      break;
    case '\r':
      fputs("\\r", stdout);
      break;
    case '\t':
      fputs("\\t", stdout);
      break;
    default:
      // CLAP strings are UTF-8; bytes >= 0x20 pass through untouched so the
      // output stays byte-exact UTF-8 (RFC 8259 allows any non-control byte).
      if (*p < 0x20) {
        printf("\\u%04x", *p);
      } else {
        fputc(*p, stdout);
      }
    }
  }
  fputc('"', stdout);
}

static void print_field(const char *key, const char *value) {
  fputs(",\"", stdout);
  fputs(key, stdout);
  fputs("\":", stdout);
  print_json_string(value);
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: clap-probe <path-to-.clap>\n");
    return 4;
  }

  // Wide load, UTF-8 argument to init(): the CLAP spec carries UTF-8 paths.
  const int wLen = MultiByteToWideChar(CP_UTF8, 0, argv[1], -1, NULL, 0);
  if (wLen <= 0) {
    fprintf(stderr, "probe: path is not valid UTF-8\n");
    return 4;
  }
  wchar_t widePath[MAX_PATH];
  if (wLen >= MAX_PATH) {
    fprintf(stderr, "probe: path too long\n");
    return 4;
  }
  MultiByteToWideChar(CP_UTF8, 0, argv[1], -1, widePath, wLen);

  HMODULE module = LoadLibraryW(widePath);
  if (!module) {
    fprintf(stderr, "probe: LoadLibraryW failed (gle=%lu)\n", (unsigned long)GetLastError());
    return 2;
  }

  const clap_plugin_entry *entry = (const clap_plugin_entry *)(void *)GetProcAddress(module, "clap_entry");
  if (!entry) {
    fprintf(stderr, "probe: no clap_entry export\n");
    FreeLibrary(module);
    return 2;
  }
  if (!clap_version_is_compatible(entry->clap_version)) {
    fprintf(stderr, "probe: incompatible CLAP version %u.%u.%u\n", entry->clap_version.major,
            entry->clap_version.minor, entry->clap_version.revision);
    FreeLibrary(module);
    return 3;
  }
  if (!entry->init(argv[1])) {
    fprintf(stderr, "probe: clap_entry.init refused the plugin\n");
    FreeLibrary(module);
    return 3;
  }

  const clap_plugin_factory *factory =
      (const clap_plugin_factory *)entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
  if (factory) {
    const uint32_t count = factory->get_plugin_count(factory);
    for (uint32_t i = 0; i < count; i++) {
      const clap_plugin_descriptor_t *desc = factory->get_plugin_descriptor(factory, i);
      if (!desc) continue;
      fputs("{\"index\":", stdout);
      printf("%u", i);
      print_field("id", desc->id);
      print_field("name", desc->name);
      print_field("vendor", desc->vendor);
      print_field("url", desc->url);
      print_field("manualUrl", desc->manual_url);
      print_field("supportUrl", desc->support_url);
      print_field("version", desc->version);
      print_field("description", desc->description);
      fputs(",\"features\":[", stdout);
      if (desc->features) {
        int first = 1;
        for (const char *const *f = desc->features; *f; f++) {
          if (!first) fputc(',', stdout);
          first = 0;
          print_json_string(*f);
        }
      }
      fputs("]}", stdout);
      fputc('\n', stdout);
    }
  }

  entry->deinit();
  FreeLibrary(module);
  fflush(stdout);
  return 0;
}
