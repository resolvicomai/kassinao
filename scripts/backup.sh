#!/usr/bin/env bash
#
# Backup diário das gravações para um armazenamento externo via rclone crypt.
# O remoto criptografado e o arquivo de configuração são obrigatórios: voz,
# transcrições e nomes de arquivos nunca devem chegar em claro ao provedor.
#
# Setup no VPS (uma vez):
#   1. Instale o rclone pelo gerenciador de pacotes da distribuição ou pelo
#      pacote oficial verificado. Evite executar instaladores remotos via pipe.
#   2. Crie um storage com credencial de criar/listar/ler, mas sem excluir, e um
#      remoto `crypt` por cima dele. Proteja o config:
#      chmod 600 /root/.config/rclone/upload.conf
#   3. Teste:
#      RCLONE_CONFIG=/root/.config/rclone/upload.conf \
#      RCLONE_REMOTE=kassinao-backup:SEU_BUCKET ./scripts/backup.sh
#   4. Agende no cron. Configure retenção no provedor (lifecycle/object lock) ou
#      rode backup-retention.sh em outro cron com uma credencial de exclusão.
#
# Restaurar:
#   rclone --config /root/.config/rclone/upload.conf copy \
#     kassinao-backup:SEU_BUCKET/kassinao-AAAAMMDD-HHMMSS.tar.gz /tmp/
#   tar -xzf /tmp/kassinao-*.tar.gz -C /root/kassinao/
#
set -euo pipefail
umask 077

REC_DIR="${RECORDINGS_DIR:-/root/kassinao/recordings}"
REMOTE="${RCLONE_REMOTE:?Defina RCLONE_REMOTE com um remoto rclone crypt}"
RCLONE_CONFIG_FILE="${RCLONE_CONFIG:?Defina RCLONE_CONFIG com o config de upload}"
LOCK_FILE="${BACKUP_LOCK_FILE:-/run/lock/kassinao-backup.lock}"
TMP=""

cleanup() {
  if [ -n "$TMP" ]; then
    rm -rf -- "$TMP"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

die() {
  echo "ERRO: $*" >&2
  exit 1
}

command -v rclone >/dev/null 2>&1 || die "rclone não instalado"
command -v flock >/dev/null 2>&1 || die "flock não instalado"
[ -d "$REC_DIR" ] || die "pasta de gravações não encontrada: $REC_DIR"
if [ ! -f "$RCLONE_CONFIG_FILE" ] || [ -L "$RCLONE_CONFIG_FILE" ]; then
  die "RCLONE_CONFIG precisa ser um arquivo regular, não um link simbólico"
fi
[ -O "$RCLONE_CONFIG_FILE" ] || die "RCLONE_CONFIG precisa pertencer ao usuário atual"

config_mode="$(stat -c '%a' "$RCLONE_CONFIG_FILE")"
if (( (8#$config_mode & 077) != 0 )); then
  die "RCLONE_CONFIG permite acesso de grupo/outros; execute chmod 600"
fi

case "$REMOTE" in
  *:*) ;;
  *) die "RCLONE_REMOTE precisa usar a forma remoto:caminho" ;;
esac

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
flock -n 9 || die "já existe um backup em execução"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE_NAME="kassinao-$STAMP.tar.gz"
TMP="$(mktemp -d)"
ARCHIVE="$TMP/$ARCHIVE_NAME"
REMOTE_ROOT="${REMOTE%/}"

# Empacota conteúdo, mas nunca estado de autenticação. Restaurar um backup não
# pode ressuscitar sessão revogada nem entregar o segredo que assina cookies.
tar \
  --exclude='*/cache' \
  --exclude='*/.cache' \
  --exclude='*.tmp' \
  --exclude='*/.cookie-secret' \
  --exclude='*/.web-sessions.json' \
  --exclude='*/.mcp-sessions.json' \
  -czf "$ARCHIVE" \
  -C "$(dirname "$REC_DIR")" \
  -- "$(basename "$REC_DIR")"

# Testa o arquivo local, faz upload imutável e baixa os bytes de volta para uma
# checagem ponta a ponta. A execução falha em vez de anunciar backup incompleto.
tar -tzf "$ARCHIVE" >/dev/null
rclone --config "$RCLONE_CONFIG_FILE" copyto \
  "$ARCHIVE" "$REMOTE_ROOT/$ARCHIVE_NAME" --immutable
rclone --config "$RCLONE_CONFIG_FILE" check \
  "$TMP" "$REMOTE_ROOT" \
  --include "/$ARCHIVE_NAME" --one-way --download --checkers 1

size="$(du -h "$ARCHIVE" | cut -f1)"
echo "backup verificado: $ARCHIVE_NAME ($size) -> $REMOTE_ROOT"
echo "retenção: use lifecycle/object lock do provedor ou scripts/backup-retention.sh com outra credencial"
