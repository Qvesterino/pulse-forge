cmake_minimum_required(VERSION 3.27)

set(CMAKE_OSX_DEPLOYMENT_TARGET "14.0" CACHE STRING "Minimum macOS version" FORCE)
set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "MRT2 requires Apple Silicon" FORCE)

project(kyx_mrt2_host LANGUAGES CXX OBJCXX)

if(NOT APPLE OR NOT CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
  message(FATAL_ERROR "KYX MRT2 native host requires macOS on Apple Silicon")
endif()

set(MAGENTA_REALTIME_SOURCE "" CACHE PATH "Path to the pinned magenta-realtime v2.0.3 checkout")
if(NOT MAGENTA_REALTIME_SOURCE OR NOT EXISTS "${MAGENTA_REALTIME_SOURCE}/CMakeLists.txt")
  message(FATAL_ERROR "Set MAGENTA_REALTIME_SOURCE to a magenta-realtime v2.0.3 source checkout")
endif()

# Upstream pins MLX, TensorFlow Lite and SentencePiece and defines
# magentart::core. Build only our target; upstream examples and UI are not
# dependencies of this application.
add_subdirectory("${MAGENTA_REALTIME_SOURCE}" "${CMAKE_BINARY_DIR}/magenta-realtime")

add_executable(kyx-mrt2-host main.mm)
target_compile_features(kyx-mrt2-host PRIVATE cxx_std_20)
target_compile_options(kyx-mrt2-host PRIVATE -fobjc-arc)
target_link_libraries(kyx-mrt2-host PRIVATE magentart::core "-framework Foundation")
set_target_properties(kyx-mrt2-host PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"
  MACOSX_BUNDLE OFF
)
