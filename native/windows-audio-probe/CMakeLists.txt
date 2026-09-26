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
endif()
