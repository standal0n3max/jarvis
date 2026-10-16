#!/bin/bash
set -euo pipefail
src=$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')
if [[ -z "${src}" ]]; then
  echo "не удалось определить адрес VPS" >&2
  exit 1
fi
ip rule del pref 50 2>/dev/null || true
ip rule add pref 50 from "$src" lookup main
