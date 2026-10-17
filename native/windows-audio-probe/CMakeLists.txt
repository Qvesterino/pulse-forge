cmake_minimum_required(VERSION 3.24)
project(kyx_windows_audio_probe LANGUAGES CXX)

include(CTest)

if(NOT WIN32)
  message(FATAL_ERROR "The KYX Windows audio probe requires Windows WASAPI.")
endif()

add_executable(kyx-windows-audio-probe main.cpp)
target_compile_features(kyx-windows-audio-probe PRIVATE cxx_std_17)
target_compile_definitions(kyx-windows-audio-probe PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(kyx-windows-audio-probe PRIVATE /W4 /permissive-)
target_link_libraries(kyx-windows-audio-probe PRIVATE avrt ole32 propsys uuid)

if(BUILD_TESTING)
  add_executable(kyx-windows-audio-probe-period-tests shared-period-selection-test.cpp)
  target_compile_features(kyx-windows-audio-probe-period-tests PRIVATE cxx_std_17)
  target_compile_options(kyx-windows-audio-probe-period-tests PRIVATE /W4 /permissive-)
  add_test(NAME shared-period-selection COMMAND kyx-windows-audio-probe-period-tests)

  add_executable(kyx-windows-audio-probe-capture-time-tests capture-start-time-test.cpp)
  target_compile_features(kyx-windows-audio-probe-capture-time-tests PRIVATE cxx_std_17)
  target_compile_options(kyx-windows-audio-probe-capture-time-tests PRIVATE /W4 /permissive-)
  add_test(NAME capture-start-time COMMAND kyx-windows-audio-probe-capture-time-tests)

  add_executable(kyx-windows-audio-probe-loopback-correlation-tests loopback-correlation-test.cpp)
  target_compile_features(kyx-windows-audio-probe-loopback-correlation-tests PRIVATE cxx_std_17)
  target_compile_options(kyx-windows-audio-probe-loopback-correlation-tests PRIVATE /W4 /permissive-)
  add_test(NAME loopback-correlation COMMAND kyx-windows-audio-probe-loopback-correlation-tests)

  add_executable(kyx-windows-audio-probe-endpoint-json-tests endpoint-json-test.cpp)
  target_compile_features(kyx-windows-audio-probe-endpoint-json-tests PRIVATE cxx_std_17)
  target_compile_definitions(
    kyx-windows-audio-probe-endpoint-json-tests PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_compile_options(kyx-windows-audio-probe-endpoint-json-tests PRIVATE /W4 /permissive-)
  target_link_libraries(kyx-windows-audio-probe-endpoint-json-tests PRIVATE ole32)
  add_test(NAME endpoint-json COMMAND kyx-windows-audio-probe-endpoint-json-tests)

  add_executable(kyx-windows-audio-probe-endpoint-selection-tests endpoint-selection-test.cpp)
  target_compile_features(kyx-windows-audio-probe-endpoint-selection-tests PRIVATE cxx_std_17)
  target_compile_options(kyx-windows-audio-probe-endpoint-selection-tests PRIVATE /W4 /permissive-)
  add_test(NAME endpoint-selection COMMAND kyx-windows-audio-probe-endpoint-selection-tests)
endif()
