# KYX VST3 probe (ADR 0035)
#
#   cmake -S native/vst3-probe -B native/vst3-probe/build
#   cmake --build native/vst3-probe/build --config Release
#
# Produces:
#   build/Release/vst3-probe.exe    out-of-process structural scanner
#
# Wave 1 requires ONLY the C toolchain — no Steinberg SDK is linked (the
# structural scan never loads plugin code). Factory enumeration and audio
# processing (ADR 0035 Waves 2–3) may add a pinned VST SDK 3.8+ dependency;
# retain the applicable MIT/BSD-like notices as recorded in ADR 0035.
cmake_minimum_required(VERSION 3.20)
project(kyx-vst3-probe C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_executable(vst3-probe vst3-probe.c)
target_include_directories(vst3-probe PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

if (MSVC)
  target_compile_definitions(vst3-probe PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()

# Structural fixture: a minimal .vst3 BUNDLE (plain directories + placeholder
# module files — the Wave 1 probe inspects layout, it never loads binaries).
set(FIXTURE_BUNDLE ${CMAKE_CURRENT_SOURCE_DIR}/fixture/Fixture.vst3)
add_custom_command(
  OUTPUT ${FIXTURE_BUNDLE}/Contents/x86_64-win/Fixture.vst3
  COMMAND ${CMAKE_COMMAND} -E make_directory ${FIXTURE_BUNDLE}/Contents/x86_64-win
  COMMAND ${CMAKE_COMMAND} -E echo "placeholder module binary" > ${FIXTURE_BUNDLE}/Contents/x86_64-win/Fixture.vst3
  COMMENT "Building .vst3 bundle fixture"
)
add_custom_target(vst3-fixture DEPENDS ${FIXTURE_BUNDLE}/Contents/x86_64-win/Fixture.vst3)
add_dependencies(vst3-probe vst3-fixture)
