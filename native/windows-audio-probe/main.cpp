#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>

#include <iomanip>
#include <iostream>
#include <string>

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

}  // namespace

int wmain() {
  std::wcout << L"KYX Windows audio capability probe\n"
            << L"Metadata only: no stream is initialized or started, no samples are read or recorded, and no device settings change.\n";

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

  CoUninitialize();
  return exitCode;
}
