#include "shared-period-selection.h"

#include <cstdint>
#include <limits>

int main() {
  std::uint32_t selected = 0;
  if (!selectLowestSupportedSharedPeriod(480, 480, 480, &selected) || selected != 480) return 1;
  if (!selectLowestSupportedSharedPeriod(128, 129, 512, &selected) || selected != 256) return 2;
  if (selectLowestSupportedSharedPeriod(512, 513, 1000, &selected)) return 3;
  if (selectLowestSupportedSharedPeriod(0, 1, 1000, &selected)) return 4;
  if (selectLowestSupportedSharedPeriod(1, 0, 1000, &selected)) return 5;
  if (selectLowestSupportedSharedPeriod(4, 16, 15, &selected)) return 6;
  if (selectLowestSupportedSharedPeriod(std::numeric_limits<std::uint32_t>::max() / 2 + 1,
                                        std::numeric_limits<std::uint32_t>::max(),
                                        std::numeric_limits<std::uint32_t>::max(), &selected)) {
    return 7;
  }
  if (selectLowestSupportedSharedPeriod(1, 1, 1, nullptr)) return 8;
  return 0;
}
