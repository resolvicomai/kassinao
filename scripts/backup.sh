#!/usr/bin/env bash
#
# Backup consistente de recordings/ + state/ para um remoto rclone crypt.
# auth/ nunca entra no arquivo: cookies, identidade e sessões pertencem somente
# à instância original. O writer precisa estar parado durante TODO o snapshot.
#
# Por padrão, o script recusa um container em execução. Para uma janela de
# manutenção automatizada, use BACKUP_STOP_CONTAINER=true: o shutdown respeita
# o StopTimeout do container e ele é iniciado novamente mesmo se o upload falhar.
# Sem Docker/container verificável, somente BACKUP_ASSUME_QUIESCED=true permite
# continuar; essa opção afirma explicitamente que nenhum processo escreve nos
# diretórios durante o backup.
#
# Restauração (com o core parado):
#   1. baixe o .tar.gz do remoto crypt e valide `tar -tzf ARQUIVO`;
#   2. extraia em uma pasta vazia e confira BACKUP-MANIFEST.txt;
#   3. substitua DATA_ROOT/recordings e DATA_ROOT/state pelos dois diretórios
#      extraídos, preserve DATA_ROOT/auth da MESMA instância e ajuste owner/mode;
#   4. inicie o core e valide /health antes de remover a cópia anterior.
# Nunca extraia diretamente sobre dados ativos.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
DEPLOY_DIR="${KASSINAO_DEPLOY_DIR:-$PROJECT_DIR}"
ENV_FILE="${KASSINAO_ENV_FILE:-$DEPLOY_DIR/.env}"
REMOTE="${RCLONE_REMOTE:?Defina RCLONE_REMOTE com um remoto rclone crypt}"
RCLONE_CONFIG_FILE="${RCLONE_CONFIG:?Defina RCLONE_CONFIG com o config de upload}"
CONTAINER="${KASSINAO_CONTAINER:-kassinao}"
STOP_CONTAINER="${BACKUP_STOP_CONTAINER:-false}"
ASSUME_QUIESCED="${BACKUP_ASSUME_QUIESCED:-false}"
DOCKER="${DOCKER_BIN:-docker}"
SYSTEMCTL="${SYSTEMCTL_BIN:-systemctl}"
HARDENER="${KASSINAO_HARDENER:-/usr/local/sbin/kassinao-harden-docker-egress}"
STORAGE_VERIFIER="${KASSINAO_STORAGE_VERIFIER:-/usr/local/sbin/kassinao-verify-storage-encryption}"
EGRESS_UNIT=kassinao-docker-egress.service
TMP=""
RESTART_CONTAINER=false

die() {
  printf 'ERRO: %s\n' "$*" >&2
  exit 1
}

for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$name" >/dev/null 2>&1; then
    die "$name não pode vir do ambiente; o backup aceita somente o daemon local da VPS"
  fi
done
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION

bool_value() {
  case "$2" in
    true | false) ;;
    *) die "$1 aceita somente true ou false" ;;
  esac
}

portable_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

command -v flock >/dev/null 2>&1 || die 'flock não instalado'
command -v "$SYSTEMCTL" >/dev/null 2>&1 || die 'systemctl não encontrado'
command -v env >/dev/null 2>&1 || die 'env não encontrado'
[ -x "$HARDENER" ] && [ ! -L "$HARDENER" ] || die 'hardener de egress ausente, sem execução ou symlink'
[ -x "$STORAGE_VERIFIER" ] && [ ! -L "$STORAGE_VERIFIER" ] || die 'verificador de storage ausente, sem execução ou symlink'

# O diretório é provisionado uma vez no host. Não há fallback por usuário:
# deploy, backup e watchdog precisam abrir exatamente o mesmo lock. O lock é
# obtido antes de ler a configuração ou o estado que um deploy pode substituir.
RUNTIME_DIR="${KASSINAO_RUNTIME_DIR:-/run/lock/kassinao}"
case "$RUNTIME_DIR" in
  /*) ;;
  *) die 'KASSINAO_RUNTIME_DIR precisa ser um caminho absoluto' ;;
esac
[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] || die 'diretório de runtime inválido'
JOB_LOCK_FILE="$RUNTIME_DIR/backup.lock"
MAINTENANCE_LOCK_FILE="$RUNTIME_DIR/maintenance.lock"
for lock_file in "$JOB_LOCK_FILE" "$MAINTENANCE_LOCK_FILE"; do
  [ ! -L "$lock_file" ] || die 'o arquivo de lock não pode ser link simbólico'
done
exec 8>"$JOB_LOCK_FILE"
chmod 600 "$JOB_LOCK_FILE"
flock -n 8 || die 'já existe um backup em execução'
exec 9>"$MAINTENANCE_LOCK_FILE"
chmod 600 "$MAINTENANCE_LOCK_FILE"
flock -w 120 9 || die 'outra manutenção não liberou o core em 120 segundos'

require_private_env_file() {
  local file="$1" canonical mode
  case "$file" in
    /*) ;;
    *) die 'KASSINAO_ENV_FILE precisa ser um caminho absoluto e canônico' ;;
  esac
  [ -f "$file" ] && [ ! -L "$file" ] || \
    die 'KASSINAO_ENV_FILE precisa ser um arquivo regular, não um link simbólico'
  [ -O "$file" ] || die 'KASSINAO_ENV_FILE precisa pertencer ao usuário atual'
  canonical="$(cd -- "$(dirname -- "$file")" && pwd -P)/$(basename -- "$file")"
  [ "$file" = "$canonical" ] || die 'KASSINAO_ENV_FILE precisa usar o caminho canônico'
  mode="$(portable_mode "$file")"
  [ "$mode" = 600 ] || die 'KASSINAO_ENV_FILE precisa de modo 0600'
}

# Lê somente a chave permitida, sem executar o arquivo nem colocar seu conteúdo
# no ambiente do processo. Duplicatas falham fechado em vez de escolher uma.
env_value() {
  local key="$1" file="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count > 1) exit 2; print value }
  ' "$file" || die "$key aparece mais de uma vez em KASSINAO_ENV_FILE"
}

needs_env=false
if [ "${KASSINAO_DATA_ROOT+x}" != x ]; then needs_env=true; fi
if [ "${KASSINAO_RECORDINGS_DIR+x}" != x ] && [ "${RECORDINGS_DIR+x}" != x ]; then needs_env=true; fi
if [ "${KASSINAO_STATE_DIR+x}" != x ] && [ "${STATE_DIR+x}" != x ]; then needs_env=true; fi
if [ "${KASSINAO_AUTH_DIR+x}" != x ] && [ "${AUTH_STATE_DIR+x}" != x ]; then needs_env=true; fi

ENV_DATA_ROOT=''
ENV_RECORDINGS_DIR=''
ENV_STATE_DIR=''
ENV_AUTH_DIR=''
if [ "$needs_env" = true ]; then
  require_private_env_file "$ENV_FILE"
  ENV_DATA_ROOT="$(env_value KASSINAO_DATA_ROOT "$ENV_FILE")"
  ENV_RECORDINGS_DIR="$(env_value KASSINAO_RECORDINGS_DIR "$ENV_FILE")"
  ENV_STATE_DIR="$(env_value KASSINAO_STATE_DIR "$ENV_FILE")"
  ENV_AUTH_DIR="$(env_value KASSINAO_AUTH_DIR "$ENV_FILE")"
fi

DATA_DIR="${KASSINAO_DATA_ROOT:-$ENV_DATA_ROOT}"
REC_DIR="${KASSINAO_RECORDINGS_DIR:-${RECORDINGS_DIR:-$ENV_RECORDINGS_DIR}}"
STATE_DIR="${KASSINAO_STATE_DIR:-${STATE_DIR:-$ENV_STATE_DIR}}"
AUTH_DIR="${KASSINAO_AUTH_DIR:-${AUTH_STATE_DIR:-$ENV_AUTH_DIR}}"

egress_ready() {
  "$SYSTEMCTL" is-active --quiet "$EGRESS_UNIT" || return 1
  env \
    -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG -u DOCKER_TLS_VERIFY \
    -u DOCKER_CERT_PATH -u DOCKER_API_VERSION \
    "$HARDENER" --check >/dev/null
}

start_and_wait_healthy() {
  if ! egress_ready; then
    printf 'ERRO: core não será reiniciado sem egress active e policy válida\n' >&2
    return 1
  fi
  "$DOCKER" start "$CONTAINER" >/dev/null || return 1
  local deadline=$((SECONDS + 120)) state health
  while [ "$SECONDS" -lt "$deadline" ]; do
    IFS='|' read -r state health < <(
      "$DOCKER" inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || true
    )
    [ "$state" = running ] && [ "$health" = healthy ] && return 0
    case "$state:$health" in exited:* | dead:* | *:unhealthy) return 1 ;; esac
    sleep 3
  done
  return 1
}

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$RESTART_CONTAINER" = true ]; then
    if ! start_and_wait_healthy; then
      printf 'ERRO: o backup terminou, mas o core não voltou saudável\n' >&2
      status=1
    fi
  fi
  if [ -n "$TMP" ]; then
    rm -rf -- "$TMP"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

bool_value BACKUP_STOP_CONTAINER "$STOP_CONTAINER"
bool_value BACKUP_ASSUME_QUIESCED "$ASSUME_QUIESCED"
case "$CONTAINER" in
  '' | *[!A-Za-z0-9_.-]*) die 'KASSINAO_CONTAINER possui caracteres inválidos' ;;
esac
command -v rclone >/dev/null 2>&1 || die 'rclone não instalado'
command -v python3 >/dev/null 2>&1 || die 'python3 não instalado'

for definition in \
  "KASSINAO_DATA_ROOT:$DATA_DIR" \
  "RECORDINGS_DIR:$REC_DIR" \
  "STATE_DIR:$STATE_DIR" \
  "AUTH_STATE_DIR:$AUTH_DIR"; do
  name="${definition%%:*}"
  value="${definition#*:}"
  case "$value" in
    /*) ;;
    *) die "$name precisa ser um caminho absoluto" ;;
  esac
done

for dir in "$DATA_DIR" "$REC_DIR" "$STATE_DIR" "$AUTH_DIR"; do
  [ -d "$dir" ] || die "diretório obrigatório não encontrado: $dir"
  [ ! -L "$dir" ] || die "diretório não pode ser link simbólico: $dir"
done
DATA_REAL="$(cd -- "$DATA_DIR" && pwd -P)"
REC_REAL="$(cd -- "$REC_DIR" && pwd -P)"
STATE_REAL="$(cd -- "$STATE_DIR" && pwd -P)"
AUTH_REAL="$(cd -- "$AUTH_DIR" && pwd -P)"

# Um formato fixo torna o arquivo restaurável sem carregar caminhos do host e
# impede prefix bypass (/var/lib/kassinao-old, state/recordings, etc.).
[ "$REC_REAL" = "$DATA_REAL/recordings" ] || \
  die 'RECORDINGS_DIR precisa ser exatamente KASSINAO_DATA_ROOT/recordings'
[ "$STATE_REAL" = "$DATA_REAL/state" ] || \
  die 'STATE_DIR precisa ser exatamente KASSINAO_DATA_ROOT/state'
[ "$AUTH_REAL" = "$DATA_REAL/auth" ] || \
  die 'AUTH_STATE_DIR precisa ser exatamente KASSINAO_DATA_ROOT/auth'
[ "$REC_REAL" != "$STATE_REAL" ] && [ "$REC_REAL" != "$AUTH_REAL" ] && [ "$STATE_REAL" != "$AUTH_REAL" ] || \
  die 'recordings, state e auth precisam ser diretórios distintos'

env -i "PATH=$PATH" "HOME=${HOME:-/root}" "$STORAGE_VERIFIER" \
  "$DATA_REAL" "$REC_REAL" "$STATE_REAL" "$AUTH_REAL" || \
  die 'storage ativo não passou na prova dm-crypt/LUKS; backup cancelado'

if [ ! -f "$RCLONE_CONFIG_FILE" ] || [ -L "$RCLONE_CONFIG_FILE" ]; then
  die 'RCLONE_CONFIG precisa ser um arquivo regular, não um link simbólico'
fi
case "$RCLONE_CONFIG_FILE" in
  /*) ;;
  *) die 'RCLONE_CONFIG precisa ser um caminho absoluto' ;;
esac
[ -O "$RCLONE_CONFIG_FILE" ] || die 'RCLONE_CONFIG precisa pertencer ao usuário atual'
config_mode="$(portable_mode "$RCLONE_CONFIG_FILE")"
if (( (8#$config_mode & 077) != 0 )); then
  die 'RCLONE_CONFIG permite acesso de grupo/outros; execute chmod 600'
fi
case "$REMOTE" in
  *:*) ;;
  *) die 'RCLONE_REMOTE precisa usar a forma remoto:caminho' ;;
esac
remote_name="${REMOTE%%:*}:"
remote_type="$(
  rclone --config "$RCLONE_CONFIG_FILE" listremotes --long |
    awk -v wanted="$remote_name" '$1 == wanted { print $2; exit }'
)"
[ "$remote_type" = crypt ] || \
  die "$remote_name precisa ser um remoto do tipo crypt (tipo encontrado: ${remote_type:-nenhum})"

# O tar não é um snapshot transacional. Parar o único writer antes de
# enumerar arquivos é o que torna recordings + state coerentes entre si.
if command -v "$DOCKER" >/dev/null 2>&1 && "$DOCKER" inspect "$CONTAINER" >/dev/null 2>&1; then
  mounts_json="$("$DOCKER" inspect -f '{{json .Mounts}}' "$CONTAINER" 2>/dev/null)" || \
    die 'não foi possível provar os mounts do core'
  python3 -c '
import json, os, sys
mounts=json.load(sys.stdin)
expected={
    "/app/recordings": os.path.realpath(sys.argv[1]),
    "/app/state": os.path.realpath(sys.argv[2]),
    "/app/auth": os.path.realpath(sys.argv[3]),
}
found={}
for mount in mounts:
    target=mount.get("Destination")
    if target in expected:
        if mount.get("Type") != "bind": raise SystemExit(1)
        found[target]=os.path.realpath(mount.get("Source") or "")
if found != expected: raise SystemExit(1)
' "$REC_REAL" "$STATE_REAL" "$AUTH_REAL" <<<"$mounts_json" || \
    die 'o container indicado não é o writer exato dos três diretórios privados'
  container_running="$("$DOCKER" inspect -f '{{.State.Running}}' "$CONTAINER")"
  case "$container_running" in
    true)
      if [ "$STOP_CONTAINER" != true ]; then
        die 'o core está rodando; pare-o ou use BACKUP_STOP_CONTAINER=true numa janela de manutenção'
      fi
      RESTART_CONTAINER=true
      "$DOCKER" stop "$CONTAINER" >/dev/null
      [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$CONTAINER")" = false ] || \
        die 'o Docker não confirmou o core parado; backup cancelado'
      ;;
    false) ;;
    *) die 'o Docker não informou se o core está parado; backup cancelado' ;;
  esac
elif [ "$ASSUME_QUIESCED" != true ]; then
  die 'não foi possível confirmar o core parado; use BACKUP_ASSUME_QUIESCED=true somente com o writer realmente inativo'
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE_NAME="kassinao-$STAMP.tar.gz"
# The plaintext archive exists only while it is uploaded and verified. Keep it
# on the same host-encrypted filesystem as DATA_ROOT; /tmp may be unencrypted.
TMP="$(mktemp -d "$DATA_REAL/.backup.XXXXXX")"
ARCHIVE="$TMP/$ARCHIVE_NAME"
REMOTE_ROOT="${REMOTE%/}"
printf '%s\n' \
  'format=kassinao-backup-v2' \
  "created_at_utc=$STAMP" \
  'contains=recordings,state' \
  'excludes=auth,session-secrets,temporary-files,caches' \
  > "$TMP/BACKUP-MANIFEST.txt"

# Os únicos top-levels privados no arquivo são recordings/ e state/. Isso
# exclui auth/ por construção, inclusive quando surgirem novos arquivos nele.
tar \
  --exclude='./recordings/cache' \
  --exclude='./recordings/.cache' \
  --exclude='./state/cache' \
  --exclude='./state/.cache' \
  --exclude='*.tmp' \
  --exclude='*/.cookie-secret' \
  --exclude='*/.instance-id' \
  --exclude='*/.web-sessions.json' \
  --exclude='*/web-sessions.json' \
  --exclude='*/.mcp-sessions.json' \
  --exclude='*/mcp-sessions.json' \
  -czf "$ARCHIVE" \
  -C "$DATA_REAL" ./recordings ./state \
  -C "$TMP" ./BACKUP-MANIFEST.txt

archive_listing="$TMP/archive.list"
tar -tzf "$ARCHIVE" > "$archive_listing"
grep -Fxq './recordings/' "$archive_listing" || die 'arquivo não contém recordings/'
grep -Fxq './state/' "$archive_listing" || die 'arquivo não contém state/'
grep -Fxq './BACKUP-MANIFEST.txt' "$archive_listing" || die 'arquivo não contém manifesto de restauração'
if grep -Eq '^\./auth(/|$)' "$archive_listing"; then
  die 'invariante violado: auth apareceu no arquivo'
fi

# O writer só precisa ficar parado até o tar local estar íntegro. A parte
# lenta (upload + download de verificação) acontece com o serviço novamente
# online e com o watchdog liberado; o lock exclusivo do job continua ativo.
if [ "$RESTART_CONTAINER" = true ]; then
  start_and_wait_healthy || die 'o core não voltou saudável após o snapshot; lock mantido'
  RESTART_CONTAINER=false
fi
flock -u 9
exec 9>&-

# Upload imutável e comparação ponta a ponta dos bytes criptografados.
rclone --config "$RCLONE_CONFIG_FILE" copyto \
  "$ARCHIVE" "$REMOTE_ROOT/$ARCHIVE_NAME" --immutable
rclone --config "$RCLONE_CONFIG_FILE" check \
  "$TMP" "$REMOTE_ROOT" \
  --include "/$ARCHIVE_NAME" --one-way --download --checkers 1

size="$(du -h "$ARCHIVE" | cut -f1)"
printf 'backup consistente e verificado: %s (%s)\n' "$ARCHIVE_NAME" "$size"
printf 'retenção: configure lifecycle/object lock no provedor; auth não foi copiado\n'
