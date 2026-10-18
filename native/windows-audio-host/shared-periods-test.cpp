#include "shared-periods.h"

#include <cstdlib>
#include <iostream>
#include <limits>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << "\n";
    std::exit(1);
  }
}

void periodMustBeWithinRangeAndFundamentalAligned() {
  using kyx::windows_audio::SharedModePeriodRange;
  using kyx::windows_audio::isLegalSharedModePeriod;
  const SharedModePeriodRange range{48, 448, 4};
  require(isLegalSharedModePeriod(range, 48), "minimum aligned period was rejected");
  require(isLegalSharedModePeriod(range, 128), "interior aligned period was rejected");
  require(isLegalSharedModePeriod(range, 448), "maximum aligned period was rejected");
  require(!isLegalSharedModePeriod(range, 47), "period below the range was accepted");
  require(!isLegalSharedModePeriod(range, 449), "period above the range was accepted");
  require(!isLegalSharedModePeriod(range, 98), "non-fundamental-aligned period was accepted");
}

void duplexPeriodRequiresACommonMultipleForBothEndpoints() {
  using kyx::windows_audio::SharedModePeriodRange;
  using kyx::windows_audio::intersectSharedModePeriods;
  using kyx::windows_audio::isLegalSharedModePeriod;
  SharedModePeriodRange combined{};
  require(intersectSharedModePeriods({48, 960, 4}, {96, 768, 6}, &combined),
          "overlapping endpoint period ranges had no computed intersection");
  require(combined.minFrames == 96 && combined.maxFrames == 768 && combined.fundamentalFrames == 12,
          "duplex range did not preserve bounds and least common multiple");
  require(isLegalSharedModePeriod(combined, 108), "common legal duplex period was rejected");
  require(!isLegalSharedModePeriod(combined, 104), "period legal for only one endpoint was accepted");
}

void emptyAlignedIntersectionsAreRejected() {
  using kyx::windows_audio::SharedModePeriodRange;
  using kyx::windows_audio::intersectSharedModePeriods;
  SharedModePeriodRange combined{};
  require(!intersectSharedModePeriods({49, 51, 4}, {50, 52, 6}, &combined),
          "overlapping numeric range with no common aligned period was accepted");
  require(!intersectSharedModePeriods({1, 100, 0}, {1, 100, 1}, &combined),
          "zero fundamental period was accepted");
  require(!intersectSharedModePeriods({1, 10, 1}, {11, 20, 1}, &combined),
          "non-overlapping endpoint ranges were accepted");
}

void invalidOutputAndLcmOverflowAreRejected() {
  using kyx::windows_audio::SharedModePeriodRange;
  using kyx::windows_audio::intersectSharedModePeriods;
  SharedModePeriodRange combined{};
  require(!intersectSharedModePeriods({1, 100, 1}, {1, 100, 1}, nullptr),
          "null duplex period output was accepted");
  require(!intersectSharedModePeriods({1, std::numeric_limits<std::uint32_t>::max(), 65'521},
                                      {1, std::numeric_limits<std::uint32_t>::max(), 99'991}, &combined),
          "least-common-multiple overflow was accepted");
}

}  // namespace

int main() {
  periodMustBeWithinRangeAndFundamentalAligned();
  duplexPeriodRequiresACommonMultipleForBothEndpoints();
  emptyAlignedIntersectionsAreRejected();
  invalidOutputAndLcmOverflowAreRejected();
  std::cout << "WASAPI shared periods: 4/4 checks passed\n";
  return 0;
}
