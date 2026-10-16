#!/bin/bash
set -euo pipefail
umask 077
dest=/var/backups/openclaw
mkdir -p "$dest"
chmod 700 "$dest"
stamp=$(date +%Y%m%d-%H%M%S)
archive="$dest/openclaw-${stamp}.tar.gz"
tar -C /home/openclaw -czf "$archive" .openclaw
chmod 600 "$archive"
find "$dest" -type f -name "openclaw-*.tar.gz" -mtime +14 -delete
