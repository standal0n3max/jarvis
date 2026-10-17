#!/bin/bash
# С ПК копирует файлы из git в /opt/jarvis на VPS и запускает update.sh.
# plans/, credentials/, local.md, секреты и denylist в git не входят и не копируются.
# Запуск: ./deploy/from-pc.sh [ssh-хост]
set -euo pipefail

HOST="${1:-ruvds-openclaw}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="/opt/jarvis"

cd "${ROOT}"
"${ROOT}/deploy/check-public.sh" --tracked

if [[ ! -s "${ROOT}/VERSION" ]]; then
  echo "СТОП: нет файла VERSION" >&2
  exit 1
fi

stage="$(mktemp -d)"
cleanup() {
  rm -rf "${stage}"
}
trap cleanup EXIT

git ls-files -z | rsync -a --from0 --files-from=- ./ "${stage}/"
ssh "${HOST}" "install -d -m 755 ${REMOTE}"
rsync -a --delete -e ssh "${stage}/" "${HOST}:${REMOTE}/"
ssh "${HOST}" "find ${REMOTE}/deploy -type f -name '*.sh' -exec chmod 755 {} +"
ssh "${HOST}" "${REMOTE}/deploy/update.sh"
