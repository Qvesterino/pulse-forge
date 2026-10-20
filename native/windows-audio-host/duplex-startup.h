#pragma once

#include <string>
#include <utility>

#include "wasapi-shared-duplex.h"

namespace kyx::windows_audio::detail {

enum class DuplexStartResult { started, captureFailed, renderFailed, stopped };

template <typename StopRequested, typename StartCapture, typename StopCapture, typename StartRender, typename StopRender>
DuplexStartResult startDuplexWithStop(StopRequested&& stopRequested, StartCapture&& startCapture,
                                      StopCapture&& stopCapture, StartRender&& startRender,
                                      StopRender&& stopRender) {
  if (stopRequested()) return DuplexStartResult::stopped;
  if (!startCapture()) return DuplexStartResult::captureFailed;
  if (stopRequested()) {
    stopCapture();
    return DuplexStartResult::stopped;
  }
  if (!startRender()) {
    stopRender();
    stopCapture();
    return DuplexStartResult::renderFailed;
  }
  if (stopRequested()) {
    stopRender();
    stopCapture();
    return DuplexStartResult::stopped;
  }
  return DuplexStartResult::started;
}

struct StartupCompletion {
  bool succeeded = false;
  SharedModeDuplexState state = SharedModeDuplexState::failed;
  std::wstring error;
};

inline StartupCompletion resolveStartupCompletion(bool succeeded, SharedModeDuplexState state,
                                                   std::wstring error, bool stopCalled) {
  if (succeeded && stopCalled) {
    return {false, SharedModeDuplexState::stopped, L"WASAPI session was stopped during startup"};
  }
  return {succeeded, state, std::move(error)};
}

}  // namespace kyx::windows_audio::detail
