/*
 * KYX ASIO streaming host (ADR 0017 wave 2.5) — driver buffers → ADR 0018
 * PCM frames on stdout.
 *
 * Loads ONE ASIO driver (hermetically by DLL path — the wave-2.5 acceptance
 * uses the SDK sample driver built as asio-fixture.dll — or by registered
 * name from HKLM\SOFTWARE\ASIO), opens its preferred buffer size, converts
 * the driver's buffers to float32 interleaved and writes "KYXP" frames to
 * stdout with per-block flushes, exactly the transport pcm-gen proved out.
 * A --seconds bound bounds every run; the manager kills on timeout anyway.
 *
 * The callback runs on the DRIVER's thread: it only converts a preallocated
 * buffer and fwrite()s — no allocation, no COM, no cleanup there. The main
 * thread waits for the target switch count, then stops the driver and closes
 * with STATS + EOF.
 *
 * Usage: asio-host (--dll <path> | --name <regname>) [--seconds N] [--rate HZ] [--channels 2]
 * Exit:  0 streamed (including driver-init failures reported as JSON), 3 usage/env.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <mmsystem.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "asio.h"
#include "asiosys.h"
#include "iasiodrv.h"

#include <initguid.h>
DEFINE_GUID(IID_IASIO, 0x838AD971, 0xC111, 0x11D0, 0x9A, 0xCF, 0x00, 0x00, 0xC0, 0xAB, 0xC4, 0xF9);
// The SDK sample driver's class id (asiosmpl.cpp); used with --dll.
DEFINE_GUID(CLSID_ASIO_SAMPLE, 0x188135E1, 0xD565, 0x11D2, 0x85, 0x4F, 0x00, 0xA0, 0xC9, 0x9F, 0x5D, 0x19);
DEFINE_GUID(IID_ICLASSFACTORY, 0x00000001, 0x0000, 0x0000, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46);

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

static IASIO *g_iasio = NULL;
static ASIOBufferInfo g_infos[2];
static long g_blockFrames = 0;
static long g_channels = 2;
static unsigned long g_totalFrames = 0;
static unsigned long g_writtenFrames = 0;
static unsigned long g_switches = 0;
static unsigned long g_seq = 0;
static int g_done = 0;
static float *g_convert = NULL;
static FILE *g_out = NULL;

/* Emit exactly `count` frames (the FINAL block may be partial so the
   delivered sample count matches the requested duration exactly). */
static void convertAndEmit(long index, unsigned long count) {
  for (long ch = 0; ch < g_channels; ch++) {
    const short *src = (const short *)g_infos[ch].buffers[index];
    float *dst = g_convert + (size_t)ch * g_blockFrames;
    for (unsigned long n = 0; n < count; n++) dst[n] = (float)(src[n] / 32768.0);
  }
  writeFrame(g_out, 1, g_seq++, g_convert, (unsigned long)(sizeof(float) * count * g_channels));
}

static void bufferSwitch(long index, ASIOBool directProcess) {
  (void)directProcess;
  if (g_done) return;
  const unsigned long remaining = g_totalFrames > g_writtenFrames ? g_totalFrames - g_writtenFrames : 0;
  if (remaining == 0) {
    g_done = 1;
    return;
  }
  const unsigned long count = remaining < (unsigned long)g_blockFrames ? remaining : (unsigned long)g_blockFrames;
  convertAndEmit(index, count);
  g_writtenFrames += count;
  g_switches++;
  if (g_writtenFrames >= g_totalFrames) g_done = 1;
}

// The driver calls asioMessage() during createBuffers — a NULL there is an
// instant segfault. We support nothing fancy: engine version 2, no time-info.
static long asioMessage(long selector, long value, void *message, double *opt) {
  (void)value;
  (void)message;
  (void)opt;
  switch (selector) {
  case kAsioEngineVersion:
    return 2;
  default:
    return 0;
  }
}

// Field order per asio.h: bufferSwitch, sampleRateDidChange, asioMessage, bufferSwitchTimeInfo.
static ASIOCallbacks g_callbacks = {bufferSwitch, NULL, asioMessage, NULL};

static IASIO *loadByDll(const wchar_t *path) {
  HMODULE module = LoadLibraryW(path);
  if (!module) {
    fprintf(stderr, "asio-host: LoadLibraryW failed (gle=%lu)\n", (unsigned long)GetLastError());
    return NULL;
  }
  const auto getClassObject = (HRESULT(WINAPI *)(REFCLSID, REFIID, void **))GetProcAddress(module, "DllGetClassObject");
  if (!getClassObject) {
    fprintf(stderr, "asio-host: DLL has no DllGetClassObject\n");
    return NULL;
  }
  IClassFactory *factory = NULL;
  if (FAILED(getClassObject(CLSID_ASIO_SAMPLE, IID_ICLASSFACTORY, (void **)&factory)) || !factory) {
    fprintf(stderr, "asio-host: DllGetClassObject refused the sample class\n");
    return NULL;
  }
  IASIO *iasio = NULL;
  // The SDK sample driver answers QueryInterface with its own class GUID
  // (asiosmpl.cpp conflates CLSID and interface id) — request that one.
  factory->CreateInstance(NULL, CLSID_ASIO_SAMPLE, (void **)&iasio);
  factory->Release();
  if (!iasio) fprintf(stderr, "asio-host: CreateInstance returned no IASIO\n");
  return iasio;
}

static IASIO *loadByName(const char *name) {
  HKEY asioKey = NULL;
  if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, "SOFTWARE\\ASIO", 0, KEY_READ, &asioKey) != ERROR_SUCCESS) return NULL;
  HKEY driverKey = NULL;
  IASIO *iasio = NULL;
  if (RegOpenKeyExA(asioKey, name, 0, KEY_READ, &driverKey) == ERROR_SUCCESS) {
    wchar_t clsidString[128] = {0};
    DWORD type = 0;
    DWORD size = sizeof(clsidString) - sizeof(wchar_t);
    if (RegGetValueW(driverKey, NULL, L"CLSID", RRF_RT_REG_SZ, &type, clsidString, &size) == ERROR_SUCCESS) {
      CLSID clsid = {};
      if (CLSIDFromString(clsidString, &clsid) == S_OK) {
        CoCreateInstance(clsid, NULL, CLSCTX_INPROC_SERVER, IID_IASIO, (void **)&iasio);
      }
    }
    RegCloseKey(driverKey);
  }
  RegCloseKey(asioKey);
  return iasio;
}

int main(int argc, char **argv) {
  const wchar_t *dllPath = NULL;
  const char *regName = NULL;
  double seconds = 10;
  long channels = 2;
  long wantedRate = 48000;

  for (int i = 1; i + 1 < argc; i += 2) {
    if (strcmp(argv[i], "--dll") == 0) {
      const int w = MultiByteToWideChar(CP_UTF8, 0, argv[i + 1], -1, NULL, 0);
      if (w <= 0 || w >= MAX_PATH) return 4;
      wchar_t *wide = (wchar_t *)malloc(sizeof(wchar_t) * w);
      MultiByteToWideChar(CP_UTF8, 0, argv[i + 1], -1, wide, w);
      dllPath = wide;
    } else if (strcmp(argv[i], "--name") == 0) {
      regName = argv[i + 1];
    } else if (strcmp(argv[i], "--seconds") == 0) {
      seconds = atof(argv[i + 1]);
    } else if (strcmp(argv[i], "--channels") == 0) {
      channels = atol(argv[i + 1]);
    } else if (strcmp(argv[i], "--rate") == 0) {
      wantedRate = atol(argv[i + 1]);
    }
  }
  if (!dllPath && !regName) {
    fprintf(stderr, "usage: asio-host (--dll <path> | --name <regname>) [--seconds N] [--rate HZ] [--channels N]\n");
    return 4;
  }
  if (seconds <= 0 || seconds > 3600 || channels < 1 || channels > 2) return 4;
  if (_setmode(_fileno(stdout), _O_BINARY) == -1) return 3;
  if (FAILED(OleInitialize(NULL))) return 3;
  g_out = stdout;
  g_channels = channels;

  g_iasio = dllPath ? loadByDll(dllPath) : loadByName(regName);
  if (!g_iasio) {
    // A driver that refuses to load is an honest JSON answer, not a crash.
    writeJsonFrame(stdout, 2, "{\"error\":\"driver-load-failed\"}");
    fflush(stdout);
    OleUninitialize();
    return 0;
  }

  char driverName[64] = {0};
  g_iasio->getDriverName(driverName);
  if (g_iasio->init(NULL) != ASIOTrue) {
    char message[128] = {0};
    g_iasio->getErrorMessage(message);
    char json[256];
    snprintf(json, sizeof(json), "{\"error\":\"driver-init-failed\",\"detail\":\"%s\"}", message);
    writeJsonFrame(stdout, 2, json);
    fflush(stdout);
    g_iasio->Release();
    OleUninitialize();
    return 0;
  }

  ASIOSampleRate rate = 0;
  if (g_iasio->canSampleRate((ASIOSampleRate)wantedRate) == ASE_OK &&
      g_iasio->setSampleRate((ASIOSampleRate)wantedRate) == ASE_OK) {
    rate = wantedRate;
  } else if (g_iasio->getSampleRate(&rate) != ASE_OK || rate <= 0) {
    rate = 48000;
  }

  long minBuffer = 0;
  long maxBuffer = 0;
  long preferredBuffer = 0;
  long granularity = 0;
  if (g_iasio->getBufferSize(&minBuffer, &maxBuffer, &preferredBuffer, &granularity) != ASE_OK ||
      preferredBuffer <= 0) {
    preferredBuffer = 512;
  }
  g_blockFrames = preferredBuffer;

  long totalInputs = 0;
  long totalOutputs = 0;
  g_iasio->getChannels(&totalInputs, &totalOutputs);
  if (channels > totalOutputs) channels = totalOutputs > 0 ? totalOutputs : 1;
  g_channels = channels;

  for (long ch = 0; ch < channels; ch++) {
    g_infos[ch].isInput = ASIOFalse;
    g_infos[ch].channelNum = ch;
    g_infos[ch].buffers[0] = NULL;
    g_infos[ch].buffers[1] = NULL;
  }
  ASIOCallbacks callbacks = {bufferSwitch, NULL, asioMessage, NULL};
  if (g_iasio->createBuffers(g_infos, channels, g_blockFrames, &callbacks) != ASE_OK) {
    writeJsonFrame(stdout, 2, "{\"error\":\"create-buffers-failed\"}");
    fflush(stdout);
    g_iasio->Release();
    OleUninitialize();
    return 0;
  }

  ASIOChannelInfo info;
  info.channel = 0;
  info.isInput = ASIOFalse;
  g_iasio->getChannelInfo(&info);
  if (info.type != ASIOSTInt16LSB) {
    char json[128];
    snprintf(json, sizeof(json), "{\"error\":\"unsupported-sample-type\",\"type\":%ld}", (long)info.type);
    writeJsonFrame(stdout, 2, json);
    fflush(stdout);
    g_iasio->disposeBuffers();
    g_iasio->Release();
    OleUninitialize();
    return 0;
  }

  g_convert = (float *)malloc(sizeof(float) * (size_t)g_blockFrames * (size_t)channels);
  if (!g_convert) return 3;
  memset(g_convert, 0, sizeof(float) * (size_t)g_blockFrames * (size_t)channels);

  char event[192];
  snprintf(event, sizeof(event),
           "{\"rate\":%ld,\"channels\":%ld,\"blockFrames\":%ld,\"driver\":\"%s\",\"sampleType\":\"int16lsb\"}",
           (long)rate, channels, g_blockFrames, driverName);
  writeJsonFrame(stdout, 2, event);

  g_totalFrames = (unsigned long)((double)rate * seconds);
  if (g_totalFrames < (unsigned long)g_blockFrames) g_totalFrames = (unsigned long)g_blockFrames;

  // The fixture driver paces its callback thread with Sleep(blockMs); at
  // the default 15.6 ms Windows timer resolution that would starve the
  // stream ~3x — request 1 ms resolution for the session.
  const bool timerRaised = timeBeginPeriod(1) == TIMERR_NOERROR;
  if (g_iasio->start() != ASE_OK) {
    writeJsonFrame(stdout, 2, "{\"error\":\"start-failed\"}");
    fflush(stdout);
    g_iasio->disposeBuffers();
    g_iasio->Release();
    OleUninitialize();
    return 0;
  }

  // The callback streams; this thread just bounds the wait (a driver that
  // stops firing must not wedge the host past the manager's kill timeout).
  const ULONGLONG deadline = GetTickCount64() + (ULONGLONG)(seconds * 1000) * 4 + 10000;
  while (!g_done && GetTickCount64() < deadline) Sleep(10);

  g_iasio->stop();
  g_iasio->disposeBuffers();
  if (timerRaised) timeEndPeriod(1);

  char stats[160];
  snprintf(stats, sizeof(stats),
           "{\"framesWritten\":%lu,\"switches\":%lu,\"blockFrames\":%ld,\"done\":%s}", g_writtenFrames, g_switches,
           g_blockFrames, g_done ? "true" : "false");
  writeJsonFrame(stdout, 3, stats);
  writeJsonFrame(stdout, 4, "{}");
  fflush(stdout);

  free(g_convert);
  g_iasio->Release();
  OleUninitialize();
  return 0;
}
