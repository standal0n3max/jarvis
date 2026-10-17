#!/bin/bash
# Уже работающий VPS: правила агента, скрипт календаря и unit-файлы.
# Ubuntu не переустанавливает. Секреты и openclaw.json не перезаписывает.
# local.md не копирует и не удаляет. USER.md пишет только если файла ещё нет.
# Запуск: sudo ./deploy/update.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "запускать от root" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! id openclaw >/dev/null 2>&1; then
  echo "СТОП: нет пользователя openclaw" >&2
  exit 1
fi

if [[ ! -f /home/openclaw/vault/system/local.md ]]; then
  echo "СТОП: нет /home/openclaw/vault/system/local.md" >&2
  echo "Сначала перенесите личные папки из живого AGENTS.md в этот файл." >&2
  echo "update.sh его не создаёт и не перезаписывает." >&2
  exit 2
fi

# shellcheck source=lib/write-version.sh
source "${ROOT}/deploy/lib/write-version.sh"

install -d -m 755 -o openclaw -g openclaw \
  /home/openclaw/vault/system \
  /home/openclaw/vault/skills/expense-tracker \
  /home/openclaw/vault/skills/obsidian-tasks
install -m 644 -o openclaw -g openclaw "${ROOT}/agent/SOUL.md" /home/openclaw/vault/SOUL.md
if [[ ! -f /home/openclaw/vault/USER.md ]]; then
  install -m 644 -o openclaw -g openclaw "${ROOT}/agent/USER.md" /home/openclaw/vault/USER.md
fi
install -m 644 -o openclaw -g openclaw "${ROOT}/agent/system/AGENTS.md" /home/openclaw/vault/system/AGENTS.md
install -m 644 -o openclaw -g openclaw "${ROOT}/agent/skills/expense-tracker/SKILL.md" /home/openclaw/vault/skills/expense-tracker/SKILL.md
install -m 644 -o openclaw -g openclaw "${ROOT}/agent/skills/obsidian-tasks/SKILL.md" /home/openclaw/vault/skills/obsidian-tasks/SKILL.md
write_vault_version "${ROOT}"

install -d -m 700 -o openclaw -g openclaw /home/openclaw/.openclaw
install -m 644 -o openclaw -g openclaw "${ROOT}/deploy/calendar-v3-mcp.mjs" /home/openclaw/.openclaw/calendar-v3-mcp.mjs

install -m 644 "${ROOT}/deploy/systemd/sota-tun.service" /etc/systemd/system/sota-tun.service
install -m 755 "${ROOT}/deploy/sbin/sota-preserve-ssh.sh" /usr/local/sbin/sota-preserve-ssh.sh

if [[ -s /etc/openclaw/vault-sync.env ]] && grep -q '^DROPBOX_DEST=.\+' /etc/openclaw/vault-sync.env; then
  install -m 644 "${ROOT}/deploy/systemd/openclaw-vault-sync.service" /etc/systemd/system/openclaw-vault-sync.service
  install -m 644 "${ROOT}/deploy/systemd/openclaw-vault-sync.timer" /etc/systemd/system/openclaw-vault-sync.timer
else
  echo "СТОП: нет DROPBOX_DEST в /etc/openclaw/vault-sync.env, unit синка не обновляю" >&2
  systemctl daemon-reload
  systemctl try-restart sota-tun.service || true
  exit 2
fi

systemctl daemon-reload
systemctl try-restart sota-tun.service || true
systemctl try-restart openclaw-vault-sync.timer || true
echo "Готово. Секреты, openclaw.json, токены и local.md не менялись."
