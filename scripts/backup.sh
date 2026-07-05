#!/usr/bin/env bash
#
# Backup diário das gravações do Kassinão para um armazenamento EXTERNO (Backblaze
# B2, AWS S3, Cloudflare R2, etc.) via rclone. Sem isso, a morte do VPS = perda total.
#
# ── Setup (só uma vez, no VPS) ───────────────────────────────────────────────
#   1. Instale o rclone:      curl https://rclone.org/install.sh | sudo bash
#   2. Configure um remoto:   rclone config
#      → crie um remoto (ex.: Backblaze B2, barato) e NOMEIE ele "kassinao-backup".
#        No B2: crie um bucket + uma "Application Key" e cole no rclone config.
#   3. Teste:                 RCLONE_REMOTE=kassinao-backup:SEU_BUCKET ./scripts/backup.sh
#   4. Agende no cron (3h da manhã):
#      (crontab -l 2>/dev/null; echo "0 3 * * * RCLONE_REMOTE=kassinao-backup:SEU_BUCKET /root/kassinao/scripts/backup.sh >> /var/log/kassinao-backup.log 2>&1") | crontab -
#
# ── Restaurar ────────────────────────────────────────────────────────────────
#   rclone copy kassinao-backup:SEU_BUCKET/kassinao-AAAAMMDD-HHMMSS.tar.gz /tmp/
#   tar -xzf /tmp/kassinao-*.tar.gz -C /root/kassinao/        # recria recordings/
#
set -euo pipefail

REC_DIR="${RECORDINGS_DIR:-/root/kassinao/recordings}"
REMOTE="${RCLONE_REMOTE:-kassinao-backup:kassinao}" # remoto:bucket[/pasta]
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"

if ! command -v rclone >/dev/null 2>&1; then
  echo "ERRO: rclone não instalado. Rode: curl https://rclone.org/install.sh | sudo bash" >&2
  exit 1
fi
if [ ! -d "$REC_DIR" ]; then
  echo "ERRO: pasta de gravações não encontrada: $REC_DIR" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ARCHIVE="$TMP/kassinao-$STAMP.tar.gz"

# Empacota tudo menos cache/ (regenerável) e temporários — economiza espaço/banda.
tar --exclude='*/cache' --exclude='*.tmp' -czf "$ARCHIVE" -C "$(dirname "$REC_DIR")" "$(basename "$REC_DIR")"

# Envia pro armazenamento externo.
rclone copy "$ARCHIVE" "$REMOTE/"

# Retenção: apaga no remoto os backups mais antigos que KEEP_DAYS.
rclone delete "$REMOTE/" --min-age "${KEEP_DAYS}d" --include 'kassinao-*.tar.gz' 2>/dev/null || true

echo "backup ok: kassinao-$STAMP.tar.gz ($(du -h "$ARCHIVE" | cut -f1)) -> $REMOTE (retenção ${KEEP_DAYS}d)"
