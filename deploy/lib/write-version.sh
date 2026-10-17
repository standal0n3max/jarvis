# Пишет маркер /home/openclaw/vault/system/VERSION.
# Если HEAD отмечен тегом — в маркер попадает тег. Иначе берётся файл VERSION.
write_vault_version() {
  local root="$1"
  local version_tag version_file

  version_tag=""
  if git -C "${root}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    version_tag="$(git -C "${root}" describe --tags --exact-match 2>/dev/null || true)"
  fi
  if [[ -z "${version_tag}" ]]; then
    if [[ ! -s "${root}/VERSION" ]]; then
      echo "СТОП: нет файла VERSION" >&2
      return 1
    fi
    version_tag="$(tr -d '[:space:]' < "${root}/VERSION")"
    if [[ "${version_tag}" != v* ]]; then
      version_tag="v${version_tag}"
    fi
  fi

  version_file="$(mktemp)"
  printf '%s\n' "${version_tag}" > "${version_file}"
  install -m 644 -o openclaw -g openclaw "${version_file}" /home/openclaw/vault/system/VERSION
  rm -f "${version_file}"
}
