#include "endpoint-json.h"

#include <iostream>
#include <string>
#include <vector>

int main() {
  using kyx::windows_audio::EndpointRecord;
  using kyx::windows_audio::EndpointMixFormat;
  using kyx::windows_audio::SharedPeriods;
  using kyx::windows_audio::serializeEndpointListJson;

  const std::vector<EndpointRecord> endpoints = {
      {L"endpoint\\capture\"id", L"Volt \"276\"\n\u00c4udio", L"capture",
       L"active", true,
       EndpointMixFormat{2, 48000, 32, 24, false, 3, SharedPeriods{480, 480, 480, 1440}}},
      {L"render-id", L"Monitor\x01 Out", L"render", L"unplugged", false},
  };
  std::string json;
  if (!serializeEndpointListJson(endpoints, &json))
    return 1;

  const std::string expected =
      "{\"schemaVersion\":2,\"endpoints\":[{\"id\":"
      "\"endpoint\\\\capture\\\"id\","
      "\"name\":\"Volt "
      "\\\"276\\\"\\n\xc3\x84udio\",\"flow\":\"capture\",\"state\":\"active\","
      "\"mixFormat\":{\"channels\":2,\"sampleRateHz\":48000,\"bitsPerSample\":32,"
      "\"validBitsPerSample\":24,"
      "\"floatingPoint\":false,\"channelMask\":3,\"sharedPeriods\":{\"defaultFrames\":480,"
      "\"fundamentalFrames\":480,\"minFrames\":480,\"maxFrames\":1440}},"
      "\"isDefaultConsole\":true},{\"id\":\"render-id\",\"name\":"
      "\"Monitor\\u0001 Out\","
      "\"flow\":\"render\",\"state\":\"unplugged\",\"mixFormat\":null,\"isDefaultConsole\":false}]"
      "}";
  if (json != expected) {
    std::cerr << "endpoint JSON escaping changed\n" << json << '\n';
    return 2;
  }

  std::string emptyJson;
  if (!serializeEndpointListJson({}, &emptyJson) ||
      emptyJson != "{\"schemaVersion\":2,\"endpoints\":[]}")
    return 3;

  if (serializeEndpointListJson(endpoints, nullptr))
    return 4;
  std::cout << "endpoint JSON serialization checks passed\n";
  return 0;
}
