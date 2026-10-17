.DEFAULT_GOAL := help

HOST ?= ruvds-openclaw

.PHONY: help check check-index deploy update install morning

help:
	@printf '%s\n' \
		'make check                 файлы из git: почта, IPv4, tg:, пути облака' \
		'make check-index           то же по индексу, после git add и до commit' \
		'make deploy               с ПК: выкладка на VPS и update.sh' \
		'                           HOST=ssh-хост, по умолчанию $(HOST)' \
		'make update               на VPS: правила, календарь, unit-файлы' \
		'make install ENV=файл     на VPS: первая установка' \
		'make morning ENV=файл     на VPS: утренняя сводка в 08:00'

check:
	./deploy/check-public.sh --tracked

check-index:
	./deploy/check-public.sh

deploy: check
	./deploy/from-pc.sh $(HOST)

update:
	sudo ./deploy/update.sh

install:
	@test -n "$(ENV)" || { echo "СТОП: make install ENV=/путь/к/env-файлу" >&2; exit 2; }
	sudo ./deploy/install-vps.sh "$(ENV)"

morning:
	@test -n "$(ENV)" || { echo "СТОП: make morning ENV=/путь/к/env-файлу" >&2; exit 2; }
	sudo ./deploy/setup-morning-cron.sh "$(ENV)"
