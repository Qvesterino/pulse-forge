// KYX ASIO probe (ADR 0017) — out-of-process driver discovery.
//
// Enumerates the machine's installed ASIO drivers (HKLM\SOFTWARE\ASIO, both
// registry views) and queries each through the COM IASIO interface: name,
// version, channel counts, buffer-size range and the current sample rate.
// One JSON line per driver on stdout; exit 0 even when no driver is usable
// ("zero installed" is a valid, honest answer). It NEVER starts streaming —
// that is the wave-2 audio host's job behind this same process boundary.
//
// Uses only the Steinberg SDK HEADERS (asio.h/asiosys.h/iasiodrv.h — fetched
// per machine by scripts/vendor-asio.mjs, not redistributable) plus plain
// Win32 COM; links no SDK translation units.
//
//   asio-probe.exe              enumerate every registered driver
//   asio-probe.exe "<name>"     query a single registered driver by name
//
// Exit: 0 = probed (any number of drivers), 4 = usage error.
// JSONL fields: {name, status: "ok"|"unavailable", version?, inputs?, outputs?,
//                minBuffer?, maxBuffer?, preferredBuffer?, granularity?,
//                sampleRate?, detail?}

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <stdio.h>
#include <string.h>

#include "asio.h"
#include "asiosys.h"
#include "iasiodrv.h"

// The SDK headers leave the interface IID to the host; this is the universally
// used IASIO identifier (same constant RtAudio / PortAudio / JACK compile in).
#include <initguid.h>
DEFINE_GUID(IID_IASIO, 0x838AD971, 0xC111, 0x11D0, 0x9A, 0xCF, 0x00, 0x00, 0xC0, 0xAB, 0xC4, 0xF9);

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

// Query one driver that is already CoCreated. Prints the JSON line, returns 1
// when the driver answered, 0 when it refused (status "unavailable").
static int probeDriver(IASIO *iasio, const char *name) {
  fputs("{\"name\":", stdout);
  print_json_string(name);

  if (!iasio) {
    fputs(",\"status\":\"unavailable\",\"detail\":\"CoCreateInstance failed (32-bit-only driver in a 64-bit process, or the DLL is broken)\"}\n", stdout);
    fflush(stdout);
    return 0;
  }

  char driverName[64] = {0};
  iasio->getDriverName(driverName);
  const long version = iasio->getDriverVersion();

  char errorMessage[128] = {0};
  if (iasio->init(NULL) != ASIOTrue) {
    iasio->getErrorMessage(errorMessage);
    print_field("status", "unavailable");
    print_field("detail", errorMessage);
    fputs("}\n", stdout);
    fflush(stdout);
    iasio->Release();
    return 0;
  }

  long inputs = 0;
  long outputs = 0;
  long minBuffer = 0;
  long maxBuffer = 0;
  long preferredBuffer = 0;
  long granularity = 0;
  ASIOSampleRate sampleRate = 0;
  const bool okChannels = iasio->getChannels(&inputs, &outputs) == ASE_OK;
  const bool okBuffers = iasio->getBufferSize(&minBuffer, &maxBuffer, &preferredBuffer, &granularity) == ASE_OK;
  const bool okRate = iasio->getSampleRate(&sampleRate) == ASE_OK && sampleRate > 0;

  print_field("status", "ok");
  print_field("driverName", driverName);
  printf(",\"version\":%ld", version);
  if (okChannels) printf(",\"inputs\":%ld,\"outputs\":%ld", inputs, outputs);
  if (okBuffers) {
    printf(",\"minBuffer\":%ld,\"maxBuffer\":%ld,\"preferredBuffer\":%ld,\"granularity\":%ld", minBuffer, maxBuffer,
           preferredBuffer, granularity);
  }
  if (okRate) printf(",\"sampleRate\":%.0f", (double)sampleRate);
  fputs("}\n", stdout);
  // Pipe stdout is block-buffered: flush per line so drivers reported before
  // a later blocking driver survive the manager's kill-on-timeout.
  fflush(stdout);
  iasio->Release();
  return 1;
}

static bool readClsid(HKEY driverKey, CLSID *out) {
  wchar_t clsidString[128] = {0};
  DWORD type = 0;
  DWORD size = sizeof(clsidString) - sizeof(wchar_t);
  if (RegGetValueW(driverKey, NULL, L"CLSID", RRF_RT_REG_SZ, &type, clsidString, &size) != ERROR_SUCCESS) return false;
  return CLSIDFromString(clsidString, out) == S_OK;
}

// Enumerate one registry view; `wow64` picks KEY_WOW64_32KEY for 32-bit-only
// driver registrations. Drivers that fail to CoCreate in this process are
// still REPORTED (status unavailable) — knowing a 32-bit-only driver exists
// is exactly what a device picker needs.
static int enumerateView(bool wow64) {
  HKEY asioKey = NULL;
  const REGSAM view = KEY_READ | (wow64 ? KEY_WOW64_32KEY : 0);
  if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, "SOFTWARE\\ASIO", 0, view, &asioKey) != ERROR_SUCCESS) return 0;

  int seen = 0;
  for (DWORD index = 0;; index++) {
    char name[256] = {0};
    DWORD nameSize = sizeof(name);
    if (RegEnumKeyExA(asioKey, index, name, &nameSize, NULL, NULL, NULL, NULL) != ERROR_SUCCESS) break;
    seen++;

    HKEY driverKey = NULL;
    IASIO *iasio = NULL;
    if (RegOpenKeyExA(asioKey, name, 0, view, &driverKey) == ERROR_SUCCESS) {
      CLSID clsid = {};
      if (readClsid(driverKey, &clsid)) {
        CoCreateInstance(clsid, NULL, CLSCTX_INPROC_SERVER, IID_IASIO, reinterpret_cast<void **>(&iasio));
      }
      RegCloseKey(driverKey);
    }
    probeDriver(iasio, name);
  }
  RegCloseKey(asioKey);
  return seen;
}

int main(int argc, char **argv) {
  if (argc > 2) {
    fprintf(stderr, "usage: asio-probe [driver-name]\n");
    return 4;
  }
  // COM in-probe: ASIO drivers are in-proc COM objects. OleInitialize rather
  // than CoInitializeEx — some driver panels want the STA shell.
  if (FAILED(OleInitialize(NULL))) {
    fprintf(stderr, "probe: COM initialization failed\n");
    return 3;
  }

  if (argc == 2) {
    HKEY asioKey = NULL;
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, "SOFTWARE\\ASIO", 0, KEY_READ, &asioKey) != ERROR_SUCCESS) {
      fprintf(stderr, "probe: no ASIO drivers registered\n");
      OleUninitialize();
      return 0;
    }
    HKEY driverKey = NULL;
    IASIO *iasio = NULL;
    if (RegOpenKeyExA(asioKey, argv[1], 0, KEY_READ, &driverKey) == ERROR_SUCCESS) {
      CLSID clsid = {};
      if (readClsid(driverKey, &clsid)) {
        CoCreateInstance(clsid, NULL, CLSCTX_INPROC_SERVER, IID_IASIO, reinterpret_cast<void **>(&iasio));
      }
      RegCloseKey(driverKey);
    }
    probeDriver(iasio, argv[1]);
    RegCloseKey(asioKey);
  } else {
    // The 64-bit view first; then 32-bit registrations, which a 64-bit probe
    // reports as unavailable when their DLLs cannot load in-process.
    enumerateView(false);
    enumerateView(true);
  }

  fflush(stdout);
  OleUninitialize();
  return 0;
}
