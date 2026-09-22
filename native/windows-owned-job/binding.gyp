{
  "comment": [
    "Task1167 / release1171 Windows owned-job prototype (operation wn1167a-v1).",
    "NOT BUILT in the authoring environment: no Windows SDK is present, so this",
    "descriptor has never been run through node-gyp or MSVC. Toolchain pins below",
    "restate the DECISION's build-only proposal (MSVC2022 + Windows SDK 10); they",
    "are a build input, not a support declaration and not a measured result.",
    "Direct Node-API binding only: no node-addon-api, no runtime dependency, and",
    "no end-user compiler or download-on-install (Article17).",
    "The addon is win32 only. On any other OS the build fails closed rather than",
    "producing a stub that could be mistaken for POSIX emulation."
  ],
  "targets": [
    {
      "target_name": "owned_job",
      "sources": ["owned-job.cc"],
      "defines": [
        "NAPI_VERSION=8",
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "WIN32_LEAN_AND_MEAN",
        "_WIN32_WINNT=0x0602",
        "NOMINMAX"
      ],
      "conditions": [
        [
          "OS==\"win\"",
          {
            "libraries": ["-lbcrypt.lib", "-lkernel32.lib", "-ladvapi32.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": ["/std:c++17", "/permissive-", "/W3", "/EHsc"]
              }
            },
            "msvs_windows_target_platform_version": "10.0",
            "win_delay_load_hook": "true"
          },
          {
            "sources": [],
            "actions": [
              {
                "action_name": "refuse_non_windows_build",
                "inputs": [],
                "outputs": ["unsupported-platform"],
                "action": [
                  "node",
                  "-e",
                  "console.error('owned_job: Windows-only addon; POSIX callers must not build it'); process.exit(1)"
                ]
              }
            ]
          }
        ]
      ]
    }
  ]
}
