# pcm-gen — reference PCM source for the framed pipe transport (ADR 0018).
#
#   npm run build:pcm-host
#
# Produces build/Release/pcm-gen.exe: a deterministic sine source that speaks
# the ADR 0018 frame protocol, so the pipe stack (Node parser, ring buffer,
# throughput acceptance) is verifiable without audio hardware. The wave-2
# ASIO streaming host replaces the generator with ASIO callbacks and emits
# the exact same frames.
cmake_minimum_required(VERSION 3.20)
project(kyx-pcm-host C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_executable(pcm-gen pcm-gen.c)
target_link_libraries(pcm-gen PRIVATE winmm)
