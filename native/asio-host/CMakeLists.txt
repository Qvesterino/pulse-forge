# KYX ASIO probe (ADR 0017) — builds ONLY when the Steinberg SDK headers are
# present (scripts/vendor-asio.mjs fetches them per machine; the license does
# not permit redistribution, so this tree stays out of git).
#
#   npm run vendor:asio     # fetch headers (accepts Steinberg terms)
#   npm run build:asio-probe
#
# Produces build/Release/asio-probe.exe: enumerates installed ASIO drivers
# over COM (IASIO) and prints one bounded JSON line each. Never streams.
cmake_minimum_required(VERSION 3.20)
project(kyx-asio-probe CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/asio-sdk/common/iasiodrv.h")
    message(WARNING
        "ASIO SDK headers missing — run `npm run vendor:asio` first (Steinberg "
        "license: fetch per machine, not redistributable). Skipping asio-probe.")
    return()
endif()

add_executable(asio-probe asio-probe.cpp)
target_include_directories(asio-probe PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/asio-sdk/common)
# Every machine that can run this probe uses IEEE-754 doubles; without the
# define the SDK headers fall back to a struct-wrapped float type meant for
# ancient DSP hosts, and the ABI diverges.
target_compile_definitions(asio-probe PRIVATE IEEE754_64FLOAT=1)
target_link_libraries(asio-probe PRIVATE ole32 advapi32 user32)
