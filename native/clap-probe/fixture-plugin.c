/**
 * Minimal VALID CLAP plugin — a test fixture for the probe (ADR 0016).
 * Exports `clap_entry` with a one-plugin factory whose descriptor the probe
 * must discover. create_plugin is deliberately NULL: the probe only reads
 * descriptors and must never instantiate anything.
 *
 * MSVC C notes: compound literals are not allowed in static initializers
 * (C2099), so the features list is a named static array, and every aggregate
 * uses designated initializers so field order can never drift from the SDK.
 */
#include <stdio.h>
#include <string.h>

#include "clap/clap.h"

static const char *const FIXTURE_FEATURES[] = {
    CLAP_PLUGIN_FEATURE_UTILITY,
    CLAP_PLUGIN_FEATURE_AUDIO_EFFECT,
    NULL,
};

static const clap_plugin_descriptor_t FIXTURE_DESCRIPTOR = {
    // CLAP_VERSION_INIT, not CLAP_VERSION — the 1.2.10 headers define only the INIT form.
    .clap_version = CLAP_VERSION_INIT,
    .id = "org.kyx.test.clap-fixture",
    .name = "KYX CLAP Fixture",
    .vendor = "KYX (Pulse Forge)",
    .url = "",
    .manual_url = "",
    .support_url = "",
    .version = "1.0.0",
    .description = "Probe test fixture - descriptor only",
    .features = FIXTURE_FEATURES,
};

static bool fixture_entry_init(const char *plugin_path) {
  (void)plugin_path;
  return true;
}

static void fixture_entry_noop(void) {}

static uint32_t CLAP_ABI fixture_count(const struct clap_plugin_factory *factory) {
  (void)factory;
  return 1;
}

static const clap_plugin_descriptor_t *CLAP_ABI fixture_descriptor(const struct clap_plugin_factory *factory,
                                                                   uint32_t index) {
  (void)factory;
  return index == 0 ? &FIXTURE_DESCRIPTOR : NULL;
}

// clap_plugin_entry_t::get_factory takes ONLY the factory id — the entry
// struct is dereferenced by the host, so there is no implicit first argument.
static const void *CLAP_ABI fixture_get_factory(const char *factory_id) {
  if (strcmp(factory_id, CLAP_PLUGIN_FACTORY_ID) == 0) {
    static const clap_plugin_factory_t FACTORY = {
        .get_plugin_count = fixture_count,
        .get_plugin_descriptor = fixture_descriptor,
        .create_plugin = NULL, // probe never instantiates
    };
    return &FACTORY;
  }
  return NULL;
}

__declspec(dllexport) const clap_plugin_entry_t clap_entry = {
    .clap_version = CLAP_VERSION_INIT,
    .init = fixture_entry_init,
    .deinit = fixture_entry_noop,
    .get_factory = fixture_get_factory,
};
