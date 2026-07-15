#!/bin/bash -p
# Prova o storage dm-crypt/LUKS escopado a uma instância em host compartilhado.
# O perfil shared não altera swap global, mas falha fechado se o host puder
# paginar plaintext: zero swap é aceito; cada swap ativo precisa provar dm-crypt.
set -Eeuo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

root_only=false
case "${1:-}" in
  '') ;;
  --root-only) root_only=true; shift ;;
  *) die 'uso: verify-shared-luks-storage.sh [--root-only]' ;;
esac
[ "$#" -eq 0 ] || die 'uso: verify-shared-luks-storage.sh [--root-only]'

# Preserve somente o seletor não secreto do arquivo de configuração. Todo o
# restante do ambiente privilegiado, inclusive PATH e HOME herdados, é negado.
SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
env_file_override_set=false
env_file_override=''
if [ "${KASSINAO_ENV_FILE+x}" = x ]; then
  env_file_override_set=true
  env_file_override="$KASSINAO_ENV_FILE"
fi
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente do verificador shared'
while IFS='=' read -r -d '' inherited_name inherited_value; do unset "$inherited_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset inherited_name inherited_value
export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C
if [ "$env_file_override_set" = true ]; then export KASSINAO_ENV_FILE="$env_file_override"; fi

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do verificador shared não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in
  */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;;
  /usr/local/sbin)
    marker=/etc/kassinao/host-controls.env
    [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(stat -c '%a:%u:%g:%h' "$marker" 2>/dev/null || true)" = 600:0:0:1 ] ||
      die 'marker do kit operacional está ausente ou irregular'
    PROJECT_DIR="$(awk -F= '$1 == "KASSINAO_DEPLOY_DIR" { if (seen++) exit 2; print substr($0, index($0,"=")+1) } END { if (seen != 1) exit 2 }' "$marker")" ||
      die 'marker do kit não contém deploy dir único'
    _script_path="$PROJECT_DIR/scripts/verify-shared-luks-storage.sh"
    ;;
  *) die 'verificador shared precisa executar do kit ou do entrypoint instalado' ;;
esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/verify-shared-luks-storage.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do verificador shared não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[ "$_no_dump_filter" = 0 ] || die 'coredump_filter do verificador shared não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$(id -u)" -eq 0 ] || die 'execute como root'

for command in awk cat cryptsetup findmnt grep losetup lsblk mountpoint readlink stat swapon tr; do
  command -v "$command" >/dev/null 2>&1 || die "$command é obrigatório"
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
if [ "${KASSINAO_ENV_FILE+x}" = x ]; then
  ENV_FILE="$KASSINAO_ENV_FILE"
elif [ "$SCRIPT_DIR" = /usr/local/sbin ]; then
  ENV_FILE=/etc/kassinao/shared.env
else
  ENV_FILE="$ROOT/.env"
fi
case "$ENV_FILE" in /*) ;; *) die 'KASSINAO_ENV_FILE precisa ser caminho absoluto' ;; esac
[ "$(readlink -f -- "$ENV_FILE")" = "$ENV_FILE" ] || die 'KASSINAO_ENV_FILE precisa ser canônico'

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

canonical_path_value() {
  local key="$1" value
  value="$(env_value "$key")"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "$key precisa ser caminho absoluto simples"
  case "$value" in
    *//* | */./* | */../* | */. | */.. | */) die "$key precisa ser canônico" ;;
  esac
  printf '%s' "$value"
}

data_root="$(canonical_path_value KASSINAO_DATA_ROOT)"
recordings="$(canonical_path_value KASSINAO_RECORDINGS_DIR)"
state="$(canonical_path_value KASSINAO_STATE_DIR)"
auth="$(canonical_path_value KASSINAO_AUTH_DIR)"
cache="$(canonical_path_value KASSINAO_MODEL_CACHE_DIR)"
app_env="$(canonical_path_value KASSINAO_SHARED_APP_ENV_FILE)"
tunnel_token="$(canonical_path_value KASSINAO_SHARED_TUNNEL_TOKEN_FILE)"
backing_file="$(canonical_path_value KASSINAO_SHARED_LUKS_BACKING_FILE)"
mapper="$(env_value KASSINAO_SHARED_LUKS_MAPPER)"
uuid="$(env_value KASSINAO_SHARED_LUKS_UUID)"
uid="$(env_value KASSINAO_UID)"
gid="$(env_value KASSINAO_GID)"

[[ "$mapper" =~ ^[A-Za-z0-9][A-Za-z0-9_.+-]{0,126}$ ]] ||
  die 'KASSINAO_SHARED_LUKS_MAPPER possui formato inválido'
[[ "$uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
  die 'KASSINAO_SHARED_LUKS_UUID precisa ser UUID canônico em minúsculas'
[[ "$uid" =~ ^[0-9]+$ ]] && [ "$uid" -ge 61000 ] && [ "$uid" -le 61183 ] ||
  die 'KASSINAO_UID shared precisa ficar na faixa privada 61000..61183'
[[ "$gid" =~ ^[0-9]+$ ]] && [ "$gid" -ge 61000 ] && [ "$gid" -le 61183 ] ||
  die 'KASSINAO_GID shared precisa ficar na faixa privada 61000..61183'

case "$data_root" in
  / | /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /proc | /root | /run | /sbin | /sys | /tmp | /usr | /var | /var/lib | /var/tmp | /media | /mnt | /opt | /srv)
    die 'KASSINAO_DATA_ROOT precisa ser um mount dedicado'
    ;;
esac
[ "$recordings" = "$data_root/recordings" ] &&
  [ "$state" = "$data_root/state" ] &&
  [ "$auth" = "$data_root/auth" ] &&
  [ "$cache" = "$data_root/cache" ] ||
  die 'mounts privados precisam ser filhos exatos de KASSINAO_DATA_ROOT'
config_dir="$data_root/config"
[ "$app_env" = "$config_dir/app.env" ] &&
  [ "$tunnel_token" = "$config_dir/cloudflared-token" ] ||
  die 'arquivos de segredo shared precisam usar os caminhos exatos sob DATA_ROOT/config'
case "$backing_file" in "$data_root" | "$data_root"/*) die 'backing file LUKS não pode ficar dentro do próprio mount' ;; esac

[ -d "$data_root" ] && [ ! -L "$data_root" ] &&
  [ "$(readlink -f -- "$data_root")" = "$data_root" ] ||
  die 'KASSINAO_DATA_ROOT precisa existir como diretório canônico, sem symlink'
[ "$(stat -c '%a:%u:%g' "$data_root" 2>/dev/null || true)" = '700:0:0' ] ||
  die 'KASSINAO_DATA_ROOT precisa ser 0700 root:root'

[ -f "$backing_file" ] && [ ! -L "$backing_file" ] &&
  [ "$(readlink -f -- "$backing_file")" = "$backing_file" ] ||
  die 'backing file LUKS precisa ser arquivo regular canônico, sem symlink'
[ "$(stat -c '%a:%u:%g' "$backing_file" 2>/dev/null || true)" = '600:0:0' ] ||
  die 'backing file LUKS precisa ser 0600 root:root'
[ "$(stat -c '%h' -- "$backing_file" 2>/dev/null || true)" = 1 ] ||
  die 'backing file LUKS não pode possuir hardlinks'
backing_allocation="$(stat -c '%s:%b' -- "$backing_file" 2>/dev/null || true)"
IFS=: read -r backing_size backing_blocks <<<"$backing_allocation"
[[ "$backing_size" =~ ^[0-9]+$ ]] && [[ "$backing_blocks" =~ ^[0-9]+$ ]] &&
  (( backing_blocks * 512 >= backing_size )) ||
  die 'backing file LUKS precisa estar totalmente alocado, sem sparse/compressão aparente'
backing_fstype="$(findmnt -n -o FSTYPE -T "$backing_file" 2>/dev/null)" ||
  die 'não foi possível provar o filesystem do backing LUKS'
case "$backing_fstype" in ext2 | ext3 | ext4 | xfs) ;; *) die 'filesystem do backing LUKS não possui semântica de alocação suportada' ;; esac

cursor="$(dirname -- "$backing_file")"
while :; do
  metadata="$(stat -c '%a:%u:%g' "$cursor" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  [ "${metadata#*:}" = '0:0' ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die 'backing file LUKS exige toda a parent-chain root-owned e sem escrita de grupo/outros'
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done

mountpoint -q -- "$data_root" || die 'KASSINAO_DATA_ROOT precisa ser um mountpoint ativo'
mount_target="$(findmnt -n -o TARGET -T "$data_root" 2>/dev/null)" ||
  die 'não foi possível resolver o mount de KASSINAO_DATA_ROOT'
[ "$(readlink -f -- "$mount_target")" = "$data_root" ] ||
  die 'KASSINAO_DATA_ROOT precisa ser a raiz exata do mount LUKS'

mapper_path="/dev/mapper/$mapper"
mount_source="$(findmnt -n -o SOURCE -T "$data_root" 2>/dev/null)" ||
  die 'não foi possível resolver a origem do mount LUKS'
[ "$(readlink -f -- "$mount_source")" = "$(readlink -f -- "$mapper_path")" ] ||
  die 'mount de KASSINAO_DATA_ROOT não usa o mapper LUKS configurado'

mount_options=",$(findmnt -n -o OPTIONS -T "$data_root" 2>/dev/null),"
for option in rw nodev nosuid noexec; do
  case "$mount_options" in *",$option,"*) ;; *) die "mount LUKS precisa da opção $option" ;; esac
done

cryptsetup isLuks "$backing_file" >/dev/null 2>&1 || die 'backing file não contém um header LUKS válido'
actual_uuid="$(cryptsetup luksUUID "$backing_file" 2>/dev/null | tr 'A-F' 'a-f')" ||
  die 'não foi possível ler o UUID LUKS'
[ "$actual_uuid" = "$uuid" ] || die 'UUID do backing file diverge de KASSINAO_SHARED_LUKS_UUID'

crypt_status="$(cryptsetup status "$mapper" 2>/dev/null)" || die 'mapper LUKS configurado não está ativo'
grep -Eq '^[[:space:]]*type:[[:space:]]+LUKS2[[:space:]]*$' <<<"$crypt_status" ||
  die 'mapper ativo não foi provado como LUKS2'
loop_device="$(awk '$1 == "device:" { print $2; count++ } END { if (count != 1) exit 2 }' <<<"$crypt_status")" ||
  die 'cryptsetup status não informou um único device de origem'
case "$loop_device" in /dev/loop[0-9]*) ;; *) die 'mapper LUKS não usa um loop device escopado' ;; esac
loop_backing="$(losetup --noheadings --output BACK-FILE "$loop_device" 2>/dev/null | awk 'NF { print; count++ } END { if (count != 1) exit 2 }')" ||
  die 'não foi possível provar o backing file do loop device'
[ "$(readlink -f -- "$loop_backing")" = "$backing_file" ] ||
  die 'loop device ativo aponta para backing file diferente do configurado'
backing_inode="$(stat -c '%i' -- "$backing_file" 2>/dev/null)" ||
  die 'não foi possível ler o inode do backing file LUKS'
backing_device="$(findmnt -n -o MAJ:MIN -T "$backing_file" 2>/dev/null)" ||
  die 'não foi possível ler o device do backing file LUKS'
loop_identity="$(losetup --noheadings --output BACK-INO,BACK-MAJ:MIN "$loop_device" 2>/dev/null |
  awk 'NF == 2 { print $1 ":" $2; count++ } END { if (count != 1) exit 2 }')" ||
  die 'não foi possível provar device e inode do backing file aberto pelo loop'
[ "$loop_identity" = "$backing_inode:$backing_device" ] ||
  die 'device/inode do backing file aberto pelo loop diverge do arquivo configurado'
mapper_types="$(lsblk -s -n -o TYPE -- "$mapper_path" 2>/dev/null)" ||
  die 'não foi possível inventariar a cadeia do mapper'
grep -Fxq crypt <<<"$mapper_types" || die 'cadeia do mapper não contém um target dm-crypt'

active_swaps="$(swapon --show --noheadings --raw --output NAME 2>/dev/null)" ||
  die 'não foi possível inventariar swaps ativos'
while IFS= read -r swap_source; do
  [ -n "$swap_source" ] || continue
  case "$swap_source" in /dev/*) ;; *) die 'swap ativo plaintext ou não-device foi recusado' ;; esac
  swap_types="$(lsblk -s -n -o TYPE -- "$swap_source" 2>/dev/null)" ||
    die 'não foi possível inventariar a cadeia do swap ativo'
  grep -Fxq crypt <<<"$swap_types" || die 'todo swap ativo precisa estar sobre dm-crypt'
done <<<"$active_swaps"

if [ "$root_only" = true ]; then
  printf 'Storage shared LUKS raiz verificado antes de qualquer mutação.\n'
  exit 0
fi

sentinel="$data_root/.kassinao-mounted"
[ -f "$sentinel" ] && [ ! -L "$sentinel" ] || die 'sentinel .kassinao-mounted ausente ou irregular'
[ "$(readlink -f -- "$sentinel")" = "$sentinel" ] || die 'sentinel .kassinao-mounted não é canônico'
[ "$(stat -c '%a:%u:%g' "$sentinel" 2>/dev/null || true)" = '400:0:0' ] ||
  die 'sentinel .kassinao-mounted precisa ser 0400 root:root'
sentinel_target="$(findmnt -n -o TARGET -T "$sentinel" 2>/dev/null)" ||
  die 'não foi possível resolver o mount da sentinel .kassinao-mounted'
[ "$(readlink -f -- "$sentinel_target")" = "$data_root" ] ||
  die 'sentinel .kassinao-mounted não está na raiz LUKS configurada'
expected_sentinel="$(printf 'kassinao-shared-luks-v1\nuuid=%s\nmapper=%s' "$uuid" "$mapper")"
actual_sentinel="$(cat -- "$sentinel"; printf '\037')"
expected_sentinel_with_marker="${expected_sentinel}"$'\n\037'
[ "$actual_sentinel" = "$expected_sentinel_with_marker" ] ||
  die 'sentinel .kassinao-mounted diverge do mapper/UUID configurado'

for child in "$recordings" "$state" "$auth" "$cache"; do
  [ -d "$child" ] && [ ! -L "$child" ] && [ "$(readlink -f -- "$child")" = "$child" ] ||
    die "diretório privado ausente, não canônico ou symlink: $child"
  [ "$(stat -c '%a:%u:%g' "$child" 2>/dev/null || true)" = "700:$uid:$gid" ] ||
    die "diretório privado precisa ser 0700 $uid:$gid: $child"
  child_target="$(findmnt -n -o TARGET -T "$child" 2>/dev/null)" ||
    die "não foi possível resolver o mount do diretório privado: $child"
  [ "$(readlink -f -- "$child_target")" = "$data_root" ] ||
    die "diretório privado não está no mesmo mount LUKS de DATA_ROOT: $child"
done

[ -d "$config_dir" ] && [ ! -L "$config_dir" ] && [ "$(readlink -f -- "$config_dir")" = "$config_dir" ] ||
  die 'diretório de configuração shared ausente, não canônico ou symlink'
[ "$(stat -c '%a:%u:%g' "$config_dir" 2>/dev/null || true)" = '700:0:0' ] ||
  die 'diretório de configuração shared precisa ser 0700 root:root'
config_target="$(findmnt -n -o TARGET -T "$config_dir" 2>/dev/null)" ||
  die 'não foi possível resolver o mount do diretório de configuração shared'
[ "$(readlink -f -- "$config_target")" = "$data_root" ] ||
  die 'diretório de configuração shared não está no mesmo mount LUKS de DATA_ROOT'

for secret_file in "$app_env" "$tunnel_token"; do
  [ -f "$secret_file" ] && [ ! -L "$secret_file" ] && [ "$(readlink -f -- "$secret_file")" = "$secret_file" ] ||
    die "arquivo de segredo shared ausente, não canônico ou symlink: $secret_file"
  [ "$(stat -c '%h' -- "$secret_file" 2>/dev/null || true)" = 1 ] ||
    die "arquivo de segredo shared não pode possuir hardlinks: $secret_file"
  secret_target="$(findmnt -n -o TARGET -T "$secret_file" 2>/dev/null)" ||
    die "não foi possível resolver o mount do arquivo de segredo shared: $secret_file"
  [ "$(readlink -f -- "$secret_target")" = "$data_root" ] ||
    die "arquivo de segredo shared não está no mesmo mount LUKS de DATA_ROOT: $secret_file"
done
[ "$(stat -c '%a:%u:%g' "$app_env" 2>/dev/null || true)" = "440:0:$gid" ] ||
  die "KASSINAO_SHARED_APP_ENV_FILE precisa ser 0440 root:$gid"
[ "$(stat -c '%a:%u:%g' "$tunnel_token" 2>/dev/null || true)" = '444:0:0' ] ||
  die 'KASSINAO_SHARED_TUNNEL_TOKEN_FILE precisa ser 0444 root:root sob parent 0700'

printf 'Storage shared LUKS completo verificado.\n'
