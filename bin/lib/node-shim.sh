#!/usr/bin/env bash
# node-shim.sh — the dist resolution every bin/ exec shim needs (#899).
#
# A shim in bin/ has to find its compiled implementation in TWO real layouts:
#
#   * repo tree / installed npm package — dist/ is a sibling of bin/, so
#     "$SCRIPT_DIR/../dist/..." resolves;
#   * control workspace — `init` copies bin/ (and the doctrine) out of the
#     package via bin/init/manifest.mjs, which ships NO dist entries at all, so
#     dist/ stays behind in the package root. The workspace's shim has to keep
#     working, not just answer --help, so the implementation is resolved through
#     the package's own CLI on PATH instead.
#
# The first cut of bin/dispatch.sh only tried the sibling path and every
# workspace dispatch would have died on a missing file; tests/packaging/
# smoke-init.sh (h) caught it on CI. This lib exists so that CI-caught constraint
# has ONE implementation rather than one per shim (tests/dispatch/T99, T100).
#
# Article 17: shell only. macOS + Linux — no OS-specific primitive here.

# Guard against double-source (platform.sh precedent).
[[ "${_NODE_SHIM_SH_SOURCED:-}" == "1" ]] && return 0
_NODE_SHIM_SH_SOURCED=1

# aigentry_node_shim <shim-name> <dist-relative-path>
#
# Reads AIGENTRY_SHIM_SCRIPT_DIR (the shim's own bin/, resolved by the caller
# exactly as the shell script's SCRIPT_DIR was, so a symlinked entrypoint still
# locates bin/ helpers) and sets AIGENTRY_SHIM_JS to the compiled entrypoint.
# Exits 2 with the caller's diagnostic when neither layout resolves.
aigentry_node_shim() {
  local name="$1" rel="$2" pkg_bin pkg_root
  AIGENTRY_SHIM_JS="$AIGENTRY_SHIM_SCRIPT_DIR/../$rel"
  if [ ! -f "$AIGENTRY_SHIM_JS" ]; then
    pkg_bin="$(command -v aigentry-orchestrator || true)"
    if [ -n "$pkg_bin" ]; then
      pkg_root="$(node -e 'const p=require("node:path"),f=require("node:fs");console.log(p.resolve(f.realpathSync(process.argv[1]),"..","..",".."))' "$pkg_bin" 2>/dev/null || true)"
      [ -n "$pkg_root" ] && AIGENTRY_SHIM_JS="$pkg_root/$rel"
    fi
  fi
  if [ ! -f "$AIGENTRY_SHIM_JS" ]; then
    echo "$name: compiled implementation not found at $AIGENTRY_SHIM_JS (run \`tsc -p .\` in the repo, or install @dmsdc-ai/aigentry-orchestrator so 'aigentry-orchestrator' is on PATH)" >&2
    exit 2
  fi
}
