{
  "targets": [
    {
      "target_name": "kyx_windows_audio_host",
      "sources": ["napi-addon.cpp", "wasapi-shared-duplex.cpp"],
      "include_dirs": ["."],
      "defines": ["NOMINMAX", "WIN32_LEAN_AND_MEAN", "UNICODE", "_UNICODE"],
      "libraries": ["avrt.lib", "ole32.lib", "uuid.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "WarningLevel": 4,
          "AdditionalOptions": ["/permissive-", "/EHsc"]
        }
      }
    }
  ]
}
