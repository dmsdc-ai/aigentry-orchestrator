#!/usr/bin/env bash
# Stub dispatch.sh — records invocation and returns success.
printf 'dispatch.sh %s\n' "$*" >> "${STUB_DISPATCH_LOG:-/dev/null}"
exit 0
