# Персональный ассистент

OpenClaw на своём VPS пишет заметки в vault и шлёт их в Telegram. Календарь — локальный Google Calendar API v3. Официальный Calendar MCP в конфиге выключен: для личного Gmail он не работает.

Живой сервер, под который собран установщик:

- Ubuntu 24.04
- Node 24.22.0 (`--node-version` у официального `install-cli.sh`)
- OpenClaw 2026.10.4 (`--version` у `install-cli.sh`)

## Что ставится

`sudo ./deploy/install-vps.sh /путь/к/env-файлу` создаёт пользователя `openclaw`, firewall только на `22/tcp`, swap 2 ГБ, OpenClaw, правила агента, синк vault в Dropbox и ежедневный бэкап `~/.openclaw`.

На уже работающем сервере `sudo ./deploy/update.sh` обновляет правила агента, `calendar-v3-mcp.mjs` и unit-файлы. Ubuntu заново не ставит. Секреты и `openclaw.json` не перезаписывает.

Утренняя сводка: `sudo ./deploy/setup-morning-cron.sh /путь/к/env-файлу`. Расписание `0 8 * * *`, Europe/Moscow, модель Sonnet, `--wake next-heartbeat`, доставка на Telegram id из env.

## Чего в git нет

- `plans/` — дневник разработки
- `credentials/` — секреты
- `*.env` и `*.key`
- vault
- `calendar-v3.json` — refresh token календаря
- `rclone.conf` — токен Dropbox
- `/var/lib/sota-connect/singbox.json` — живые ключи туннеля

Пример ключей без значений: `deploy/env.example`.

В env лежат `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `DROPBOX_DEST`, `GOOGLE_CALENDAR_CLIENT_ID` и `GOOGLE_CALENDAR_CLIENT_SECRET`.

## Три ручных шага

Пока их нет, установщик ставит базу и останавливается.

1. Sota. Конфиг sing-box со стеком `gvisor` положить в `/var/lib/sota-connect/singbox.json` (mode `600`). В git его нет. В репозитории остаются unit `sota-tun` и `deploy/sbin/sota-preserve-ssh.sh`: перед туннелем скрипт сохраняет SSH.
2. rclone. У пользователя `openclaw` remote с именем `dropbox`.
3. Календарь. `node /home/openclaw/.openclaw/calendar-v3-mcp.mjs login`. Refresh token ляжет в `~/.openclaw/calendar-v3.json`.
