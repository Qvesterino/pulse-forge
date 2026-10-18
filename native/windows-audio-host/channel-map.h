#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <vector>

namespace kyx::windows_audio {

inline constexpr std::size_t kMaximumAudioChannels = 32;

inline bool checkedSampleCount(std::size_t frames, std::uint32_t channels, std::size_t* samples) noexcept {
  if (!samples || channels == 0 || frames > std::numeric_limits<std::size_t>::max() / channels) return false;
  *samples = frames * channels;
  return *samples <= std::numeric_limits<std::size_t>::max() / sizeof(float);
}

inline bool buffersDoNotOverlap(const float* first,
                                std::size_t firstSamples,
                                const float* second,
                                std::size_t secondSamples) noexcept {
  const std::uintptr_t firstBegin = reinterpret_cast<std::uintptr_t>(first);
  const std::uintptr_t secondBegin = reinterpret_cast<std::uintptr_t>(second);
  const std::size_t firstBytes = firstSamples * sizeof(float);
  const std::size_t secondBytes = secondSamples * sizeof(float);
  if (firstBytes > std::numeric_limits<std::uintptr_t>::max() - firstBegin ||
      secondBytes > std::numeric_limits<std::uintptr_t>::max() - secondBegin) {
    return false;
  }
  const std::uintptr_t firstEnd = firstBegin + firstBytes;
  const std::uintptr_t secondEnd = secondBegin + secondBytes;
  return firstEnd <= secondBegin || secondEnd <= firstBegin;
}

/**
 * A channel map is ordered by project channel: map[0] is the hardware channel
 * that feeds or receives project channel 0. Duplicate endpoints would
 * silently duplicate or overwrite signal, so they are rejected.
 */
inline bool isValidChannelMap(const std::vector<std::uint32_t>& map,
                              std::uint32_t endpointChannels,
                              std::uint32_t projectChannels) noexcept {
  if (endpointChannels == 0 || endpointChannels > kMaximumAudioChannels ||
      projectChannels == 0 || projectChannels > kMaximumAudioChannels ||
      map.size() != projectChannels || map.size() > endpointChannels) {
    return false;
  }

  std::uint64_t used = 0;
  for (const std::uint32_t channel : map) {
    if (channel >= endpointChannels || channel >= kMaximumAudioChannels) return false;
    const std::uint64_t bit = std::uint64_t{1} << channel;
    if ((used & bit) != 0) return false;
    used |= bit;
  }
  return true;
}

/** Copy selected interleaved float32 endpoint channels into project order. */
inline bool selectInputChannels(const float* endpointSamples,
                                std::uint32_t endpointChannels,
                                const std::vector<std::uint32_t>& channelMap,
                                std::uint32_t projectChannels,
                                std::size_t frames,
                                float* projectSamples) noexcept {
  if (!isValidChannelMap(channelMap, endpointChannels, projectChannels)) return false;
  if (frames == 0) return true;
  if (!endpointSamples || !projectSamples) return false;
  std::size_t endpointSampleCount = 0;
  std::size_t projectSampleCount = 0;
  if (!checkedSampleCount(frames, endpointChannels, &endpointSampleCount) ||
      !checkedSampleCount(frames, projectChannels, &projectSampleCount) ||
      !buffersDoNotOverlap(endpointSamples, endpointSampleCount, projectSamples, projectSampleCount)) return false;

  for (std::size_t frame = 0; frame < frames; ++frame) {
    const std::size_t endpointBase = frame * endpointChannels;
    const std::size_t projectBase = frame * projectChannels;
    for (std::uint32_t projectChannel = 0; projectChannel < projectChannels; ++projectChannel) {
      projectSamples[projectBase + projectChannel] =
          endpointSamples[endpointBase + channelMap[projectChannel]];
    }
  }
  return true;
}

/** Expand project-order float32 into endpoint order, zeroing unmapped outputs. */
inline bool routeOutputChannels(const float* projectSamples,
                                std::uint32_t projectChannels,
                                const std::vector<std::uint32_t>& channelMap,
                                std::uint32_t endpointChannels,
                                std::size_t frames,
                                float* endpointSamples) noexcept {
  if (!isValidChannelMap(channelMap, endpointChannels, projectChannels)) return false;
  if (frames == 0) return true;
  if (!projectSamples || !endpointSamples) return false;
  std::size_t endpointSampleCount = 0;
  std::size_t projectSampleCount = 0;
  if (!checkedSampleCount(frames, endpointChannels, &endpointSampleCount) ||
      !checkedSampleCount(frames, projectChannels, &projectSampleCount) ||
      !buffersDoNotOverlap(projectSamples, projectSampleCount, endpointSamples, endpointSampleCount)) return false;

  for (std::size_t frame = 0; frame < frames; ++frame) {
    const std::size_t endpointBase = frame * endpointChannels;
    const std::size_t projectBase = frame * projectChannels;
    std::fill_n(endpointSamples + endpointBase, endpointChannels, 0.0F);
    for (std::uint32_t projectChannel = 0; projectChannel < projectChannels; ++projectChannel) {
      endpointSamples[endpointBase + channelMap[projectChannel]] =
          projectSamples[projectBase + projectChannel];
    }
  }
  return true;
}

}  // namespace kyx::windows_audio
