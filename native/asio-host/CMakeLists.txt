# KYX ASIO wave 2.5 — streaming host + fixture driver (ADR 0017/0018)
#
#   npm run vendor:asio     # SDK headers + sample-driver sources (license gate)
#   npm run build:asio-probe
#
# Targets (all gated on the vendored SDK tree):
#   asio-probe      discovery probe (wave 1)
#   asio-fixture    the SDK SAMPLE driver built as a 64-bit DLL — a virtual
#                   device that paces buffers in realtime and synthesizes a
#                   tone; lets the streaming path be acceptance-tested with
#                   zero ASIO hardware
#   asio-host       the streaming host: driver buffers → ADR 0018 PCM frames
#                   on stdout (the transport pcm-gen proved out)
cmake_minimum_required(VERSION 3.20)
project(kyx-asio-host CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/asio-sdk/common/iasiodrv.h")
    message(WARNING
        "ASIO SDK missing — run `npm run vendor:asio` first (Steinberg "
        "license: fetch per machine, not redistributable). Skipping all targets.")
    return()
endif()

# Every machine here uses IEEE-754 doubles; without the define the SDK headers
# fall back to a struct-wrapped float type and the ABI diverges.
add_compile_definitions(IEEE754_64FLOAT=1)

add_executable(asio-probe asio-probe.cpp)
target_include_directories(asio-probe PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/asio-sdk/common)
target_link_libraries(asio-probe PRIVATE ole32 advapi32 user32)

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/asio-sdk/driver/asiosample/asiosmpl.cpp")
    set(SDK ${CMAKE_CURRENT_SOURCE_DIR}/asio-sdk)
    add_library(asio-fixture SHARED
        ${SDK}/common/combase.cpp
        ${SDK}/common/dllentry.cpp
        ${SDK}/common/register.cpp
        ${SDK}/common/debugmessage.cpp
        ${SDK}/driver/asiosample/asiosmpl.cpp
        ${SDK}/driver/asiosample/wintimer.cpp
        ${SDK}/driver/asiosample/asiosample.def
    )
    set_target_properties(asio-fixture PROPERTIES PREFIX "")
    target_include_directories(asio-fixture PRIVATE
        ${SDK}/common ${SDK}/driver/asiosample)
    # wintimer.cpp reads timeGetTime (winmm).
    target_link_libraries(asio-fixture PRIVATE winmm)

    add_executable(asio-host asio-host.cpp)
    target_include_directories(asio-host PRIVATE ${SDK}/common)
    target_link_libraries(asio-host PRIVATE ole32 advapi32 winmm)
endif()
