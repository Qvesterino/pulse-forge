# KYX CLAP audio hosting (ADR 0016) — tone fixture plugin + player host.
#
#   npm run build:clap-probe        # also builds this tree (shared SDK include)
#
# Produces:
#   build/Release/clap-player.exe      minimal hosting path: instantiate ->
#                                      activate -> process cycles -> ADR 0018
#                                      frames on stdout
#   build/Release/clap-tone.clap       deterministic 440 Hz tone plugin —
#                                      the acceptance fixture (renamed DLL)
#
# Reuses the vendored MIT CLAP headers from ../clap-probe/clap.
cmake_minimum_required(VERSION 3.20)
project(kyx-clap-host C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

set(CLAP_INCLUDE ${CMAKE_CURRENT_SOURCE_DIR}/../clap-probe)
if(NOT EXISTS "${CLAP_INCLUDE}/clap/clap.h")
    message(WARNING "CLAP SDK headers missing — run scripts/vendor-clap.mjs first. Skipping clap-host targets.")
    return()
endif()

add_executable(clap-player clap-player.c)
target_include_directories(clap-player PRIVATE ${CLAP_INCLUDE})

add_library(clap-tone SHARED clap-tone.c)
set_target_properties(clap-tone PROPERTIES PREFIX "")
target_include_directories(clap-tone PRIVATE ${CLAP_INCLUDE})
add_custom_command(TARGET clap-tone POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
    $<TARGET_FILE:clap-tone> $<TARGET_FILE_DIR:clap-tone>/clap-tone.clap)
