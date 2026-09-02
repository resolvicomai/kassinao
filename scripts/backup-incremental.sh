#!/usr/bin/env bash
#
# Backup INCREMENTAL das gravações (e, opcionalmente, do estado operacional)
# para um remoto rclone do tipo crypt.
#
# Por que incremental: o backup em tarball completo diário reenviava o acervo
# inteiro toda madrugada, embora FLAC e transcrições nunca mudem depois da
# gravação. Com poucos GB de áudio isso estourou a cota gratuita do provedor em
# duas semanas e o backup ficou 30 dias parado sem ninguém perceber.
#
# `rclone copy` sobe só o que falta no destino e NUNCA apaga lá. Uma gravação
# removida por engano no servidor continua no backup: a mesma propriedade
# append-only que o tarball garantia. Retenção/expurgo, quando desejados, ficam
# no provedor (lifecycle) ou em scripts/backup-retention.sh, com credencial própria.
#
# O que NÃO sobe: cache (mix e zips, regeneráveis), segredo dos cookies,
# identidade da instância e sessões web/MCP. Restaurar um backup não pode
# ressuscitar sessão revogada; depois de um restore todos entram de novo pelo Discord.
#
# Heartbeat: ao fim de um upload verificado, grava STATE_DIR/backup-heartbeat.json.
# Com BACKUP_STATUS=enabled o bot lê esse arquivo e avisa o dono por DM quando o
# último sucesso ficou mais velho que 48 h. É a ponte entre este cron e alguém
# que de fato vai ler o aviso.
#
# Variáveis:
#   RECORDINGS_DIR   caminho absoluto das gravações (obrigatório)
#   STATE_DIR        caminho absoluto do estado operacional (opcional; sobe em .state/)
#   RCLONE_REMOTE    remoto crypt no formato remoto:caminho (obrigatório)
#   RCLONE_CONFIG    arquivo de configuração do rclone, modo 0600 (obrigatório)
#   BACKUP_LOCK_FILE lock do job (padrão /run/lock/kassinao-backup.lock)
#   BACKUP_HEARTBEAT_FILE  destino do heartbeat (padrão STATE_DIR/backup-heartbeat.json)
#   BACKUP_HEARTBEAT_OWNER uid[:gid] que deve ler o heartbeat (padrão: dono de STATE_DIR)
#
# Este script não guarda o .env nem o rclone.conf. Sem eles o bot não sobe num
# servidor novo, e sem as senhas do crypt o backup é indecifrável. Guarde-os num
# gerenciador de senhas, fora da VPS.
#
# Ressalva: uma gravação em andamento na hora do cron faz os FLAC dela crescerem
# durante o upload; o rclone pode recusar o arquivo mutável e o script termina
# sem heartbeat naquela noite (a próxima execução completa). Agende o cron fora
# do horário de reuniões. O estado sobe antes das gravações justamente para não
# ficar refém dessa janela.
set -euo pipefail
umask 077

REC_DIR="${RECORDINGS_DIR:?Defina RECORDINGS_DIR com o caminho absoluto das gravações}"
STATE="${STATE_DIR:-}"
REMOTE="${RCLONE_REMOTE:?Defina RCLONE_REMOTE com um remoto rclone crypt}"
RCLONE_CONFIG_FILE="${RCLONE_CONFIG:?Defina RCLONE_CONFIG com o config de upload}"
LOCK_FILE="${BACKUP_LOCK_FILE:-/run/lock/kassinao-backup.lock}"

die() {
  echo "ERRO: $*" >&2
  exit 1
}

command -v rclone >/dev/null 2>&1 || die "rclone não instalado"
command -v flock >/dev/null 2>&1 || die "flock não instalado"

require_dir() {
  local label="$1" dir="$2"
  case "$dir" in
    /*) ;;
    *) die "$label precisa ser um caminho absoluto" ;;
  esac
  [ ! -L "$dir" ] || die "$label não pode ser um link simbólico"
  [ -d "$dir" ] || die "pasta não encontrada para $label: $dir"
}
require_dir RECORDINGS_DIR "$REC_DIR"
[ -z "$STATE" ] || require_dir STATE_DIR "$STATE"
# No layout legado de volume único, STATE_DIR == RECORDINGS_DIR: copiar o estado
# para .state/ reenviaria o acervo inteiro (com cache) e recriaria o problema de
# cota que este script existe para resolver.
if [ -n "$STATE" ] && [ "$(cd "$STATE" && pwd -P)" = "$(cd "$REC_DIR" && pwd -P)" ]; then
  die "STATE_DIR não pode ser o mesmo diretório de RECORDINGS_DIR; no layout de volume único deixe STATE_DIR vazio"
fi

if [ ! -f "$RCLONE_CONFIG_FILE" ] || [ -L "$RCLONE_CONFIG_FILE" ]; then
  die "RCLONE_CONFIG precisa ser um arquivo regular, não um link simbólico"
fi
[ -O "$RCLONE_CONFIG_FILE" ] || die "RCLONE_CONFIG precisa pertencer ao usuário atual"
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
file_owner() { stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"; }
config_mode="$(file_mode "$RCLONE_CONFIG_FILE")"
if (( (8#$config_mode & 077) != 0 )); then
  die "RCLONE_CONFIG permite acesso de grupo/outros; execute chmod 600"
fi

case "$REMOTE" in
  *:*) ;;
  *) die "RCLONE_REMOTE precisa usar a forma remoto:caminho" ;;
esac

# O destino PRECISA ser crypt: voz, transcrição e nomes de arquivo nunca podem
# chegar em claro ao provedor.
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

REMOTE_ROOT="${REMOTE%/}"

REC_EXCLUDES=(
  --exclude '/*/cache/**'
  --exclude '/*/.cache/**'
  --exclude '/cache/**'
  --exclude '/.cache/**'
  --exclude '*.tmp'
  --exclude '/.cookie-secret'
  --exclude '/.instance-id'
  --exclude '/.web-sessions.json'
  --exclude '/.mcp-sessions.json'
  --exclude '/web-sessions.json'
  --exclude '/mcp-sessions.json'
  --exclude '/.state/**'
)
STATE_EXCLUDES=(
  --exclude '*.tmp'
  --exclude '/cache/**'
  --exclude '/.cache/**'
  --exclude '/.cookie-secret'
  --exclude '/.instance-id'
  --exclude '/web-sessions.json'
  --exclude '/mcp-sessions.json'
  --exclude '/backup-heartbeat.json'
)

if [ -n "$STATE" ]; then
  # Regras de auto-record, configuração por servidor e admissão: pequenos, mas
  # sem eles um servidor novo sobe "vazio". Vão para .state/ (nome que nenhum id
  # de gravação usa, então não colide com o acervo na raiz).
  rclone --config "$RCLONE_CONFIG_FILE" copy \
    "$STATE" "$REMOTE_ROOT/.state" \
    "${STATE_EXCLUDES[@]}" \
    --transfers 2 --checkers 4 \
    --stats-one-line --stats 0
  rclone --config "$RCLONE_CONFIG_FILE" check \
    "$STATE" "$REMOTE_ROOT/.state" \
    "${STATE_EXCLUDES[@]}" \
    --one-way --size-only
fi

rclone --config "$RCLONE_CONFIG_FILE" copy \
  "$REC_DIR" "$REMOTE_ROOT" \
  "${REC_EXCLUDES[@]}" \
  --transfers 4 --checkers 8 \
  --stats-one-line --stats 0

# Confere que nada ficou para trás. O crypt não expõe hash do conteúdo em claro,
# então esta checagem compara tamanho, não bytes. A integridade byte a byte de
# cada arquivo já é garantida na subida, pelo checksum que o provedor valida.
rclone --config "$RCLONE_CONFIG_FILE" check \
  "$REC_DIR" "$REMOTE_ROOT" \
  "${REC_EXCLUDES[@]}" \
  --one-way --size-only


size_json="$(rclone --config "$RCLONE_CONFIG_FILE" size "$REMOTE_ROOT" --json 2>/dev/null || true)"
count="$(printf '%s' "$size_json" | sed -n 's/.*"count":[[:space:]]*\([0-9]*\).*/\1/p')"
bytes="$(printf '%s' "$size_json" | sed -n 's/.*"bytes":[[:space:]]*\([0-9]*\).*/\1/p')"
finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Heartbeat legível pelo container (uid do dono de STATE_DIR), escrito de forma
# atômica. O remoto aparece só pelo nome: nenhuma credencial entra no arquivo.
heartbeat_file="${BACKUP_HEARTBEAT_FILE:-}"
if [ -z "$heartbeat_file" ] && [ -n "$STATE" ]; then
  heartbeat_file="$STATE/backup-heartbeat.json"
fi
if [ -n "$heartbeat_file" ]; then
  heartbeat_dir="$(dirname "$heartbeat_file")"
  [ -d "$heartbeat_dir" ] || die "diretório do heartbeat não existe: $heartbeat_dir"
  [ ! -L "$heartbeat_file" ] || die "o heartbeat não pode ser um link simbólico"
  tmp="$heartbeat_file.$$.tmp"
  printf '{"finishedAt":"%s","files":%s,"bytes":%s,"remote":"%s"}\n' \
    "$finished_at" "${count:-0}" "${bytes:-0}" "${REMOTE_ROOT//\"/}" > "$tmp"
  chmod 0644 "$tmp"
  owner="${BACKUP_HEARTBEAT_OWNER:-$(file_owner "$heartbeat_dir")}"
  chown "$owner" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$heartbeat_file"
fi

echo "backup incremental verificado -> $REMOTE_ROOT (${count:-?} arquivos, ${bytes:-?} bytes) em $finished_at"
