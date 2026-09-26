#pragma once

#include <cstdint>
#include <limits>

/** Select the lowest IAudioClient3 period that is legal for the queried range. */
inline bool selectLowestSupportedSharedPeriod(std::uint32_t fundamentalFrames, std::uint32_t minimumFrames,
                                              std::uint32_t maximumFrames, std::uint32_t* selectedFrames) noexcept {
  if (!selectedFrames || fundamentalFrames == 0 || minimumFrames == 0 || maximumFrames < minimumFrames) return false;

  const std::uint64_t fundamental = fundamentalFrames;
  const std::uint64_t minimum = minimumFrames;
  const std::uint64_t firstMultiple = ((minimum + fundamental - 1) / fundamental) * fundamental;
  if (firstMultiple > maximumFrames || firstMultiple > std::numeric_limits<std::uint32_t>::max()) return false;

  *selectedFrames = static_cast<std::uint32_t>(firstMultiple);
  return true;
}
