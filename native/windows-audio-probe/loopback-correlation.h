#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <vector>

namespace kyx::audio_probe {

constexpr std::size_t kLoopbackProbeFrames = 127;
using LoopbackProbe = std::array<float, kLoopbackProbeFrames>;

inline LoopbackProbe makeLoopbackProbe() {
  LoopbackProbe probe{};
  unsigned int state = 0x5d;
  for (float& sample : probe) {
    sample = (state & 1U) != 0 ? 1.0F : -1.0F;
    const unsigned int feedback = (state ^ (state >> 3U)) & 1U;
    state = (state >> 1U) | (feedback << 6U);
  }
  return probe;
}

inline bool findLoopbackProbe(const std::vector<float>& captured, const LoopbackProbe& probe, std::size_t* offset,
                              double* normalizedCorrelation, double minimumCorrelation = 0.70) {
  if (!offset || !normalizedCorrelation || captured.size() < probe.size() || minimumCorrelation < 0.0 ||
      minimumCorrelation > 1.0) {
    return false;
  }

  double probeEnergy = 0.0;
  for (const float sample : probe) probeEnergy += static_cast<double>(sample) * sample;
  if (probeEnergy <= 0.0) return false;

  double bestScore = 0.0;
  std::size_t bestOffset = 0;
  for (std::size_t start = 0; start + probe.size() <= captured.size(); ++start) {
    double dot = 0.0;
    double capturedEnergy = 0.0;
    for (std::size_t index = 0; index < probe.size(); ++index) {
      const double value = captured[start + index];
      if (!std::isfinite(value)) return false;
      dot += value * probe[index];
      capturedEnergy += value * value;
    }
    if (capturedEnergy <= 0.0) continue;
    const double score = dot / std::sqrt(probeEnergy * capturedEnergy);
    if (score > bestScore) {
      bestScore = score;
      bestOffset = start;
    }
  }

  *offset = bestOffset;
  *normalizedCorrelation = bestScore;
  return bestScore >= minimumCorrelation;
}

}  // namespace kyx::audio_probe
