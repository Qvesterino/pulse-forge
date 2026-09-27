# KYX CLAP probe + test fixtures (ADR 0016)
#
#   cmake -S native/clap-probe -B native/clap-probe/build
#   cmake --build native/clap-probe/build --config Release
#
# Produces:
#   build/Release/clap-probe.exe           out-of-process plugin scanner
#   build/Release/clap-fixture.clap        valid CLAP fixture (test DLL renamed)
#   build/Release/clap-fixture-empty.clap  DLL without clap_entry (negative case)
#
# Requires only the C toolchain + the vendored MIT headers in clap/ — no
# third-party binaries are linked.
cmake_minimum_required(VERSION 3.20)
project(kyx-clap-probe C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_executable(clap-probe clap-probe.c)
target_include_directories(clap-probe PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

# One-plugin valid CLAP. No PREFIX so the DLL name is clean; the POST_BUILD
# copy gives it the .clap extension the scanner looks for (the bytes stay a
# plain DLL — that is exactly what a .clap file is on Windows).
add_library(clap-fixture SHARED fixture-plugin.c)
set_target_properties(clap-fixture PROPERTIES PREFIX "")
add_custom_command(TARGET clap-fixture POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
    $<TARGET_FILE:clap-fixture> $<TARGET_FILE_DIR:clap-fixture>/clap-fixture.clap)

add_library(clap-fixture-empty SHARED fixture-empty.c)
set_target_properties(clap-fixture-empty PROPERTIES PREFIX "")
add_custom_command(TARGET clap-fixture-empty POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
    $<TARGET_FILE:clap-fixture-empty> $<TARGET_FILE_DIR:clap-fixture-empty>/clap-fixture-empty.clap)
