#!/bin/bash
# Перед коммитом смотрит индекс: почта, IPv4, tg: с длинным числом, пути Dropbox.
# Свои строки — deploy/personal-denylist.txt, этот файл в git не входит.
# Запуск: ./deploy/check-public.sh
# Уже отслеживаемые файлы, не только индекс: ./deploy/check-public.sh --tracked
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

mode="index"
if [[ "${1:-}" == "--tracked" ]]; then
  mode="tracked"
elif [[ -n "${1:-}" ]]; then
  echo "СТОП: аргумент только --tracked" >&2
  exit 2
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "СТОП: это не git-репозиторий" >&2
  exit 1
fi

if git ls-files --error-unmatch deploy/personal-denylist.txt >/dev/null 2>&1; then
  echo "СТОП: deploy/personal-denylist.txt отслеживается git" >&2
  exit 1
fi

grep_prefix=(git grep -n -I)
if [[ "${mode}" == "index" ]]; then
  if [[ -z "$(git diff --cached --name-only)" ]]; then
    echo "Индекс пуст. Сначала git add, затем снова ./deploy/check-public.sh"
    exit 0
  fi
  grep_prefix+=(--cached)
fi

fail=0

show_hits() {
  local label="$1"
  shift
  local output status
  set +e
  output="$("${grep_prefix[@]}" "$@" -- . ':(exclude)deploy/check-public.sh' 2>&1)"
  status=$?
  set -e
  if [[ "${status}" -eq 0 ]]; then
    echo "СТОП: ${label}" >&2
    printf '%s\n' "${output}" >&2
    fail=1
  elif [[ "${status}" -gt 1 ]]; then
    echo "СТОП: проверка «${label}» завершилась с кодом ${status}" >&2
    printf '%s\n' "${output}" >&2
    exit 1
  fi
}

show_hits "почта" -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
show_hits "tg: с длинным числом" -E 'tg:[0-9]{6,}'
show_hits "путь Dropbox" -E 'remotely-save|Приложения/|Dropbox/|[Dd]ropbox:[A-Za-z0-9/]'

ipv4_output=""
ipv4_status=0
set +e
ipv4_output="$("${grep_prefix[@]}" -E '[0-9]{1,3}(\.[0-9]{1,3}){3}' -- . ':(exclude)deploy/check-public.sh' 2>&1)"
ipv4_status=$?
set -e
if [[ "${ipv4_status}" -gt 1 ]]; then
  echo "СТОП: проверка IPv4 завершилась с кодом ${ipv4_status}" >&2
  printf '%s\n' "${ipv4_output}" >&2
  exit 1
fi
if [[ "${ipv4_status}" -eq 0 ]]; then
  ipv4_hits=""
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    rest="$(printf '%s' "${line}" | sed -E 's/127\.0\.0\.1//g; s/1\.1\.1\.1//g')"
    if printf '%s' "${rest}" | grep -E -q '[0-9]{1,3}(\.[0-9]{1,3}){3}'; then
      ipv4_hits+="${line}"$'\n'
    fi
  done <<< "${ipv4_output}"
  if [[ -n "${ipv4_hits}" ]]; then
    echo "СТОП: IPv4" >&2
    printf '%s' "${ipv4_hits}" >&2
    fail=1
  fi
fi

denylist="${ROOT}/deploy/personal-denylist.txt"
if [[ -f "${denylist}" ]]; then
  while IFS= read -r needle || [[ -n "${needle}" ]]; do
    needle="${needle#"${needle%%[![:space:]]*}"}"
    needle="${needle%"${needle##*[![:space:]]}"}"
    [[ -z "${needle}" || "${needle}" == \#* ]] && continue
    show_hits "строка из personal-denylist.txt" -F -e "${needle}"
  done < "${denylist}"
fi

if [[ "${fail}" -ne 0 ]]; then
  exit 1
fi

echo "Публичная проверка прошла."
