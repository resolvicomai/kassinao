#!/bin/bash -p
# Remove somente arquivos de backup antigos, usando uma credencial separada da
# credencial de upload. Prefira lifecycle/object lock no provedor quando houver.
set -euo pipefail
umask 077

_saved_deploy_dir="${KASSINAO_DEPLOY_DIR-}"
_saved_env_file="${KASSINAO_ENV_FILE-}"
_saved_remote="${RCLONE_RETENTION_REMOTE-}"
_saved_rclone_config="${RCLONE_RETENTION_CONFIG-}"
_saved_keep_days="${BACKUP_KEEP_DAYS-}"
_saved_max_delete="${BACKUP_MAX_DELETE-}"
_saved_dry_run="${BACKUP_RETENTION_DRY_RUN-}"
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
[ -r "/proc/$$/environ" ] || { printf 'ERRO: /proc é obrigatório para limpar o ambiente da retenção.\n' >&2; exit 1; }
while IFS='=' read -r -d '' _inherited_name _inherited_value; do
  unset "$_inherited_name" 2>/dev/null || true
done < "/proc/$$/environ"
unset _inherited_name _inherited_value

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME=/root
LC_ALL=C
export PATH HOME LC_ALL
KASSINAO_DEPLOY_DIR="$_saved_deploy_dir"
KASSINAO_ENV_FILE="$_saved_env_file"
RCLONE_RETENTION_REMOTE="$_saved_remote"
RCLONE_RETENTION_CONFIG="$_saved_rclone_config"
BACKUP_KEEP_DAYS="$_saved_keep_days"
BACKUP_MAX_DELETE="$_saved_max_delete"
BACKUP_RETENTION_DRY_RUN="$_saved_dry_run"
export KASSINAO_DEPLOY_DIR KASSINAO_ENV_FILE RCLONE_RETENTION_REMOTE RCLONE_RETENTION_CONFIG
export BACKUP_KEEP_DAYS BACKUP_MAX_DELETE BACKUP_RETENTION_DRY_RUN

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) printf 'ERRO: caminho da retenção não é canônico.\n' >&2; exit 1 ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) printf 'ERRO: retenção precisa executar do kit selado.\n' >&2; exit 1 ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) printf 'ERRO: arquitetura sem runtime no-dump.\n' >&2; exit 1 ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/backup-retention.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || { printf 'ERRO: core limit da retenção não ficou selado.\n' >&2; exit 1; }
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[ "$_no_dump_filter" = 0 ] || { printf 'ERRO: coredump_filter da retenção não ficou selado.\n' >&2; exit 1; }
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_DIR="${KASSINAO_DEPLOY_DIR:-$PROJECT_DIR}"
ENV_FILE="${KASSINAO_ENV_FILE:-$DEPLOY_DIR/.env}"
REMOTE="${RCLONE_RETENTION_REMOTE:?Defina RCLONE_RETENTION_REMOTE}"
RCLONE_CONFIG_FILE="${RCLONE_RETENTION_CONFIG:?Defina RCLONE_RETENTION_CONFIG}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
MAX_DELETE="${BACKUP_MAX_DELETE:-100}"
RUNTIME_DIR=/run/lock/kassinao
LOCK_FILE="$RUNTIME_DIR/backup-retention.lock"
DRY_RUN="${BACKUP_RETENTION_DRY_RUN:-0}"

die() {
  echo "ERRO: $*" >&2
  exit 1
}
ulimit -c 0 2>/dev/null || die 'não foi possível desabilitar core dumps da retenção'

clean_child() {
  env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" "$@"
}

portable_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
portable_owner_group() { stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"; }
portable_link_count() { stat -c '%h' "$1" 2>/dev/null || stat -f '%l' "$1"; }

require_private_env_file() {
  local file="$1" canonical
  case "$file" in /*) ;; *) die 'KASSINAO_ENV_FILE precisa ser absoluto' ;; esac
  [ -f "$file" ] && [ ! -L "$file" ] && [ -O "$file" ] || \
    die 'KASSINAO_ENV_FILE precisa ser arquivo regular privado do operador'
  canonical="$(cd -- "$(dirname -- "$file")" && pwd -P)/$(basename -- "$file")"
  [ "$canonical" = "$file" ] && [ "$(portable_mode "$file")" = 600 ] || \
    die 'KASSINAO_ENV_FILE precisa ser canônico e 0600'
}

env_value() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 2; print value }
  ' "$ENV_FILE" || die "$key precisa aparecer exatamente uma vez em KASSINAO_ENV_FILE"
}

require_private_env_file "$ENV_FILE"
HOST_SCOPE="$(env_value KASSINAO_HOST_SCOPE)"
case "$HOST_SCOPE" in dedicated | shared) ;; *) die 'KASSINAO_HOST_SCOPE aceita somente dedicated ou shared' ;; esac

case "$DRY_RUN" in
  0 | 1) ;;
  *) die "BACKUP_RETENTION_DRY_RUN precisa ser 0 ou 1" ;;
esac

case "$REMOTE" in *:*) ;; *) die "RCLONE_RETENTION_REMOTE precisa usar a forma remoto:caminho" ;; esac
remote_name_without_colon="${REMOTE%%:*}"
remote_path="${REMOTE#*:}"
[[ "$remote_name_without_colon" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || \
  die 'RCLONE_RETENTION_REMOTE usa um nome de remoto inválido'
[ -n "$remote_path" ] || die 'RCLONE_RETENTION_REMOTE precisa incluir um caminho não vazio'
[[ "$remote_path" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || \
  die 'RCLONE_RETENTION_REMOTE precisa incluir um caminho seguro'
case "/$remote_path/" in *'/../'* | *'/./'* | *'//'*) die 'RCLONE_RETENTION_REMOTE precisa incluir um caminho seguro, sem . ou ..' ;; esac

command -v rclone >/dev/null 2>&1 || die "rclone não instalado"
command -v flock >/dev/null 2>&1 || die "flock não instalado"
[[ "$KEEP_DAYS" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_KEEP_DAYS precisa ser inteiro positivo"
[[ "$MAX_DELETE" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_MAX_DELETE precisa ser inteiro positivo"
if [ ! -f "$RCLONE_CONFIG_FILE" ] || [ -L "$RCLONE_CONFIG_FILE" ]; then
  die "RCLONE_RETENTION_CONFIG precisa ser um arquivo regular, não um link simbólico"
fi
[ -O "$RCLONE_CONFIG_FILE" ] || die "RCLONE_RETENTION_CONFIG precisa pertencer ao usuário atual"

config_mode="$(portable_mode "$RCLONE_CONFIG_FILE")"
if (( (8#$config_mode & 077) != 0 )); then
  die "RCLONE_RETENTION_CONFIG permite acesso de grupo/outros; execute chmod 600"
fi
if [ "$HOST_SCOPE" = shared ]; then
  DATA_ROOT="$(env_value KASSINAO_DATA_ROOT)"
  [ -d "$DATA_ROOT" ] && [ ! -L "$DATA_ROOT" ] && [ "$(cd -- "$DATA_ROOT" && pwd -P)" = "$DATA_ROOT" ] || \
    die 'KASSINAO_DATA_ROOT shared precisa ser diretório canônico'
  STORAGE_VERIFIER=/usr/local/sbin/kassinao-verify-shared-luks-storage
  [ -x "$STORAGE_VERIFIER" ] && [ ! -L "$STORAGE_VERIFIER" ] || \
    die 'verificador de storage shared ausente, sem execução ou symlink'
  clean_child "KASSINAO_ENV_FILE=$ENV_FILE" \
    "$STORAGE_VERIFIER" >/dev/null || die 'storage shared não passou na prova dm-crypt/LUKS'
  expected_retention_config="$DATA_ROOT/config/backup-retention-rclone.conf"
  [ "$RCLONE_CONFIG_FILE" = "$expected_retention_config" ] || \
    die 'no adapter shared, RCLONE_RETENTION_CONFIG precisa ser DATA_ROOT/config/backup-retention-rclone.conf'
  [ "$(cd -- "$(dirname -- "$RCLONE_CONFIG_FILE")" && pwd -P)/$(basename -- "$RCLONE_CONFIG_FILE")" = "$RCLONE_CONFIG_FILE" ] || \
    die 'RCLONE_RETENTION_CONFIG shared precisa usar caminho canônico'
  [ "$(portable_link_count "$RCLONE_CONFIG_FILE")" = 1 ] || \
    die 'RCLONE_RETENTION_CONFIG shared não pode possuir hardlinks'
  config_parent="$(dirname -- "$RCLONE_CONFIG_FILE")"
  [ -d "$config_parent" ] && [ ! -L "$config_parent" ] && \
    [ "$(portable_mode "$config_parent"):$(portable_owner_group "$config_parent")" = "700:$(id -u):$(id -g)" ] || \
    die 'DATA_ROOT/config precisa ser diretório privado 0700 do operador'
  command -v findmnt >/dev/null 2>&1 || die 'findmnt não instalado'
  config_mount="$(findmnt -n -o TARGET -T "$RCLONE_CONFIG_FILE" 2>/dev/null)" || \
    die 'não foi possível provar o mount cifrado de RCLONE_RETENTION_CONFIG'
  [ "$(cd -- "$config_mount" && pwd -P)" = "$DATA_ROOT" ] || \
    die 'RCLONE_RETENTION_CONFIG shared precisa permanecer no mesmo mount dm-crypt/LUKS de DATA_ROOT'
fi

remote_name="${REMOTE%%:*}:"
remote_type="$(
  clean_child rclone --config "$RCLONE_CONFIG_FILE" listremotes --long |
    awk -v wanted="$remote_name" '$1 == wanted { print $2; exit }'
)"
[ "$remote_type" = "crypt" ] || \
  die "$remote_name precisa ser um remoto do tipo crypt (tipo encontrado: ${remote_type:-nenhum})"

[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] && \
  [ "$(readlink -f -- "$RUNTIME_DIR")" = "$RUNTIME_DIR" ] && \
  [ "$(stat -c '%a:%u:%g' "$RUNTIME_DIR" 2>/dev/null || true)" = 700:0:0 ] || \
  die 'diretório /run/lock/kassinao precisa ser canônico, 0700 e root:root'
[ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] && \
  [ "$(readlink -f -- "$LOCK_FILE")" = "$LOCK_FILE" ] && \
  [ "$(stat -c '%a:%u:%g:%h' "$LOCK_FILE" 2>/dev/null || true)" = 600:0:0:1 ] || \
  die 'backup-retention.lock precisa preexistir como regular 0600 root:root sem hardlink'
exec 9<>"$LOCK_FILE"
[ "$(stat -Lc '%a:%u:%g:%h' "/proc/$$/fd/9" 2>/dev/null || true)" = 600:0:0:1 ] && \
  [ "$(readlink -f -- "/proc/$$/fd/9" 2>/dev/null || true)" = "$LOCK_FILE" ] && \
  [ "$(stat -c '%d:%i' "$LOCK_FILE" 2>/dev/null || true)" = "$(stat -Lc '%d:%i' "/proc/$$/fd/9" 2>/dev/null || true)" ] || \
  die 'backup-retention.lock mudou durante a abertura'
flock -n 9 || die "já existe uma retenção em execução"

extra_args=()
if [ "$DRY_RUN" = "1" ]; then
  extra_args+=(--dry-run)
fi

clean_child rclone --config "$RCLONE_CONFIG_FILE" delete "${REMOTE%/}" \
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
