{
  "targets": [
    {
      "target_name": "oslock",
      "sources": ["oslock.c"],
      "defines": ["NAPI_VERSION=8"],
      "cflags": ["-std=c11", "-Wall", "-Wextra", "-fvisibility=hidden"],
      "xcode_settings": {
        "OTHER_CFLAGS": ["-std=c11", "-Wall", "-Wextra"],
        "GCC_SYMBOLS_PRIVATE_EXTERN": "YES"
      },
      "conditions": [
        ["OS=='win'", {
          "defines": ["WIN32_LEAN_AND_MEAN", "UNICODE", "_UNICODE"],
          "msvs_settings": { "VCCLCompilerTool": { "WarningLevel": 4 } }
        }]
      ]
    }
  ]
}
