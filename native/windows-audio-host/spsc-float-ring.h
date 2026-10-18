#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <vector>

namespace kyx::windows_audio {

static_assert(std::atomic<std::uint64_t>::is_always_lock_free,
              "the realtime SPSC ring requires lock-free 64-bit atomic indexes");

/**
 * Bounded, preallocated interleaved float32 FIFO for one producer and one
 * consumer. Construct before starting audio; reads and writes allocate nothing.
 * A write is all-or-nothing so a full capture packet is reported as an overrun
 * instead of silently committing a partial packet.
 */
#if defined(_MSC_VER)
#pragma warning(push)
#pragma warning(disable : 4324)  // Keep the two audio-thread indexes on separate cache lines.
#endif
class FloatSpscRing final {
 public:
  FloatSpscRing(std::uint32_t capacityFrames, std::uint32_t channels) {
    constexpr std::size_t kMaximumRingBytes = 32u * 1024u * 1024u;
    if (channels == 0 || channels > 32 || capacityFrames < 2 ||
        (capacityFrames & (capacityFrames - 1)) != 0 ||
        capacityFrames > (1u << 20) ||
        static_cast<std::size_t>(capacityFrames) >
            std::numeric_limits<std::size_t>::max() / channels / sizeof(float) ||
        static_cast<std::size_t>(capacityFrames) * channels * sizeof(float) > kMaximumRingBytes) {
      return;
    }
    channels_ = channels;
    capacityFrames_ = capacityFrames;
    frameMask_ = capacityFrames - 1;
    samples_.resize(static_cast<std::size_t>(capacityFrames) * channels);
  }

  FloatSpscRing(const FloatSpscRing&) = delete;
  FloatSpscRing& operator=(const FloatSpscRing&) = delete;

  bool valid() const noexcept { return !samples_.empty(); }
  std::uint32_t capacityFrames() const noexcept { return capacityFrames_; }
  std::uint32_t channels() const noexcept { return channels_; }

  bool writeFrames(const float* interleavedSamples, std::size_t frames) noexcept {
    if (frames == 0) return true;
    if (!valid() || !interleavedSamples || frames > capacityFrames_) return false;

    const std::uint64_t writeFrame = writeFrame_.load(std::memory_order_relaxed);
    const std::uint64_t readFrame = readFrame_.load(std::memory_order_acquire);
    const std::uint64_t occupiedFrames = writeFrame - readFrame;
    if (occupiedFrames > capacityFrames_ || frames > capacityFrames_ - occupiedFrames) return false;

    for (std::size_t frame = 0; frame < frames; ++frame) {
      const std::size_t ringFrame = static_cast<std::size_t>(writeFrame + frame) & frameMask_;
      const std::size_t sourceBase = frame * channels_;
      const std::size_t ringBase = ringFrame * channels_;
      std::copy_n(interleavedSamples + sourceBase, channels_, samples_.data() + ringBase);
    }
    writeFrame_.store(writeFrame + frames, std::memory_order_release);
    return true;
  }

  /** Read up to maxFrames, preserving complete interleaved frames. */
  std::size_t readFrames(float* interleavedSamples, std::size_t maxFrames) noexcept {
    if (maxFrames == 0) return 0;
    if (!valid() || !interleavedSamples) return 0;

    const std::uint64_t readFrame = readFrame_.load(std::memory_order_relaxed);
    const std::uint64_t writeFrame = writeFrame_.load(std::memory_order_acquire);
    const std::uint64_t availableFrames = writeFrame - readFrame;
    if (availableFrames > capacityFrames_) return 0;
    const std::size_t frames = static_cast<std::size_t>(
        std::min<std::uint64_t>(availableFrames, maxFrames));

    for (std::size_t frame = 0; frame < frames; ++frame) {
      const std::size_t ringFrame = static_cast<std::size_t>(readFrame + frame) & frameMask_;
      const std::size_t destinationBase = frame * channels_;
      const std::size_t ringBase = ringFrame * channels_;
      std::copy_n(samples_.data() + ringBase, channels_, interleavedSamples + destinationBase);
    }
    readFrame_.store(readFrame + frames, std::memory_order_release);
    return frames;
  }

  /** Approximate queue depth for non-realtime diagnostics and UI metering. */
  std::uint32_t queuedFrames() const noexcept {
    const std::uint64_t writeFrame = writeFrame_.load(std::memory_order_acquire);
    const std::uint64_t readFrame = readFrame_.load(std::memory_order_acquire);
    const std::uint64_t queued = writeFrame - readFrame;
    return queued > capacityFrames_ ? 0 : static_cast<std::uint32_t>(queued);
  }

 private:
  std::vector<float> samples_;
  std::uint32_t channels_ = 0;
  std::uint32_t capacityFrames_ = 0;
  std::size_t frameMask_ = 0;
  alignas(64) std::atomic<std::uint64_t> writeFrame_{0};
  alignas(64) std::atomic<std::uint64_t> readFrame_{0};
};
#if defined(_MSC_VER)
#pragma warning(pop)
#endif

}  // namespace kyx::windows_audio
