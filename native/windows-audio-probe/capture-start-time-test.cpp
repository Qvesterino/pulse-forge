#include "capture-start-time.h"

#include <cmath>

int main() {
  double milliseconds = 0.0;
  if (!qpcRelativeMilliseconds(100'050'000, 100'000'000, 10'000'000, &milliseconds)) return 1;
  if (std::abs(milliseconds - 5.0) > 0.000001) return 2;

  if (!qpcRelativeMilliseconds(99'950'000, 100'000'000, 10'000'000, &milliseconds)) return 3;
  if (std::abs(milliseconds + 5.0) > 0.000001) return 4;

  if (qpcRelativeMilliseconds(100'000'000, 100'000'000, 0, &milliseconds)) return 5;
  if (qpcRelativeMilliseconds(100'000'000, -1, 10'000'000, &milliseconds)) return 6;
  if (qpcRelativeMilliseconds(100'000'000, 100'000'000, 10'000'000, nullptr)) return 7;
  return 0;
}
