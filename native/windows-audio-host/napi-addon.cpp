#include <node_api.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <new>
#include <string>
#include <utility>
#include <vector>

#include "wasapi-shared-duplex.h"

namespace {

using kyx::windows_audio::SharedModeDuplexRequest;
using kyx::windows_audio::SharedModeDuplexSnapshot;
using kyx::windows_audio::WasapiSharedDuplexSession;

struct SessionWrap {
  std::unique_ptr<WasapiSharedDuplexSession> session;
  std::uint32_t inputChannels = 0;
  std::uint32_t outputChannels = 0;
  std::uint32_t periodFrames = 0;
  std::uint32_t ringCapacityFrames = 0;
};

struct StartWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  napi_ref receiver = nullptr;
  SessionWrap* session = nullptr;
  bool succeeded = false;
  std::wstring error;
};

bool throwTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return false;
}

bool throwError(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return false;
}

napi_value createWideString(napi_env env, const std::wstring& value) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t), "WASAPI add-on requires Windows UTF-16 wchar_t");
  napi_value result = nullptr;
  if (napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(value.data()), value.size(), &result) != napi_ok)
    return nullptr;
  return result;
}

bool getNamedValue(napi_env env, napi_value object, const char* name, napi_value* value) {
  bool present = false;
  if (napi_has_named_property(env, object, name, &present) != napi_ok || !present)
    return throwTypeError(env, name);
  return napi_get_named_property(env, object, name, value) == napi_ok;
}

bool getWideString(napi_env env, napi_value value, std::wstring* output, const char* name) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string)
    return throwTypeError(env, name);
  std::size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length == 0 || length > 2048)
    return throwTypeError(env, name);
  std::vector<char16_t> buffer(length + 1);
  std::size_t copied = 0;
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &copied) != napi_ok || copied != length)
    return throwTypeError(env, name);
  output->clear();
  output->reserve(length);
  for (std::size_t index = 0; index < length; ++index) {
    if (buffer[index] == u'\0') return throwTypeError(env, name);
    output->push_back(static_cast<wchar_t>(buffer[index]));
  }
  return true;
}

bool getUnsignedInteger(napi_env env,
                        napi_value value,
                        std::uint32_t maximum,
                        std::uint32_t* output,
                        const char* name) {
  napi_valuetype type = napi_undefined;
  double number = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number) || std::floor(number) != number ||
      number < 0 || number > maximum) {
    return throwTypeError(env, name);
  }
  *output = static_cast<std::uint32_t>(number);
  return true;
}

bool getChannelMap(napi_env env, napi_value value, std::vector<std::uint32_t>* output, const char* name) {
  bool isArray = false;
  std::uint32_t length = 0;
  if (napi_is_array(env, value, &isArray) != napi_ok || !isArray ||
      napi_get_array_length(env, value, &length) != napi_ok || length == 0 || length > 32) {
    return throwTypeError(env, name);
  }
  output->clear();
  output->reserve(length);
  std::uint32_t seen = 0;
  for (std::uint32_t index = 0; index < length; ++index) {
    napi_value item = nullptr;
    std::uint32_t channel = 0;
    if (napi_get_element(env, value, index, &item) != napi_ok ||
        !getUnsignedInteger(env, item, 31, &channel, name)) {
      return false;
    }
    const std::uint32_t bit = std::uint32_t{1} << channel;
    if ((seen & bit) != 0) return throwTypeError(env, name);
    seen |= bit;
    output->push_back(channel);
  }
  return true;
}

bool parseRequest(napi_env env, napi_value value, SharedModeDuplexRequest* request) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object)
    return throwTypeError(env, "request must be an object");

  napi_value property = nullptr;
  if (!getNamedValue(env, value, "inputEndpointId", &property) ||
      !getWideString(env, property, &request->inputEndpointId, "inputEndpointId must be a bounded exact endpoint ID"))
    return false;
  if (!getNamedValue(env, value, "outputEndpointId", &property) ||
      !getWideString(env, property, &request->outputEndpointId, "outputEndpointId must be a bounded exact endpoint ID"))
    return false;
  if (!getNamedValue(env, value, "sampleRateHz", &property) ||
      !getUnsignedInteger(env, property, 384'000, &request->sampleRateHz, "sampleRateHz must be a bounded integer"))
    return false;
  if (!getNamedValue(env, value, "periodFrames", &property) ||
      !getUnsignedInteger(env, property, 131'072, &request->periodFrames, "periodFrames must be a bounded integer"))
    return false;
  if (!getNamedValue(env, value, "inputChannelMap", &property) ||
      !getChannelMap(env, property, &request->inputChannelMap, "inputChannelMap must contain unique channel indexes"))
    return false;
  if (!getNamedValue(env, value, "outputChannelMap", &property) ||
      !getChannelMap(env, property, &request->outputChannelMap, "outputChannelMap must contain unique channel indexes"))
    return false;

  bool hasCapacity = false;
  if (napi_has_named_property(env, value, "ringCapacityFrames", &hasCapacity) != napi_ok) return false;
  if (hasCapacity) {
    if (napi_get_named_property(env, value, "ringCapacityFrames", &property) != napi_ok ||
        !getUnsignedInteger(env, property, 1u << 20, &request->ringCapacityFrames,
                            "ringCapacityFrames must be a bounded integer"))
      return false;
  }
  return true;
}

bool setNumber(napi_env env, napi_value object, const char* name, double value) {
  napi_value number = nullptr;
  return napi_create_double(env, value, &number) == napi_ok &&
         napi_set_named_property(env, object, name, number) == napi_ok;
}

bool setCString(napi_env env, napi_value object, const char* name, const char* value) {
  napi_value string = nullptr;
  return napi_create_string_utf8(env, value ? value : "", NAPI_AUTO_LENGTH, &string) == napi_ok &&
         napi_set_named_property(env, object, name, string) == napi_ok;
}

bool setUint64(napi_env env, napi_value object, const char* name, std::uint64_t value) {
  napi_value number = nullptr;
  return napi_create_double(env, static_cast<double>(value), &number) == napi_ok &&
         napi_set_named_property(env, object, name, number) == napi_ok;
}

bool setWideString(napi_env env, napi_value object, const char* name, const std::wstring& value) {
  napi_value string = createWideString(env, value);
  return string && napi_set_named_property(env, object, name, string) == napi_ok;
}

bool setChannelArray(napi_env env, napi_value object, const char* name, const std::vector<std::uint32_t>& values) {
  napi_value array = nullptr;
  if (napi_create_array_with_length(env, values.size(), &array) != napi_ok) return false;
  for (std::size_t index = 0; index < values.size(); ++index) {
    napi_value number = nullptr;
    if (napi_create_uint32(env, values[index], &number) != napi_ok ||
        napi_set_element(env, array, static_cast<std::uint32_t>(index), number) != napi_ok)
      return false;
  }
  return napi_set_named_property(env, object, name, array) == napi_ok;
}

const char* stateName(kyx::windows_audio::SharedModeDuplexState state) noexcept {
  switch (state) {
    case kyx::windows_audio::SharedModeDuplexState::idle: return "idle";
    case kyx::windows_audio::SharedModeDuplexState::starting: return "starting";
    case kyx::windows_audio::SharedModeDuplexState::running: return "running";
    case kyx::windows_audio::SharedModeDuplexState::deviceLost: return "device-lost";
    case kyx::windows_audio::SharedModeDuplexState::failed: return "failed";
    case kyx::windows_audio::SharedModeDuplexState::stopped: return "stopped";
  }
  return "failed";
}

napi_value createSnapshot(napi_env env, const SharedModeDuplexSnapshot& snapshot) {
  napi_value result = nullptr;
  napi_value state = nullptr;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(env, stateName(snapshot.state), NAPI_AUTO_LENGTH, &state) != napi_ok ||
      napi_set_named_property(env, result, "state", state) != napi_ok ||
      !setCString(env, result, "startupStage", snapshot.startupStage) ||
      !setCString(env, result, "startupEndpoint", snapshot.startupEndpoint) ||
      !setWideString(env, result, "lastError", snapshot.lastError))
    return nullptr;

  const auto& negotiation = snapshot.negotiation;
  if (!setWideString(env, result, "inputEndpointId", negotiation.inputEndpointId) ||
      !setWideString(env, result, "outputEndpointId", negotiation.outputEndpointId) ||
      !setNumber(env, result, "sampleRateHz", negotiation.sampleRateHz) ||
      !setNumber(env, result, "periodFrames", negotiation.periodFrames) ||
      !setNumber(env, result, "inputEndpointChannels", negotiation.inputEndpointChannels) ||
      !setNumber(env, result, "outputEndpointChannels", negotiation.outputEndpointChannels) ||
      !setNumber(env, result, "inputBufferFrames", negotiation.inputBufferFrames) ||
      !setNumber(env, result, "outputBufferFrames", negotiation.outputBufferFrames) ||
      !setUint64(env, result, "captureOverrunPackets", snapshot.captureOverrunPackets) ||
      !setUint64(env, result, "renderOverrunPackets", snapshot.renderOverrunPackets) ||
      !setUint64(env, result, "renderUnderrunPeriods", snapshot.renderUnderrunPeriods) ||
      !setUint64(env, result, "captureDiscontinuities", snapshot.captureDiscontinuities) ||
      !setUint64(env, result, "captureTimestampErrors", snapshot.captureTimestampErrors) ||
      !setNumber(env, result, "captureQueuedFrames", snapshot.captureQueuedFrames) ||
      !setNumber(env, result, "renderQueuedFrames", snapshot.renderQueuedFrames) ||
      !setChannelArray(env, result, "inputChannelMap", negotiation.inputChannelMap) ||
      !setChannelArray(env, result, "outputChannelMap", negotiation.outputChannelMap))
    return nullptr;

  napi_value periods = nullptr;
  if (napi_create_object(env, &periods) != napi_ok ||
      !setNumber(env, periods, "minFrames", negotiation.commonSharedPeriods.minFrames) ||
      !setNumber(env, periods, "maxFrames", negotiation.commonSharedPeriods.maxFrames) ||
      !setNumber(env, periods, "fundamentalFrames", negotiation.commonSharedPeriods.fundamentalFrames) ||
      napi_set_named_property(env, result, "sharedPeriods", periods) != napi_ok)
    return nullptr;
  if (negotiation.reportedInputLatencyFrames &&
      !setNumber(env, result, "reportedInputLatencyFrames", *negotiation.reportedInputLatencyFrames))
    return nullptr;
  if (negotiation.reportedOutputLatencyFrames &&
      !setNumber(env, result, "reportedOutputLatencyFrames", *negotiation.reportedOutputLatencyFrames))
    return nullptr;
  return result;
}

void finalizeSession(napi_env, void* data, void*) {
  auto* session = static_cast<SessionWrap*>(data);
  if (!session) return;
  session->session->stop();
  delete session;
}

SessionWrap* unwrapSession(napi_env env, napi_value receiver) {
  SessionWrap* session = nullptr;
  if (napi_unwrap(env, receiver, reinterpret_cast<void**>(&session)) != napi_ok || !session) {
    napi_throw_type_error(env, nullptr, "invalid Windows audio session");
    return nullptr;
  }
  return session;
}

void executeStart(napi_env, void* data) {
  auto* work = static_cast<StartWork*>(data);
  work->succeeded = work->session->session->start(&work->error);
}

void completeStart(napi_env env, napi_status status, void* data) {
  auto* work = static_cast<StartWork*>(data);
  bool succeeded = work->succeeded && status == napi_ok;
  if (!succeeded) {
    if (work->error.empty()) work->error = L"WASAPI startup work did not complete";
    napi_value message = createWideString(env, work->error);
    napi_value error = nullptr;
    if (!message || napi_create_error(env, nullptr, message, &error) != napi_ok) {
      napi_value fallback = nullptr;
      napi_create_string_utf8(env, "WASAPI startup failed", NAPI_AUTO_LENGTH, &fallback);
      napi_create_error(env, nullptr, fallback, &error);
    }
    napi_reject_deferred(env, work->deferred, error);
  } else {
    napi_value receiver = nullptr;
    SessionWrap* session = nullptr;
    if (napi_get_reference_value(env, work->receiver, &receiver) == napi_ok &&
        napi_unwrap(env, receiver, reinterpret_cast<void**>(&session)) == napi_ok && session) {
      const auto snapshot = session->session->snapshot();
      napi_value value = createSnapshot(env, snapshot);
      if (value) {
        napi_resolve_deferred(env, work->deferred, value);
      } else {
        napi_value message = nullptr;
        napi_value error = nullptr;
        napi_create_string_utf8(env, "Could not serialize WASAPI negotiation", NAPI_AUTO_LENGTH, &message);
        napi_create_error(env, nullptr, message, &error);
        napi_reject_deferred(env, work->deferred, error);
      }
    } else {
      napi_value message = nullptr;
      napi_value error = nullptr;
      napi_create_string_utf8(env, "Windows audio session was released during startup", NAPI_AUTO_LENGTH, &message);
      napi_create_error(env, nullptr, message, &error);
      napi_reject_deferred(env, work->deferred, error);
    }
  }
  if (work->receiver) napi_delete_reference(env, work->receiver);
  if (work->work) napi_delete_async_work(env, work->work);
  delete work;
}

napi_value startSession(napi_env env, napi_callback_info info) {
  napi_value receiver = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, &receiver, nullptr) != napi_ok) return nullptr;
  SessionWrap* session = unwrapSession(env, receiver);
  if (!session) return nullptr;

  napi_value promise = nullptr;
  napi_deferred deferred = nullptr;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return nullptr;
  auto* work = new (std::nothrow) StartWork();
  if (!work) {
    napi_throw_error(env, nullptr, "could not allocate WASAPI startup work");
    return nullptr;
  }
  work->deferred = deferred;
  work->session = session;
  if (napi_create_reference(env, receiver, 1, &work->receiver) != napi_ok) {
    delete work;
    napi_throw_error(env, nullptr, "could not retain WASAPI session during startup");
    return nullptr;
  }
  napi_value resourceName = nullptr;
  if (napi_create_string_utf8(env, "kyx-wasapi-start", NAPI_AUTO_LENGTH, &resourceName) != napi_ok ||
      napi_create_async_work(env, nullptr, resourceName, executeStart, completeStart, work, &work->work) != napi_ok ||
      napi_queue_async_work(env, work->work) != napi_ok) {
    if (work->work) napi_delete_async_work(env, work->work);
    napi_delete_reference(env, work->receiver);
    delete work;
    napi_throw_error(env, nullptr, "could not queue WASAPI startup work");
    return nullptr;
  }
  return promise;
}

napi_value stopSession(napi_env env, napi_callback_info info) {
  napi_value receiver = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, &receiver, nullptr) != napi_ok) return nullptr;
  SessionWrap* session = unwrapSession(env, receiver);
  if (!session) return nullptr;
  session->session->stop();
  napi_value undefined = nullptr;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value readCapture(napi_env env, napi_callback_info info) {
  std::size_t argc = 1;
  napi_value argv[1]{};
  napi_value receiver = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, &receiver, nullptr) != napi_ok || argc != 1) {
    napi_throw_type_error(env, nullptr, "readCapture requires a bounded maxFrames argument");
    return nullptr;
  }
  SessionWrap* session = unwrapSession(env, receiver);
  if (!session) return nullptr;
  std::uint32_t maxFrames = 0;
  if (!getUnsignedInteger(env, argv[0], session->ringCapacityFrames, &maxFrames,
                          "maxFrames must be within the ring capacity") || maxFrames == 0) {
    if (maxFrames == 0) napi_throw_type_error(env, nullptr, "maxFrames must be positive");
    return nullptr;
  }

  const std::size_t available = std::min<std::size_t>(session->session->captureQueuedFrames(), maxFrames);
  const std::size_t sampleCount = available * session->inputChannels;
  napi_value arrayBuffer = nullptr;
  void* bufferData = nullptr;
  if (napi_create_arraybuffer(env, sampleCount * sizeof(float), &bufferData, &arrayBuffer) != napi_ok)
    return nullptr;
  const std::size_t frames = available == 0 ? 0 : session->session->readCapture(static_cast<float*>(bufferData), available);
  napi_value samples = nullptr;
  if (napi_create_typedarray(env, napi_float32_array, frames * session->inputChannels, arrayBuffer, 0, &samples) != napi_ok)
    return nullptr;
  napi_value result = nullptr;
  if (napi_create_object(env, &result) != napi_ok || !setNumber(env, result, "frames", frames) ||
      napi_set_named_property(env, result, "samples", samples) != napi_ok)
    return nullptr;
  return result;
}

napi_value readCaptureInto(napi_env env, napi_callback_info info) {
  std::size_t argc = 1;
  napi_value argv[1]{};
  napi_value receiver = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, &receiver, nullptr) != napi_ok || argc != 1) {
    napi_throw_type_error(env, nullptr, "readCaptureInto requires one bounded Float32Array");
    return nullptr;
  }
  SessionWrap* session = unwrapSession(env, receiver);
  if (!session) return nullptr;
  bool isTypedArray = false;
  napi_typedarray_type arrayType = napi_uint8_array;
  std::size_t length = 0;
  void* data = nullptr;
  if (napi_is_typedarray(env, argv[0], &isTypedArray) != napi_ok || !isTypedArray ||
      napi_get_typedarray_info(env, argv[0], &arrayType, &length, &data, nullptr, nullptr) != napi_ok ||
      arrayType != napi_float32_array || !data || session->inputChannels == 0 || length == 0 ||
      length % session->inputChannels != 0) {
    napi_throw_type_error(env, nullptr, "capture target must be an interleaved Float32Array");
    return nullptr;
  }
  const std::size_t maxFrames = length / session->inputChannels;
  if (maxFrames > session->ringCapacityFrames) {
    napi_throw_range_error(env, nullptr, "capture target exceeds the native ring capacity");
    return nullptr;
  }
  const std::size_t available = std::min<std::size_t>(session->session->captureQueuedFrames(), maxFrames);
  const std::size_t frames = available == 0 ? 0 : session->session->readCapture(static_cast<float*>(data), available);
  napi_value result = nullptr;
  if (napi_create_uint32(env, static_cast<std::uint32_t>(frames), &result) != napi_ok) return nullptr;
  return result;
}

napi_value writeRender(napi_env env, napi_callback_info info) {
  std::size_t argc = 1;
  napi_value argv[1]{};
  napi_value receiver = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, &receiver, nullptr) != napi_ok || argc != 1) {
    napi_throw_type_error(env, nullptr, "writeRender requires one Float32Array");
    return nullptr;
  }
  SessionWrap* session = unwrapSession(env, receiver);
  if (!session) return nullptr;
  bool isTypedArray = false;
  napi_valuetype type = napi_undefined;
  napi_typedarray_type arrayType = napi_uint8_array;
  std::size_t length = 0;
  void* data = nullptr;
  if (napi_is_typedarray(env, argv[0], &isTypedArray) != napi_ok || !isTypedArray ||
      napi_get_typedarray_info(env, argv[0], &arrayType, &length, &data, nullptr, nullptr) != napi_ok ||
      arrayType != napi_float32_array || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object ||
      session->outputChannels == 0 || length % session->outputChannels != 0) {
    napi_throw_type_error(env, nullptr, "render PCM must be interleaved Float32Array frames");
    return nullptr;
  }
  const std::size_t frames = length / session->outputChannels;
  const bool accepted = session->session->writeRender(static_cast<const float*>(data), frames);
  napi_value result = nullptr;
  if (napi_get_boolean(env, accepted, &result) != napi_ok) return nullptr;
  return result;
}

napi_value getSnapshot(napi_env env, napi_callback_info info) {
  napi_value receiver = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, &receiver, nullptr) != napi_ok) return nullptr;
  SessionWrap* session = unwrapSession(env, receiver);
  return session ? createSnapshot(env, session->session->snapshot()) : nullptr;
}

napi_value createSession(napi_env env, napi_callback_info info) {
  std::size_t argc = 1;
  napi_value argv[1]{};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    napi_throw_type_error(env, nullptr, "createSession requires one request object");
    return nullptr;
  }
  SharedModeDuplexRequest request;
  if (!parseRequest(env, argv[0], &request)) return nullptr;

  napi_value object = nullptr;
  SessionWrap* session = nullptr;
  try {
    session = new SessionWrap();
    session->inputChannels = static_cast<std::uint32_t>(request.inputChannelMap.size());
    session->outputChannels = static_cast<std::uint32_t>(request.outputChannelMap.size());
    session->periodFrames = request.periodFrames;
    session->ringCapacityFrames = request.ringCapacityFrames;
    session->session = std::make_unique<WasapiSharedDuplexSession>(std::move(request));
    if (napi_create_object(env, &object) != napi_ok) throw std::bad_alloc();
    napi_property_descriptor properties[] = {
        {"start", nullptr, startSession, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stop", nullptr, stopSession, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"readCapture", nullptr, readCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"readCaptureInto", nullptr, readCaptureInto, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"writeRender", nullptr, writeRender, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"snapshot", nullptr, getSnapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    if (napi_define_properties(env, object, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok ||
        napi_wrap(env, object, session, finalizeSession, nullptr, nullptr) != napi_ok) {
      delete session;
      return nullptr;
    }
    return object;
  } catch (...) {
    delete session;
    napi_throw_error(env, nullptr, "could not create native WASAPI session");
    return nullptr;
  }
}

napi_value probeSharedFloat32View(napi_env env, napi_callback_info info) {
  std::size_t argc = 1;
  napi_value argv[1]{};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    napi_throw_type_error(env, nullptr, "probeSharedFloat32View requires one Float32Array over SharedArrayBuffer");
    return nullptr;
  }

  bool isTypedArray = false;
  napi_typedarray_type arrayType = napi_uint8_array;
  std::size_t length = 0;
  void* data = nullptr;
  napi_value backingBuffer = nullptr;
  if (napi_is_typedarray(env, argv[0], &isTypedArray) != napi_ok || !isTypedArray ||
      napi_get_typedarray_info(env, argv[0], &arrayType, &length, &data, &backingBuffer, nullptr) != napi_ok ||
      arrayType != napi_float32_array || !data || length < 1 || length > 4096) {
    napi_throw_type_error(env, nullptr, "probe view must be a bounded Float32Array");
    return nullptr;
  }

  napi_value global = nullptr;
  napi_value sharedArrayBufferConstructor = nullptr;
  bool isSharedArrayBuffer = false;
  if (napi_get_global(env, &global) != napi_ok ||
      napi_get_named_property(env, global, "SharedArrayBuffer", &sharedArrayBufferConstructor) != napi_ok ||
      napi_instanceof(env, backingBuffer, sharedArrayBufferConstructor, &isSharedArrayBuffer) != napi_ok ||
      !isSharedArrayBuffer) {
    napi_throw_type_error(env, nullptr, "probe view must be backed by SharedArrayBuffer");
    return nullptr;
  }

  auto* samples = static_cast<float*>(data);
  for (std::size_t index = 0; index < length; ++index) samples[index] = samples[index] * 2.0F + 1.0F;
  napi_value result = nullptr;
  if (napi_create_uint32(env, static_cast<std::uint32_t>(length), &result) != napi_ok) return nullptr;
  return result;
}

napi_value initialize(napi_env env, napi_value exports) {
  napi_value factory = nullptr;
  if (napi_create_function(env, "createSession", NAPI_AUTO_LENGTH, createSession, nullptr, &factory) != napi_ok ||
      napi_set_named_property(env, exports, "createSession", factory) != napi_ok)
    return nullptr;
  napi_value sharedBufferProbe = nullptr;
  if (napi_create_function(env, "probeSharedFloat32View", NAPI_AUTO_LENGTH, probeSharedFloat32View, nullptr,
                           &sharedBufferProbe) != napi_ok ||
      napi_set_named_property(env, exports, "probeSharedFloat32View", sharedBufferProbe) != napi_ok)
    return nullptr;
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
