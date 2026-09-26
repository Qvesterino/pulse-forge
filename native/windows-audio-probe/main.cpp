#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>
#include "shared-period-selection.h"

#include <iomanip>
#include <iostream>
#include <string>
#include <chrono>
#include <algorithm>
#include <cwchar>

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

double framesToMs(UINT32 frames, UINT32 sampleRate) {
  return sampleRate == 0 ? 0.0 : 1000.0 * static_cast<double>(frames) / sampleRate;
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

bool prepareStream(IAudioClient3* client, AUDCLNT_SHAREMODE mode, WAVEFORMATEX* format,
                   UINT32* periodFrames, UINT32* bufferFrames) {
  HRESULT hr = AUDCLNT_E_UNSUPPORTED_FORMAT;
  if (mode == AUDCLNT_SHAREMODE_SHARED) {
    AudioClientProperties properties{};
    properties.cbSize = sizeof(properties);
    // Match the documented metadata preflight query for a real stream.
    properties.eCategory = AudioCategory_Media;
    properties.Options = AUDCLNT_STREAMOPTIONS_NONE;
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
    hr = client->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, *periodFrames, format, nullptr);
  } else {
    REFERENCE_TIME defaultPeriod = 0;
    REFERENCE_TIME minimumPeriod = 0;
    hr = client->GetDevicePeriod(&defaultPeriod, &minimumPeriod);
    if (FAILED(hr) || minimumPeriod <= 0) {
      std::wcerr << L"GetDevicePeriod failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
                 << L")\n";
      return false;
    }
    REFERENCE_TIME requestedPeriod = minimumPeriod;
    *periodFrames = static_cast<UINT32>((requestedPeriod * format->nSamplesPerSec) / 10'000'000);
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
      hr = client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, requestedPeriod,
                              requestedPeriod, format, nullptr);
    }
  }
  if (FAILED(hr)) {
    std::wcerr << L"Stream initialization failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
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

bool runCaptureStream(IAudioClient3* client, HANDLE eventHandle, UINT32 seconds, UINT32 bufferFrames,
                      UINT32 sampleRate) {
  ComPtr<IAudioCaptureClient> capture;
  HRESULT hr = client->GetService(IID_PPV_ARGS(capture.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcerr << L"Could not acquire IAudioCaptureClient (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }

  hr = client->SetEventHandle(eventHandle);
  if (FAILED(hr)) {
    std::wcerr << L"SetEventHandle failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }
  hr = client->Start();
  if (FAILED(hr)) {
    std::wcerr << L"Capture stream Start failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }

  UINT64 totalFrames = 0;
  UINT64 firstDevicePosition = 0;
  UINT64 lastDevicePosition = 0;
  UINT64 lastQpcPosition = 0;
  UINT64 packetCount = 0;
  UINT64 discontinuities = 0;
  UINT64 silentPackets = 0;
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

    UINT32 packetFrames = 0;
    for (;;) {
      hr = capture->GetNextPacketSize(&packetFrames);
      if (FAILED(hr)) {
        std::wcerr << L"GetNextPacketSize failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
                   << std::dec << L")\n";
        ok = false;
        break;
      }
      if (packetFrames == 0) break;

      BYTE* data = nullptr;
      DWORD flags = 0;
      UINT64 devicePosition = 0;
      UINT64 qpcPosition = 0;
      hr = capture->GetBuffer(&data, &packetFrames, &flags, &devicePosition, &qpcPosition);
      if (FAILED(hr)) {
        std::wcerr << L"Capture GetBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
                   << std::dec << L")\n";
        ok = false;
        break;
      }
      // Deliberately inspect metadata only. PCM is never copied, played, or written.
      if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) ++discontinuities;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) ++silentPackets;
      if (packetCount == 0) firstDevicePosition = devicePosition;
      lastDevicePosition = devicePosition;
      lastQpcPosition = qpcPosition;
      totalFrames += packetFrames;
      ++packetCount;
      hr = capture->ReleaseBuffer(packetFrames);
      if (FAILED(hr)) {
        std::wcerr << L"Capture ReleaseBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
                   << std::dec << L")\n";
        ok = false;
        break;
      }
    }
    if (!ok) break;
  }

  const HRESULT stopHr = client->Stop();
  const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
  REFERENCE_TIME streamLatency = 0;
  const HRESULT latencyHr = client->GetStreamLatency(&streamLatency);
  std::wcout << L"    capture result: elapsed=" << std::fixed << std::setprecision(2) << elapsed
            << L" s, packets=" << packetCount << L", frames=" << totalFrames << L" ("
            << (sampleRate ? static_cast<double>(totalFrames) / sampleRate : 0.0) << L" s PCM), discontinuities="
            << discontinuities << L", silent packets=" << silentPackets << L", event timeouts=" << eventTimeouts
            << L"\n    device positions: first=" << firstDevicePosition << L", last=" << lastDevicePosition
            << L", last QPC position=" << lastQpcPosition << L"\n";
  if (SUCCEEDED(latencyHr)) {
    std::wcout << L"    WASAPI reported stream latency=" << std::fixed << std::setprecision(3)
              << static_cast<double>(streamLatency) / 10'000.0 << L" ms (not round-trip latency)\n";
  }
  if (FAILED(stopHr)) {
    std::wcerr << L"Capture Stop failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(stopHr) << std::dec
               << L")\n";
    ok = false;
  }
  if (totalFrames == 0 || discontinuities != 0) ok = false;
  return ok;
}

bool runSilentRenderStream(IAudioClient3* client, HANDLE eventHandle, UINT32 seconds, UINT32 bufferFrames,
                           UINT32 sampleRate) {
  ComPtr<IAudioRenderClient> render;
  HRESULT hr = client->GetService(IID_PPV_ARGS(render.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcerr << L"Could not acquire IAudioRenderClient (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }
  hr = client->SetEventHandle(eventHandle);
  if (FAILED(hr)) {
    std::wcerr << L"SetEventHandle failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }

  // Prime the endpoint with silence before starting; no tone or captured input is used.
  BYTE* initialData = nullptr;
  hr = render->GetBuffer(bufferFrames, &initialData);
  if (FAILED(hr)) {
    std::wcerr << L"Render prime GetBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }
  hr = render->ReleaseBuffer(bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
  if (FAILED(hr)) {
    std::wcerr << L"Render prime ReleaseBuffer failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }
  hr = client->Start();
  if (FAILED(hr)) {
    std::wcerr << L"Render stream Start failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec
               << L")\n";
    return false;
  }

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

  const HRESULT stopHr = client->Stop();
  const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
  REFERENCE_TIME streamLatency = 0;
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

bool runStreamTest(IMMDeviceEnumerator* enumerator, EDataFlow flow, AUDCLNT_SHAREMODE mode,
                   const std::wstring& exactName, UINT32 seconds) {
  ComPtr<IMMDeviceCollection> devices;
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
    if (SUCCEEDED(devices->Item(index, candidate.GetAddressOf())) && endpointName(candidate.Get()) == exactName) {
      if (selected) {
        std::wcerr << L"Endpoint name is ambiguous; use a unique active endpoint name\n";
        return false;
      }
      selected = candidate;
    }
  }
  if (!selected) {
    std::wcerr << L"No active " << flowName(flow) << L" endpoint exactly named '" << exactName << L"'\n";
    return false;
  }

  std::wcout << L"\nExplicit stream test: " << flowName(flow) << L" / "
            << (mode == AUDCLNT_SHAREMODE_SHARED ? L"WASAPI shared" : L"WASAPI exclusive") << L" / "
            << endpointName(selected.Get()) << L" / " << seconds << L" seconds\n"
            << L"PCM is discarded in process memory; no file is written. Render mode sends silence only.\n";

  ComPtr<IAudioClient3> client;
  hr = selected->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr,
                          reinterpret_cast<void**>(client.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcerr << L"IAudioClient3 activation failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr)
               << std::dec << L")\n";
    return false;
  }

  WAVEFORMATEX* mixFormat = nullptr;
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
  hr = client->IsFormatSupported(mode, streamFormat, nullptr);
  if (hr != S_OK && mode == AUDCLNT_SHAREMODE_EXCLUSIVE) {
    streamFormat = mixFormat;
    hr = client->IsFormatSupported(mode, streamFormat, nullptr);
  }
  if (hr != S_OK) {
    std::wcerr << L"No exact endpoint format is supported for this stream mode\n";
    CoTaskMemFree(mixFormat);
    return false;
  }
  printFormat(L"stream format", streamFormat);

  UINT32 periodFrames = 0;
  UINT32 bufferFrames = 0;
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
  const bool ok = flow == eCapture
                      ? runCaptureStream(client.Get(), event.value, seconds, bufferFrames, sampleRate)
                      : runSilentRenderStream(client.Get(), event.value, seconds, bufferFrames, sampleRate);
  CoTaskMemFree(mixFormat);
  return ok;
}

void printUsage() {
  std::wcout << L"\nOptional stream test (never runs without this explicit command):\n"
            << L"  kyx-windows-audio-probe.exe --stream-test capture|render shared|exclusive \"exact endpoint name\" [seconds] [--exclusive-confirmed]\n"
            << L"  Duration is 10 seconds by default and is capped at 30 seconds.\n"
            << L"  Exclusive mode requires --exclusive-confirmed because it can interrupt other apps' audio.\n"
            << L"  Capture packets are discarded; render mode queues silence only. No PCM is saved.\n";
}

struct StreamTestOptions {
  EDataFlow flow = eAll;
  AUDCLNT_SHAREMODE mode = static_cast<AUDCLNT_SHAREMODE>(-1);
  std::wstring exactName;
  UINT32 seconds = 10;
};

bool parseStreamTestOptions(int argc, wchar_t** argv, StreamTestOptions* options) {
  if (argc < 5 || argc > 7 || !options) return false;
  const std::wstring flowArg = argv[2];
  const std::wstring modeArg = argv[3];
  options->flow = flowArg == L"capture" ? eCapture : flowArg == L"render" ? eRender : eAll;
  options->mode = modeArg == L"shared" ? AUDCLNT_SHAREMODE_SHARED
                  : modeArg == L"exclusive" ? AUDCLNT_SHAREMODE_EXCLUSIVE
                                             : static_cast<AUDCLNT_SHAREMODE>(-1);
  options->exactName = argv[4];

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
         !options->exactName.empty() &&
         (options->mode == AUDCLNT_SHAREMODE_SHARED ? !exclusiveConfirmed
                                                     : exclusiveConfirmed);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring(argv[1]) == L"--help") {
    std::wcout << L"KYX Windows audio capability probe\n";
    printUsage();
    return 0;
  }
  const bool streamMode = argc > 1 && std::wstring(argv[1]) == L"--stream-test";
  StreamTestOptions streamOptions;
  std::wcout << L"KYX Windows audio capability probe\n";
  if (streamMode) {
    if (!parseStreamTestOptions(argc, argv, &streamOptions)) {
      std::wcerr << L"Invalid stream-test arguments\n";
      printUsage();
      return 2;
    }
  } else {
    std::wcout << L"Metadata only: no stream is initialized or started, no samples are read or recorded, and no device settings change.\n";
    if (argc > 1) {
      printUsage();
      return 2;
    }
  }

  const HRESULT initHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(initHr)) {
    std::wcerr << L"COM initialization failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(initHr)
               << std::dec << L")\n";
    return 1;
  }

  int exitCode = 0;
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                IID_PPV_ARGS(enumerator.GetAddressOf()));
  if (FAILED(hr)) {
    std::wcerr << L"Could not create the Windows audio device enumerator (HRESULT 0x" << std::hex
               << static_cast<unsigned long>(hr) << std::dec << L")\n";
    exitCode = 1;
  } else {
    if (streamMode) {
      exitCode = runStreamTest(enumerator.Get(), streamOptions.flow, streamOptions.mode, streamOptions.exactName,
                               streamOptions.seconds)
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
