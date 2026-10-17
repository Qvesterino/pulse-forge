#include "endpoint-selection.h"

#include <iostream>

int main() {
  using kyx::windows_audio::endpointMatchesSelector;

  if (!endpointMatchesSelector(true, L"opaque-id-A", L"opaque-id-A",
                               L"Volt Capture"))
    return 1;
  if (endpointMatchesSelector(true, L"Volt Capture", L"opaque-id-A",
                              L"Volt Capture")) {
    std::cerr << "opaque ID selector fell back to a friendly name\n";
    return 2;
  }
  if (endpointMatchesSelector(true, L"opaque-id-a", L"opaque-id-A",
                              L"Volt Capture")) {
    std::cerr << "opaque ID selector stopped using exact matching\n";
    return 3;
  }
  if (!endpointMatchesSelector(false, L"Volt Capture", L"opaque-id-A",
                               L"Volt Capture"))
    return 4;
  if (endpointMatchesSelector(false, L"volt capture", L"opaque-id-A",
                              L"Volt Capture")) {
    std::cerr << "friendly name selector stopped using exact matching\n";
    return 5;
  }
  if (endpointMatchesSelector(true, L"", L"opaque-id-A", L"Volt Capture"))
    return 6;

  std::cout << "exact endpoint selector checks passed\n";
  return 0;
}
