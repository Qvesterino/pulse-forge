#pragma once

#include <windows.h>

#include <string>
#include <vector>

namespace kyx::windows_audio {

struct EndpointRecord {
  std::wstring id;
  std::wstring name;
  std::wstring flow;
  std::wstring state;
  bool isDefaultConsole = false;
};

inline bool toUtf8(const std::wstring &input, std::string *output) {
  if (!output)
    return false;
  output->clear();
  if (input.empty())
    return true;

  const int required = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, input.data(),
      static_cast<int>(input.size()), nullptr, 0, nullptr, nullptr);
  if (required <= 0)
    return false;
  output->resize(static_cast<std::size_t>(required));
  return WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(),
                             static_cast<int>(input.size()), output->data(),
                             required, nullptr, nullptr) == required;
}

inline std::string escapeJson(const std::string &input) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string output;
  output.reserve(input.size());
  for (const unsigned char value : input) {
    switch (value) {
    case '"':
      output += "\\\"";
      break;
    case '\\':
      output += "\\\\";
      break;
    case '\b':
      output += "\\b";
      break;
    case '\f':
      output += "\\f";
      break;
    case '\n':
      output += "\\n";
      break;
    case '\r':
      output += "\\r";
      break;
    case '\t':
      output += "\\t";
      break;
    default:
      if (value < 0x20) {
        output += "\\u00";
        output.push_back(kHex[value >> 4]);
        output.push_back(kHex[value & 0x0f]);
      } else {
        output.push_back(static_cast<char>(value));
      }
    }
  }
  return output;
}

inline bool appendJsonString(const std::wstring &value, std::string *output) {
  if (!output)
    return false;
  std::string utf8;
  if (!toUtf8(value, &utf8))
    return false;
  *output += '"';
  *output += escapeJson(utf8);
  *output += '"';
  return true;
}

inline bool
serializeEndpointListJson(const std::vector<EndpointRecord> &endpoints,
                          std::string *output) {
  if (!output)
    return false;
  output->clear();
  *output = "{\"schemaVersion\":1,\"endpoints\":[";
  for (std::size_t index = 0; index < endpoints.size(); ++index) {
    if (index > 0)
      *output += ',';
    const EndpointRecord &endpoint = endpoints[index];
    *output += "{\"id\":";
    if (!appendJsonString(endpoint.id, output))
      return false;
    *output += ",\"name\":";
    if (!appendJsonString(endpoint.name, output))
      return false;
    *output += ",\"flow\":";
    if (!appendJsonString(endpoint.flow, output))
      return false;
    *output += ",\"state\":";
    if (!appendJsonString(endpoint.state, output))
      return false;
    *output += ",\"isDefaultConsole\":";
    *output += endpoint.isDefaultConsole ? "true}" : "false}";
  }
  *output += "]}";
  return true;
}

} // namespace kyx::windows_audio
