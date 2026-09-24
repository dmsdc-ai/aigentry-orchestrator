# Package-owned native storage-provenance helpers.
#
# These are ordinary, self-contained executables. They are NOT Node addons: there
# is no N-API, no node-gyp, no prebuilt download and no ABI coupling to any Node
# release, so a Node upgrade can never silently invalidate them.
#
# Nothing here runs at install time. The build is explicit and opt-in, driven by
# `npm run build:advisor-storage` (scripts/build-advisor-storage.mjs) or by an
# independent CI builder invoking this file directly. A package that ships without
# these binaries still works: the adapter reports `unknown` and production writes
# refuse, which is the correct behaviour in the absence of evidence.
#
# Output goes to native/task-advisor-storage/bin/ with the exact fixed names the
# adapter resolves relative to the package root:
#
#   advisor-storage-provenance-darwin-<arch>
#   advisor-storage-provenance-win32-<arch>.exe
#
# Example (macOS):
#   cmake -S native/task-advisor-storage -B build/advisor-storage \
#         -DCMAKE_BUILD_TYPE=Release
#   cmake --build build/advisor-storage
#
# Example (Windows CI builder):
#   cmake -S native\task-advisor-storage -B build\advisor-storage -A x64
#   cmake --build build\advisor-storage --config Release

cmake_minimum_required(VERSION 3.16)
project(advisor_storage_provenance C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Map the CMake architecture onto the exact `process.arch` token the adapter uses
# to build the helper filename. An unmapped architecture is a hard error rather
# than a differently named binary the adapter would silently fail to find.
if(NOT DEFINED ADVISOR_STORAGE_ARCH)
  if(APPLE AND CMAKE_OSX_ARCHITECTURES)
    set(_raw "${CMAKE_OSX_ARCHITECTURES}")
  else()
    set(_raw "${CMAKE_SYSTEM_PROCESSOR}")
  endif()
  string(TOLOWER "${_raw}" _raw)
  if(_raw MATCHES "arm64|aarch64")
    set(ADVISOR_STORAGE_ARCH "arm64")
  elseif(_raw MATCHES "x86_64|amd64|x64")
    set(ADVISOR_STORAGE_ARCH "x64")
  else()
    message(FATAL_ERROR
      "Unmapped architecture '${_raw}'. Set -DADVISOR_STORAGE_ARCH to the exact "
      "Node process.arch token so the adapter can resolve the helper by name.")
  endif()
endif()

set(_bin "${CMAKE_CURRENT_SOURCE_DIR}/bin")

if(APPLE)
  add_executable(advisor_storage_darwin darwin.c)
  target_compile_options(advisor_storage_darwin PRIVATE -Wall -Wextra -Werror)
  find_library(DISK_ARBITRATION_FRAMEWORK DiskArbitration REQUIRED)
  find_library(CORE_FOUNDATION_FRAMEWORK CoreFoundation REQUIRED)
  target_link_libraries(advisor_storage_darwin
    PRIVATE ${DISK_ARBITRATION_FRAMEWORK} ${CORE_FOUNDATION_FRAMEWORK})
  set_target_properties(advisor_storage_darwin PROPERTIES
    RUNTIME_OUTPUT_NAME "advisor-storage-provenance-darwin-${ADVISOR_STORAGE_ARCH}"
    RUNTIME_OUTPUT_DIRECTORY "${_bin}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${_bin}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${_bin}")

elseif(WIN32)
  add_executable(advisor_storage_windows windows.c)
  # wmain entry point; the helper takes a single wide-character path argument.
  set_target_properties(advisor_storage_windows PROPERTIES
    RUNTIME_OUTPUT_NAME "advisor-storage-provenance-win32-${ADVISOR_STORAGE_ARCH}"
    RUNTIME_OUTPUT_DIRECTORY "${_bin}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${_bin}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${_bin}")
  if(MSVC)
    target_compile_options(advisor_storage_windows PRIVATE /W4 /WX)
    target_link_options(advisor_storage_windows PRIVATE /ENTRY:wmainCRTStartup)
  endif()
  target_link_libraries(advisor_storage_windows PRIVATE kernel32)

else()
  # Linux needs no helper: the adapter reads /proc/self/mountinfo and the selected
  # /sys attributes with ordinary process permissions and no native code at all.
  message(STATUS
    "No native helper is built on this platform; the Linux adapter is pure Node.")
endif()
