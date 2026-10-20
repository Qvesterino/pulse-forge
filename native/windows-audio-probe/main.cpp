#include <windows.h>
#include <avrt.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>
#include <ksmedia.h>
#include <wrl/client.h>
#include "capture-start-time.h"
#include "endpoint-selection.h"
#include "endpoint-json.h"
#include "loopback-correlation.h"
#include "shared-period-selection.h"

#include <cstring>
#include <iomanip>
#include <iostream>
#include <string>
#include <chrono>
#include <algorithm>
#include <cwchar>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

const wchar_t* flowName(EDataFlow flow) {
  return flow == eCapture ? L"capture" : L"render";
}

std::wstring endpointName(IMMDevice* device) {
  ComPtr<IPropertyStore> properties;
  if (FAILED(device->OpenPropertyStore(STGM_READ, properties.GetAddressOf()))) return L"(name unavailable)";

  PROPVARIANT value;
  PropVariantInit(&value);
  std::wstring name = L"(name unavailable)";
  if (SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR && value.pwszVal) {
    name = value.pwszVal;
  }
  PropVariantClear(&value);
  return name;
}

std::wstring endpointId(IMMDevice* device) {
  LPWSTR rawId = nullptr;
  if (FAILED(device->GetId(&rawId)) || !rawId) return {};
  std::wstring id(rawId);
  CoTaskMemFree(rawId);
  return id;
}

std::optional<kyx::windows_audio::EndpointMixFormat>
endpointMixFormat(IMMDevice* device) {
  if (!device)
    return std::nullopt;

  ComPtr<IAudioClient3> client;
  if (FAILED(device->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr,
                              reinterpret_cast<void**>(client.GetAddressOf()))))
    return std::nullopt;

  WAVEFORMATEX* rawFormat = nullptr;
  if (FAILED(client->GetMixFormat(&rawFormat)) || !rawFormat)
    return std::nullopt;

  kyx::windows_audio::EndpointMixFormat result;
  result.channels = rawFormat->nChannels;
  result.sampleRateHz = rawFormat->nSamplesPerSec;
  result.bitsPerSample = rawFormat->wBitsPerSample;
  result.validBitsPerSample = rawFormat->wBitsPerSample;
  if (rawFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
    result.floatingPoint = true;
  } else if (rawFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
             rawFormat->cbSize >= sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
    const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(rawFormat);
    result.floatingPoint = IsEqualGUID(extensible->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    result.channelMask = extensible->dwChannelMask;
    if (extensible->Samples.wValidBitsPerSample > 0)
      result.validBitsPerSample = extensible->Samples.wValidBitsPerSample;
  }

  UINT32 defaultFrames = 0;
  UINT32 fundamentalFrames = 0;
  UINT32 minFrames = 0;
  UINT32 maxFrames = 0;
  if (SUCCEEDED(client->GetSharedModeEnginePeriod(rawFormat, &defaultFrames,
                                                  &fundamentalFrames, &minFrames,
                                                  &maxFrames)) &&
      defaultFrames > 0 && fundamentalFrames > 0 && minFrames > 0 &&
      maxFrames >= minFrames) {
    result.sharedPeriods = kyx::windows_audio::SharedPeriods{
        defaultFrames, fundamentalFrames, minFrames, maxFrames};
  }

  CoTaskMemFree(rawFormat);
  return result;
}

const wchar_t *endpointStateName(DWORD state) {
  if (state == DEVICE_STATE_ACTIVE)
    return L"active";
  if (state == DEVICE_STATE_DISABLED)
    return L"disabled";
  if (state == DEVICE_STATE_NOTPRESENT)
    return L"not-present";
  if (state == DEVICE_STATE_UNPLUGGED)
    return L"unplugged";
  return L"unknown";
}

bool writeStdoutUtf8(const std::string &value) {
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!output || output == INVALID_HANDLE_VALUE)
    return false;
  DWORD consoleMode = 0;
  if (GetConsoleMode(output, &consoleMode))
    SetConsoleOutputCP(CP_UTF8);

  std::size_t offset = 0;
  while (offset < value.size()) {
    const DWORD bytes = static_cast<DWORD>(
        std::min<std::size_t>(value.size() - offset, MAXDWORD));
    DWORD written = 0;
    if (!WriteFile(output, value.data() + offset, bytes, &written, nullptr) ||
        written == 0)
      return false;
    offset += written;
  }
  return true;
}

bool listEndpointsAsJson(IMMDeviceEnumerator *enumerator) {
  if (!enumerator)
    return false;
  std::vector<kyx::windows_audio::EndpointRecord> endpoints;
  constexpr DWORD kAllStates = DEVICE_STATE_ACTIVE | DEVICE_STATE_DISABLED |
                               DEVICE_STATE_NOTPRESENT | DEVICE_STATE_UNPLUGGED;

  for (const EDataFlow flow : {eCapture, eRender}) {
    std::wstring defaultId;
    ComPtr<IMMDevice> defaultDevice;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(
            flow, eConsole, defaultDevice.GetAddressOf()))) {
      defaultId = endpointId(defaultDevice.Get());
    }

    ComPtr<IMMDeviceCollection> devices;
    HRESULT hr = enumerator->EnumAudioEndpoints(flow, kAllStates,
                                                devices.GetAddressOf());
    if (FAILED(hr)) {
      std::wcerr << L"Endpoint enumeration failed for " << flowName(flow)
                 << L" (HRESULT 0x" << std::hex
                 << static_cast<unsigned long>(hr) << std::dec << L")\n";
      return false;
    }

    UINT count = 0;
    hr = devices->GetCount(&count);
    if (FAILED(hr)) {
      std::wcerr << L"Endpoint count failed for " << flowName(flow)
                 << L" (HRESULT 0x" << std::hex
                 << static_cast<unsigned long>(hr) << std::dec << L")\n";
      return false;
    }
    if (count > 256) {
      std::wcerr << L"Endpoint count exceeded the discovery limit\n";
      return false;
    }

    for (UINT index = 0; index < count; ++index) {
      ComPtr<IMMDevice> device;
      hr = devices->Item(index, device.GetAddressOf());
      if (FAILED(hr) || !device) {
        std::wcerr << L"Could not read endpoint " << index << L" for "
                   << flowName(flow) << L"\n";
        return false;
      }
      std::wstring id = endpointId(device.Get());
      if (id.empty()) {
        std::wcerr << L"Endpoint " << index
                   << L" has no readable endpoint ID\n";
        return false;
      }
      DWORD state = 0;
      const HRESULT stateHr = device->GetState(&state);
      const bool isDefaultConsole = id == defaultId;
      auto mixFormat = stateHr == S_OK && state == DEVICE_STATE_ACTIVE
                           ? endpointMixFormat(device.Get())
                           : std::nullopt;
      endpoints.push_back(
          {std::move(id), endpointName(device.Get()), flowName(flow),
           stateHr == S_OK ? endpointStateName(state) : L"unknown",
           isDefaultConsole, std::move(mixFormat)});
    }
  }

  std::string json;
  if (!kyx::windows_audio::serializeEndpointListJson(endpoints, &json)) {
    std::wcerr << L"Could not encode Windows endpoint list as UTF-8 JSON\n";
    return false;
  }
  json.push_back('\n');
  if (!writeStdoutUtf8(json)) {
    std::wcerr << L"Could not write endpoint JSON to stdout\n";
    return false;
  }
  return true;
}

double framesToMs(UINT32 frames, UINT32 sampleRate) {
  return sampleRate == 0 ? 0.0
                         : 1000.0 * static_cast<double>(frames) / sampleRate;
}

void printFormat(const wchar_t* label, const WAVEFORMATEX* format) {
  if (!format) return;
  std::wcout << L"    " << label << L": " << format->nChannels << L" ch, " << format->nSamplesPerSec << L" Hz, "
            << format->wBitsPerSample << L" bits, tag=0x" << std::hex << format->wFormatTag << std::dec;
  if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE && format->cbSize >= sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
    const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
    std::wcout << L", validBits=" << extensible->Samples.wValidBitsPerSample << L", channelMask=0x" << std::hex
               << extensible->dwChannelMask << std::dec;
  }
  std::wcout << L"\n";
}

void printSupportedPeriod(IAudioClient3* client, const WAVEFORMATEX* format, const wchar_t* label) {
  UINT32 defaultFrames = 0;
  UINT32 fundamentalFrames = 0;
  UINT32 minimumFrames = 0;
  UINT32 maximumFrames = 0;
  const HRESULT hr = client->GetSharedModeEnginePeriod(
      format, &defaultFrames, &fundamentalFrames, &minimumFrames, &maximumFrames);
  if (FAILED(hr)) {
    std::wcout << L"    " << label << L": unavailable (HRESULT 0x" << std::hex
               << static_cast<unsigned long>(hr) << std::dec << L")\n";
    return;
  }

  const UINT32 rate = format->nSamplesPerSec;
  std::wcout << L"    " << label << L" (frames / ms): default=" << defaultFrames << L" / "
            << std::fixed << std::setprecision(3) << framesToMs(defaultFrames, rate) << L", fundamental="
            << fundamentalFrames << L" / " << framesToMs(fundamentalFrames, rate) << L", min=" << minimumFrames
            << L" / " << framesToMs(minimumFrames, rate) << L", max=" << maximumFrames << L" / "
            << framesToMs(maximumFrames, rate) << L"\n";
}

const wchar_t* supportResult(HRESULT hr) {
  if (hr == S_OK) return L"exact";
  if (hr == S_FALSE) return L"closest shared-mode match";
  if (hr == AUDCLNT_E_UNSUPPORTED_FORMAT) return L"unsupported";
  return L"query failed";
}

void printFormatSupport(IAudioClient* client, const WAVEFORMATEX& format, AUDCLNT_SHAREMODE mode) {
  WAVEFORMATEX* closest = nullptr;
  const HRESULT hr = client->IsFormatSupported(mode, &format, mode == AUDCLNT_SHAREMODE_SHARED ? &closest : nullptr);
  std::wcout << L"    " << (mode == AUDCLNT_SHAREMODE_SHARED ? L"shared" : L"exclusive") << L" "
            << format.nSamplesPerSec << L" Hz / " << format.nChannels << L" ch / " << format.wBitsPerSample
            << L"-bit " << (format.wFormatTag == WAVE_FORMAT_IEEE_FLOAT ? L"float" : L"PCM") << L": "
            << supportResult(hr);
  if (closest) {
    std::wcout << L" (closest " << closest->nSamplesPerSec << L" Hz / " << closest->nChannels << L" ch / "
              << closest->wBitsPerSample << L" bits)";
    CoTaskMemFree(closest);
  }
  if (FAILED(hr) && hr != AUDCLNT_E_UNSUPPORTED_FORMAT) {
    std::wcout << L" (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec << L")";
  }
  std::wcout << L"\n";
}

WAVEFORMATEX makeFormat(UINT32 sampleRate, WORD channels, WORD bits, WORD tag) {
  WAVEFORMATEX format{};
  format.wFormatTag = tag;
  format.nChannels = channels;
  format.nSamplesPerSec = sampleRate;
  format.wBitsPerSample = bits;
  format.nBlockAlign = static_cast<WORD>(channels * bits / 8);
  format.nAvgBytesPerSec = sampleRate * format.nBlockAlign;
  return format;
}

void probeEndpoint(IMMDevice* device, EDataFlow flow, const std::wstring& defaultId) {
  const std::wstring id = endpointId(device);
  std::wcout << L"\n[" << flowName(flow) << L"] " << endpointName(device)
            << (id == defaultId ? L" (default console endpoint)" : L"") << L"\n";

  ComPtr<IAudioClient3> client;
  HRESULT hr = device->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr,
                                reinterpret_cast<void**>(client.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcout << L"    IAudioClient3 unavailable (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
              << std::dec << L")\n";
    return;
  }

  WAVEFORMATEX* mixFormat = nullptr;
  hr = client->GetMixFormat(&mixFormat);
  if (FAILED(hr) || !mixFormat) {
    std::wcout << L"    GetMixFormat failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
              << L")\n";
    return;
  }
  printFormat(L"shared engine mix format", mixFormat);

  REFERENCE_TIME defaultDevicePeriod = 0;
  REFERENCE_TIME minimumDevicePeriod = 0;
  hr = client->GetDevicePeriod(&defaultDevicePeriod, &minimumDevicePeriod);
  if (SUCCEEDED(hr)) {
    std::wcout << L"    device periods: shared default=" << std::fixed << std::setprecision(3)
              << static_cast<double>(defaultDevicePeriod) / 10'000.0 << L" ms, exclusive minimum="
              << static_cast<double>(minimumDevicePeriod) / 10'000.0 << L" ms\n";
  } else {
    std::wcout << L"    GetDevicePeriod failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
              << L")\n";
  }
  printSupportedPeriod(client.Get(), mixFormat, L"default-client shared periods");

  AudioClientProperties properties{};
  properties.cbSize = sizeof(properties);
  properties.eCategory = AudioCategory_Media;
  properties.Options = AUDCLNT_STREAMOPTIONS_NONE;
  hr = client->SetClientProperties(&properties);
  if (SUCCEEDED(hr)) {
    printSupportedPeriod(client.Get(), mixFormat, L"AudioCategory_Media shared periods");
  } else {
    std::wcout << L"    AudioCategory_Media properties unavailable (HRESULT 0x" << std::hex
              << static_cast<unsigned long>(hr) << std::dec << L")\n";
  }

  WAVEFORMATEX* currentFormat = nullptr;
  UINT32 currentFrames = 0;
  hr = client->GetCurrentSharedModeEnginePeriod(&currentFormat, &currentFrames);
  if (SUCCEEDED(hr) && currentFormat) {
    std::wcout << L"    current shared engine period: " << currentFrames << L" frames / " << std::fixed
              << std::setprecision(3) << framesToMs(currentFrames, currentFormat->nSamplesPerSec) << L" ms\n";
  } else {
    std::wcout << L"    current shared engine period unavailable (HRESULT 0x" << std::hex
              << static_cast<unsigned long>(hr) << std::dec << L")\n";
  }
  CoTaskMemFree(currentFormat);

  std::wcout << L"    candidate format support (capability query only; no stream opened):\n";
  constexpr UINT32 rates[] = {44'100, 48'000, 96'000};
  constexpr WORD channels[] = {1, 2};
  constexpr WORD sampleFormats[] = {WAVE_FORMAT_PCM, WAVE_FORMAT_IEEE_FLOAT};
  for (const UINT32 rate : rates) {
    for (const WORD channelCount : channels) {
      for (const WORD tag : sampleFormats) {
        const WORD bits = tag == WAVE_FORMAT_PCM ? 16 : 32;
        const WAVEFORMATEX candidate = makeFormat(rate, channelCount, bits, tag);
        printFormatSupport(client.Get(), candidate, AUDCLNT_SHAREMODE_SHARED);
        printFormatSupport(client.Get(), candidate, AUDCLNT_SHAREMODE_EXCLUSIVE);
      }
    }
  }

  CoTaskMemFree(mixFormat);
}

struct ScopedEvent {
  HANDLE value = nullptr;
  ~ScopedEvent() {
    if (value) CloseHandle(value);
  }
};

struct ScopedMmcssTask {
  HANDLE value = nullptr;

  bool registerTask(const wchar_t* taskName) {
    DWORD taskIndex = 0;
    value = AvSetMmThreadCharacteristicsW(taskName, &taskIndex);
    return value != nullptr;
  }

  ~ScopedMmcssTask() {
    if (value) AvRevertMmThreadCharacteristics(value);
  }
};

struct ScopedWaveFormat {
  WAVEFORMATEX* value = nullptr;
  ~ScopedWaveFormat() { CoTaskMemFree(value); }
};

void reportStreamStage(const wchar_t* stage) {
  std::wcout << L"    stage: " << stage << L"\n" << std::flush;
}

bool prepareStream(IAudioClient3* client, AUDCLNT_SHAREMODE mode, WAVEFORMATEX* format,
                   UINT32* periodFrames, UINT32* bufferFrames, DWORD extraStreamFlags = 0) {
  HRESULT hr = AUDCLNT_E_UNSUPPORTED_FORMAT;
  if (mode == AUDCLNT_SHAREMODE_SHARED) {
    AudioClientProperties properties{};
    properties.cbSize = sizeof(properties);
    // Match the documented metadata preflight query for a real stream.
    properties.eCategory = AudioCategory_Media;
    properties.Options = AUDCLNT_STREAMOPTIONS_NONE;
    reportStreamStage(L"shared-set-client-properties");
    hr = client->SetClientProperties(&properties);
    if (FAILED(hr)) {
      std::wcerr << L"SetClientProperties(AudioCategory_Media) failed (HRESULT 0x" << std::hex
                 << static_cast<unsigned long>(hr) << std::dec << L")\n";
      return false;
    }

    UINT32 defaultFrames = 0;
    UINT32 fundamentalFrames = 0;
    UINT32 minimumFrames = 0;
    UINT32 maximumFrames = 0;
    reportStreamStage(L"shared-query-engine-period");
    hr = client->GetSharedModeEnginePeriod(format, &defaultFrames, &fundamentalFrames, &minimumFrames, &maximumFrames);
    if (FAILED(hr) || minimumFrames == 0) {
      std::wcerr << L"No valid shared period is available (HRESULT 0x" << std::hex
                 << static_cast<unsigned long>(hr) << std::dec << L")\n";
      return false;
    }
    if (!selectLowestSupportedSharedPeriod(fundamentalFrames, minimumFrames, maximumFrames, periodFrames)) {
      std::wcerr << L"No legal shared period is available within the reported range\n";
      return false;
    }
    reportStreamStage(L"shared-initialize-audio-stream");
    hr = client->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK | extraStreamFlags, *periodFrames,
                                             format, nullptr);
  } else {
    REFERENCE_TIME defaultPeriod = 0;
    REFERENCE_TIME minimumPeriod = 0;
    reportStreamStage(L"exclusive-query-device-period");
    hr = client->GetDevicePeriod(&defaultPeriod, &minimumPeriod);
    if (FAILED(hr) || minimumPeriod <= 0) {
      std::wcerr << L"GetDevicePeriod failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
                 << L")\n";
      return false;
    }
    REFERENCE_TIME requestedPeriod = minimumPeriod;
    *periodFrames = static_cast<UINT32>((requestedPeriod * format->nSamplesPerSec) / 10'000'000);
    reportStreamStage(L"exclusive-initialize-audio-stream");
    hr = client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, requestedPeriod,
                            requestedPeriod, format, nullptr);
    if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
      // WASAPI may require a buffer aligned to the endpoint's fundamental size.
      // Ask for the aligned frame count, then retry with the corresponding time.
      hr = client->GetBufferSize(bufferFrames);
      if (FAILED(hr) || *bufferFrames == 0) {
        std::wcerr << L"Could not get the aligned exclusive buffer size (HRESULT 0x" << std::hex
                   << static_cast<unsigned long>(hr) << std::dec << L")\n";
        return false;
      }
      requestedPeriod = static_cast<REFERENCE_TIME>(
          (10'000'000.0 * static_cast<double>(*bufferFrames) / format->nSamplesPerSec) + 0.5);
      *periodFrames = *bufferFrames;
      reportStreamStage(L"exclusive-retry-aligned-initialize");
      hr = client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, requestedPeriod,
                              requestedPeriod, format, nullptr);
    }
  }
  if (FAILED(hr)) {
    std::wcerr << L"Stream initialization failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }
  reportStreamStage(L"get-allocated-buffer-size");
  hr = client->GetBufferSize(bufferFrames);
  if (FAILED(hr) || *bufferFrames == 0) {
    std::wcerr << L"GetBufferSize failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }
  return true;
}

bool preparePullLoopbackStream(IAudioClient3* client, WAVEFORMATEX* format, UINT32* bufferFrames) {
  // Use pull-mode loopback and service it from the render stream's event.
  // This also works on Windows versions where loopback clients do not receive
  // their own event notifications.
  constexpr REFERENCE_TIME kLoopbackBufferDuration100ns = 100'000;  // 10 ms
  HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                                  kLoopbackBufferDuration100ns, 0, format, nullptr);
  if (FAILED(hr)) {
    std::wcerr << L"Shared loopback stream initialization failed (HRESULT 0x" << std::hex
               << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }
  hr = client->GetBufferSize(bufferFrames);
  if (FAILED(hr) || *bufferFrames == 0) {
    std::wcerr << L"GetBufferSize failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }
  return true;
}

bool runCaptureStream(IAudioClient3* client, HANDLE eventHandle, AUDCLNT_SHAREMODE mode, UINT32 seconds,
                      UINT32 bufferFrames, UINT32 sampleRate) {
  ComPtr<IAudioCaptureClient> capture;
  reportStreamStage(L"capture-acquire-service");
  HRESULT hr = client->GetService(IID_PPV_ARGS(capture.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcerr << L"Could not acquire IAudioCaptureClient (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }

  reportStreamStage(L"capture-set-event-handle");
  hr = client->SetEventHandle(eventHandle);
  if (FAILED(hr)) {
    std::wcerr << L"SetEventHandle failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }
  LARGE_INTEGER qpcFrequency{};
  LARGE_INTEGER qpcStartCall{};
  const bool canMeasureQpcStart = QueryPerformanceFrequency(&qpcFrequency) != 0 &&
                                  QueryPerformanceCounter(&qpcStartCall) != 0;
  reportStreamStage(L"capture-start");
  hr = client->Start();
  if (FAILED(hr)) {
    std::wcerr << L"Capture stream Start failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }
  LARGE_INTEGER qpcStartReturned{};
  const bool canMeasureQpcReturn = canMeasureQpcStart && QueryPerformanceCounter(&qpcStartReturned) != 0;
  reportStreamStage(L"capture-event-loop");

  UINT64 totalFrames = 0;
  UINT64 firstDevicePosition = 0;
  UINT64 lastDevicePosition = 0;
  UINT64 firstQpcPosition100ns = 0;
  UINT64 lastQpcPosition100ns = 0;
  UINT64 expectedNextDevicePosition = 0;
  UINT64 packetCount = 0;
  UINT64 discontinuities = 0;
  UINT64 firstPacketDiscontinuities = 0;
  UINT64 laterDiscontinuities = 0;
  UINT64 silentPackets = 0;
  UINT64 timestampErrors = 0;
  UINT64 devicePositionGaps = 0;
  UINT64 exclusiveBufferErrors = 0;
  UINT64 exclusivePacketSizeMismatches = 0;
  UINT64 eventTimeouts = 0;
  bool ok = true;
  const auto started = std::chrono::steady_clock::now();
  const auto deadline = started + std::chrono::seconds(seconds);
  const DWORD waitMs = std::max<DWORD>(100, static_cast<DWORD>(10'000.0 * bufferFrames / sampleRate));

  auto consumePacket = [&]() {
    UINT32 packetFrames = 0;
    BYTE* data = nullptr;
    DWORD flags = 0;
    UINT64 devicePosition = 0;
    UINT64 qpcPosition = 0;
    hr = capture->GetBuffer(&data, &packetFrames, &flags, &devicePosition, &qpcPosition);
    if (hr == AUDCLNT_E_BUFFER_ERROR && mode == AUDCLNT_SHAREMODE_EXCLUSIVE) {
      ++exclusiveBufferErrors;
      return true;
    }
    if (FAILED(hr)) {
      std::wcerr << L"Capture GetBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
                 << std::dec << L")\n";
      ok = false;
      return false;
    }
    if (mode == AUDCLNT_SHAREMODE_EXCLUSIVE && packetFrames != bufferFrames) {
      ++exclusivePacketSizeMismatches;
    }

    // Deliberately inspect metadata only. PCM is never copied, played, or written.
    const bool isFirstPacket = packetCount == 0;
    if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) {
      ++discontinuities;
      if (isFirstPacket) {
        ++firstPacketDiscontinuities;
      } else {
        ++laterDiscontinuities;
      }
    }
    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) ++silentPackets;
    if (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) ++timestampErrors;
    if (isFirstPacket) {
      firstDevicePosition = devicePosition;
      firstQpcPosition100ns = qpcPosition;
    } else if (devicePosition != expectedNextDevicePosition) {
      ++devicePositionGaps;
    }
    expectedNextDevicePosition = devicePosition + packetFrames;
    lastDevicePosition = devicePosition;
    lastQpcPosition100ns = qpcPosition;
    totalFrames += packetFrames;
    ++packetCount;
    hr = capture->ReleaseBuffer(packetFrames);
    if (FAILED(hr)) {
      std::wcerr << L"Capture ReleaseBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
                 << std::dec << L")\n";
      ok = false;
      return false;
    }
    return true;
  };

  while (std::chrono::steady_clock::now() < deadline) {
    const DWORD waitResult = WaitForSingleObject(eventHandle, waitMs);
    if (waitResult == WAIT_TIMEOUT) {
      ++eventTimeouts;
      if (eventTimeouts >= 3) {
        std::wcerr << L"Capture event timed out three consecutive times\n";
        ok = false;
        break;
      }
      continue;
    }
    if (waitResult != WAIT_OBJECT_0) {
      std::wcerr << L"Capture event wait failed (Win32 " << GetLastError() << L")\n";
      ok = false;
      break;
    }

    if (mode == AUDCLNT_SHAREMODE_SHARED) {
      // GetNextPacketSize is supported only for shared-mode capture streams.
      for (;;) {
        UINT32 packetFrames = 0;
        hr = capture->GetNextPacketSize(&packetFrames);
        if (FAILED(hr)) {
          std::wcerr << L"GetNextPacketSize failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
                     << std::dec << L")\n";
          ok = false;
          break;
        }
        if (packetFrames == 0) break;
        if (!consumePacket()) break;
      }
    } else {
      // In exclusive event mode, service one whole endpoint buffer per event.
      // Do not call the shared-mode-only GetNextPacketSize method here.
      if (!consumePacket()) ok = false;
    }
    if (!ok) break;
  }

  reportStreamStage(L"capture-stop");
  const HRESULT stopHr = client->Stop();
  const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
  REFERENCE_TIME streamLatency = 0;
  reportStreamStage(L"capture-query-stream-latency");
  const HRESULT latencyHr = client->GetStreamLatency(&streamLatency);
  std::wcout << L"    capture result: elapsed=" << std::fixed << std::setprecision(2) << elapsed
            << L" s, packets=" << packetCount << L", frames=" << totalFrames << L" ("
            << (sampleRate ? static_cast<double>(totalFrames) / sampleRate : 0.0)
            << L" s PCM), discontinuities=" << discontinuities << L" (first packet="
            << firstPacketDiscontinuities << L", later=" << laterDiscontinuities << L"), silent packets="
            << silentPackets << L", timestamp errors=" << timestampErrors << L", device-position gaps="
            << devicePositionGaps << L", exclusive buffer errors=" << exclusiveBufferErrors
            << L", exclusive packet-size mismatches=" << exclusivePacketSizeMismatches
            << L", event timeouts=" << eventTimeouts
            << L"\n    device positions: first=" << firstDevicePosition << L", last=" << lastDevicePosition
            << L", last packet QPC timestamp=" << lastQpcPosition100ns << L" (100-ns units)\n";
  if (SUCCEEDED(latencyHr)) {
    std::wcout << L"    WASAPI reported stream latency=" << std::fixed << std::setprecision(3)
              << static_cast<double>(streamLatency) / 10'000.0 << L" ms (not round-trip latency)\n";
  }
  double firstFrameAfterStartCallMs = 0.0;
  double firstFrameAfterStartReturnMs = 0.0;
  if (firstQpcPosition100ns > 0 && canMeasureQpcStart &&
      qpcRelativeMilliseconds(firstQpcPosition100ns, qpcStartCall.QuadPart, qpcFrequency.QuadPart,
                              &firstFrameAfterStartCallMs)) {
    std::wcout << L"    first captured frame QPC: " << std::fixed << std::setprecision(3)
              << firstFrameAfterStartCallMs << L" ms relative to Start call";
    if (canMeasureQpcReturn &&
        qpcRelativeMilliseconds(firstQpcPosition100ns, qpcStartReturned.QuadPart, qpcFrequency.QuadPart,
                                &firstFrameAfterStartReturnMs)) {
      std::wcout << L", " << firstFrameAfterStartReturnMs << L" ms relative to Start return";
    }
    std::wcout << L"; GetBuffer QPC timestamps are 100-ns units\n";
  } else {
    std::wcout << L"    first captured frame QPC: unavailable\n";
  }
  if (FAILED(stopHr)) {
    std::wcerr << L"Capture Stop failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(stopHr) << std::dec
               << L")\n";
    ok = false;
  }
  return ok && totalFrames > 0 && laterDiscontinuities == 0 && timestampErrors == 0 &&
         devicePositionGaps == 0 && exclusiveBufferErrors == 0 && exclusivePacketSizeMismatches == 0 &&
         eventTimeouts == 0;
}

bool runSilentRenderStream(IAudioClient3* client, HANDLE eventHandle, UINT32 seconds, UINT32 bufferFrames,
                           UINT32 sampleRate) {
  ComPtr<IAudioRenderClient> render;
  reportStreamStage(L"render-acquire-service");
  HRESULT hr = client->GetService(IID_PPV_ARGS(render.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcerr << L"Could not acquire IAudioRenderClient (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }
  reportStreamStage(L"render-set-event-handle");
  hr = client->SetEventHandle(eventHandle);
  if (FAILED(hr)) {
    std::wcerr << L"SetEventHandle failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }

  // Prime the endpoint with silence before starting; no tone or captured input is used.
  BYTE* initialData = nullptr;
  reportStreamStage(L"render-prime-get-buffer");
  hr = render->GetBuffer(bufferFrames, &initialData);
  if (FAILED(hr)) {
    std::wcerr << L"Render prime GetBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }
  reportStreamStage(L"render-prime-release-silence");
  hr = render->ReleaseBuffer(bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
  if (FAILED(hr)) {
    std::wcerr << L"Render prime ReleaseBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }
  reportStreamStage(L"render-start");
  hr = client->Start();
  if (FAILED(hr)) {
    std::wcerr << L"Render stream Start failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }

  reportStreamStage(L"render-event-loop");
  UINT64 renderedFrames = bufferFrames;
  UINT64 eventCount = 0;
  UINT64 eventTimeouts = 0;
  bool ok = true;
  const auto started = std::chrono::steady_clock::now();
  const auto deadline = started + std::chrono::seconds(seconds);
  const DWORD waitMs = std::max<DWORD>(100, static_cast<DWORD>(10'000.0 * bufferFrames / sampleRate));
  while (std::chrono::steady_clock::now() < deadline) {
    const DWORD waitResult = WaitForSingleObject(eventHandle, waitMs);
    if (waitResult == WAIT_TIMEOUT) {
      ++eventTimeouts;
      if (eventTimeouts >= 3) {
        std::wcerr << L"Render event timed out three consecutive times\n";
        ok = false;
        break;
      }
      continue;
    }
    if (waitResult != WAIT_OBJECT_0) {
      std::wcerr << L"Render event wait failed (Win32 " << GetLastError() << L")\n";
      ok = false;
      break;
    }
    ++eventCount;
    UINT32 padding = 0;
    hr = client->GetCurrentPadding(&padding);
    if (FAILED(hr) || padding > bufferFrames) {
      std::wcerr << L"GetCurrentPadding failed or returned an invalid value (HRESULT 0x" << std::hex
                 << static_cast<unsigned long>(hr) << std::dec << L")\n";
      ok = false;
      break;
    }
    const UINT32 available = bufferFrames - padding;
    if (available == 0) continue;
    BYTE* data = nullptr;
    hr = render->GetBuffer(available, &data);
    if (FAILED(hr)) {
      std::wcerr << L"Render GetBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
                 << L")\n";
      ok = false;
      break;
    }
    hr = render->ReleaseBuffer(available, AUDCLNT_BUFFERFLAGS_SILENT);
    if (FAILED(hr)) {
      std::wcerr << L"Render ReleaseBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
                 << std::dec << L")\n";
      ok = false;
      break;
    }
    renderedFrames += available;
  }

  reportStreamStage(L"render-stop");
  const HRESULT stopHr = client->Stop();
  const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
  REFERENCE_TIME streamLatency = 0;
  reportStreamStage(L"render-query-stream-latency");
  const HRESULT latencyHr = client->GetStreamLatency(&streamLatency);
  std::wcout << L"    silent-render result: elapsed=" << std::fixed << std::setprecision(2) << elapsed
            << L" s, events=" << eventCount << L", frames queued=" << renderedFrames << L" ("
            << (sampleRate ? static_cast<double>(renderedFrames) / sampleRate : 0.0) << L" s), event timeouts="
            << eventTimeouts << L"\n";
  if (SUCCEEDED(latencyHr)) {
    std::wcout << L"    WASAPI reported stream latency=" << std::fixed << std::setprecision(3)
              << static_cast<double>(streamLatency) / 10'000.0 << L" ms (not round-trip latency)\n";
  }
  if (FAILED(stopHr)) {
    std::wcerr << L"Render Stop failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(stopHr) << std::dec
               << L")\n";
    ok = false;
  }
  return ok && renderedFrames > bufferFrames && eventTimeouts == 0;
}

bool isFloat32Format(const WAVEFORMATEX* format) {
  if (!format || format->nChannels == 0 || format->wBitsPerSample != 32) return false;
  if (format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return true;
  if (format->wFormatTag != WAVE_FORMAT_EXTENSIBLE ||
      format->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
    return false;
  }
  const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
  return extensible->Samples.wValidBitsPerSample == 32 &&
         IsEqualGUID(extensible->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
}

bool runLoopbackTest(IMMDeviceEnumerator* enumerator, const std::wstring& exactName, UINT32 seconds) {
  ComPtr<IMMDeviceCollection> devices;
  HRESULT hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, devices.GetAddressOf());
  if (FAILED(hr)) {
    std::wcerr << L"Could not enumerate active render endpoints for loopback (HRESULT 0x" << std::hex
               << static_cast<unsigned long>(hr) << std::dec << L")\n";
    return false;
  }
  UINT count = 0;
  if (FAILED(hr = devices->GetCount(&count))) return false;
  ComPtr<IMMDevice> selected;
  for (UINT index = 0; index < count; ++index) {
    ComPtr<IMMDevice> candidate;
    if (SUCCEEDED(devices->Item(index, candidate.GetAddressOf())) && endpointName(candidate.Get()) == exactName) {
      if (selected) {
        std::wcerr << L"Render endpoint name is ambiguous; use a unique active endpoint name\n";
        return false;
      }
      selected = candidate;
    }
  }
  if (!selected) {
    std::wcerr << L"No active render endpoint exactly named '" << exactName << L"'\n";
    return false;
  }

  std::wcout << L"\nExplicit WASAPI shared render-loopback test: " << endpointName(selected.Get()) << L" / " << seconds
             << L" seconds\n"
             << L"Queues one 2.6 ms, -32 dBFS correlation burst; loopback samples stay in memory and are discarded.\n"
             << L"This measures the Windows render-to-loopback path, not DAC/ADC or physical round-trip latency.\n";

  ComPtr<IAudioClient3> renderClient;
  ComPtr<IAudioClient3> loopbackClient;
  hr = selected->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr,
                          reinterpret_cast<void**>(renderClient.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcerr << L"Render IAudioClient3 activation failed (HRESULT 0x" << std::hex
               << static_cast<unsigned long>(hr) << std::dec << L")\n";
    return false;
  }
  hr = selected->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr,
                          reinterpret_cast<void**>(loopbackClient.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcerr << L"Loopback IAudioClient3 activation failed (HRESULT 0x" << std::hex
               << static_cast<unsigned long>(hr) << std::dec << L")\n";
    return false;
  }

  ScopedWaveFormat renderFormat;
  hr = renderClient->GetMixFormat(&renderFormat.value);
  if (FAILED(hr) || !renderFormat.value) {
    std::wcerr << L"GetMixFormat failed for render client (HRESULT 0x" << std::hex
               << static_cast<unsigned long>(hr) << std::dec << L")\n";
    return false;
  }
  if (!isFloat32Format(renderFormat.value)) {
    std::wcerr << L"Loopback correlation currently requires the endpoint shared mix format to be 32-bit float\n";
    printFormat(L"unsupported shared mix format", renderFormat.value);
    return false;
  }

  UINT32 renderBufferFrames = 0;
  UINT32 loopbackBufferFrames = 0;
  UINT32 renderPeriodFrames = 0;
  if (!prepareStream(renderClient.Get(), AUDCLNT_SHAREMODE_SHARED, renderFormat.value, &renderPeriodFrames,
                     &renderBufferFrames) ||
      !preparePullLoopbackStream(loopbackClient.Get(), renderFormat.value, &loopbackBufferFrames)) {
    return false;
  }

  ComPtr<IAudioRenderClient> render;
  ComPtr<IAudioCaptureClient> capture;
  hr = renderClient->GetService(IID_PPV_ARGS(render.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcerr << L"Could not acquire IAudioRenderClient (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }
  hr = loopbackClient->GetService(IID_PPV_ARGS(capture.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcerr << L"Could not acquire loopback IAudioCaptureClient (HRESULT 0x" << std::hex
               << static_cast<unsigned long>(hr) << std::dec << L")\n";
    return false;
  }

  ScopedEvent renderEvent;
  renderEvent.value = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!renderEvent.value) {
    std::wcerr << L"CreateEvent failed (Win32 " << GetLastError() << L")\n";
    return false;
  }
  if (FAILED(renderClient->SetEventHandle(renderEvent.value))) {
    std::wcerr << L"SetEventHandle failed for render stream\n";
    return false;
  }

  const UINT32 sampleRate = renderFormat.value->nSamplesPerSec;
  const UINT32 channels = renderFormat.value->nChannels;
  const UINT32 blockAlign = renderFormat.value->nBlockAlign;
  const DWORD waitMs = std::max<DWORD>(100, static_cast<DWORD>(10'000.0 * renderBufferFrames / sampleRate));
  std::wcout << L"    shared mix: " << channels << L" ch, " << sampleRate << L" Hz float32; render period="
             << renderPeriodFrames << L" frames / " << std::fixed << std::setprecision(3)
             << framesToMs(renderPeriodFrames, sampleRate) << L" ms; render buffer=" << renderBufferFrames
             << L" frames / " << framesToMs(renderBufferFrames, sampleRate) << L" ms; loopback buffer="
             << loopbackBufferFrames << L" frames / " << framesToMs(loopbackBufferFrames, sampleRate) << L" ms\n";

  const wchar_t* mmcssTaskName = L"Audio";
  ScopedMmcssTask mmcssTask;
  if (!mmcssTask.registerTask(mmcssTaskName)) {
    std::wcerr << L"AvSetMmThreadCharacteristics failed for MMCSS task '" << mmcssTaskName << L"' (Win32 "
               << GetLastError() << L")\n";
    return false;
  }

  BYTE* initialData = nullptr;
  hr = render->GetBuffer(renderBufferFrames, &initialData);
  if (FAILED(hr)) {
    std::wcerr << L"Render prime GetBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }
  hr = render->ReleaseBuffer(renderBufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
  if (FAILED(hr)) {
    std::wcerr << L"Render prime ReleaseBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }

  LARGE_INTEGER qpcFrequency{};
  if (!QueryPerformanceFrequency(&qpcFrequency) || qpcFrequency.QuadPart <= 0) {
    std::wcerr << L"QueryPerformanceFrequency failed\n";
    return false;
  }
  hr = loopbackClient->Start();
  if (FAILED(hr)) {
    std::wcerr << L"Loopback stream Start failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }
  hr = renderClient->Start();
  if (FAILED(hr)) {
    loopbackClient->Stop();
    std::wcerr << L"Render stream Start failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }

  const auto started = std::chrono::steady_clock::now();
  const auto deadline = started + std::chrono::seconds(seconds);
  const auto probe = kyx::audio_probe::makeLoopbackProbe();
  constexpr float probeLevel = 0.0251189F;  // -32 dBFS
  const UINT64 targetProbeFrame = sampleRate;
  std::vector<float> capturedSamples;
  capturedSamples.reserve(static_cast<std::size_t>(seconds) * sampleRate);
  UINT64 capturedFrames = 0;
  UINT64 expectedDevicePosition = 0;
  UINT64 firstQpcPosition100ns = 0;
  UINT64 firstPacketDiscontinuities = 0;
  UINT64 laterDiscontinuities = 0;
  UINT64 silentPackets = 0;
  UINT64 timestampErrors = 0;
  UINT64 devicePositionGaps = 0;
  UINT64 eventTimeouts = 0;
  UINT64 renderedFrames = renderBufferFrames;
  UINT64 renderEvents = 0;
  bool probeQueued = false;
  UINT64 framesAheadOfProbe = 0;
  LARGE_INTEGER probeReleaseQpc{};
  bool ok = true;

  auto drainLoopback = [&]() {
    for (;;) {
      UINT32 packetFrames = 0;
      BYTE* data = nullptr;
      DWORD flags = 0;
      UINT64 devicePosition = 0;
      UINT64 qpcPosition100ns = 0;
      hr = capture->GetBuffer(&data, &packetFrames, &flags, &devicePosition, &qpcPosition100ns);
      if (hr == AUDCLNT_S_BUFFER_EMPTY) return true;
      if (FAILED(hr)) {
        std::wcerr << L"Loopback GetBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
                   << std::dec << L")\n";
        return false;
      }
      const bool firstPacket = capturedFrames == 0;
      if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) {
        if (firstPacket) {
          ++firstPacketDiscontinuities;
        } else {
          ++laterDiscontinuities;
        }
      }
      if (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) ++timestampErrors;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) ++silentPackets;
      if (firstPacket) {
        firstQpcPosition100ns = qpcPosition100ns;
      } else if (devicePosition != expectedDevicePosition) {
        ++devicePositionGaps;
      }
      expectedDevicePosition = devicePosition + packetFrames;

      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        capturedSamples.insert(capturedSamples.end(), packetFrames, 0.0F);
      } else if (data) {
        const auto* samples = reinterpret_cast<const float*>(data);
        for (UINT32 frame = 0; frame < packetFrames; ++frame) {
          double mono = 0.0;
          for (UINT32 channel = 0; channel < channels; ++channel) {
            mono += samples[static_cast<std::size_t>(frame) * channels + channel];
          }
          capturedSamples.push_back(static_cast<float>(mono / channels));
        }
      } else {
        capture->ReleaseBuffer(packetFrames);
        std::wcerr << L"Loopback returned a null non-silent packet\n";
        return false;
      }
      capturedFrames += packetFrames;
      hr = capture->ReleaseBuffer(packetFrames);
      if (FAILED(hr)) {
        std::wcerr << L"Loopback ReleaseBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
                   << std::dec << L")\n";
        return false;
      }
    }
  };

  auto renderAvailable = [&]() {
    UINT32 padding = 0;
    hr = renderClient->GetCurrentPadding(&padding);
    if (FAILED(hr) || padding > renderBufferFrames) {
      std::wcerr << L"Render GetCurrentPadding failed or returned an invalid value (HRESULT 0x" << std::hex
                 << static_cast<unsigned long>(hr) << std::dec << L")\n";
      return false;
    }
    const UINT32 available = renderBufferFrames - padding;
    if (available == 0) return true;
    BYTE* data = nullptr;
    hr = render->GetBuffer(available, &data);
    if (FAILED(hr) || !data) {
      std::wcerr << L"Render GetBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
                 << L")\n";
      return false;
    }
    std::memset(data, 0, static_cast<std::size_t>(available) * blockAlign);
    auto* samples = reinterpret_cast<float*>(data);
    const UINT64 bufferStartFrame = renderedFrames;
    bool bufferContainsProbe = false;
    UINT32 probeOffsetInBuffer = 0;
    for (UINT32 frame = 0; frame < available; ++frame) {
      const UINT64 streamFrame = bufferStartFrame + frame;
      if (streamFrame < targetProbeFrame || streamFrame >= targetProbeFrame + probe.size()) continue;
      const std::size_t probeIndex = static_cast<std::size_t>(streamFrame - targetProbeFrame);
      for (UINT32 channel = 0; channel < channels; ++channel) {
        samples[static_cast<std::size_t>(frame) * channels + channel] = probe[probeIndex] * probeLevel;
      }
      if (!bufferContainsProbe) probeOffsetInBuffer = frame;
      bufferContainsProbe = true;
    }
    if (bufferContainsProbe && !probeQueued) {
      QueryPerformanceCounter(&probeReleaseQpc);
      framesAheadOfProbe = static_cast<UINT64>(padding) + probeOffsetInBuffer;
      probeQueued = true;
    }
    const DWORD releaseFlags = bufferContainsProbe ? 0 : AUDCLNT_BUFFERFLAGS_SILENT;
    hr = render->ReleaseBuffer(available, releaseFlags);
    if (FAILED(hr)) {
      std::wcerr << L"Render ReleaseBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
                 << std::dec << L")\n";
      return false;
    }
    renderedFrames += available;
    return true;
  };

  while (std::chrono::steady_clock::now() < deadline) {
    const DWORD waitResult = WaitForSingleObject(renderEvent.value, waitMs);
    if (waitResult == WAIT_TIMEOUT) {
      ++eventTimeouts;
      if (eventTimeouts >= 3) {
        std::wcerr << L"Render/loopback events timed out three consecutive times\n";
        ok = false;
        break;
      }
      continue;
    }
    if (waitResult != WAIT_OBJECT_0) {
      std::wcerr << L"Render event wait failed (Win32 " << GetLastError() << L")\n";
      ok = false;
      break;
    }
    if (!drainLoopback()) {
      ok = false;
      break;
    }
    ++renderEvents;
    if (!renderAvailable()) {
      ok = false;
      break;
    }
  }

  const HRESULT renderStopHr = renderClient->Stop();
  const HRESULT loopbackStopHr = loopbackClient->Stop();
  drainLoopback();
  const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
  if (FAILED(renderStopHr) || FAILED(loopbackStopHr)) {
    std::wcerr << L"Stopping render or loopback client failed\n";
    ok = false;
  }

  std::size_t matchOffset = 0;
  double matchCorrelation = 0.0;
  const bool foundProbe = probeQueued &&
                         kyx::audio_probe::findLoopbackProbe(capturedSamples, probe, &matchOffset,
                                                           &matchCorrelation);
  std::wcout << L"    loopback result: elapsed=" << std::fixed << std::setprecision(2) << elapsed
             << L" s, render events=" << renderEvents << L", captured=" << capturedFrames << L" frames ("
             << capturedSamples.size() << L" mono samples), later discontinuities=" << laterDiscontinuities
             << L", first-packet discontinuities=" << firstPacketDiscontinuities << L", silent packets="
             << silentPackets << L", timestamp errors=" << timestampErrors << L", device-position gaps="
             << devicePositionGaps << L", event timeouts=" << eventTimeouts << L"\n";
  const bool captureTimelineValid = laterDiscontinuities == 0 && timestampErrors == 0 && devicePositionGaps == 0;
  if (foundProbe && captureTimelineValid && firstQpcPosition100ns > 0 && probeReleaseQpc.QuadPart > 0) {
    const long double qpcSubmit100ns =
        static_cast<long double>(probeReleaseQpc.QuadPart) * 10'000'000.0L / qpcFrequency.QuadPart;
    const long double expectedPresentation100ns =
        qpcSubmit100ns + 10'000'000.0L * framesAheadOfProbe / sampleRate;
    const long double loopbackMatch100ns =
        static_cast<long double>(firstQpcPosition100ns) + 10'000'000.0L * matchOffset / sampleRate;
    const double renderToLoopbackMs = static_cast<double>(loopbackMatch100ns - expectedPresentation100ns) / 10'000.0;
    std::wcout << L"    correlation: offset=" << matchOffset << L" frames, normalized=" << std::fixed
               << std::setprecision(4) << matchCorrelation << L"; estimated render-to-WASAPI-loopback delay="
               << std::fixed << std::setprecision(3) << renderToLoopbackMs << L" ms\n";
  } else if (!foundProbe) {
    std::wcout << L"    correlation: probe not detected (queued=" << (probeQueued ? L"yes" : L"no")
               << L", best normalized score=" << std::fixed << std::setprecision(4) << matchCorrelation << L")\n";
  } else {
    std::wcout << L"    correlation: probe found (normalized=" << std::fixed << std::setprecision(4)
               << matchCorrelation << L"), but latency was not reported because the capture timeline had errors\n";
  }
  return ok && foundProbe && laterDiscontinuities == 0 && timestampErrors == 0 && devicePositionGaps == 0 &&
         eventTimeouts == 0 && firstQpcPosition100ns > 0 && probeReleaseQpc.QuadPart > 0;
}

bool runStreamTest(IMMDeviceEnumerator* enumerator, EDataFlow flow, AUDCLNT_SHAREMODE mode,
                   const std::wstring& selector, bool selectById, UINT32 seconds) {
  ComPtr<IMMDeviceCollection> devices;
  reportStreamStage(L"enumerate-active-endpoints");
  HRESULT hr = enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, devices.GetAddressOf());
  if (FAILED(hr)) {
    std::wcerr << L"Could not enumerate active " << flowName(flow) << L" endpoints (HRESULT 0x" << std::hex
               << static_cast<unsigned long>(hr) << std::dec << L")\n";
    return false;
  }
  UINT count = 0;
  hr = devices->GetCount(&count);
  if (FAILED(hr)) return false;
  ComPtr<IMMDevice> selected;
  for (UINT index = 0; index < count; ++index) {
    ComPtr<IMMDevice> candidate;
    if (FAILED(devices->Item(index, candidate.GetAddressOf())) || !candidate)
      continue;
    const bool matches = selectById
                             ? kyx::windows_audio::endpointMatchesSelector(
                                   true, selector, endpointId(candidate.Get()), L"")
                             : kyx::windows_audio::endpointMatchesSelector(
                                   false, selector, L"", endpointName(candidate.Get()));
    if (matches) {
      if (selected) {
        std::wcerr << (selectById ? L"Endpoint ID is unexpectedly ambiguous\n"
                                  : L"Endpoint name is ambiguous; use an opaque endpoint ID\n");
        return false;
      }
      selected = candidate;
    }
  }
  if (!selected) {
    if (selectById)
      std::wcerr << L"No active " << flowName(flow) << L" endpoint has the exact opaque ID requested\n";
    else
      std::wcerr << L"No active " << flowName(flow) << L" endpoint exactly named '" << selector << L"'\n";
    return false;
  }

  std::wcout << L"\nExplicit stream test: " << flowName(flow) << L" / "
            << (mode == AUDCLNT_SHAREMODE_SHARED ? L"WASAPI shared" : L"WASAPI exclusive") << L" / "
            << endpointName(selected.Get()) << L" / " << seconds << L" seconds\n"
            << L"PCM is discarded in process memory; no file is written. Render mode sends silence only.\n";

  ComPtr<IAudioClient3> client;
  reportStreamStage(L"activate-audio-client");
  hr = selected->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr,
                          reinterpret_cast<void**>(client.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcerr << L"IAudioClient3 activation failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }

  WAVEFORMATEX* mixFormat = nullptr;
  reportStreamStage(L"get-mix-format");
  hr = client->GetMixFormat(&mixFormat);
  if (FAILED(hr) || !mixFormat) {
    std::wcerr << L"GetMixFormat failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }

  // Query the shared period with the endpoint mix format used by the metadata
  // preflight. Exclusive mode prefers the Volt's tested PCM16 format.
  WAVEFORMATEX candidateFormat = makeFormat(48'000, 2, 16, WAVE_FORMAT_PCM);
  WAVEFORMATEX* streamFormat = mode == AUDCLNT_SHAREMODE_SHARED ? mixFormat : &candidateFormat;
  WAVEFORMATEX* closestMatch = nullptr;
  reportStreamStage(L"check-stream-format");
  hr = client->IsFormatSupported(mode, streamFormat,
                                 mode == AUDCLNT_SHAREMODE_SHARED ? &closestMatch : nullptr);
  if (hr != S_OK && mode == AUDCLNT_SHAREMODE_EXCLUSIVE) {
    streamFormat = mixFormat;
    hr = client->IsFormatSupported(mode, streamFormat, nullptr);
  }
  if (closestMatch) CoTaskMemFree(closestMatch);
  if (hr != S_OK) {
    std::wcerr << L"No exact endpoint format is supported for this stream mode (HRESULT 0x" << std::hex
               << static_cast<unsigned long>(hr) << std::dec << L")\n";
    CoTaskMemFree(mixFormat);
    return false;
  }
  printFormat(L"stream format", streamFormat);

  UINT32 periodFrames = 0;
  UINT32 bufferFrames = 0;
  reportStreamStage(L"prepare-audio-stream");
  if (!prepareStream(client.Get(), mode, streamFormat, &periodFrames, &bufferFrames)) {
    CoTaskMemFree(mixFormat);
    return false;
  }
  ScopedEvent event;
  event.value = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!event.value) {
    std::wcerr << L"CreateEvent failed (Win32 " << GetLastError() << L")\n";
    CoTaskMemFree(mixFormat);
    return false;
  }
  const UINT32 sampleRate = streamFormat->nSamplesPerSec;
  const double periodMs = framesToMs(periodFrames, sampleRate);
  std::wcout << L"    requested period=" << periodFrames << L" frames / " << std::fixed << std::setprecision(3)
            << periodMs << L" ms; allocated endpoint buffer=" << bufferFrames << L" frames / "
            << framesToMs(bufferFrames, sampleRate) << L" ms\n";
  const wchar_t* mmcssTaskName = periodMs < 10.0 ? L"Pro Audio" : L"Audio";
  ScopedMmcssTask mmcssTask;
  reportStreamStage(L"register-mmcss");
  if (!mmcssTask.registerTask(mmcssTaskName)) {
    std::wcerr << L"AvSetMmThreadCharacteristics failed for MMCSS task '" << mmcssTaskName << L"' (Win32 "
               << GetLastError() << L")\n";
    CoTaskMemFree(mixFormat);
    return false;
  }
  std::wcout << L"    MMCSS service-thread task: " << mmcssTaskName << L"\n";
  reportStreamStage(flow == eCapture ? L"run-capture-stream" : L"run-silent-render-stream");
  const bool ok = flow == eCapture
                      ? runCaptureStream(client.Get(), event.value, mode, seconds, bufferFrames, sampleRate)
                      : runSilentRenderStream(client.Get(), event.value, seconds, bufferFrames, sampleRate);
  CoTaskMemFree(mixFormat);
  return ok;
}

void printUsage() {
  std::wcout
      << L"\nMetadata-only endpoint listing for the Studio discovery bridge:\n"
      << L"  kyx-windows-audio-probe.exe --list-json\n"
      << L"  Returns opaque endpoint IDs, friendly names, flow, state and "
         L"console-default status.\n"
      << L"  Does not initialize streams, read samples or change device "
         L"settings.\n";
  std::wcout
      << L"\nOptional stream test (never runs without this explicit command):\n"
      << L"  kyx-windows-audio-probe.exe --stream-test capture|render "
         L"shared|exclusive \"exact endpoint name\" [seconds] "
         L"[--exclusive-confirmed]\n"
      << L"  kyx-windows-audio-probe.exe --stream-id-test capture|render "
         L"shared|exclusive \"opaque endpoint ID\" [seconds] "
         L"[--exclusive-confirmed]\n"
      << L"  Duration is 10 seconds by default and is capped at 30 seconds.\n"
      << L"  ID selection never falls back to a name or default endpoint.\n"
      << L"  Exclusive mode requires --exclusive-confirmed because it can "
         L"interrupt other apps' audio.\n"
      << L"  Capture packets are discarded; render mode queues silence only. "
         L"No PCM is saved.\n";
  std::wcout << L"\nOptional render-loopback check (shared mode only):\n"
             << L"  kyx-windows-audio-probe.exe --loopback-test \"exact render endpoint name\" [seconds]\n"
             << L"  Duration is 4 seconds by default and may be set from 2 to 10 seconds.\n"
             << L"  Plays one short -32 dBFS correlation burst; captured loopback PCM stays in memory and is discarded.\n"
             << L"  Measures render-to-WASAPI-loopback timing, not physical DAC/ADC round-trip latency.\n";
}

struct StreamTestOptions {
  EDataFlow flow = eAll;
  AUDCLNT_SHAREMODE mode = static_cast<AUDCLNT_SHAREMODE>(-1);
  std::wstring selector;
  bool selectById = false;
  UINT32 seconds = 10;
};

bool parseStreamTestOptions(int argc, wchar_t** argv, bool selectById, StreamTestOptions* options) {
  if (argc < 5 || argc > 7 || !options) return false;
  const std::wstring flowArg = argv[2];
  const std::wstring modeArg = argv[3];
  options->flow = flowArg == L"capture" ? eCapture : flowArg == L"render" ? eRender : eAll;
  options->mode = modeArg == L"shared" ? AUDCLNT_SHAREMODE_SHARED
                  : modeArg == L"exclusive" ? AUDCLNT_SHAREMODE_EXCLUSIVE
                                             : static_cast<AUDCLNT_SHAREMODE>(-1);
  options->selector = argv[4];
  options->selectById = selectById;
  if (options->selector.empty() || options->selector.size() > (selectById ? 2048 : 512))
    return false;

  bool exclusiveConfirmed = false;
  if (argc >= 6) {
    if (std::wstring(argv[5]) == L"--exclusive-confirmed") {
      exclusiveConfirmed = true;
      if (argc != 6) return false;
    } else {
      wchar_t* end = nullptr;
      const unsigned long seconds = std::wcstoul(argv[5], &end, 10);
      if (end == argv[5] || *end != L'\0' || seconds == 0 || seconds > 30) return false;
      options->seconds = static_cast<UINT32>(seconds);
    }
  }
  if (argc == 7) {
    if (options->mode != AUDCLNT_SHAREMODE_EXCLUSIVE || std::wstring(argv[6]) != L"--exclusive-confirmed") return false;
    exclusiveConfirmed = true;
  }

  return (options->flow == eCapture || options->flow == eRender) &&
         (options->mode == AUDCLNT_SHAREMODE_SHARED || options->mode == AUDCLNT_SHAREMODE_EXCLUSIVE) &&
         !options->selector.empty() &&
         (options->mode == AUDCLNT_SHAREMODE_SHARED ? !exclusiveConfirmed
                                                     : exclusiveConfirmed);
}

struct LoopbackOptions {
  std::wstring exactName;
  UINT32 seconds = 4;
};

bool parseLoopbackOptions(int argc, wchar_t** argv, LoopbackOptions* options) {
  if (argc < 3 || argc > 4 || !options) return false;
  options->exactName = argv[2];
  if (argc == 4) {
    wchar_t* end = nullptr;
    const unsigned long seconds = std::wcstoul(argv[3], &end, 10);
    if (end == argv[3] || *end != L'\0' || seconds < 2 || seconds > 10) return false;
    options->seconds = static_cast<UINT32>(seconds);
  }
  return !options->exactName.empty();
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring(argv[1]) == L"--help") {
    std::wcout << L"KYX Windows audio capability probe\n";
    printUsage();
    return 0;
  }
  const bool streamByName = argc > 1 && std::wstring(argv[1]) == L"--stream-test";
  const bool streamById = argc > 1 && std::wstring(argv[1]) == L"--stream-id-test";
  const bool streamMode = streamByName || streamById;
  const bool loopbackMode = argc > 1 && std::wstring(argv[1]) == L"--loopback-test";
  const bool endpointJsonMode =
      argc > 1 && std::wstring(argv[1]) == L"--list-json";
  StreamTestOptions streamOptions;
  LoopbackOptions loopbackOptions;
  if (!endpointJsonMode)
    std::wcout << L"KYX Windows audio capability probe\n";
  if (streamMode) {
    if (!parseStreamTestOptions(argc, argv, streamById, &streamOptions)) {
      std::wcerr << L"Invalid stream-test arguments\n";
      printUsage();
      return 2;
    }
  } else if (loopbackMode) {
    if (!parseLoopbackOptions(argc, argv, &loopbackOptions)) {
      std::wcerr << L"Invalid loopback-test arguments\n";
      printUsage();
      return 2;
    }
  } else if (endpointJsonMode) {
    if (argc != 2) {
      std::wcerr << L"--list-json does not accept additional arguments\n";
      return 2;
    }
  } else {
    std::wcout
        << L"Metadata only: no stream is initialized or started, no samples "
           L"are read or recorded, and no device settings change.\n";
    if (argc > 1) {
      printUsage();
      return 2;
    }
  }

  const HRESULT initHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(initHr)) {
    std::wcerr << L"COM initialization failed (HRESULT 0x" << std::hex
               << static_cast<unsigned long>(initHr) << std::dec << L")\n";
    return 1;
  }

  int exitCode = 0;
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr =
      CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                       IID_PPV_ARGS(enumerator.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcerr
        << L"Could not create the Windows audio device enumerator (HRESULT 0x"
        << std::hex << static_cast<unsigned long>(hr) << std::dec << L")\n";
    exitCode = 1;
  } else {
    if (endpointJsonMode) {
      exitCode = listEndpointsAsJson(enumerator.Get()) ? 0 : 1;
    } else if (streamMode) {
      exitCode = runStreamTest(enumerator.Get(), streamOptions.flow,
                               streamOptions.mode, streamOptions.selector,
                               streamOptions.selectById, streamOptions.seconds)
                     ? 0
                     : 1;
    } else if (loopbackMode) {
      exitCode = runLoopbackTest(enumerator.Get(), loopbackOptions.exactName,
                                 loopbackOptions.seconds)
                     ? 0
                     : 1;
    } else {
      for (const EDataFlow flow : {eCapture, eRender}) {
        std::wstring defaultId;
        ComPtr<IMMDevice> defaultDevice;
        if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(flow, eConsole, defaultDevice.GetAddressOf()))) {
          defaultId = endpointId(defaultDevice.Get());
        }

        ComPtr<IMMDeviceCollection> devices;
        hr = enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, devices.GetAddressOf());
        if (FAILED(hr)) {
          std::wcout << L"\nCould not enumerate " << flowName(flow) << L" endpoints (HRESULT 0x" << std::hex
                     << static_cast<unsigned long>(hr) << std::dec << L")\n";
          exitCode = 1;
          continue;
        }

        UINT count = 0;
        hr = devices->GetCount(&count);
        if (FAILED(hr)) {
          std::wcout << L"\nCould not count " << flowName(flow) << L" endpoints\n";
          exitCode = 1;
          continue;
        }
        if (count == 0) std::wcout << L"\nNo active " << flowName(flow) << L" endpoints.\n";
        for (UINT index = 0; index < count; ++index) {
          ComPtr<IMMDevice> device;
          if (SUCCEEDED(devices->Item(index, device.GetAddressOf()))) probeEndpoint(device.Get(), flow, defaultId);
        }
      }
    }
  }

  enumerator.Reset();
  CoUninitialize();
  return exitCode;
}
