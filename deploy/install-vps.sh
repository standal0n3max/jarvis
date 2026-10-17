#!/bin/bash
# Новый VPS: Ubuntu, пользователь openclaw, firewall, swap, Node/OpenClaw,
# правила агента, timer синка и бэкап.
# Секреты, ключ Sota и токены OAuth в этот скрипт не входят.
# Запуск: sudo ./deploy/install-vps.sh /путь/к/env-файлу
# Текущий уже работающий сервер этим скриптом заново не настраивать.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "запускать от root" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${1:-}"

echo "Ручные шаги. Пока их нет, скрипт ставит только базу и останавливается:"
echo "  Sota: /var/lib/sota-connect/singbox.json (mode 600), стек tun gvisor. В git этот файл не входит."
echo "  Dropbox: rclone remote с именем dropbox у пользователя openclaw"
echo "  Google Calendar: node /home/openclaw/.openclaw/calendar-v3-mcp.mjs login"

if [[ -z "${ENV_FILE}" || ! -f "${ENV_FILE}" ]]; then
  echo "СТОП: передайте env-файл по образцу deploy/env.example" >&2
  exit 2
fi

env_value() {
  local key="$1"
  local file="$2"
  local line value
  line="$(grep -E "^${key}=" "$file" | head -n 1 || true)"
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ ${#value} -ge 2 && "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

missing_key=0
for key in OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_OWNER_ID DROPBOX_DEST; do
  if ! grep -q "^${key}=.\\+" "${ENV_FILE}"; then
    echo "СТОП: в env-файле нет ${key}" >&2
    missing_key=1
  fi
done
if [[ "${missing_key}" -ne 0 ]]; then
  exit 2
fi

owner_id="$(env_value TELEGRAM_OWNER_ID "${ENV_FILE}")"
owner_name="$(env_value TELEGRAM_OWNER_USERNAME "${ENV_FILE}")"
bot_name="$(env_value TELEGRAM_BOT_USERNAME "${ENV_FILE}")"
dropbox_dest="$(env_value DROPBOX_DEST "${ENV_FILE}")"

if [[ ! "${owner_id}" =~ ^[0-9]+$ ]]; then
  echo "СТОП: TELEGRAM_OWNER_ID должен быть числом" >&2
  exit 2
fi
if [[ -z "${dropbox_dest}" || "${dropbox_dest}" == *$'\n'* || "${dropbox_dest}" == *'"'* || "${dropbox_dest}" == *'$'* || "${dropbox_dest}" == *'`'* ]]; then
  echo "СТОП: DROPBOX_DEST пустой или содержит кавычки и подстановки" >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl ufw rclone python3

if ! id openclaw >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash openclaw
fi
loginctl enable-linger openclaw
timedatectl set-timezone Europe/Moscow

if ! ufw status | grep -q '22/tcp'; then
  ufw allow 22/tcp
fi
ufw --force enable

if ! swapon --show | grep -q .; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v openclaw >/dev/null 2>&1; then
  curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh \
    | bash -s -- --version 2026.10.4 --node-version 24.22.0 --no-onboard
fi
if ! openclaw --version 2>/dev/null | grep -q '2026.10.4'; then
  echo "СТОП: установлен не OpenClaw 2026.10.4" >&2
  openclaw --version >&2 || true
  exit 1
fi

install -d -m 700 -o openclaw -g openclaw /home/openclaw/.openclaw
install -m 600 -o openclaw -g openclaw "${ENV_FILE}" /home/openclaw/.openclaw/.env
install -m 644 -o openclaw -g openclaw "${ROOT}/deploy/calendar-v3-mcp.mjs" /home/openclaw/.openclaw/calendar-v3-mcp.mjs

umask 077
google_env="$(mktemp)"
grep -E '^(GOOGLE_CALENDAR_CLIENT_ID|GOOGLE_CALENDAR_CLIENT_SECRET)=' "${ENV_FILE}" > "${google_env}" || true
if grep -q '^GOOGLE_CALENDAR_CLIENT_ID=.\+' "${google_env}" && grep -q '^GOOGLE_CALENDAR_CLIENT_SECRET=.\+' "${google_env}"; then
  install -m 600 -o openclaw -g openclaw "${google_env}" /home/openclaw/.openclaw/google-calendar.env
fi
rm -f "${google_env}"

install -d -m 755 /etc/openclaw
umask 077
printf 'DROPBOX_DEST="%s"\n' "${dropbox_dest}" > /etc/openclaw/vault-sync.env
chmod 600 /etc/openclaw/vault-sync.env

missing=0
if [[ ! -s /var/lib/sota-connect/singbox.json ]]; then
  echo "СТОП: нет /var/lib/sota-connect/singbox.json"
  missing=1
fi
if ! su -s /bin/bash openclaw -c "rclone listremotes" | grep -qx 'dropbox:'; then
  echo "СТОП: нет rclone remote dropbox"
  missing=1
fi
if [[ ! -s /home/openclaw/.openclaw/google-calendar.env ]]; then
  echo "СТОП: нет google-calendar.env"
  missing=1
fi
if [[ ! -s /home/openclaw/.openclaw/calendar-v3.json ]]; then
  echo "СТОП: нет calendar-v3.json, нужен node /home/openclaw/.openclaw/calendar-v3-mcp.mjs login"
  missing=1
fi
if [[ "${missing}" -ne 0 ]]; then
  echo "База поставлена. Повторите скрипт после ручных шагов."
  exit 2
fi

if [[ -f /home/openclaw/.openclaw/openclaw.json && "${OPENCLAW_DEPLOY_FORCE:-}" != "1" ]]; then
  echo "openclaw.json уже есть, шаблон не перезаписываю"
else
  rendered="$(mktemp)"
  TEMPLATE="${ROOT}/deploy/openclaw.json" DEST="${rendered}" TELEGRAM_OWNER_ID="${owner_id}" TELEGRAM_BOT_USERNAME="${bot_name}" \
    python3 - <<'PY'
import json
import os
from pathlib import Path

data = json.loads(Path(os.environ["TEMPLATE"]).read_text())
telegram = data["channels"]["telegram"]
telegram["allowFrom"] = ["tg:" + os.environ["TELEGRAM_OWNER_ID"]]
name = os.environ.get("TELEGRAM_BOT_USERNAME", "").strip()
if name:
    telegram["name"] = name
Path(os.environ["DEST"]).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
PY
  install -m 600 -o openclaw -g openclaw "${rendered}" /home/openclaw/.openclaw/openclaw.json
  rm -f "${rendered}"
fi

install -d -m 755 -o openclaw -g openclaw \
  /home/openclaw/vault/inbox \
  /home/openclaw/vault/finance \
  /home/openclaw/vault/tasks \
  /home/openclaw/vault/ideas \
  /home/openclaw/vault/media/movies \
  /home/openclaw/vault/system \
  /home/openclaw/vault/skills/expense-tracker \
  /home/openclaw/vault/skills/obsidian-tasks

install -m 644 -o openclaw -g openclaw "${ROOT}/agent/SOUL.md" /home/openclaw/vault/SOUL.md
user_md="$(mktemp)"
cp "${ROOT}/agent/USER.md" "${user_md}"
python3 - "${user_md}" "${owner_id}" "${owner_name}" <<'PY'
import sys
from pathlib import Path

path, owner_id, owner_name = sys.argv[1:]
text = Path(path).read_text()
text = text.replace("Telegram id REPLACE_ME", "Telegram id " + owner_id)
if owner_name:
    text = text.replace("@REPLACE_ME", "@" + owner_name)
Path(path).write_text(text)
PY
install -m 644 -o openclaw -g openclaw "${user_md}" /home/openclaw/vault/USER.md
rm -f "${user_md}"
install -m 644 -o openclaw -g openclaw "${ROOT}/agent/system/AGENTS.md" /home/openclaw/vault/system/AGENTS.md
install -m 644 -o openclaw -g openclaw "${ROOT}/agent/skills/expense-tracker/SKILL.md" /home/openclaw/vault/skills/expense-tracker/SKILL.md
install -m 644 -o openclaw -g openclaw "${ROOT}/agent/skills/obsidian-tasks/SKILL.md" /home/openclaw/vault/skills/obsidian-tasks/SKILL.md
# local.md.example на сервер не копируется. local.md создаёт владелец, скрипт его не трогает.
# shellcheck source=lib/write-version.sh
source "${ROOT}/deploy/lib/write-version.sh"
write_vault_version "${ROOT}"

install -d -m 700 -o openclaw -g openclaw /home/openclaw/.config/rclone
install -m 600 -o openclaw -g openclaw "${ROOT}/deploy/rclone/vault-exclude.txt" /home/openclaw/.config/rclone/vault-exclude.txt

install -m 644 "${ROOT}/deploy/systemd/openclaw-vault-sync.service" /etc/systemd/system/openclaw-vault-sync.service
install -m 644 "${ROOT}/deploy/systemd/openclaw-vault-sync.timer" /etc/systemd/system/openclaw-vault-sync.timer
install -m 644 "${ROOT}/deploy/systemd/sota-tun.service" /etc/systemd/system/sota-tun.service
install -m 755 "${ROOT}/deploy/sbin/openclaw-backup.sh" /usr/local/sbin/openclaw-backup.sh
install -m 755 "${ROOT}/deploy/sbin/sota-preserve-ssh.sh" /usr/local/sbin/sota-preserve-ssh.sh
install -m 644 "${ROOT}/deploy/cron/openclaw-backup" /etc/cron.d/openclaw-backup

systemctl daemon-reload
systemctl enable --now sota-tun.service
systemctl enable --now openclaw-vault-sync.timer

su -s /bin/bash openclaw -c 'openclaw gateway install && systemctl --user enable --now openclaw-gateway.service'
echo "Готово. Секреты остаются в ~/.openclaw/.env. Канал: openclaw channels add --channel telegram --use-env"
echo "Утренняя сводка: sudo ./deploy/setup-morning-cron.sh /путь/к/env-файлу"
