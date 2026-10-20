#include "wasapi-shared-duplex.h"
#include "duplex-startup.h"

#include <array>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <utility>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << "\n";
    std::exit(1);
  }
}

kyx::windows_audio::SharedModeDuplexRequest validRequest() {
  kyx::windows_audio::SharedModeDuplexRequest request;
  request.inputEndpointId = L"capture-endpoint-id";
  request.outputEndpointId = L"render-endpoint-id";
  request.sampleRateHz = 48'000;
  request.periodFrames = 480;
  request.ringCapacityFrames = 1024;
  request.inputChannelMap = {0, 1};
  request.outputChannelMap = {0, 1};
  return request;
}

void missingEndpointSelectionFailsBeforeStarting() {
  auto request = validRequest();
  request.inputEndpointId.clear();
  kyx::windows_audio::WasapiSharedDuplexSession session(std::move(request));
  std::wstring error;

  require(!session.start(&error), "session started without an exact capture endpoint ID");
  require(error.find(L"selected explicitly") != std::wstring::npos,
          "missing endpoint selection did not return an actionable validation error");
  const auto snapshot = session.snapshot();
  require(snapshot.state == kyx::windows_audio::SharedModeDuplexState::failed,
          "invalid start request did not enter the failed state");
  require(!snapshot.lastError.empty(), "failed session did not retain its error for recovery UI");
}

void undersizedRingsAndStoppedSessionsCannotStart() {
  auto request = validRequest();
  request.ringCapacityFrames = 256;
  kyx::windows_audio::WasapiSharedDuplexSession smallRing(std::move(request));
  std::wstring error;
  require(!smallRing.start(&error), "ring smaller than requested period was accepted");
  require(error.find(L"at least one requested endpoint period") != std::wstring::npos,
          "undersized ring did not explain the minimum capacity");

  auto stoppedRequest = validRequest();
  kyx::windows_audio::WasapiSharedDuplexSession stopped(std::move(stoppedRequest));
  stopped.stop();
  require(!stopped.start(&error), "a stopped session was allowed to restart with stale stream state");
  require(error.find(L"cannot be started") != std::wstring::npos,
          "stopped session did not require an explicit new session for retry");
}

void stoppedAndFailedSessionsKeepCaptureReadableButCannotRender() {
  auto request = validRequest();
  request.inputEndpointId.clear();
  kyx::windows_audio::WasapiSharedDuplexSession session(std::move(request));
  std::wstring error;
  require(!session.start(&error), "invalid session unexpectedly started");

  std::array<float, 4> capture{};
  const std::array<float, 4> render{1, 2, 3, 4};
  require(session.readCapture(capture.data(), 2) == 0, "empty capture ring returned frames");
  require(!session.writeRender(render.data(), 2), "failed session accepted render PCM");
}

void unavailableExactIdsFailWithoutSelectingCurrentDefaults() {
  auto request = validRequest();
  request.inputEndpointId = L"{KYX-test-capture-endpoint-that-does-not-exist}";
  request.outputEndpointId = L"{KYX-test-render-endpoint-that-does-not-exist}";
  kyx::windows_audio::WasapiSharedDuplexSession session(std::move(request));
  std::wstring error;

  require(!session.start(&error), "unknown endpoint IDs silently opened another device");
  require(error.find(L"not an active capture device") != std::wstring::npos,
          "unknown capture ID did not fail at exact flow and ID selection");
  const auto snapshot = session.snapshot();
  require(snapshot.state == kyx::windows_audio::SharedModeDuplexState::failed,
          "missing endpoint did not become a recoverable failed session");
  require(std::string(snapshot.startupStage) == "scan-exact-endpoint-id" &&
              std::string(snapshot.startupEndpoint) == "capture",
          "missing endpoint did not retain the native startup phase and direction");
  require(snapshot.negotiation.sampleRateHz == 0,
          "missing endpoint unexpectedly returned a successful negotiation");
}

void stopCanOverlapAnInProgressStart() {
  auto request = validRequest();
  request.inputEndpointId = L"{KYX-concurrent-start-stop-capture-does-not-exist}";
  request.outputEndpointId = L"{KYX-concurrent-start-stop-render-does-not-exist}";
  kyx::windows_audio::WasapiSharedDuplexSession session(std::move(request));
  std::atomic<bool> startFinished{false};
  bool started = false;
  std::wstring error;

  std::thread starter([&]() {
    started = session.start(&error);
    startFinished.store(true, std::memory_order_release);
  });
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (!startFinished.load(std::memory_order_acquire) && std::chrono::steady_clock::now() < deadline) {
    const std::string stage(session.snapshot().startupStage);
    if (stage != "idle" && stage != "validating-request") break;
    std::this_thread::yield();
  }
  session.stop();
  starter.join();

  const auto snapshot = session.snapshot();
  require(!started, "test used nonexistent exact IDs but native startup succeeded");
  require(snapshot.state != kyx::windows_audio::SharedModeDuplexState::starting &&
              snapshot.state != kyx::windows_audio::SharedModeDuplexState::running,
          "overlapping stop returned while native startup remained live");
  require(!error.empty(), "overlapping native startup failure did not return its reason");
  session.stop();
}

void stopDuringCaptureStartSkipsRenderStart() {
  bool stopRequested = false;
  int captureStops = 0;
  int renderStarts = 0;

  const auto result = kyx::windows_audio::detail::startDuplexWithStop(
      [&]() { return stopRequested; },
      [&]() {
        // Model a blocking IAudioClient3::Start() that only returns after Stop.
        stopRequested = true;
        return true;
      },
      [&]() { ++captureStops; },
      [&]() {
        ++renderStarts;
        return true;
      },
      []() {});

  require(result == kyx::windows_audio::detail::DuplexStartResult::stopped,
          "stop during capture Start did not cancel duplex startup");
  require(renderStarts == 0, "render Start ran after stop during capture Start");
  require(captureStops == 1, "capture client was not stopped after delayed Start returned");
}

void stopDuringRenderStartStopsBothClients() {
  bool stopRequested = false;
  int captureStops = 0;
  int renderStops = 0;

  const auto result = kyx::windows_audio::detail::startDuplexWithStop(
      [&]() { return stopRequested; }, []() { return true; }, [&]() { ++captureStops; },
      [&]() {
        stopRequested = true;
        return true;
      },
      [&]() { ++renderStops; });

  require(result == kyx::windows_audio::detail::DuplexStartResult::stopped,
          "stop during render Start did not cancel duplex startup");
  require(renderStops == 1 && captureStops == 1, "both clients were not stopped after render Start completed");
}

void failedDuplexStartDoesNotLeavePartialClientsRunning() {
  int captureStops = 0;
  int renderStarts = 0;
  const auto captureFailure = kyx::windows_audio::detail::startDuplexWithStop(
      []() { return false; }, []() { return false; }, [&]() { ++captureStops; },
      [&]() {
        ++renderStarts;
        return true;
      },
      []() {});
  require(captureFailure == kyx::windows_audio::detail::DuplexStartResult::captureFailed,
          "capture Start failure did not fail duplex startup");
  require(renderStarts == 0 && captureStops == 0, "capture failure advanced startup or stopped an unstarted client");

  captureStops = 0;
  int renderStops = 0;
  const auto renderFailure = kyx::windows_audio::detail::startDuplexWithStop(
      []() { return false; }, []() { return true; }, [&]() { ++captureStops; }, []() { return false; },
      [&]() { ++renderStops; });
  require(renderFailure == kyx::windows_audio::detail::DuplexStartResult::renderFailed,
          "render Start failure did not fail duplex startup");
  require(renderStops == 1 && captureStops == 1, "render Start failure did not stop both clients");
}

void stopWinningStartupCommitCannotReportReady() {
  using kyx::windows_audio::SharedModeDuplexState;
  using kyx::windows_audio::detail::resolveStartupCompletion;

  const auto stopped = resolveStartupCompletion(true, SharedModeDuplexState::running, L"", true);
  require(!stopped.succeeded && stopped.state == SharedModeDuplexState::stopped,
          "Stop that won the startup lock still reported a running session");
  require(!stopped.error.empty(), "cancelled startup did not provide a recovery reason");

  const auto failed = resolveStartupCompletion(false, SharedModeDuplexState::failed, L"device error", true);
  require(!failed.succeeded && failed.state == SharedModeDuplexState::failed && failed.error == L"device error",
          "Stop erased a real endpoint startup failure");
}

}  // namespace

int main() {
  missingEndpointSelectionFailsBeforeStarting();
  undersizedRingsAndStoppedSessionsCannotStart();
  stoppedAndFailedSessionsKeepCaptureReadableButCannotRender();
  unavailableExactIdsFailWithoutSelectingCurrentDefaults();
  stopCanOverlapAnInProgressStart();
  stopDuringCaptureStartSkipsRenderStart();
  stopDuringRenderStartStopsBothClients();
  failedDuplexStartDoesNotLeavePartialClientsRunning();
  stopWinningStartupCommitCannotReportReady();
  std::cout << "WASAPI duplex request and lifecycle validation: 9/9 checks passed (unknown-ID cases opened no stream)\n";
  return 0;
}
