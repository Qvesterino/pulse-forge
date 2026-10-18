#pragma once

#include <cstdint>
#include <limits>

namespace kyx::windows_audio {

struct SharedModePeriodRange {
  std::uint32_t minFrames = 0;
  std::uint32_t maxFrames = 0;
  std::uint32_t fundamentalFrames = 0;
};

inline bool isValidSharedModePeriodRange(const SharedModePeriodRange& range) noexcept {
  return range.minFrames > 0 && range.maxFrames >= range.minFrames && range.fundamentalFrames > 0;
}

inline bool isLegalSharedModePeriod(const SharedModePeriodRange& range, std::uint32_t frames) noexcept {
  return isValidSharedModePeriodRange(range) && frames >= range.minFrames && frames <= range.maxFrames &&
         frames % range.fundamentalFrames == 0;
}

inline std::uint64_t greatestCommonDivisor(std::uint64_t left, std::uint64_t right) noexcept {
  while (right != 0) {
    const std::uint64_t remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

/** Compute legal periods accepted by both selected endpoints. */
inline bool intersectSharedModePeriods(const SharedModePeriodRange& input,
                                       const SharedModePeriodRange& output,
                                       SharedModePeriodRange* intersection) noexcept {
  if (!intersection || !isValidSharedModePeriodRange(input) || !isValidSharedModePeriodRange(output)) return false;
  const std::uint64_t divisor = greatestCommonDivisor(input.fundamentalFrames, output.fundamentalFrames);
  const std::uint64_t lcm = static_cast<std::uint64_t>(input.fundamentalFrames / divisor) * output.fundamentalFrames;
  const std::uint32_t minimum = input.minFrames > output.minFrames ? input.minFrames : output.minFrames;
  const std::uint32_t maximum = input.maxFrames < output.maxFrames ? input.maxFrames : output.maxFrames;
  if (lcm > std::numeric_limits<std::uint32_t>::max() || maximum < minimum || lcm > maximum) return false;
  *intersection = {minimum, maximum, static_cast<std::uint32_t>(lcm)};

  // The range may overlap while containing no common aligned period.
  const std::uint64_t firstMultiple =
      ((static_cast<std::uint64_t>(minimum) + lcm - 1) / lcm) * lcm;
  return firstMultiple <= maximum;
}

}  // namespace kyx::windows_audio
