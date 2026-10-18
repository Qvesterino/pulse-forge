#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "shared-periods.h"

namespace kyx::windows_audio {

struct SharedModeDuplexRequest {
  std::wstring inputEndpointId;
  std::wstring outputEndpointId;
  std::uint32_t sampleRateHz = 0;
  std::uint32_t periodFrames = 0;
  std::uint32_t ringCapacityFrames = 4096;
  std::vector<std::uint32_t> inputChannelMap;
  std::vector<std::uint32_t> outputChannelMap;
};

struct SharedModeDuplexNegotiation {
  std::wstring inputEndpointId;
  std::wstring outputEndpointId;
  std::uint32_t sampleRateHz = 0;
  std::uint32_t periodFrames = 0;
  std::uint32_t inputEndpointChannels = 0;
  std::uint32_t outputEndpointChannels = 0;
  std::uint32_t inputBufferFrames = 0;
  std::uint32_t outputBufferFrames = 0;
  std::optional<std::uint32_t> reportedInputLatencyFrames;
  std::optional<std::uint32_t> reportedOutputLatencyFrames;
  SharedModePeriodRange commonSharedPeriods;
  std::vector<std::uint32_t> inputChannelMap;
  std::vector<std::uint32_t> outputChannelMap;
};

enum class SharedModeDuplexState : std::uint8_t { idle, starting, running, deviceLost, failed, stopped };

struct SharedModeDuplexSnapshot {
  SharedModeDuplexState state = SharedModeDuplexState::idle;
  SharedModeDuplexNegotiation negotiation;
  std::uint64_t captureOverrunPackets = 0;
  std::uint64_t renderOverrunPackets = 0;
  std::uint64_t renderUnderrunPeriods = 0;
  std::uint64_t captureDiscontinuities = 0;
  std::uint64_t captureTimestampErrors = 0;
  std::uint32_t captureQueuedFrames = 0;
  std::uint32_t renderQueuedFrames = 0;
  std::wstring lastError;
};

/**
 * Exact-endpoint, float32-only WASAPI shared-mode duplex session.
 * Construction preallocates its bounded PCM rings; the service thread uses
 * event-driven capture/render and never substitutes endpoints or formats.
 * start/stop control calls must be serialized; the audio rings each allow one
 * producer and one consumer.
 */
class WasapiSharedDuplexSession final {
 public:
  explicit WasapiSharedDuplexSession(SharedModeDuplexRequest request);
  ~WasapiSharedDuplexSession();

  WasapiSharedDuplexSession(const WasapiSharedDuplexSession&) = delete;
  WasapiSharedDuplexSession& operator=(const WasapiSharedDuplexSession&) = delete;

  bool start(std::wstring* error = nullptr);
  void stop() noexcept;

  /** Single consumer for capture and single producer for render. */
  std::size_t readCapture(float* interleavedSamples, std::size_t maxFrames) noexcept;
  bool writeRender(const float* interleavedSamples, std::size_t frames) noexcept;
  std::uint32_t captureQueuedFrames() const noexcept;
  std::uint32_t renderQueuedFrames() const noexcept;
  SharedModeDuplexSnapshot snapshot() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace kyx::windows_audio
