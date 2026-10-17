#pragma once

#include <string>

namespace kyx::windows_audio {

/** Match only the requested selector type; opaque IDs never fall back to a name. */
inline bool endpointMatchesSelector(bool selectById, const std::wstring &selector,
                                    const std::wstring &candidateId,
                                    const std::wstring &candidateName) {
  return !selector.empty() &&
         (selectById ? candidateId == selector : candidateName == selector);
}

} // namespace kyx::windows_audio
