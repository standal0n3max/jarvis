#!/bin/bash
# Утренняя сводка на уже установленном OpenClaw.
# Job id с сервера не читает и не записывает.
# Запуск: sudo ./deploy/setup-morning-cron.sh /путь/к/env-файлу
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "запускать от root" >&2
  exit 1
fi

ENV_FILE="${1:-}"
if [[ -z "${ENV_FILE}" || ! -f "${ENV_FILE}" ]]; then
  echo "СТОП: передайте env-файл с TELEGRAM_OWNER_ID" >&2
  exit 2
fi

line="$(grep -E '^TELEGRAM_OWNER_ID=' "${ENV_FILE}" | head -n 1 || true)"
owner_id="${line#TELEGRAM_OWNER_ID=}"
owner_id="${owner_id#"${owner_id%%[![:space:]]*}"}"
owner_id="${owner_id%"${owner_id##*[![:space:]]}"}"
owner_id="${owner_id%\"}"
owner_id="${owner_id#\"}"

if [[ ! "${owner_id}" =~ ^[0-9]+$ ]]; then
  echo "СТОП: TELEGRAM_OWNER_ID должен быть числом" >&2
  exit 2
fi

if ! id openclaw >/dev/null 2>&1; then
  echo "СТОП: нет пользователя openclaw" >&2
  exit 1
fi

su -s /bin/bash openclaw -c "openclaw cron add \
  --name morning-digest \
  --declaration-key morning-digest \
  --cron '0 8 * * *' \
  --tz Europe/Moscow \
  --exact \
  --session isolated \
  --agent main \
  --message 'Утренняя сводка: просроченные задачи и траты за вчера. Если их нет, так и напиши. Новые файлы не создавай.' \
  --model openrouter/anthropic/claude-sonnet-5.5 \
  --wake next-heartbeat \
  --announce \
  --channel telegram \
  --to '${owner_id}'"
echo "Сводка поставлена на 08:00 Europe/Moscow. Сразу сообщение не отправляется."
