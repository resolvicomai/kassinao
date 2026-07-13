#!/usr/bin/env bash
# Remove somente arquivos de backup antigos, usando uma credencial separada da
# credencial de upload. Prefira lifecycle/object lock no provedor quando houver.
set -euo pipefail
umask 077

REMOTE="${RCLONE_RETENTION_REMOTE:?Defina RCLONE_RETENTION_REMOTE}"
RCLONE_CONFIG_FILE="${RCLONE_RETENTION_CONFIG:?Defina RCLONE_RETENTION_CONFIG}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
MAX_DELETE="${BACKUP_MAX_DELETE:-100}"
LOCK_FILE="${BACKUP_RETENTION_LOCK_FILE:-/run/lock/kassinao-backup-retention.lock}"
DRY_RUN="${BACKUP_RETENTION_DRY_RUN:-0}"

die() {
  echo "ERRO: $*" >&2
  exit 1
}

case "$DRY_RUN" in
  0 | 1) ;;
  *) die "BACKUP_RETENTION_DRY_RUN precisa ser 0 ou 1" ;;
esac

case "$REMOTE" in
  *:*) ;;
  *) die "RCLONE_RETENTION_REMOTE precisa usar a forma remoto:caminho" ;;
esac
remote_path="${REMOTE#*:}"
if [[ "$remote_path" =~ ^/*$ ]]; then
  die "RCLONE_RETENTION_REMOTE precisa incluir um caminho não vazio"
fi
if [[ "$remote_path" =~ (^|/)\.{1,2}(/|$) ]]; then
  die "RCLONE_RETENTION_REMOTE precisa incluir um caminho seguro, sem . ou .."
fi

command -v rclone >/dev/null 2>&1 || die "rclone não instalado"
command -v flock >/dev/null 2>&1 || die "flock não instalado"
[[ "$KEEP_DAYS" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_KEEP_DAYS precisa ser inteiro positivo"
[[ "$MAX_DELETE" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_MAX_DELETE precisa ser inteiro positivo"
if [ ! -f "$RCLONE_CONFIG_FILE" ] || [ -L "$RCLONE_CONFIG_FILE" ]; then
  die "RCLONE_RETENTION_CONFIG precisa ser um arquivo regular, não um link simbólico"
fi
[ -O "$RCLONE_CONFIG_FILE" ] || die "RCLONE_RETENTION_CONFIG precisa pertencer ao usuário atual"

config_mode="$(stat -c '%a' "$RCLONE_CONFIG_FILE")"
if (( (8#$config_mode & 077) != 0 )); then
  die "RCLONE_RETENTION_CONFIG permite acesso de grupo/outros; execute chmod 600"
fi

remote_name="${REMOTE%%:*}:"
remote_type="$(
  rclone --config "$RCLONE_CONFIG_FILE" listremotes --long |
    awk -v wanted="$remote_name" '$1 == wanted { print $2; exit }'
)"
[ "$remote_type" = "crypt" ] || \
  die "$remote_name precisa ser um remoto do tipo crypt (tipo encontrado: ${remote_type:-nenhum})"

[ -d "$(dirname "$LOCK_FILE")" ] || die "diretório do lock não existe: $(dirname "$LOCK_FILE")"
[ ! -L "$LOCK_FILE" ] || die "o arquivo de lock não pode ser um link simbólico"
exec 9>"$LOCK_FILE"
flock -n 9 || die "já existe uma retenção em execução"

extra_args=()
if [ "$DRY_RUN" = "1" ]; then
  extra_args+=(--dry-run)
fi

rclone --config "$RCLONE_CONFIG_FILE" delete "${REMOTE%/}" \
  --min-age "${KEEP_DAYS}d" \
  --filter '+ /kassinao-*.tar.gz' \
  --filter '- **' \
  --max-delete "$MAX_DELETE" \
  "${extra_args[@]}"

if [ "$DRY_RUN" = "1" ]; then
  echo "dry-run concluído: nenhuma exclusão aplicada em ${REMOTE%/}"
else
  echo "retenção concluída: backups > ${KEEP_DAYS}d em ${REMOTE%/} (limite: $MAX_DELETE)"
fi
