#!/bin/bash -p
# Materializa somente os quatro diretórios privados depois que o operador já
# montou e selou um volume dm-crypt/LUKS. Este script nunca cria, altera ou
# assume ownership de KASSINAO_DATA_ROOT.
set -Eeuo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 0 ] || die 'uso: prepare-storage.sh'
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente do preparo de storage'
while IFS='=' read -r -d '' _name _value; do unset "$_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset _name _value
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do preparo de storage não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'preparo de storage precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/prepare-storage.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do preparo de storage não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[ "$_no_dump_filter" = 0 ] || die 'coredump_filter do preparo de storage não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$(id -u)" -eq 0 ] || die 'execute como root'
for command in awk chmod chown mkdir pwd stat; do
  command -v "$command" >/dev/null 2>&1 || die "$command é obrigatório"
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
[ "$ROOT" = "$PROJECT_DIR" ] || die 'raiz canônica divergiu do kit selado'

# Controles privilegiados só podem sair do kit operacional selado. O .env é
# privado e mutável, portanto fica fora do manifesto e é validado separadamente.
cursor="$ROOT"
while :; do
  [ ! -e "$cursor/.git" ] || die 'o preparo de produção exige o kit operacional fora de qualquer Git'
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done

[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die 'diretório do kit ausente ou symlink'
root_metadata="$(stat -c '%a:%u:%g' "$ROOT" 2>/dev/null || true)"
case "$root_metadata" in
  700:0:0 | 500:0:0) ;;
  *) die 'diretório do kit precisa ser 0700/0500 e pertencer a root:root' ;;
esac

cursor="$ROOT"
while :; do
  metadata="$(stat -c '%a:%u:%g' "$cursor" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  owner_group="${metadata#*:}"
  [ "$owner_group" = '0:0' ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die "kit e diretórios pais precisam ser root-owned e não graváveis: $cursor"
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done

MANIFEST="$ROOT/MANIFEST.sha256"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die 'MANIFEST.sha256 do kit ausente ou irregular'
manifest_metadata="$(stat -c '%a:%u:%g' "$MANIFEST" 2>/dev/null || true)"
manifest_mode="${manifest_metadata%%:*}"
[ "${manifest_metadata#*:}" = '0:0' ] && [[ "$manifest_mode" =~ ^[0-7]+$ ]] &&
  (( (8#$manifest_mode & 022) == 0 )) ||
  die 'MANIFEST.sha256 precisa ser root-owned e não gravável por grupo/outros'

manifest_paths=()
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^([0-9a-f]{64})\ \ (\./)?([A-Za-z0-9._/-]+)$ ]] ||
    die 'MANIFEST.sha256 contém linha inválida'
  relative_path="${BASH_REMATCH[3]}"
  case "$relative_path" in
    /* | ../* | *//* | */./* | */../* | . | .. | */. | */..) die 'MANIFEST.sha256 contém caminho não canônico' ;;
  esac
  manifest_paths+=("$relative_path")
done < "$MANIFEST"
[ "${#manifest_paths[@]}" -gt 0 ] || die 'MANIFEST.sha256 está vazio'

for required_control in scripts/prepare-storage.sh scripts/verify-storage-encryption.sh; do
  matches=0
  for relative_path in "${manifest_paths[@]}"; do
    [ "$relative_path" != "$required_control" ] || matches=$((matches + 1))
  done
  [ "$matches" -eq 1 ] || die "$required_control precisa aparecer exatamente uma vez no manifesto"
done

if command -v sha256sum >/dev/null 2>&1; then
  (cd -- "$ROOT" && sha256sum -c MANIFEST.sha256 --quiet) || die 'integridade do kit diverge do manifesto'
elif command -v shasum >/dev/null 2>&1; then
  (cd -- "$ROOT" && shasum -a 256 -c MANIFEST.sha256 >/dev/null) || die 'integridade do kit diverge do manifesto'
else
  die 'sha256sum ou shasum é obrigatório'
fi

for relative_path in "${manifest_paths[@]}"; do
  source="$ROOT/$relative_path"
  [ -f "$source" ] && [ ! -L "$source" ] || die "arquivo do manifesto ausente ou symlink: $relative_path"
  metadata="$(stat -c '%a:%u:%g' "$source" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  owner_group="${metadata#*:}"
  [ "$owner_group" = '0:0' ] || die "arquivo do kit não pertence a root:root: $relative_path"
  [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die "arquivo do kit é gravável por grupo/outros: $relative_path"
done

ENV_FILE="$ROOT/.env"
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || die '.env privado ausente ou symlink'
[ "$(stat -c '%a:%u:%g' "$ENV_FILE" 2>/dev/null || true)" = '600:0:0' ] ||
  die '.env privado precisa ser 0600 e pertencer a root:root'

env_value() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 2; print value }
  ' "$ENV_FILE" || die "$key precisa aparecer exatamente uma vez em .env"
}

path_keys=(
  KASSINAO_DATA_ROOT
  KASSINAO_RECORDINGS_DIR
  KASSINAO_STATE_DIR
  KASSINAO_AUTH_DIR
  KASSINAO_MODEL_CACHE_DIR
)
storage_paths=()
for key in "${path_keys[@]}"; do
  value="$(env_value "$key")"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "$key precisa ser caminho absoluto simples"
  case "$value" in
    *//* | */./* | */../* | */. | */.. | */) die "$key precisa ser canônico" ;;
  esac
  storage_paths+=("$value")
done

data_root="${storage_paths[0]}"
case "$data_root" in
  / | /bin | /bin/* | /boot | /boot/* | /dev | /dev/* | /etc | /etc/* | \
    /home | /home/* | /lib | /lib/* | /lib64 | /lib64/* | /proc | /proc/* | \
    /root | /root/* | /run | /run/* | /sbin | /sbin/* | /sys | /sys/* | \
    /tmp | /tmp/* | /usr | /usr/* | /var | /var/lib | /var/run | /var/run/* | \
    /var/tmp | /var/tmp/* | /media | /mnt | /opt | /srv)
    die 'KASSINAO_DATA_ROOT precisa ser dedicado e ficar fora de áreas proibidas'
    ;;
esac

[ "${storage_paths[1]}" = "$data_root/recordings" ] &&
  [ "${storage_paths[2]}" = "$data_root/state" ] &&
  [ "${storage_paths[3]}" = "$data_root/auth" ] &&
  [ "${storage_paths[4]}" = "$data_root/cache" ] ||
  die 'mounts privados precisam ser filhos exatos de KASSINAO_DATA_ROOT'

uid="$(env_value KASSINAO_UID)"
gid="$(env_value KASSINAO_GID)"
[[ "$uid" =~ ^[1-9][0-9]*$ ]] && [ "$uid" -le 4294967294 ] ||
  die 'KASSINAO_UID precisa ser um identificador numérico não-root válido'
[[ "$gid" =~ ^[1-9][0-9]*$ ]] && [ "$gid" -le 4294967294 ] ||
  die 'KASSINAO_GID precisa ser um identificador numérico não-root válido'

[ -d "$data_root" ] && [ ! -L "$data_root" ] &&
  [ "$(cd -- "$data_root" && pwd -P)" = "$data_root" ] ||
  die 'KASSINAO_DATA_ROOT precisa existir como diretório canônico, sem symlink'
[ "$(stat -c '%a:%u:%g' "$data_root" 2>/dev/null || true)" = '700:0:0' ] ||
  die 'KASSINAO_DATA_ROOT precisa estar pronto como 0700 root:root'

verifier="$ROOT/scripts/verify-storage-encryption.sh"
# Gate obrigatório: nenhuma criação, chmod ou chown acontece antes desta prova.
env -i "PATH=$PATH" HOME=/root "$verifier" "$data_root" ||
  die 'KASSINAO_DATA_ROOT não passou na prova dm-crypt/LUKS'

for child in "${storage_paths[@]:1}"; do
  if [ -e "$child" ] || [ -L "$child" ]; then
    [ -d "$child" ] && [ ! -L "$child" ] && [ "$(cd -- "$child" && pwd -P)" = "$child" ] ||
      die "diretório privado existente é irregular ou symlink: $child"
  else
    mkdir -m 0700 -- "$child"
  fi
  chown -- "$uid:$gid" "$child"
  chmod -- 0700 "$child"
done

for child in "${storage_paths[@]:1}"; do
  [ -d "$child" ] && [ ! -L "$child" ] && [ "$(cd -- "$child" && pwd -P)" = "$child" ] ||
    die "diretório privado não ficou canônico: $child"
  [ "$(stat -c '%a:%u:%g' "$child" 2>/dev/null || true)" = "700:$uid:$gid" ] ||
    die "diretório privado não ficou 0700 $uid:$gid: $child"
done

env -i "PATH=$PATH" HOME=/root "$verifier" "${storage_paths[@]}" ||
  die 'diretórios privados não passaram na prova final dm-crypt/LUKS'

printf 'Storage privado preparado e verificado em %s (filhos 0700 %s:%s).\n' "$data_root" "$uid" "$gid"
