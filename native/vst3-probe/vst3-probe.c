/**
 * KYX VST3 probe (ADR 0035) — out-of-process STRUCTURAL scanner for .vst3
 * entries.
 *
 * Wave 1 (this file): classifies a .vst3 entry and enumerates its binary
 * modules WITHOUT loading anything — no Steinberg SDK, no plugin code ever
 * runs here. On Windows a .vst3 entry is a BUNDLE DIRECTORY:
 *
 *   <Name>.vst3/
 *     Contents/x86_64-win/<Name>.vst3   (the module DLL)
 *     Contents/Resources/...            (optional)
 *
 * or, rarely, a single-file module. The probe prints one JSON line per
 * discovered module binary to stdout, then exits. Factory enumeration and
 * audio processing are Waves 2–3 (ADR 0035) and REQUIRE the Steinberg VST3
 * SDK build plus the Steinberg VST3 license agreement before any
 * SDK-linked binary is distributed — the structural scan ships without the
 * SDK on purpose.
 *
 * Usage:   vst3-probe.exe <path-to-.vst3 entry>
 * Stdout:  one JSON object per module binary (UTF-8)
 *            { "path": "<abs>", "arch": "x86_64-win", "bytes": <n> }
 * Stderr:  human diagnostics
 * Exit:    0 = probed (including "no modules found in layout")
 *          2 = not a .vst3 entry (missing extension / no bundle layout)
 *          4 = usage error
 *
 * Windows-only in Wave 1 (mirrors the ADR 0016 platform matrix).
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define EXIT_PROBED 0
#define EXIT_NOT_A_VST3 2
#define EXIT_USAGE 4

#define MAX_PATH_LEN 2048

static void print_json_string(const char *s) {
  fputc('"', stdout);
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    switch (*p) {
    case '"':
      fputs("\\\"", stdout);
      break;
    case '\\':
      fputs("\\\\", stdout);
      break;
    default:
      if (*p < 0x20) {
        fprintf(stdout, "\\u%04x", *p);
      } else {
        fputc(*p, stdout);
      }
    }
  }
  fputc('"', stdout);
}

static int ends_with_vst3_ci(const char *s) {
  size_t len = strlen(s);
  if (len < 5) return 0;
  const char *tail = s + len - 5;
  return (tail[0] == '.' || tail[0] == '.') &&
         tolower((unsigned char)tail[1]) == 'v' && tolower((unsigned char)tail[2]) == 's' &&
         tolower((unsigned char)tail[3]) == 't' && tolower((unsigned char)tail[4]) == '3';
}

/** Enumerate Contents/<arch>/* module binaries of a bundle directory. */
static int scan_bundle(const char *bundlePath) {
  char contents[MAX_PATH_LEN];
  snprintf(contents, sizeof(contents), "%s\\Contents", bundlePath);
  DWORD attrs = GetFileAttributesA(contents);
  if (attrs == INVALID_FILE_ATTRIBUTES || !(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
    return EXIT_NOT_A_VST3; // a bundle without Contents/ is not a v3 bundle
  }
  int found = 0;
  static const char *architectures[] = {"x86_64-win", "arm64-win", "x86-win", NULL};
  for (int a = 0; architectures[a] != NULL; a++) {
    char archDir[MAX_PATH_LEN];
    snprintf(archDir, sizeof(archDir), "%s\\%s", contents, architectures[a]);
    attrs = GetFileAttributesA(archDir);
    if (attrs == INVALID_FILE_ATTRIBUTES || !(attrs & FILE_ATTRIBUTE_DIRECTORY)) continue;
    char pattern[MAX_PATH_LEN];
    snprintf(pattern, sizeof(pattern), "%s\\*.vst3", archDir);
    WIN32_FIND_DATAA data;
    HANDLE find = FindFirstFileA(pattern, &data);
    if (find == INVALID_HANDLE_VALUE) continue;
    do {
      if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
      char modulePath[MAX_PATH_LEN];
      snprintf(modulePath, sizeof(modulePath), "%s\\%s", archDir, data.cFileName);
      unsigned long long bytes =
          ((unsigned long long)data.nFileSizeHigh << 32) | (unsigned long long)data.nFileSizeLow;
      fputs("{\"path\":", stdout);
      print_json_string(modulePath);
      fprintf(stdout, ",\"arch\":\"%s\",\"bytes\":%llu}\n", architectures[a], bytes);
      found = 1;
    } while (FindNextFileA(find, &data));
    FindClose(find);
  }
  return found > 0 ? EXIT_PROBED : EXIT_NOT_A_VST3;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: vst3-probe.exe <path-to-.vst3 entry>\n");
    return EXIT_USAGE;
  }
  const char *entryPath = argv[1];
  DWORD attrs = GetFileAttributesA(entryPath);
  if (attrs == INVALID_FILE_ATTRIBUTES) {
    fprintf(stderr, "path does not exist\n");
    return EXIT_NOT_A_VST3;
  }
  if (!(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
    if (!ends_with_vst3_ci(entryPath)) {
      fprintf(stderr, "not a .vst3 entry\n");
      return EXIT_NOT_A_VST3;
    }
    // Single-file module (legacy layout): one JSON line, no load.
    HANDLE file = CreateFileA(entryPath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    unsigned long long bytes = 0;
    if (file != INVALID_HANDLE_VALUE) {
      LARGE_INTEGER size;
      if (GetFileSizeEx(file, &size)) bytes = (unsigned long long)size.QuadPart;
      CloseHandle(file);
    }
    fputs("{\"path\":", stdout);
    print_json_string(entryPath);
    fprintf(stdout, ",\"arch\":\"single-file\",\"bytes\":%llu}\n", bytes);
    return EXIT_PROBED;
  }
  if (!ends_with_vst3_ci(entryPath)) {
    fprintf(stderr, "not a .vst3 entry\n");
    return EXIT_NOT_A_VST3;
  }
  return scan_bundle(entryPath);
}
