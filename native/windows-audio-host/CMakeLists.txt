cmake_minimum_required(VERSION 3.24)
project(kyx_windows_audio_host LANGUAGES CXX)

include(CTest)

if(NOT WIN32)
  message(FATAL_ERROR "The KYX Windows audio host requires Windows WASAPI.")
endif()

add_library(kyx_windows_audio_channel_map INTERFACE)
target_include_directories(kyx_windows_audio_channel_map INTERFACE ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_features(kyx_windows_audio_channel_map INTERFACE cxx_std_17)

add_library(kyx-windows-audio-shared-duplex STATIC wasapi-shared-duplex.cpp)
target_compile_features(kyx-windows-audio-shared-duplex PUBLIC cxx_std_17)
target_compile_definitions(kyx-windows-audio-shared-duplex PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(kyx-windows-audio-shared-duplex PRIVATE /W4 /permissive-)
target_link_libraries(kyx-windows-audio-shared-duplex PUBLIC kyx_windows_audio_channel_map PRIVATE avrt ole32 uuid)

if(BUILD_TESTING)
  add_executable(kyx-windows-audio-channel-map-tests channel-map-test.cpp)
  target_link_libraries(kyx-windows-audio-channel-map-tests PRIVATE kyx_windows_audio_channel_map)
  target_compile_options(kyx-windows-audio-channel-map-tests PRIVATE /W4 /permissive-)
  add_test(NAME windows-audio-channel-map COMMAND kyx-windows-audio-channel-map-tests)

  add_executable(kyx-windows-audio-spsc-ring-tests spsc-float-ring-test.cpp)
  target_compile_features(kyx-windows-audio-spsc-ring-tests PRIVATE cxx_std_17)
  target_compile_options(kyx-windows-audio-spsc-ring-tests PRIVATE /W4 /permissive-)
  add_test(NAME windows-audio-spsc-ring COMMAND kyx-windows-audio-spsc-ring-tests)

  add_executable(kyx-windows-audio-period-tests shared-periods-test.cpp)
  target_compile_features(kyx-windows-audio-period-tests PRIVATE cxx_std_17)
  target_compile_options(kyx-windows-audio-period-tests PRIVATE /W4 /permissive-)
  add_test(NAME windows-audio-shared-periods COMMAND kyx-windows-audio-period-tests)

  add_executable(kyx-windows-audio-duplex-tests wasapi-shared-duplex-test.cpp)
  target_compile_features(kyx-windows-audio-duplex-tests PRIVATE cxx_std_17)
  target_compile_options(kyx-windows-audio-duplex-tests PRIVATE /W4 /permissive-)
  target_link_libraries(kyx-windows-audio-duplex-tests PRIVATE kyx-windows-audio-shared-duplex)
  add_test(NAME windows-audio-duplex-request COMMAND kyx-windows-audio-duplex-tests)
endif()
