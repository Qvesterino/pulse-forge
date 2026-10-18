#include "spsc-float-ring.h"

#include <array>
#include <atomic>
#include <cstdlib>
#include <iostream>
#include <thread>
#include <vector>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << "\n";
    std::exit(1);
  }
}

void fifoPreservesInterleavedFramesAcrossWraparound() {
  kyx::windows_audio::FloatSpscRing ring(4, 2);
  const std::array<float, 6> first{1, 10, 2, 20, 3, 30};
  const std::array<float, 6> second{4, 40, 5, 50, 6, 60};
  std::array<float, 8> output{};

  require(ring.valid(), "valid ring configuration was rejected");
  require(ring.writeFrames(first.data(), 3), "initial frame block did not fit");
  require(ring.queuedFrames() == 3, "ring depth did not reflect committed frames");
  require(ring.readFrames(output.data(), 2) == 2, "partial read returned the wrong frame count");
  require(output[0] == 1 && output[1] == 10 && output[2] == 2 && output[3] == 20,
          "partial read changed interleaved channel order");
  require(ring.writeFrames(second.data(), 3), "wrapped write did not fit in freed ring space");
  require(ring.readFrames(output.data(), 4) == 4, "wrapped read returned the wrong frame count");
  require(output == std::array<float, 8>{3, 30, 4, 40, 5, 50, 6, 60},
          "FIFO order or wraparound was incorrect");
  require(ring.queuedFrames() == 0, "ring was not empty after all frames were read");
}

void fullWritesAreRejectedWithoutOverwritingQueuedAudio() {
  kyx::windows_audio::FloatSpscRing ring(4, 1);
  const std::array<float, 4> full{1, 2, 3, 4};
  const std::array<float, 1> extra{5};
  std::array<float, 4> output{};

  require(ring.writeFrames(full.data(), full.size()), "ring refused a block that exactly fills its capacity");
  require(!ring.writeFrames(extra.data(), extra.size()), "full ring accepted an extra frame");
  require(ring.readFrames(output.data(), output.size()) == output.size(), "full queue was not readable");
  require(output == full, "failed full-ring write overwrote already queued audio");
}

void invalidCapacityAndChannelConfigurationsAreRejected() {
  require(!kyx::windows_audio::FloatSpscRing(3, 2).valid(), "non-power-of-two frame capacity was accepted");
  require(!kyx::windows_audio::FloatSpscRing(4, 0).valid(), "zero channels were accepted");
  require(!kyx::windows_audio::FloatSpscRing(4, 33).valid(), "channel cap was not enforced");

  kyx::windows_audio::FloatSpscRing ring(4, 2);
  const std::array<float, 2> frame{1, 2};
  require(!ring.writeFrames(nullptr, 1), "non-empty null input was accepted");
  require(ring.writeFrames(nullptr, 0), "zero-frame write was not a no-op");
  require(ring.readFrames(nullptr, 1) == 0, "non-empty null output returned samples");
  require(ring.readFrames(nullptr, 0) == 0, "zero-frame read returned samples");
  require(!ring.writeFrames(frame.data(), 5), "write larger than ring capacity was accepted");
}

void singleProducerConsumerStressPreservesFrameSequence() {
  constexpr std::uint32_t kFrames = 100'000;
  kyx::windows_audio::FloatSpscRing ring(1024, 2);
  std::atomic<bool> failed{false};
  std::thread producer([&]() {
    for (std::uint32_t index = 1; index <= kFrames;) {
      const std::array<float, 2> frame{static_cast<float>(index), -static_cast<float>(index)};
      if (ring.writeFrames(frame.data(), 1)) ++index;
      else std::this_thread::yield();
    }
  });
  std::thread consumer([&]() {
    std::uint32_t expected = 1;
    while (expected <= kFrames) {
      std::array<float, 2> frame{};
      if (ring.readFrames(frame.data(), 1) == 0) {
        std::this_thread::yield();
        continue;
      }
      if (frame[0] != static_cast<float>(expected) || frame[1] != -static_cast<float>(expected)) {
        failed.store(true, std::memory_order_relaxed);
      }
      ++expected;
    }
  });

  producer.join();
  consumer.join();
  require(!failed.load(std::memory_order_relaxed), "concurrent SPSC transfer reordered or corrupted frames");
  require(ring.queuedFrames() == 0, "stress run left unexpected frames queued");
}

}  // namespace

int main() {
  fifoPreservesInterleavedFramesAcrossWraparound();
  fullWritesAreRejectedWithoutOverwritingQueuedAudio();
  invalidCapacityAndChannelConfigurationsAreRejected();
  singleProducerConsumerStressPreservesFrameSequence();
  std::cout << "WASAPI SPSC float ring: 4/4 checks passed (100000 concurrent frames)\n";
  return 0;
}
