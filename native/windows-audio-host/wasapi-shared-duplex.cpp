#include "wasapi-shared-duplex.h"

#include <windows.h>
#include <avrt.h>
#include <audioclient.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "channel-map.h"
#include "spsc-float-ring.h"

using Microsoft::WRL::ComPtr;

namespace kyx::windows_audio {
namespace {

constexpr std::uint32_t kMaximumStreamFrames = 131'072;
constexpr std::uint32_t kMaximumEndpointBufferFrames = 65'536;
constexpr auto kStartupTimeout = std::chrono::seconds(15);

std::wstring hresultMessage(const wchar_t* operation, HRESULT result) {
  std::wostringstream message;
  message << operation << L" failed (HRESULT 0x" << std::hex << std::uppercase << std::setw(8)
          << std::setfill(L'0') << static_cast<unsigned long>(result) << L")";
  return message.str();
}

bool isDeviceInvalidation(HRESULT result) noexcept {
  return result == AUDCLNT_E_DEVICE_INVALIDATED || result == AUDCLNT_E_RESOURCES_INVALIDATED;
}

struct ScopedComInitialization {
  HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ~ScopedComInitialization() {
    if (SUCCEEDED(result)) CoUninitialize();
  }
  bool valid() const noexcept { return SUCCEEDED(result); }
};

struct ScopedMmcssTask {
  HANDLE handle = nullptr;
  ~ScopedMmcssTask() {
    if (handle) AvRevertMmThreadCharacteristics(handle);
  }
};

struct ScopedWaveFormat {
  WAVEFORMATEX* value = nullptr;
  ~ScopedWaveFormat() { CoTaskMemFree(value); }
};

struct ScopedEvent {
  HANDLE value = nullptr;
  ~ScopedEvent() {
    if (value) CloseHandle(value);
  }
};

class EndpointNotification final : public IMMNotificationClient {
 public:
  EndpointNotification(HANDLE changedEvent, std::wstring inputId, std::wstring outputId)
      : changedEvent_(changedEvent), inputId_(std::move(inputId)), outputId_(std::move(outputId)) {}

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
    if (!object) return E_POINTER;
    if (IsEqualIID(iid, __uuidof(IUnknown)) || IsEqualIID(iid, __uuidof(IMMNotificationClient))) {
      *object = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references_); }

  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = InterlockedDecrement(&references_);
    if (remaining == 0) delete this;
    return remaining;
  }

  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR id, DWORD state) override {
    if (id && state != DEVICE_STATE_ACTIVE && isSelected(id)) SetEvent(changedEvent_);
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR id) override {
    if (id && isSelected(id)) SetEvent(changedEvent_);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow, ERole, LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }

 private:
  bool isSelected(LPCWSTR id) const noexcept {
    return inputId_ == id || outputId_ == id;
  }

  volatile LONG references_ = 1;
  HANDLE changedEvent_;
  const std::wstring inputId_;
  const std::wstring outputId_;
};

struct PreparedEndpoint {
  ComPtr<IAudioClient3> client;
  WAVEFORMATEXTENSIBLE format{};
  SharedModePeriodRange periods{};
  std::uint32_t channels = 0;
  std::uint32_t bufferFrames = 0;
  std::optional<std::uint32_t> reportedLatencyFrames;
};

std::optional<std::uint32_t> queryStreamLatencyFrames(IAudioClient3* client, std::uint32_t sampleRateHz) {
  if (!client || sampleRateHz == 0) return std::nullopt;
  REFERENCE_TIME streamLatency = 0;
  if (FAILED(client->GetStreamLatency(&streamLatency)) || streamLatency <= 0) return std::nullopt;
  const long double frames = static_cast<long double>(streamLatency) * sampleRateHz / 10'000'000.0L;
  if (frames > std::numeric_limits<std::uint32_t>::max()) return std::nullopt;
  return static_cast<std::uint32_t>(frames + 0.5L);
}

bool makeFloat32Format(const WAVEFORMATEX* mixFormat,
                       std::uint32_t sampleRateHz,
                       WAVEFORMATEXTENSIBLE* result,
                       std::wstring* error) {
  if (!mixFormat || !result || mixFormat->nChannels == 0 || mixFormat->nChannels > kMaximumAudioChannels ||
      sampleRateHz < 8'000 || sampleRateHz > 384'000) {
    if (error) *error = L"Selected endpoint reported an unsupported channel count or sample rate";
    return false;
  }

  std::uint32_t channelMask = 0;
  if (mixFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
      mixFormat->cbSize >= sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
    channelMask = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(mixFormat)->dwChannelMask;
  } else if (mixFormat->nChannels == 1) {
    channelMask = SPEAKER_FRONT_CENTER;
  } else if (mixFormat->nChannels == 2) {
    channelMask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
  }

  *result = {};
  result->Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  result->Format.nChannels = mixFormat->nChannels;
  result->Format.nSamplesPerSec = sampleRateHz;
  result->Format.wBitsPerSample = 32;
  result->Format.nBlockAlign = static_cast<WORD>(mixFormat->nChannels * sizeof(float));
  result->Format.nAvgBytesPerSec = sampleRateHz * result->Format.nBlockAlign;
  result->Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  result->Samples.wValidBitsPerSample = 32;
  result->dwChannelMask = channelMask;
  result->SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
  return true;
}

bool prepareEndpoint(IMMDeviceEnumerator* enumerator,
                     const std::wstring& endpointId,
                     EDataFlow flow,
                     std::uint32_t sampleRateHz,
                     std::uint32_t periodFrames,
                     HANDLE eventHandle,
                     const std::vector<std::uint32_t>& channelMap,
                     std::atomic<const char*>* startupStage,
                     std::atomic<const char*>* startupEndpoint,
                     PreparedEndpoint* prepared,
                     std::wstring* error) {
  if (!enumerator || !prepared || !error) return false;
  const char* endpointName = flow == eCapture ? "capture" : "render";
  const auto reportStage = [&](const char* stage) {
    if (startupEndpoint) startupEndpoint->store(endpointName, std::memory_order_release);
    if (startupStage) startupStage->store(stage, std::memory_order_release);
  };

  ComPtr<IMMDeviceCollection> flowEndpoints;
  reportStage("enumerate-active-endpoints");
  HRESULT result = enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, flowEndpoints.GetAddressOf());
  if (FAILED(result)) {
    *error = hresultMessage(L"Could not enumerate active endpoints for the selected audio flow", result);
    return false;
  }
  UINT endpointCount = 0;
  reportStage("read-active-endpoint-count");
  result = flowEndpoints->GetCount(&endpointCount);
  if (FAILED(result)) {
    *error = hresultMessage(L"Could not read active endpoint count", result);
    return false;
  }
  bool exactEndpointInFlow = false;
  reportStage("scan-exact-endpoint-id");
  for (UINT index = 0; index < endpointCount; ++index) {
    ComPtr<IMMDevice> candidate;
    if (FAILED(flowEndpoints->Item(index, candidate.GetAddressOf())) || !candidate) continue;
    LPWSTR candidateId = nullptr;
    if (SUCCEEDED(candidate->GetId(&candidateId)) && candidateId) {
      exactEndpointInFlow = endpointId == candidateId;
      CoTaskMemFree(candidateId);
      if (exactEndpointInFlow) break;
    }
  }
  if (!exactEndpointInFlow) {
    *error = flow == eCapture ? L"The exact selected endpoint is not an active capture device"
                              : L"The exact selected endpoint is not an active render device";
    return false;
  }

  ComPtr<IMMDevice> device;
  reportStage("open-exact-endpoint");
  result = enumerator->GetDevice(endpointId.c_str(), device.GetAddressOf());
  if (FAILED(result)) {
    *error = hresultMessage(L"Could not open the exact selected endpoint ID", result);
    return false;
  }
  LPWSTR actualId = nullptr;
  reportStage("verify-endpoint-id");
  result = device->GetId(&actualId);
  if (FAILED(result) || !actualId) {
    if (actualId) CoTaskMemFree(actualId);
    *error = hresultMessage(L"Could not read the selected endpoint ID", result);
    return false;
  }
  const bool exactIdMatches = endpointId == actualId;
  CoTaskMemFree(actualId);
  if (!exactIdMatches) {
    *error = L"Windows returned a different endpoint ID than the one selected";
    return false;
  }

  DWORD state = 0;
  reportStage("read-endpoint-state");
  result = device->GetState(&state);
  if (FAILED(result)) {
    *error = hresultMessage(L"Could not read selected endpoint state", result);
    return false;
  }
  if (state != DEVICE_STATE_ACTIVE) {
    *error = L"The exact selected endpoint is not active; choose it again after reconnecting";
    return false;
  }

  reportStage("activate-audio-client");
  result = device->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr,
                            reinterpret_cast<void**>(prepared->client.GetAddressOf()));
  if (FAILED(result)) {
    *error = hresultMessage(L"Could not activate IAudioClient3 on the selected endpoint", result);
    return false;
  }

  AudioClientProperties properties{};
  properties.cbSize = sizeof(properties);
  properties.bIsOffload = FALSE;
  properties.eCategory = AudioCategory_Media;
  properties.Options = AUDCLNT_STREAMOPTIONS_NONE;
  reportStage("set-client-properties");
  result = prepared->client->SetClientProperties(&properties);
  if (FAILED(result)) {
    *error = hresultMessage(L"Could not set shared-mode audio client properties", result);
    return false;
  }

  ScopedWaveFormat mixFormat;
  reportStage("get-mix-format");
  result = prepared->client->GetMixFormat(&mixFormat.value);
  if (FAILED(result) || !mixFormat.value) {
    *error = hresultMessage(L"Could not read endpoint mix format", result);
    return false;
  }
  if (!makeFloat32Format(mixFormat.value, sampleRateHz, &prepared->format, error)) return false;
  prepared->channels = prepared->format.Format.nChannels;
  if (!isValidChannelMap(channelMap, prepared->channels, static_cast<std::uint32_t>(channelMap.size()))) {
    *error = L"Selected endpoint channel map is invalid for the endpoint's channel count";
    return false;
  }

  WAVEFORMATEX* closestMatch = nullptr;
  result = prepared->client->IsFormatSupported(AUDCLNT_SHAREMODE_SHARED, &prepared->format.Format, &closestMatch);
  if (closestMatch) CoTaskMemFree(closestMatch);
  if (result != S_OK) {
    *error = hresultMessage(L"Selected endpoint does not support the requested exact float32 shared format", result);
    return false;
  }

  UINT32 defaultFrames = 0;
  UINT32 fundamentalFrames = 0;
  UINT32 minimumFrames = 0;
  UINT32 maximumFrames = 0;
  reportStage("query-shared-periods");
  result = prepared->client->GetSharedModeEnginePeriod(&prepared->format.Format, &defaultFrames, &fundamentalFrames,
                                                        &minimumFrames, &maximumFrames);
  if (FAILED(result)) {
    *error = hresultMessage(L"Could not query endpoint shared-mode periods", result);
    return false;
  }
  (void)defaultFrames;
  prepared->periods = {minimumFrames, maximumFrames, fundamentalFrames};
  if (!isLegalSharedModePeriod(prepared->periods, periodFrames)) {
    *error = L"Requested period is outside this endpoint's supported range or is not fundamental-period aligned";
    return false;
  }

  reportStage("initialize-shared-stream");
  result = prepared->client->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, periodFrames,
                                                          &prepared->format.Format, nullptr);
  if (FAILED(result)) {
    *error = hresultMessage(L"Could not initialize the selected shared-mode period", result);
    return false;
  }
  reportStage("query-endpoint-buffer");
  result = prepared->client->GetBufferSize(&prepared->bufferFrames);
  if (FAILED(result) || prepared->bufferFrames == 0 || prepared->bufferFrames > kMaximumEndpointBufferFrames) {
    *error = hresultMessage(L"Endpoint buffer size is invalid or exceeds the host limit", result);
    return false;
  }
  reportStage("attach-event-handle");
  result = prepared->client->SetEventHandle(eventHandle);
  if (FAILED(result)) {
    *error = hresultMessage(L"Could not attach the event-driven endpoint handle", result);
    return false;
  }
  return true;
}

}  // namespace

struct WasapiSharedDuplexSession::Impl {
  explicit Impl(SharedModeDuplexRequest value)
      : request(std::move(value)), captureRing(request.ringCapacityFrames,
                                              static_cast<std::uint32_t>(request.inputChannelMap.size())),
        renderRing(request.ringCapacityFrames,
                   static_cast<std::uint32_t>(request.outputChannelMap.size())) {
    stopEvent.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    deviceChangedEvent.value = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    captureEvent.value = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    renderEvent.value = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    eventsValid = stopEvent.value && deviceChangedEvent.value && captureEvent.value && renderEvent.value;
  }

  SharedModeDuplexRequest request;
  FloatSpscRing captureRing;
  FloatSpscRing renderRing;
  ScopedEvent stopEvent;
  ScopedEvent deviceChangedEvent;
  ScopedEvent captureEvent;
  ScopedEvent renderEvent;
  bool eventsValid = false;
  std::thread worker;
  std::mutex workerMutex;
  mutable std::mutex startupMutex;
  std::condition_variable startupCondition;
  bool startCalled = false;
  bool stopCalled = false;
  bool startupComplete = false;
  bool startupSucceeded = false;
  std::wstring startupError;
  std::atomic<SharedModeDuplexState> state{SharedModeDuplexState::idle};
  std::atomic<const char*> startupStage{"idle"};
  std::atomic<const char*> startupEndpoint{""};
  std::atomic<std::uint64_t> captureOverrunPackets{0};
  std::atomic<std::uint64_t> renderOverrunPackets{0};
  std::atomic<std::uint64_t> renderUnderrunPeriods{0};
  std::atomic<std::uint64_t> captureDiscontinuities{0};
  std::atomic<std::uint64_t> captureTimestampErrors{0};
  mutable std::mutex statusMutex;
  SharedModeDuplexNegotiation negotiation;
  std::wstring lastError;
  std::vector<float> captureScratch;
  std::vector<float> renderScratch;

  bool validateRequest(std::wstring* error) const {
    if (!eventsValid) {
      *error = L"Could not create the native audio session events";
      return false;
    }
    if (request.inputEndpointId.empty() || request.inputEndpointId.size() > 2048 ||
        request.outputEndpointId.empty() || request.outputEndpointId.size() > 2048) {
      *error = L"Capture and render endpoint IDs must be selected explicitly";
      return false;
    }
    if (request.sampleRateHz < 8'000 || request.sampleRateHz > 384'000 || request.periodFrames == 0 ||
        request.periodFrames > kMaximumStreamFrames) {
      *error = L"Sample rate or requested period is outside the bounded host range";
      return false;
    }
    if (!captureRing.valid() || !renderRing.valid()) {
      *error = L"PCM ring configuration is invalid or exceeds its memory limit";
      return false;
    }
    if (captureRing.capacityFrames() < request.periodFrames || renderRing.capacityFrames() < request.periodFrames) {
      *error = L"PCM ring capacity must hold at least one requested endpoint period";
      return false;
    }
    return true;
  }

  void finishStartup(bool success, SharedModeDuplexState finalState, const std::wstring& error) {
    if (!error.empty()) {
      std::lock_guard<std::mutex> lock(statusMutex);
      lastError = error;
    }
    state.store(finalState, std::memory_order_release);
    {
      std::lock_guard<std::mutex> lock(startupMutex);
      if (!startupComplete) {
        startupComplete = true;
        startupSucceeded = success;
        startupError = error;
      }
    }
    startupCondition.notify_all();
  }

  void setTerminal(SharedModeDuplexState terminalState, const std::wstring& error) {
    if (!error.empty()) {
      std::lock_guard<std::mutex> lock(statusMutex);
      lastError = error;
    }
    state.store(terminalState, std::memory_order_release);
    startupCondition.notify_all();
  }

  void joinWorker() noexcept {
    std::lock_guard<std::mutex> lock(workerMutex);
    if (worker.joinable() && worker.get_id() != std::this_thread::get_id()) worker.join();
  }

  bool start(std::wstring* error) {
    startupStage.store("validating-request", std::memory_order_release);
    std::wstring validationError;
    if (!validateRequest(&validationError)) {
      if (error) *error = validationError;
      finishStartup(false, SharedModeDuplexState::failed, validationError);
      return false;
    }
    std::wstring workerCreationError;
    {
      std::lock_guard<std::mutex> lock(startupMutex);
      if (stopCalled) {
        if (error) *error = L"A stopped WASAPI session cannot be started; create a new session to retry";
        return false;
      }
      if (startCalled) {
        if (error) *error = L"A WASAPI session can only be started once; create a new session to retry";
        return false;
      }
      startCalled = true;
      state.store(SharedModeDuplexState::starting, std::memory_order_release);
      startupEndpoint.store("", std::memory_order_release);
      startupStage.store("creating-worker", std::memory_order_release);
      ResetEvent(stopEvent.value);
      ResetEvent(deviceChangedEvent.value);
      try {
        // Keep creation under startupMutex so stop() cannot signal an empty
        // worker slot and return just before this thread is launched.
        worker = std::thread([this]() { run(); });
      } catch (const std::exception& exception) {
        const std::string detail(exception.what());
        workerCreationError = L"Could not create WASAPI service thread: " +
                              std::wstring(detail.begin(), detail.end());
      } catch (...) {
        workerCreationError = L"Could not create WASAPI service thread";
      }
    }
    if (!workerCreationError.empty()) {
      if (error) *error = workerCreationError;
      finishStartup(false, SharedModeDuplexState::failed, workerCreationError);
      return false;
    }

    std::unique_lock<std::mutex> lock(startupMutex);
    const bool completed = startupCondition.wait_for(lock, kStartupTimeout, [this]() { return startupComplete; });
    if (!completed) {
      lock.unlock();
      SetEvent(stopEvent.value);
      joinWorker();
      const std::wstring message = L"Timed out while opening the selected WASAPI endpoints";
      if (error) *error = message;
      finishStartup(false, SharedModeDuplexState::failed, message);
      return false;
    }
    const bool success = startupSucceeded;
    const std::wstring startupMessage = startupError;
    lock.unlock();
    if (!success) joinWorker();
    if (error && !success) *error = startupMessage;
    return success;
  }

  void stop() noexcept {
    {
      std::lock_guard<std::mutex> lock(startupMutex);
      stopCalled = true;
    }
    if (stopEvent.value) SetEvent(stopEvent.value);
    joinWorker();
    const auto current = state.load(std::memory_order_acquire);
    if (current == SharedModeDuplexState::idle || current == SharedModeDuplexState::starting)
      state.store(SharedModeDuplexState::stopped, std::memory_order_release);
  }

  void run() noexcept {
    startupEndpoint.store("", std::memory_order_release);
    startupStage.store("initializing-com", std::memory_order_release);
    const ScopedComInitialization com;
    if (!com.valid()) {
      finishStartup(false, SharedModeDuplexState::failed, hresultMessage(L"Could not initialize COM MTA", com.result));
      return;
    }

    try {
      runSession();
    } catch (const std::exception& exception) {
      const std::string detail(exception.what());
      const std::wstring message = L"WASAPI host exception: " + std::wstring(detail.begin(), detail.end());
      finishStartup(false, SharedModeDuplexState::failed, message);
    } catch (...) {
      finishStartup(false, SharedModeDuplexState::failed, L"WASAPI host failed with an unknown native exception");
    }
  }

  void runSession() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    startupStage.store("creating-device-enumerator", std::memory_order_release);
    HRESULT result = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                      IID_PPV_ARGS(enumerator.GetAddressOf()));
    if (FAILED(result)) {
      finishStartup(false, SharedModeDuplexState::failed, hresultMessage(L"Could not create MMDeviceEnumerator", result));
      return;
    }

    ComPtr<IMMNotificationClient> notification;
    startupStage.store("registering-device-notifications", std::memory_order_release);
    notification.Attach(new EndpointNotification(deviceChangedEvent.value, request.inputEndpointId,
                                                  request.outputEndpointId));
    result = enumerator->RegisterEndpointNotificationCallback(notification.Get());
    if (FAILED(result)) {
      finishStartup(false, SharedModeDuplexState::failed,
                    hresultMessage(L"Could not register selected-endpoint loss notifications", result));
      return;
    }

    PreparedEndpoint input;
    PreparedEndpoint output;
    std::wstring error;
    startupEndpoint.store("capture", std::memory_order_release);
    if (!prepareEndpoint(enumerator.Get(), request.inputEndpointId, eCapture, request.sampleRateHz,
                         request.periodFrames, captureEvent.value, request.inputChannelMap,
                         &startupStage, &startupEndpoint, &input, &error)) {
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, SharedModeDuplexState::failed, error);
      return;
    }
    if (!prepareEndpoint(enumerator.Get(), request.outputEndpointId, eRender, request.sampleRateHz,
                         request.periodFrames, renderEvent.value, request.outputChannelMap,
                         &startupStage, &startupEndpoint, &output, &error)) {
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, SharedModeDuplexState::failed, error);
      return;
    }
    if (captureRing.capacityFrames() < input.bufferFrames || renderRing.capacityFrames() < output.bufferFrames) {
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, SharedModeDuplexState::failed,
                    L"PCM ring capacity is smaller than a selected endpoint's negotiated buffer");
      return;
    }

    SharedModePeriodRange commonPeriods{};
    if (!intersectSharedModePeriods(input.periods, output.periods, &commonPeriods) ||
        !isLegalSharedModePeriod(commonPeriods, request.periodFrames)) {
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, SharedModeDuplexState::failed,
                    L"Selected capture and render endpoints have no common legal shared-mode period");
      return;
    }

    ComPtr<IAudioCaptureClient> capture;
    startupEndpoint.store("capture", std::memory_order_release);
    startupStage.store("acquiring-audio-service", std::memory_order_release);
    result = input.client->GetService(IID_PPV_ARGS(capture.GetAddressOf()));
    if (FAILED(result)) {
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, SharedModeDuplexState::failed, hresultMessage(L"Could not acquire capture service", result));
      return;
    }
    ComPtr<IAudioRenderClient> render;
    startupEndpoint.store("render", std::memory_order_release);
    startupStage.store("acquiring-audio-service", std::memory_order_release);
    result = output.client->GetService(IID_PPV_ARGS(render.GetAddressOf()));
    if (FAILED(result)) {
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, SharedModeDuplexState::failed, hresultMessage(L"Could not acquire render service", result));
      return;
    }

    if (input.bufferFrames > std::numeric_limits<std::size_t>::max() / request.inputChannelMap.size() ||
        output.bufferFrames > std::numeric_limits<std::size_t>::max() / request.outputChannelMap.size()) {
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, SharedModeDuplexState::failed, L"Endpoint scratch-buffer size overflowed");
      return;
    }
    startupEndpoint.store("", std::memory_order_release);
    startupStage.store("allocating-pcm-buffers", std::memory_order_release);
    captureScratch.resize(static_cast<std::size_t>(input.bufferFrames) * request.inputChannelMap.size());
    renderScratch.resize(static_cast<std::size_t>(output.bufferFrames) * request.outputChannelMap.size());

    SharedModeDuplexNegotiation nextNegotiation;
    nextNegotiation.inputEndpointId = request.inputEndpointId;
    nextNegotiation.outputEndpointId = request.outputEndpointId;
    nextNegotiation.sampleRateHz = request.sampleRateHz;
    nextNegotiation.periodFrames = request.periodFrames;
    nextNegotiation.inputEndpointChannels = input.channels;
    nextNegotiation.outputEndpointChannels = output.channels;
    nextNegotiation.inputBufferFrames = input.bufferFrames;
    nextNegotiation.outputBufferFrames = output.bufferFrames;
    nextNegotiation.reportedInputLatencyFrames = input.reportedLatencyFrames;
    nextNegotiation.reportedOutputLatencyFrames = output.reportedLatencyFrames;
    nextNegotiation.commonSharedPeriods = commonPeriods;
    nextNegotiation.inputChannelMap = request.inputChannelMap;
    nextNegotiation.outputChannelMap = request.outputChannelMap;
    {
      std::lock_guard<std::mutex> lock(statusMutex);
      negotiation = std::move(nextNegotiation);
    }

    ScopedMmcssTask mmcss;
    const double periodMs = 1000.0 * request.periodFrames / request.sampleRateHz;
    DWORD taskIndex = 0;
    startupEndpoint.store("", std::memory_order_release);
    startupStage.store("registering-mmcss", std::memory_order_release);
    mmcss.handle = AvSetMmThreadCharacteristicsW(periodMs < 10.0 ? L"Pro Audio" : L"Audio", &taskIndex);
    if (!mmcss.handle) {
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, SharedModeDuplexState::failed,
                    L"Could not register the WASAPI service thread with the matching MMCSS task");
      return;
    }

    BYTE* initialRenderData = nullptr;
    startupEndpoint.store("render", std::memory_order_release);
    startupStage.store("priming-render-buffer", std::memory_order_release);
    result = render->GetBuffer(output.bufferFrames, &initialRenderData);
    if (FAILED(result)) {
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, isDeviceInvalidation(result) ? SharedModeDuplexState::deviceLost
                                                       : SharedModeDuplexState::failed,
                    hresultMessage(L"Could not prime the render endpoint with silence", result));
      return;
    }
    (void)initialRenderData;
    result = render->ReleaseBuffer(output.bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
    if (FAILED(result)) {
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, isDeviceInvalidation(result) ? SharedModeDuplexState::deviceLost
                                                       : SharedModeDuplexState::failed,
                    hresultMessage(L"Could not prime the render endpoint with silence", result));
      return;
    }

    if (WaitForSingleObject(stopEvent.value, 0) == WAIT_OBJECT_0) {
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, SharedModeDuplexState::stopped, L"WASAPI session was stopped during startup");
      return;
    }
    startupEndpoint.store("capture", std::memory_order_release);
    startupStage.store("starting-capture-client", std::memory_order_release);
    result = input.client->Start();
    if (FAILED(result)) {
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, isDeviceInvalidation(result) ? SharedModeDuplexState::deviceLost
                                                       : SharedModeDuplexState::failed,
                    hresultMessage(L"Could not start capture endpoint", result));
      return;
    }
    startupEndpoint.store("render", std::memory_order_release);
    startupStage.store("starting-render-client", std::memory_order_release);
    result = output.client->Start();
    if (FAILED(result)) {
      input.client->Stop();
      enumerator->UnregisterEndpointNotificationCallback(notification.Get());
      finishStartup(false, isDeviceInvalidation(result) ? SharedModeDuplexState::deviceLost
                                                       : SharedModeDuplexState::failed,
                    hresultMessage(L"Could not start render endpoint", result));
      return;
    }

    startupEndpoint.store("capture", std::memory_order_release);
    startupStage.store("query-capture-latency", std::memory_order_release);
    input.reportedLatencyFrames = queryStreamLatencyFrames(input.client.Get(), request.sampleRateHz);
    startupEndpoint.store("render", std::memory_order_release);
    startupStage.store("query-render-latency", std::memory_order_release);
    output.reportedLatencyFrames = queryStreamLatencyFrames(output.client.Get(), request.sampleRateHz);
    {
      std::lock_guard<std::mutex> lock(statusMutex);
      negotiation.reportedInputLatencyFrames = input.reportedLatencyFrames;
      negotiation.reportedOutputLatencyFrames = output.reportedLatencyFrames;
    }

    finishStartup(true, SharedModeDuplexState::running, L"");
    startupStage.store("running", std::memory_order_release);
    startupEndpoint.store("", std::memory_order_release);
    const DWORD waitMs = std::max<DWORD>(25, static_cast<DWORD>(4'000.0 * request.periodFrames / request.sampleRateHz));
    const auto missingEventLimit = std::max(std::chrono::milliseconds(100),
        std::chrono::milliseconds(static_cast<std::int64_t>(4000.0 * request.periodFrames / request.sampleRateHz)));
    auto lastCaptureEvent = std::chrono::steady_clock::now();
    auto lastRenderEvent = lastCaptureEvent;
    std::array<HANDLE, 4> waitHandles{stopEvent.value, deviceChangedEvent.value, captureEvent.value, renderEvent.value};
    SharedModeDuplexState terminalState = SharedModeDuplexState::stopped;
    std::wstring terminalError;
    bool running = true;
    while (running) {
      const DWORD waitResult = WaitForMultipleObjects(static_cast<DWORD>(waitHandles.size()), waitHandles.data(), FALSE,
                                                      waitMs);
      if (waitResult == WAIT_OBJECT_0) break;
      if (waitResult == WAIT_OBJECT_0 + 1) {
        terminalState = SharedModeDuplexState::deviceLost;
        terminalError = L"A selected endpoint was removed or became inactive; retry the exact endpoint after reconnecting";
        break;
      }
      if (waitResult == WAIT_FAILED) {
        terminalState = SharedModeDuplexState::failed;
        terminalError = L"WASAPI event wait failed (Win32 " + std::to_wstring(GetLastError()) + L")";
        break;
      }
      if (waitResult != WAIT_TIMEOUT && waitResult != WAIT_OBJECT_0 + 2 && waitResult != WAIT_OBJECT_0 + 3) {
        terminalState = SharedModeDuplexState::failed;
        terminalError = L"WASAPI event wait returned an unexpected result";
        break;
      }

      const bool captureReady = waitResult == WAIT_OBJECT_0 + 2 || WaitForSingleObject(captureEvent.value, 0) == WAIT_OBJECT_0;
      const bool renderReady = waitResult == WAIT_OBJECT_0 + 3 || WaitForSingleObject(renderEvent.value, 0) == WAIT_OBJECT_0;
      if (captureReady) {
        const HRESULT captureResult = serviceCapture(capture.Get(), input);
        lastCaptureEvent = std::chrono::steady_clock::now();
        if (FAILED(captureResult)) {
          terminalState = isDeviceInvalidation(captureResult) ? SharedModeDuplexState::deviceLost
                                                             : SharedModeDuplexState::failed;
          terminalError = hresultMessage(L"Capture event service failed", captureResult);
          running = false;
        }
      }
      if (running && renderReady) {
        const HRESULT renderResult = serviceRender(output.client.Get(), render.Get(), output);
        lastRenderEvent = std::chrono::steady_clock::now();
        if (FAILED(renderResult)) {
          terminalState = isDeviceInvalidation(renderResult) ? SharedModeDuplexState::deviceLost
                                                            : SharedModeDuplexState::failed;
          terminalError = hresultMessage(L"Render event service failed", renderResult);
          running = false;
        }
      }
      if (running && waitResult == WAIT_TIMEOUT) {
        const auto now = std::chrono::steady_clock::now();
        if (now - lastCaptureEvent > missingEventLimit || now - lastRenderEvent > missingEventLimit) {
          terminalState = SharedModeDuplexState::failed;
          terminalError = L"A selected endpoint stopped signaling its event within the bounded service interval";
          running = false;
        }
      }
    }

    input.client->Stop();
    output.client->Stop();
    enumerator->UnregisterEndpointNotificationCallback(notification.Get());
    setTerminal(terminalState, terminalError);
  }

  HRESULT serviceCapture(IAudioCaptureClient* capture, const PreparedEndpoint& endpoint) {
    if (!capture) return E_POINTER;
    for (;;) {
      UINT32 packetFrames = 0;
      HRESULT result = capture->GetNextPacketSize(&packetFrames);
      if (FAILED(result)) return result;
      if (packetFrames == 0) return S_OK;
      if (packetFrames > endpoint.bufferFrames) return E_UNEXPECTED;

      BYTE* data = nullptr;
      DWORD flags = 0;
      result = capture->GetBuffer(&data, &packetFrames, &flags, nullptr, nullptr);
      if (FAILED(result)) return result;
      if (packetFrames > endpoint.bufferFrames) {
        capture->ReleaseBuffer(packetFrames);
        return E_UNEXPECTED;
      }
      if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY)
        captureDiscontinuities.fetch_add(1, std::memory_order_relaxed);
      if (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR)
        captureTimestampErrors.fetch_add(1, std::memory_order_relaxed);

      const std::uint32_t projectChannels = static_cast<std::uint32_t>(request.inputChannelMap.size());
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        std::fill_n(captureScratch.data(), static_cast<std::size_t>(packetFrames) * projectChannels, 0.0F);
      } else if (!data || !selectInputChannels(reinterpret_cast<const float*>(data), endpoint.channels,
                                                request.inputChannelMap, projectChannels, packetFrames,
                                                captureScratch.data())) {
        capture->ReleaseBuffer(packetFrames);
        return E_UNEXPECTED;
      }
      if (!captureRing.writeFrames(captureScratch.data(), packetFrames))
        captureOverrunPackets.fetch_add(1, std::memory_order_relaxed);
      result = capture->ReleaseBuffer(packetFrames);
      if (FAILED(result)) return result;
    }
  }

  HRESULT serviceRender(IAudioClient3* client, IAudioRenderClient* render, const PreparedEndpoint& endpoint) {
    if (!client || !render) return E_POINTER;
    UINT32 padding = 0;
    HRESULT result = client->GetCurrentPadding(&padding);
    if (FAILED(result) || padding > endpoint.bufferFrames) return FAILED(result) ? result : E_UNEXPECTED;
    const UINT32 availableFrames = endpoint.bufferFrames - padding;
    if (availableFrames == 0) return S_OK;

    BYTE* data = nullptr;
    result = render->GetBuffer(availableFrames, &data);
    if (FAILED(result)) return result;
    const std::uint32_t projectChannels = static_cast<std::uint32_t>(request.outputChannelMap.size());
    const std::size_t readFrames = renderRing.readFrames(renderScratch.data(), availableFrames);
    if (readFrames < availableFrames) {
      std::fill(renderScratch.begin() + static_cast<std::ptrdiff_t>(readFrames * projectChannels),
                renderScratch.begin() + static_cast<std::ptrdiff_t>(availableFrames * projectChannels), 0.0F);
      renderUnderrunPeriods.fetch_add(1, std::memory_order_relaxed);
    }
    if (!routeOutputChannels(renderScratch.data(), projectChannels, request.outputChannelMap, endpoint.channels,
                             availableFrames, reinterpret_cast<float*>(data))) {
      render->ReleaseBuffer(availableFrames, 0);
      return E_UNEXPECTED;
    }
    return render->ReleaseBuffer(availableFrames, 0);
  }

  std::size_t readCapture(float* output, std::size_t maxFrames) noexcept {
    return captureRing.readFrames(output, maxFrames);
  }

  bool writeRender(const float* input, std::size_t frames) noexcept {
    if (state.load(std::memory_order_acquire) != SharedModeDuplexState::running) return false;
    const bool accepted = renderRing.writeFrames(input, frames);
    if (!accepted && frames > 0) renderOverrunPackets.fetch_add(1, std::memory_order_relaxed);
    return accepted;
  }

  std::uint32_t captureQueuedFrames() const noexcept { return captureRing.queuedFrames(); }
  std::uint32_t renderQueuedFrames() const noexcept { return renderRing.queuedFrames(); }

  SharedModeDuplexSnapshot snapshot() const {
    SharedModeDuplexSnapshot result;
    result.state = state.load(std::memory_order_acquire);
    result.startupStage = startupStage.load(std::memory_order_acquire);
    result.startupEndpoint = startupEndpoint.load(std::memory_order_acquire);
    {
      std::lock_guard<std::mutex> lock(statusMutex);
      result.negotiation = negotiation;
      result.lastError = lastError;
    }
    result.captureOverrunPackets = captureOverrunPackets.load(std::memory_order_relaxed);
    result.renderOverrunPackets = renderOverrunPackets.load(std::memory_order_relaxed);
    result.renderUnderrunPeriods = renderUnderrunPeriods.load(std::memory_order_relaxed);
    result.captureDiscontinuities = captureDiscontinuities.load(std::memory_order_relaxed);
    result.captureTimestampErrors = captureTimestampErrors.load(std::memory_order_relaxed);
    result.captureQueuedFrames = captureRing.queuedFrames();
    result.renderQueuedFrames = renderRing.queuedFrames();
    return result;
  }
};

WasapiSharedDuplexSession::WasapiSharedDuplexSession(SharedModeDuplexRequest request)
    : impl_(std::make_unique<Impl>(std::move(request))) {}

WasapiSharedDuplexSession::~WasapiSharedDuplexSession() { stop(); }

bool WasapiSharedDuplexSession::start(std::wstring* error) { return impl_->start(error); }
void WasapiSharedDuplexSession::stop() noexcept { impl_->stop(); }
std::size_t WasapiSharedDuplexSession::readCapture(float* samples, std::size_t maxFrames) noexcept {
  return impl_->readCapture(samples, maxFrames);
}
bool WasapiSharedDuplexSession::writeRender(const float* samples, std::size_t frames) noexcept {
  return impl_->writeRender(samples, frames);
}
std::uint32_t WasapiSharedDuplexSession::captureQueuedFrames() const noexcept {
  return impl_->captureQueuedFrames();
}
std::uint32_t WasapiSharedDuplexSession::renderQueuedFrames() const noexcept {
  return impl_->renderQueuedFrames();
}
SharedModeDuplexSnapshot WasapiSharedDuplexSession::snapshot() const { return impl_->snapshot(); }

}  // namespace kyx::windows_audio
