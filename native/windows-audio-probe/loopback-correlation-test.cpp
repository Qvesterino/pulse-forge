#include "loopback-correlation.h"

#include <cmath>
#include <iostream>
#include <limits>
#include <vector>

int main() {
  using namespace kyx::audio_probe;

  const LoopbackProbe probe = makeLoopbackProbe();
  std::vector<float> captured(400, 0.0F);
  constexpr std::size_t expectedOffset = 193;
  for (std::size_t index = 0; index < probe.size(); ++index) {
    captured[expectedOffset + index] = probe[index] * 0.4F + 0.002F * std::sin(static_cast<float>(index) * 0.31F);
  }
  std::size_t offset = 0;
  double correlation = 0.0;
  if (!findLoopbackProbe(captured, probe, &offset, &correlation) || offset != expectedOffset || correlation <= 0.99) {
    std::cerr << "delayed probe was not located accurately: offset=" << offset << " correlation=" << correlation << "\n";
    return 1;
  }

  const std::vector<float> silence(512, 0.0F);
  if (findLoopbackProbe(silence, probe, &offset, &correlation)) {
    std::cerr << "silence was incorrectly classified as a probe\n";
    return 1;
  }

  const std::vector<float> tooShort(64, 0.0F);
  if (findLoopbackProbe(tooShort, probe, &offset, &correlation)) {
    std::cerr << "short input was incorrectly classified as a probe\n";
    return 1;
  }

  std::vector<float> invalidCapture = captured;
  invalidCapture[0] = std::numeric_limits<float>::quiet_NaN();
  if (findLoopbackProbe(invalidCapture, probe, &offset, &correlation)) {
    std::cerr << "non-finite capture data was incorrectly accepted\n";
    return 1;
  }

  std::cout << "loopback correlation helper checks passed\n";
  return 0;
}
