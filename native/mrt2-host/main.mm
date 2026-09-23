// KYX's private stdio adapter for Google's Magenta RealTime 2 C++ runner.
// The renderer never speaks to this process directly; Electron validates and
// owns every transport before forwarding these bounded frames.
#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>
#import <CoreFoundation/CoreFoundation.h>

#include <magentart/realtime_runner.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

constexpr uint32_t kProtocolVersion = 1;
constexpr size_t kMaxControlBytes = 64 * 1024;
constexpr size_t kMaxPacketBytes = 5'760'032;
constexpr size_t kMaxFrameBytes = kMaxPacketBytes + 256;
constexpr size_t kMaxTransportIdBytes = 128;
constexpr size_t kAudioHeaderBytes = 32;
constexpr size_t kFrameSamples = magentart::core::kFrameSamples;
constexpr int kSampleRate = 48'000;
constexpr int kChannels = 2;
constexpr int kFramesPerSecond = 25;
constexpr size_t kMaxCaptureFrames = static_cast<size_t>(kSampleRate) * 120;
constexpr size_t kMaxNoteFrames = 25 * 60 * 10;
constexpr char kModelId[] = "mrt2_small";
constexpr uint8_t kPacketMagic[8] = {'K', 'Y', 'X', 'M', 'R', 'T', '2', 0};

static_assert(std::endian::native == std::endian::little,
              "KYXMRT2 float PCM packets require a little-endian host");

uint16_t readU16BE(const uint8_t *bytes) {
  return static_cast<uint16_t>((static_cast<uint16_t>(bytes[0]) << 8) | bytes[1]);
}

uint32_t readU32BE(const uint8_t *bytes) {
  return (static_cast<uint32_t>(bytes[0]) << 24) |
         (static_cast<uint32_t>(bytes[1]) << 16) |
         (static_cast<uint32_t>(bytes[2]) << 8) |
         static_cast<uint32_t>(bytes[3]);
}

void writeU16LE(uint8_t *bytes, uint16_t value) {
  bytes[0] = static_cast<uint8_t>(value);
  bytes[1] = static_cast<uint8_t>(value >> 8);
}

void writeU32LE(uint8_t *bytes, uint32_t value) {
  bytes[0] = static_cast<uint8_t>(value);
  bytes[1] = static_cast<uint8_t>(value >> 8);
  bytes[2] = static_cast<uint8_t>(value >> 16);
  bytes[3] = static_cast<uint8_t>(value >> 24);
}

bool readExact(FILE *stream, uint8_t *destination, size_t count) {
  size_t offset = 0;
  while (offset < count) {
    const size_t read = std::fread(destination + offset, 1, count - offset, stream);
    if (read == 0) {
      if (offset == 0) return false;
      throw std::runtime_error("truncated frame");
    }
    offset += read;
  }
  return true;
}

bool isRecord(id value) {
  return value != nil && [value isKindOfClass:[NSDictionary class]];
}

bool isArray(id value) {
  return value != nil && [value isKindOfClass:[NSArray class]];
}

bool isString(id value) {
  return value != nil && [value isKindOfClass:[NSString class]];
}

bool isNumber(id value) {
  return value != nil && [value isKindOfClass:[NSNumber class]] &&
         CFGetTypeID((CFTypeRef)value) != CFBooleanGetTypeID();
}

bool readFiniteNumber(id value, double *result) {
  if (!isNumber(value)) return false;
  const double number = [value doubleValue];
  if (!std::isfinite(number)) return false;
  *result = number;
  return true;
}

bool readBoundedString(id value, size_t maxBytes, std::string *result) {
  if (!isString(value)) return false;
  NSData *data = [(NSString *)value dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil || data.length == 0 || data.length > maxBytes) return false;
  result->assign(static_cast<const char *>(data.bytes), data.length);
  return true;
}

NSString *toNSString(const std::string &value) {
  return [[NSString alloc] initWithBytes:value.data()
                                 length:value.size()
                               encoding:NSUTF8StringEncoding];
}

std::string sha256Hex(NSData *data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH] = {};
  CC_SHA256(data.bytes, static_cast<CC_LONG>(data.length), digest);
  static constexpr char hex[] = "0123456789abcdef";
  std::string output;
  output.resize(CC_SHA256_DIGEST_LENGTH * 2);
  for (size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; ++index) {
    output[index * 2] = hex[digest[index] >> 4];
    output[index * 2 + 1] = hex[digest[index] & 0x0f];
  }
  return output;
}

struct IncomingFrame {
  uint8_t kind = 0;
  std::string transportId;
  std::vector<uint8_t> payload;
};

bool readFrame(IncomingFrame *frame) {
  uint8_t lengthBytes[4] = {};
  if (!readExact(stdin, lengthBytes, sizeof(lengthBytes))) return false;
  const uint32_t bodyLength = readU32BE(lengthBytes);
  if (bodyLength < 3 || bodyLength > kMaxFrameBytes) {
    throw std::runtime_error("invalid frame length");
  }
  std::vector<uint8_t> body(bodyLength);
  if (!readExact(stdin, body.data(), body.size())) throw std::runtime_error("truncated frame");
  frame->kind = body[0];
  const uint16_t idLength = readU16BE(body.data() + 1);
  if (idLength > kMaxTransportIdBytes || 3u + idLength > body.size()) {
    throw std::runtime_error("invalid transport id length");
  }
  if (frame->kind == 3) {
    if (idLength != 0 || body.size() != 3) throw std::runtime_error("invalid shutdown frame");
    frame->transportId.clear();
    frame->payload.clear();
    return true;
  }
  if (idLength == 0) throw std::runtime_error("transport id is required");
  if (frame->kind == 2 && body.size() != 3u + idLength) {
    throw std::runtime_error("invalid close frame");
  }
  @autoreleasepool {
    NSString *transport = [[NSString alloc] initWithBytes:body.data() + 3
                                                   length:idLength
                                                 encoding:NSUTF8StringEncoding];
    if (transport == nil) throw std::runtime_error("transport id is not valid UTF-8");
    NSData *transportBytes = [transport dataUsingEncoding:NSUTF8StringEncoding];
    frame->transportId.assign(static_cast<const char *>(transportBytes.bytes), transportBytes.length);
  }
  frame->payload.assign(body.begin() + 3 + idLength, body.end());
  return true;
}

class Host {
 public:
  explicit Host(std::filesystem::path modelRoot)
      : modelRoot_(std::move(modelRoot)), runner_() {}

  bool initialize() {
    const auto resources = modelRoot_ / "resources";
    const auto model = modelRoot_ / "models" / kModelId / "mrt2_small.mlxfn";
    if (!std::filesystem::exists(resources / "musiccoca")) {
      log("MusicCoCa resources were not found under the model root");
      return false;
    }
    if (!std::filesystem::exists(model)) {
      log("MRT2 Small .mlxfn model was not found under the model root");
      return false;
    }
    if (!runner_.init_assets(resources.c_str())) {
      log("Magenta RealTime could not initialize MusicCoCa assets");
      return false;
    }
    if (!runner_.load_model(model.c_str())) {
      log("Magenta RealTime could not load MRT2 Small");
      return false;
    }
    // Upstream load_model primes and starts its inference thread. Keep the
    // process idle until KYX explicitly starts a generative session.
    runner_.stop();
    runner_.set_onset_mode(1);
    runner_.set_drumless(false);
    return true;
  }

  void run() {
    outputThread_ = std::thread([this] { outputLoop(); });
    IncomingFrame frame;
    try {
      while (!stopping_.load(std::memory_order_relaxed) && readFrame(&frame)) {
        if (frame.kind == 3) {
          stopping_.store(true, std::memory_order_relaxed);
          break;
        }
        @autoreleasepool {
          if (frame.kind == 0) {
            handleControl(frame.transportId, frame.payload);
          } else if (frame.kind == 1) {
            handleStylePacket(frame.transportId, frame.payload);
          } else if (frame.kind == 2) {
            closeTransport(frame.transportId);
          } else {
            throw std::runtime_error("unsupported frame kind");
          }
        }
      }
    } catch (const std::exception &error) {
      log(error.what());
      stopping_.store(true, std::memory_order_relaxed);
    }
    stopping_.store(true, std::memory_order_relaxed);
    stopRunner();
    if (outputThread_.joinable()) outputThread_.join();
  }

 private:
  struct CaptureState {
    bool active = false;
    std::string requestId;
    std::string inputHash;
    size_t expectedFrames = 0;
    size_t collectedFrames = 0;
  };

  void log(const std::string &message) {
    std::cerr << "[kyx-mrt2-host] " << message << std::endl;
  }

  bool writeBytes(const uint8_t *bytes, size_t length) {
    std::lock_guard<std::mutex> lock(outputMutex_);
    if (std::fwrite(bytes, 1, length, stdout) != length) return false;
    return std::fflush(stdout) == 0;
  }

  bool writeFrame(uint8_t kind, const std::string &transportId,
                  const uint8_t *payload, size_t payloadSize) {
    if (transportId.size() > kMaxTransportIdBytes ||
        payloadSize > kMaxFrameBytes - 3 - transportId.size()) {
      return false;
    }
    const size_t bodySize = 3 + transportId.size() + payloadSize;
    std::vector<uint8_t> frame(4 + bodySize);
    frame[0] = static_cast<uint8_t>(bodySize >> 24);
    frame[1] = static_cast<uint8_t>(bodySize >> 16);
    frame[2] = static_cast<uint8_t>(bodySize >> 8);
    frame[3] = static_cast<uint8_t>(bodySize);
    frame[4] = kind;
    frame[5] = static_cast<uint8_t>(transportId.size() >> 8);
    frame[6] = static_cast<uint8_t>(transportId.size());
    std::memcpy(frame.data() + 7, transportId.data(), transportId.size());
    if (payloadSize > 0) {
      std::memcpy(frame.data() + 7 + transportId.size(), payload, payloadSize);
    }
    return writeBytes(frame.data(), frame.size());
  }

  bool sendControl(const std::string &transportId, NSDictionary *message) {
    @autoreleasepool {
      NSError *error = nil;
      NSData *data = [NSJSONSerialization dataWithJSONObject:message
                                                     options:NSJSONWritingSortedKeys
                                                       error:&error];
      if (data == nil || data.length > kMaxControlBytes) {
        log("could not serialize bounded control response");
        return false;
      }
      return writeFrame(0, transportId,
                        static_cast<const uint8_t *>(data.bytes), data.length);
    }
  }

  bool sendStatus(const std::string &transportId, const std::string &state,
                  const std::string &requestId = {},
                  const std::string &sessionId = {},
                  const std::string &message = {}) {
    NSMutableDictionary *response = [@{
      @"version": @(kProtocolVersion),
      @"type": @"status",
      @"state": toNSString(state),
    } mutableCopy];
    if (!requestId.empty()) response[@"requestId"] = toNSString(requestId);
    if (!sessionId.empty()) response[@"sessionId"] = toNSString(sessionId);
    if (!message.empty()) response[@"message"] = toNSString(message);
    return sendControl(transportId, response);
  }

  bool sendError(const std::string &transportId, const std::string &code,
                 const std::string &message,
                 const std::string &requestId = {},
                 const std::string &sessionId = {}) {
    NSMutableDictionary *response = [@{
      @"version": @(kProtocolVersion),
      @"type": @"error",
      @"code": toNSString(code),
      @"message": toNSString(message),
    } mutableCopy];
    if (!requestId.empty()) response[@"requestId"] = toNSString(requestId);
    if (!sessionId.empty()) response[@"sessionId"] = toNSString(sessionId);
    return sendControl(transportId, response);
  }

  void handleControl(const std::string &transportId,
                     const std::vector<uint8_t> &payload) {
    if (payload.empty() || payload.size() > kMaxControlBytes) {
      sendError(transportId, "invalid-control", "Control payload size is invalid");
      return;
    }
    @autoreleasepool {
      NSData *data = [NSData dataWithBytes:payload.data() length:payload.size()];
      NSError *jsonError = nil;
      id decoded = [NSJSONSerialization JSONObjectWithData:data
                                                    options:NSJSONReadingFragmentsAllowed
                                                      error:&jsonError];
      if (!isRecord(decoded)) {
        sendError(transportId, "invalid-control", "Control JSON must be an object");
        return;
      }
      NSDictionary *message = (NSDictionary *)decoded;
      double version = 0;
      std::string type;
      std::string requestId;
      if (!readFiniteNumber(message[@"version"], &version) || version != kProtocolVersion ||
          !readBoundedString(message[@"type"], 64, &type) ||
          !readBoundedString(message[@"requestId"], 160, &requestId)) {
        sendError(transportId, "invalid-control", "Control version, type, or requestId is invalid");
        return;
      }
      if (type == "hello") {
        handleHello(transportId, message, requestId);
      } else if (type == "session.create") {
        handleSessionCreate(transportId, message, requestId);
      } else if (type == "input.update") {
        handleInputUpdate(transportId, message, requestId);
      } else if (type == "session.start") {
        handleSessionStart(transportId, message, requestId);
      } else if (type == "session.stop") {
        handleSessionStop(transportId, message, requestId);
      } else if (type == "session.close") {
        handleSessionClose(transportId, message, requestId);
      } else if (type == "capture.start") {
        handleCaptureStart(transportId, message, requestId);
      } else {
        sendError(transportId, "unsupported-message", "The native MRT2 host does not support this message type", requestId);
      }
    }
  }

  void handleHello(const std::string &transportId, NSDictionary *message,
                   const std::string &requestId) {
    std::string client;
    if (!readBoundedString(message[@"client"], 32, &client) || client != "kyx") {
      sendError(transportId, "invalid-client", "Only the KYX provider client is supported", requestId);
      return;
    }
    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      transports_.insert(transportId);
    }
    NSDictionary *response = @{
      @"version": @(kProtocolVersion),
      @"type": @"hello.ok",
      @"requestId": toNSString(requestId),
      @"providerId": @"mrt2",
      @"modelIds": @[@"mrt2_small"],
      @"outputSampleRates": @[@48000],
      @"outputChannels": @[@2],
      @"supportsRealtime": @YES,
      @"supportsCapture": @YES,
      @"supportsTextStyle": @YES,
      @"supportsNoteConditioning": @YES,
      @"supportsAudioStyle": @NO,
      @"supportsDrumsMode": @YES,
      @"supportsSeed": @NO,
      @"maxCaptureSeconds": @120,
      @"macroSupport": @{
        @"energy": @"unsupported",
        @"density": @"unsupported",
        @"variation": @"unsupported",
        @"texture": @"unsupported",
      },
    };
    sendControl(transportId, response);
  }

  bool requireOwnedSession(const std::string &transportId,
                           NSDictionary *message,
                           const std::string &requestId,
                           std::string *sessionId) {
    std::string requested;
    if (!readBoundedString(message[@"sessionId"], 160, &requested)) {
      sendError(transportId, "invalid-session", "sessionId is invalid", requestId);
      return false;
    }
    std::lock_guard<std::mutex> lock(stateMutex_);
    if (!transports_.contains(transportId) || requested != sessionId_ ||
        sessionTransportId_ != transportId) {
      sendError(transportId, "invalid-session", "The session is not owned by this transport", requestId);
      return false;
    }
    *sessionId = sessionId_;
    return true;
  }

  void handleSessionCreate(const std::string &transportId,
                           NSDictionary *message,
                           const std::string &requestId) {
    NSDictionary *config = isRecord(message[@"config"]) ? message[@"config"] : nil;
    std::string modelId;
    double sampleRate = 0;
    double channels = 0;
    if (config == nil || !readBoundedString(config[@"modelId"], 64, &modelId) ||
        !readFiniteNumber(config[@"outputSampleRate"], &sampleRate) ||
        !readFiniteNumber(config[@"outputChannels"], &channels) ||
        modelId != kModelId || sampleRate != kSampleRate || channels != kChannels) {
      sendError(transportId, "unsupported-config", "Only MRT2 Small stereo 48 kHz sessions are supported", requestId);
      return;
    }
    const std::string sessionId = [[[NSUUID UUID] UUIDString] UTF8String];
    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      if (!transports_.contains(transportId)) {
        sendError(transportId, "not-connected", "Send hello before creating a session", requestId);
        return;
      }
      if (!sessionId_.empty()) {
        sendError(transportId, "busy", "Only one MRT2 Small session can be active in KYX", requestId);
        return;
      }
      sessionId_ = sessionId;
      sessionTransportId_ = transportId;
      latestInputHash_.clear();
      currentPrompt_.clear();
      promptStatus_ = 0;
    }
    sendControl(transportId, @{
      @"version": @(kProtocolVersion),
      @"type": @"session.ok",
      @"requestId": toNSString(requestId),
      @"sessionId": toNSString(sessionId),
    });
  }

  bool validateInput(NSDictionary *input, std::string *prompt,
                     NSArray **noteFrames, bool *drumless,
                     std::string *inputHash, std::string *error) {
    double bpm = 0, frameRate = 0, startTick = 0;
    if (!readFiniteNumber(input[@"bpm"], &bpm) || bpm < 20 || bpm > 300 ||
        !readFiniteNumber(input[@"frameRateHz"], &frameRate) || frameRate != kFramesPerSecond ||
        !readFiniteNumber(input[@"startTick"], &startTick) || startTick < 0) {
      *error = "input BPM, frameRateHz, or startTick is invalid";
      return false;
    }
    NSDictionary *macros = isRecord(input[@"macros"]) ? input[@"macros"] : nil;
    for (NSString *key in @[@"energy", @"density", @"variation", @"texture"]) {
      double value = 0;
      if (macros == nil || !readFiniteNumber(macros[key], &value) || value < 0 || value > 1) {
        *error = "input macro values must be finite numbers between 0 and 1";
        return false;
      }
    }
    std::string drumMode;
    if (!readBoundedString(input[@"drumsMode"], 32, &drumMode) ||
        (drumMode != "off" && drumMode != "on" && drumMode != "provider-default")) {
      *error = "input drumsMode is invalid";
      return false;
    }
    *drumless = drumMode == "off";

    NSDictionary *style = isRecord(input[@"style"]) ? input[@"style"] : nil;
    std::string styleKind;
    if (style == nil || !readBoundedString(style[@"kind"], 16, &styleKind)) {
      *error = "input style descriptor is invalid";
      return false;
    }
    if (styleKind == "audio") {
      *error = "Audio-style conditioning is not enabled until the upstream MusicCoCa PCM format is verified";
      return false;
    }
    if (styleKind != "text" || !readBoundedString(style[@"text"], 400, prompt)) {
      *error = "Only a non-empty text style prompt is supported by this MRT2 host";
      return false;
    }
    if (input[@"seed"] != nil) {
      *error = "This MRT2 runtime does not guarantee seed control";
      return false;
    }

    id framesValue = input[@"noteFrames"];
    if (!isArray(framesValue) || [(NSArray *)framesValue count] == 0 ||
        [(NSArray *)framesValue count] > kMaxNoteFrames) {
      *error = "input.noteFrames is empty or exceeds the bounded limit";
      return false;
    }
    for (id frameValue in (NSArray *)framesValue) {
      if (!isRecord(frameValue)) {
        *error = "input.noteFrames contains an invalid frame";
        return false;
      }
      NSDictionary *frame = (NSDictionary *)frameValue;
      double frameIndex = 0;
      id pitches = frame[@"pitchState"];
      if (!readFiniteNumber(frame[@"frameIndex"], &frameIndex) || frameIndex < 0 ||
          std::floor(frameIndex) != frameIndex || frameIndex >= kMaxNoteFrames ||
          !isArray(pitches) || [(NSArray *)pitches count] != 128) {
        *error = "input.noteFrames has an invalid frameIndex or 128-pitch state";
        return false;
      }
      for (id stateValue in (NSArray *)pitches) {
        double state = 0;
        if (!readFiniteNumber(stateValue, &state) || state < 0 || state > 3 ||
            std::floor(state) != state) {
          *error = "input.noteFrames pitch states must be integers from 0 to 3";
          return false;
        }
      }
    }
    *noteFrames = (NSArray *)framesValue;

    NSError *jsonError = nil;
    NSData *canonical = [NSJSONSerialization dataWithJSONObject:input
                                                        options:NSJSONWritingSortedKeys
                                                          error:&jsonError];
    if (canonical == nil || canonical.length > kMaxControlBytes) {
      *error = "input could not be serialized within the control-message limit";
      return false;
    }
    *inputHash = sha256Hex(canonical);
    return true;
  }

  void setNoteState(NSArray *noteFrames) {
    NSDictionary *first = noteFrames.count > 0 && isRecord(noteFrames[0]) ? noteFrames[0] : nil;
    NSArray *pitchState = first != nil && isArray(first[@"pitchState"]) ? first[@"pitchState"] : nil;
    if (pitchState == nil || pitchState.count != 128) return;
    for (int pitch = 0; pitch < 128; ++pitch) {
      const int state = [pitchState[pitch] intValue];
      if (state == 3) continue;
      const bool active = activeNotes_[pitch];
      if (state == 0) {
        if (active) runner_.set_note_off(pitch);
        activeNotes_[pitch] = false;
      } else if (state == 2) {
        if (active) runner_.set_note_off(pitch);
        runner_.set_note_on(pitch);
        activeNotes_[pitch] = true;
      } else if (!active) {
        runner_.set_note_on(pitch);
        activeNotes_[pitch] = true;
      }
    }
  }

  void releaseAllNotes() {
    for (int pitch = 0; pitch < 128; ++pitch) {
      if (activeNotes_[pitch]) runner_.set_note_off(pitch);
      activeNotes_[pitch] = false;
    }
  }

  void handleInputUpdate(const std::string &transportId,
                         NSDictionary *message,
                         const std::string &requestId) {
    std::string sessionId;
    if (!requireOwnedSession(transportId, message, requestId, &sessionId)) return;
    NSDictionary *input = isRecord(message[@"input"]) ? message[@"input"] : nil;
    std::string prompt, inputHash, error;
    NSArray *noteFrames = nil;
    bool drumless = false;
    if (input == nil || !validateInput(input, &prompt, &noteFrames, &drumless,
                                       &inputHash, &error)) {
      sendError(transportId, "invalid-input", input == nil ? "input must be an object" : error,
                requestId, sessionId);
      return;
    }
    bool promptChanged = false;
    {
      std::lock_guard<std::mutex> stateLock(stateMutex_);
      promptChanged = prompt != currentPrompt_;
      currentPrompt_ = prompt;
      latestInputHash_ = inputHash;
    }
    if (promptChanged) runner_.set_text_prompt(prompt);
    runner_.set_drumless(drumless);
    setNoteState(noteFrames);
    const int encoderStatus = runner_.get_text_encoder_status();
    {
      std::lock_guard<std::mutex> stateLock(stateMutex_);
      promptStatus_ = encoderStatus;
    }
    sendStatus(transportId,
               encoderStatus == 3 ? "error" : (encoderStatus == 1 ? "loading" : "ready"),
               requestId, sessionId,
               encoderStatus == 3 ? "MRT2 MusicCoCa prompt encoding failed" : "");
  }

  void handleSessionStart(const std::string &transportId,
                          NSDictionary *message,
                          const std::string &requestId) {
    std::string sessionId;
    if (!requireOwnedSession(transportId, message, requestId, &sessionId)) return;
    try {
      {
        std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
        if (!runnerRunning_) {
          runner_.start();
          runnerRunning_ = true;
        }
      }
      {
        std::lock_guard<std::mutex> stateLock(stateMutex_);
        liveRequested_ = true;
        buffering_ = false;
      }
      sendStatus(transportId, "running", requestId, sessionId);
    } catch (const std::exception &exception) {
      sendError(transportId, "start-failed", exception.what(), requestId, sessionId);
    }
  }

  void handleSessionStop(const std::string &transportId,
                         NSDictionary *message,
                         const std::string &requestId) {
    std::string sessionId;
    if (!requireOwnedSession(transportId, message, requestId, &sessionId)) return;
    std::string cancelledCapture;
    {
      std::lock_guard<std::mutex> stateLock(stateMutex_);
      liveRequested_ = false;
      buffering_ = false;
      if (capture_.active) {
        cancelledCapture = capture_.requestId;
        capture_ = {};
      }
    }
    stopRunner();
    releaseAllNotes();
    if (!cancelledCapture.empty()) {
      sendError(transportId, "capture-cancelled", "MRT2 capture was stopped with its session", cancelledCapture, sessionId);
    }
    sendStatus(transportId, "ready", requestId, sessionId);
  }

  void handleSessionClose(const std::string &transportId,
                          NSDictionary *message,
                          const std::string &requestId) {
    std::string sessionId;
    if (!requireOwnedSession(transportId, message, requestId, &sessionId)) return;
    std::string cancelledCapture;
    {
      std::lock_guard<std::mutex> stateLock(stateMutex_);
      liveRequested_ = false;
      buffering_ = false;
      if (capture_.active) cancelledCapture = capture_.requestId;
      capture_ = {};
    }
    stopRunner();
    releaseAllNotes();
    {
      std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
      runner_.reset();
    }
    {
      std::lock_guard<std::mutex> stateLock(stateMutex_);
      sessionId_.clear();
      sessionTransportId_.clear();
      currentPrompt_.clear();
      latestInputHash_.clear();
      promptStatus_ = 0;
    }
    if (!cancelledCapture.empty()) {
      sendError(transportId, "capture-cancelled", "MRT2 session was closed during capture", cancelledCapture, sessionId);
    }
    sendStatus(transportId, "ready", requestId, sessionId);
  }

  void handleCaptureStart(const std::string &transportId,
                          NSDictionary *message,
                          const std::string &requestId) {
    std::string sessionId;
    if (!requireOwnedSession(transportId, message, requestId, &sessionId)) return;
    double duration = 0;
    if (!readFiniteNumber(message[@"durationSec"], &duration) || duration <= 0 || duration > 120) {
      sendError(transportId, "invalid-capture", "Capture duration must be greater than 0 and at most 120 seconds", requestId, sessionId);
      return;
    }
    const size_t expectedFrames = static_cast<size_t>(std::ceil(duration * kSampleRate));
    if (expectedFrames == 0 || expectedFrames > kMaxCaptureFrames) {
      sendError(transportId, "invalid-capture", "Capture exceeds the bounded 48 kHz PCM limit", requestId, sessionId);
      return;
    }
    std::string inputHash;
    {
      std::lock_guard<std::mutex> stateLock(stateMutex_);
      if (capture_.active) {
        sendError(transportId, "busy", "An MRT2 capture is already active", requestId, sessionId);
        return;
      }
      inputHash = latestInputHash_;
    }
    if (inputHash.empty()) {
      sendError(transportId, "missing-input", "Update the MRT2 session input before capture", requestId, sessionId);
      return;
    }
    try {
      {
        std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
        if (!runnerRunning_) {
          runner_.start();
          runnerRunning_ = true;
        }
      }
      {
        std::lock_guard<std::mutex> stateLock(stateMutex_);
        capture_ = {true, requestId, inputHash, expectedFrames, 0};
        buffering_ = false;
      }
      sendStatus(transportId, "capturing", {}, sessionId);
    } catch (const std::exception &exception) {
      sendError(transportId, "capture-start-failed", exception.what(), requestId, sessionId);
    }
  }

  void handleStylePacket(const std::string &transportId,
                         const std::vector<uint8_t> &packet) {
    {
      std::lock_guard<std::mutex> stateLock(stateMutex_);
      if (!transports_.contains(transportId)) return;
    }
    if (packet.size() < kAudioHeaderBytes || packet.size() > kMaxPacketBytes ||
        std::memcmp(packet.data(), kPacketMagic, sizeof(kPacketMagic)) != 0 ||
        packet[10] != 1 || readU16LE(packet.data() + 8) != kProtocolVersion) {
      sendError(transportId, "invalid-style-packet", "MRT2 audio-style packet is malformed");
      return;
    }
    const uint8_t channels = packet[11];
    const uint32_t sampleRate =
        static_cast<uint32_t>(packet[12]) |
        (static_cast<uint32_t>(packet[13]) << 8) |
        (static_cast<uint32_t>(packet[14]) << 16) |
        (static_cast<uint32_t>(packet[15]) << 24);
    const uint32_t frames =
        static_cast<uint32_t>(packet[16]) |
        (static_cast<uint32_t>(packet[17]) << 8) |
        (static_cast<uint32_t>(packet[18]) << 16) |
        (static_cast<uint32_t>(packet[19]) << 24);
    const uint32_t dataBytes =
        static_cast<uint32_t>(packet[24]) |
        (static_cast<uint32_t>(packet[25]) << 8) |
        (static_cast<uint32_t>(packet[26]) << 16) |
        (static_cast<uint32_t>(packet[27]) << 24);
    if (channels < 1 || channels > 2 || sampleRate == 0 || sampleRate > 192'000 ||
        frames == 0 || frames > 720'000 ||
        dataBytes != frames * channels * sizeof(float) ||
        packet.size() != kAudioHeaderBytes + dataBytes) {
      sendError(transportId, "invalid-style-packet", "MRT2 audio-style packet dimensions are invalid");
      return;
    }
    for (size_t offset = kAudioHeaderBytes; offset < packet.size(); offset += sizeof(float)) {
      float sample = 0;
      std::memcpy(&sample, packet.data() + offset, sizeof(sample));
      if (!std::isfinite(sample)) {
        sendError(transportId, "invalid-style-packet", "MRT2 audio-style packet contains non-finite PCM");
        return;
      }
    }
    // Upstream's path-based audio prompt is explicitly a fake placeholder,
    // and its PCM setter has no sample-rate argument. Refuse to feed ambiguous
    // samples until the expected PCM format is established and tested.
    sendError(transportId, "unsupported-audio-style",
              "This MRT2 host build does not accept audio-style conditioning yet");
  }

  static uint16_t readU16LE(const uint8_t *bytes) {
    return static_cast<uint16_t>(bytes[0] | (static_cast<uint16_t>(bytes[1]) << 8));
  }

  void closeTransport(const std::string &transportId) {
    bool ownsSession = false;
    std::string cancelledCapture;
    {
      std::lock_guard<std::mutex> stateLock(stateMutex_);
      transports_.erase(transportId);
      ownsSession = sessionTransportId_ == transportId && !sessionId_.empty();
      if (ownsSession) {
        if (capture_.active) cancelledCapture = capture_.requestId;
        capture_ = {};
        liveRequested_ = false;
        sessionId_.clear();
        sessionTransportId_.clear();
        currentPrompt_.clear();
        latestInputHash_.clear();
        promptStatus_ = 0;
      }
    }
    if (ownsSession) {
      stopRunner();
      releaseAllNotes();
      {
        std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
        runner_.reset();
      }
      if (!cancelledCapture.empty()) {
        sendError(transportId, "capture-cancelled", "MRT2 transport closed during capture", cancelledCapture);
      }
    }
  }

  void stopRunner() {
    std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
    if (!runnerRunning_) return;
    runner_.stop();
    runnerRunning_ = false;
  }

  bool sendAudioPacket(const std::string &transportId,
                       uint32_t sequence,
                       const float *left,
                       const float *right,
                       size_t frames) {
    if (frames == 0 || frames > kFrameSamples) return false;
    const size_t dataBytes = frames * kChannels * sizeof(float);
    std::vector<uint8_t> packet(kAudioHeaderBytes + dataBytes);
    std::memcpy(packet.data(), kPacketMagic, sizeof(kPacketMagic));
    writeU16LE(packet.data() + 8, kProtocolVersion);
    packet[10] = 0;
    packet[11] = kChannels;
    writeU32LE(packet.data() + 12, kSampleRate);
    writeU32LE(packet.data() + 16, static_cast<uint32_t>(frames));
    writeU32LE(packet.data() + 20, sequence);
    writeU32LE(packet.data() + 24, static_cast<uint32_t>(dataBytes));
    writeU32LE(packet.data() + 28, 0);
    for (size_t index = 0; index < frames; ++index) {
      const float leftSample = std::isfinite(left[index]) ? left[index] : 0.0f;
      const float rightSample = std::isfinite(right[index]) ? right[index] : 0.0f;
      std::memcpy(packet.data() + kAudioHeaderBytes + index * 2 * sizeof(float),
                  &leftSample, sizeof(float));
      std::memcpy(packet.data() + kAudioHeaderBytes + (index * 2 + 1) * sizeof(float),
                  &rightSample, sizeof(float));
    }
    return writeFrame(1, transportId, packet.data(), packet.size());
  }

  void pollPromptStatus() {
    const int status = runner_.get_text_encoder_status();
    std::string transportId, sessionId;
    {
      std::lock_guard<std::mutex> stateLock(stateMutex_);
      if (sessionId_.empty() || currentPrompt_.empty() || status == promptStatus_) return;
      promptStatus_ = status;
      transportId = sessionTransportId_;
      sessionId = sessionId_;
    }
    const char *state = status == 1 ? "loading" : (status == 3 ? "error" : "ready");
    const char *message = status == 3 ? "MRT2 MusicCoCa prompt encoding failed" : "";
    sendStatus(transportId, state, {}, sessionId, message);
  }

  void outputLoop() {
    std::array<float, kFrameSamples> left{};
    std::array<float, kFrameSamples> right{};
    auto nextFrame = std::chrono::steady_clock::now();
    while (!stopping_.load(std::memory_order_relaxed)) {
      @autoreleasepool {
        pollPromptStatus();
        bool active = false;
        {
          std::lock_guard<std::mutex> stateLock(stateMutex_);
          active = !sessionId_.empty() && (liveRequested_ || capture_.active);
        }
        if (active) {
          left.fill(0.0f);
          right.fill(0.0f);
          const bool audioAvailable = runner_.read_audio_stereo(left.data(), right.data(), kFrameSamples, false);
          bool completeCapture = false;
          bool statusChanged = false;
          bool stillCapturing = false;
          std::string transportId, sessionId, captureRequestId, inputHash;
          size_t emittedFrames = kFrameSamples;
          size_t capturedFrames = 0;
          const uint32_t sequence = sequence_.fetch_add(1, std::memory_order_relaxed);
          {
            std::lock_guard<std::mutex> stateLock(stateMutex_);
            if (!sessionId_.empty() && (liveRequested_ || capture_.active)) {
              transportId = sessionTransportId_;
              sessionId = sessionId_;
              if (buffering_ == audioAvailable) {
                buffering_ = !audioAvailable;
                statusChanged = true;
                stillCapturing = capture_.active;
              }
              if (capture_.active) {
                emittedFrames = std::min(kFrameSamples, capture_.expectedFrames - capture_.collectedFrames);
                captureRequestId = capture_.requestId;
                inputHash = capture_.inputHash;
              }
              if (!sendAudioPacket(transportId, sequence, left.data(), right.data(), emittedFrames)) {
                stopping_.store(true, std::memory_order_relaxed);
              } else if (capture_.active) {
                capture_.collectedFrames += emittedFrames;
                capturedFrames = capture_.collectedFrames;
                completeCapture = capturedFrames >= capture_.expectedFrames;
                if (completeCapture) capture_ = {};
              }
            }
          }
          if (statusChanged) {
            sendStatus(transportId,
                       audioAvailable ? (stillCapturing ? "capturing" : "running") : "buffering",
                       {}, sessionId,
                       audioAvailable ? "" : "MRT2 inference is waiting for the next audio frame");
          }
          if (completeCapture) {
            sendControl(transportId, @{
              @"version": @(kProtocolVersion),
              @"type": @"capture.ok",
              @"requestId": toNSString(captureRequestId),
              @"sessionId": toNSString(sessionId),
              @"frames": @(capturedFrames),
              @"durationSec": @(static_cast<double>(capturedFrames) / kSampleRate),
              @"inputHash": toNSString(inputHash),
            });
            bool stillLive = false;
            {
              std::lock_guard<std::mutex> stateLock(stateMutex_);
              stillLive = liveRequested_;
            }
            sendStatus(transportId, stillLive ? "running" : "ready", {}, sessionId);
            if (!stillLive) stopRunner();
          }
        }
      }
      nextFrame += std::chrono::milliseconds(1000 / kFramesPerSecond);
      const auto now = std::chrono::steady_clock::now();
      if (nextFrame < now - std::chrono::milliseconds(160)) nextFrame = now;
      std::this_thread::sleep_until(nextFrame);
    }
  }

  std::filesystem::path modelRoot_;
  magentart::core::RealtimeRunner runner_;
  std::mutex outputMutex_;
  std::mutex stateMutex_;
  std::mutex lifecycleMutex_;
  std::set<std::string> transports_;
  std::string sessionId_;
  std::string sessionTransportId_;
  std::string currentPrompt_;
  std::string latestInputHash_;
  CaptureState capture_;
  std::array<bool, 128> activeNotes_{};
  std::atomic<bool> stopping_{false};
  std::atomic<uint32_t> sequence_{0};
  std::thread outputThread_;
  bool liveRequested_ = false;
  bool runnerRunning_ = false;
  bool buffering_ = false;
  int promptStatus_ = 0;
};

std::filesystem::path parseModelRoot(int argc, char **argv) {
  if (argc != 3 || std::string(argv[1]) != "--model-root" ||
      argv[2] == nullptr || argv[2][0] == '\0') {
    throw std::runtime_error("usage: kyx-mrt2-host --model-root <fixed-model-directory>");
  }
  return std::filesystem::weakly_canonical(argv[2]);
}

}  // namespace

int main(int argc, char **argv) {
  @autoreleasepool {
    try {
      // Upstream emits model-loading diagnostics through std::cout. Reserve
      // stdout exclusively for the versioned host protocol.
      std::cout.rdbuf(std::cerr.rdbuf());
      Host host(parseModelRoot(argc, argv));
      if (!host.initialize()) return 2;
      static constexpr char readyLine[] =
          "{\"version\":1,\"type\":\"ready\",\"providerId\":\"mrt2\",\"modelId\":\"mrt2_small\"}\n";
      if (std::fwrite(readyLine, 1, sizeof(readyLine) - 1, stdout) != sizeof(readyLine) - 1 ||
          std::fflush(stdout) != 0) {
        return 3;
      }
      host.run();
      return 0;
    } catch (const std::exception &error) {
      std::cerr << "[kyx-mrt2-host] fatal: " << error.what() << std::endl;
      return 1;
    }
  }
}
