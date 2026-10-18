#include "channel-map.h"

#include <array>
#include <cstdlib>
#include <iostream>
#include <vector>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << "\n";
    std::exit(1);
  }
}

void inputMapSelectsRequestedHardwareChannelsInProjectOrder() {
  constexpr std::array<float, 12> endpoint{
      0.1F, 0.2F, 0.3F, 0.4F,
      1.1F, 1.2F, 1.3F, 1.4F,
      2.1F, 2.2F, 2.3F, 2.4F,
  };
  const std::vector<std::uint32_t> map{3, 1};
  std::array<float, 6> project{};

  require(kyx::windows_audio::selectInputChannels(endpoint.data(), 4, map, 2, 3, project.data()),
          "valid input channel map was rejected");
  require(project == std::array<float, 6>{0.4F, 0.2F, 1.4F, 1.2F, 2.4F, 2.2F},
          "input samples were not selected in project-channel order");
}

void outputMapRoutesAndZerosUnselectedHardwareChannels() {
  constexpr std::array<float, 4> project{0.25F, -0.5F, 0.75F, -1.0F};
  const std::vector<std::uint32_t> map{2, 0};
  std::array<float, 8> endpoint{};

  require(kyx::windows_audio::routeOutputChannels(project.data(), 2, map, 4, 2, endpoint.data()),
          "valid output channel map was rejected");
  require(endpoint == std::array<float, 8>{-0.5F, 0.0F, 0.25F, 0.0F, -1.0F, 0.0F, 0.75F, 0.0F},
          "output routing changed project order or failed to zero unused hardware channels");
}

void invalidMapsAndBuffersAreRejected() {
  using kyx::windows_audio::isValidChannelMap;
  require(!isValidChannelMap({}, 2, 0), "empty project map was accepted");
  require(!isValidChannelMap({0, 0}, 2, 2), "duplicate hardware channel was accepted");
  require(!isValidChannelMap({0, 2}, 2, 2), "out-of-range hardware channel was accepted");
  require(!isValidChannelMap({0}, 2, 2), "project channel count mismatch was accepted");
  require(!isValidChannelMap({0}, 33, 1), "endpoint channel cap was not enforced");

  const std::vector<std::uint32_t> stereo{0, 1};
  require(!kyx::windows_audio::selectInputChannels(nullptr, 2, stereo, 2, 1, nullptr),
          "non-empty null input buffers were accepted");
  require(!kyx::windows_audio::routeOutputChannels(nullptr, 2, stereo, 2, 1, nullptr),
          "non-empty null output buffers were accepted");
  require(kyx::windows_audio::selectInputChannels(nullptr, 2, stereo, 2, 0, nullptr),
          "zero-frame input did not permit null buffers");
}

void overlappingBuffersAreRejectedBeforeAnyWrite() {
  const std::vector<std::uint32_t> stereo{0, 1};
  std::array<float, 8> samples{1.0F, 2.0F, 3.0F, 4.0F, 5.0F, 6.0F, 7.0F, 8.0F};
  const auto before = samples;

  require(!kyx::windows_audio::selectInputChannels(samples.data(), 2, stereo, 2, 2, samples.data() + 1),
          "partially overlapping input buffers were accepted");
  require(!kyx::windows_audio::routeOutputChannels(samples.data(), 2, stereo, 2, 2, samples.data() + 1),
          "partially overlapping output buffers were accepted");
  require(samples == before, "buffer validation changed overlapping samples before rejecting them");
}

}  // namespace

int main() {
  inputMapSelectsRequestedHardwareChannelsInProjectOrder();
  outputMapRoutesAndZerosUnselectedHardwareChannels();
  invalidMapsAndBuffersAreRejected();
  overlappingBuffersAreRejectedBeforeAnyWrite();
  std::cout << "WASAPI channel mapping: 4/4 checks passed\n";
  return 0;
}
