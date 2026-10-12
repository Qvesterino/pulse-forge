#pragma once

#include <cmath>
#include <cstdint>

/** Convert a WASAPI 100-ns packet timestamp to milliseconds relative to a raw QPC sample. */
inline bool qpcRelativeMilliseconds(std::uint64_t timestamp100ns, std::int64_t referenceCounter,
                                    std::int64_t counterFrequency, double* milliseconds) noexcept {
  if (!milliseconds || referenceCounter < 0 || counterFrequency <= 0) return false;

  const long double reference100ns = static_cast<long double>(referenceCounter) * 10'000'000.0L /
                                    static_cast<long double>(counterFrequency);
  const long double deltaMilliseconds =
      (static_cast<long double>(timestamp100ns) - reference100ns) / 10'000.0L;
  *milliseconds = static_cast<double>(deltaMilliseconds);
  return std::isfinite(*milliseconds);
}
