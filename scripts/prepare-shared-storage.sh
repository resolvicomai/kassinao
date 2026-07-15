#!/bin/bash -p
# Prepara os diretórios de runtime, os arquivos de configuração cifrados e a
# sentinel depois que o file-container LUKS shared já está aberto e provado.
set -Eeuo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 0 ] || die 'uso: prepare-shared-storage.sh'

# Este script roda como root. Não permita que sudo preserve PATH, HOME,
# credenciais ou funções de uma sessão interativa antes do primeiro lookup.
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente do preparo shared'
SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
while IFS='=' read -r -d '' inherited_name inherited_value; do unset "$inherited_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset inherited_name inherited_value
export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do preparo shared não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'preparo shared precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/prepare-shared-storage.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do preparo shared não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter do preparo shared não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$(id -u)" -eq 0 ] || die 'execute como root'
for command in awk cat chmod chown find findmnt mkdir python3 readlink stat; do
  command -v "$command" >/dev/null 2>&1 || die "$command é obrigatório"
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
[ "$ROOT" = "$PROJECT_DIR" ] || die 'raiz canônica divergiu do kit selado'
ENV_FILE="$ROOT/.env"
APP_ENV_TEMPLATE="$ROOT/app.env.example"
VERIFIER="$ROOT/scripts/verify-shared-luks-storage.sh"
NEIGHBOR_AUDITOR="$ROOT/scripts/audit-shared-vps-security.sh"
MANIFEST="$ROOT/MANIFEST.sha256"

# O prepare é privilegiado e só opera a partir de um bundle selado, fora de Git.
cursor="$ROOT"
while :; do
  [ ! -e "$cursor/.git" ] || die 'o preparo shared exige o kit operacional fora de qualquer Git'
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die 'diretório do kit ausente ou symlink'
root_metadata="$(stat -c '%a:%u:%g' "$ROOT" 2>/dev/null || true)"
case "$root_metadata" in 700:0:0 | 500:0:0) ;; *) die 'diretório do kit precisa ser 0700/0500 root:root' ;; esac

cursor="$ROOT"
while :; do
  metadata="$(stat -c '%a:%u:%g' "$cursor" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  [ "${metadata#*:}" = '0:0' ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die "kit e diretórios pais precisam ser root-owned e não graváveis: $cursor"
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done

[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die 'MANIFEST.sha256 ausente ou irregular'
manifest_metadata="$(stat -c '%a:%u:%g' "$MANIFEST" 2>/dev/null || true)"
manifest_mode="${manifest_metadata%%:*}"
[ "${manifest_metadata#*:}" = '0:0' ] && [[ "$manifest_mode" =~ ^[0-7]+$ ]] &&
  (( (8#$manifest_mode & 022) == 0 )) ||
  die 'MANIFEST.sha256 precisa ser root-owned e não gravável por grupo/outros'

required_controls=(
  scripts/prepare-shared-storage.sh
  scripts/verify-shared-luks-storage.sh
  scripts/audit-shared-vps-security.sh
)
for required in "${required_controls[@]}"; do
  count="$(awk -v wanted="$required" '{ path=$2; sub(/^\.\//, "", path); if (path == wanted) count++ } END { print count + 0 }' "$MANIFEST")"
  [ "$count" -eq 1 ] || die "$required precisa aparecer exatamente uma vez no manifesto"
done
template_count="$(awk '{ path=$2; sub(/^\.\//, "", path); if (path == "app.env.example") count++ } END { print count + 0 }' "$MANIFEST")"
[ "$template_count" -eq 1 ] || die 'app.env.example precisa aparecer exatamente uma vez no manifesto'
if command -v sha256sum >/dev/null 2>&1; then
  (cd -- "$ROOT" && sha256sum -c MANIFEST.sha256 --quiet) || die 'integridade do kit diverge do manifesto'
elif command -v shasum >/dev/null 2>&1; then
  (cd -- "$ROOT" && shasum -a 256 -c MANIFEST.sha256 >/dev/null) || die 'integridade do kit diverge do manifesto'
else
  die 'sha256sum ou shasum é obrigatório'
fi
for required in "${required_controls[@]}"; do
  source="$ROOT/$required"
  [ -f "$source" ] && [ ! -L "$source" ] || die "controle ausente ou symlink: $required"
  metadata="$(stat -c '%a:%u:%g' "$source" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  [ "${metadata#*:}" = '0:0' ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die "controle precisa ser root-owned e não gravável: $required"
  [ -x "$source" ] || die "controle precisa ser executável: $required"
done
[ -f "$APP_ENV_TEMPLATE" ] && [ ! -L "$APP_ENV_TEMPLATE" ] ||
  die 'app.env.example público ausente ou irregular'
template_metadata="$(stat -c '%a:%u:%g' "$APP_ENV_TEMPLATE" 2>/dev/null || true)"
template_mode="${template_metadata%%:*}"
[ "${template_metadata#*:}" = '0:0' ] && [[ "$template_mode" =~ ^[0-7]+$ ]] &&
  (( (8#$template_mode & 022) == 0 )) ||
  die 'app.env.example precisa ser root-owned e não gravável por grupo/outros'

[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || die '.env privado ausente ou symlink'
[ "$(stat -c '%a:%u:%g' "$ENV_FILE" 2>/dev/null || true)" = '600:0:0' ] ||
  die '.env privado precisa ser 0600 root:root'

env_value() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 2; print value }
  ' "$ENV_FILE" || die "$key precisa aparecer exatamente uma vez em .env"
}

data_root="$(env_value KASSINAO_DATA_ROOT)"
recordings="$(env_value KASSINAO_RECORDINGS_DIR)"
state="$(env_value KASSINAO_STATE_DIR)"
auth="$(env_value KASSINAO_AUTH_DIR)"
cache="$(env_value KASSINAO_MODEL_CACHE_DIR)"
app_env="$(env_value KASSINAO_SHARED_APP_ENV_FILE)"
tunnel_token="$(env_value KASSINAO_SHARED_TUNNEL_TOKEN_FILE)"
uid="$(env_value KASSINAO_UID)"
gid="$(env_value KASSINAO_GID)"
uuid="$(env_value KASSINAO_SHARED_LUKS_UUID)"
mapper="$(env_value KASSINAO_SHARED_LUKS_MAPPER)"
config_dir="$data_root/config"

[[ "$uid" =~ ^[0-9]+$ ]] && [ "$uid" -ge 61000 ] && [ "$uid" -le 61183 ] ||
  die 'KASSINAO_UID shared precisa ser explícito e ficar na faixa privada 61000..61183'
[[ "$gid" =~ ^[0-9]+$ ]] && [ "$gid" -ge 61000 ] && [ "$gid" -le 61183 ] ||
  die 'KASSINAO_GID shared precisa ser explícito e ficar na faixa privada 61000..61183'

[ "$app_env" = "$config_dir/app.env" ] &&
  [ "$tunnel_token" = "$config_dir/cloudflared-token" ] ||
  die 'arquivos de segredo shared precisam usar os caminhos exatos sob DATA_ROOT/config'

# Gate de ordem: até esta chamada o script fez somente leituras. O verifier
# root-only prova backing, UUID, mapper, cadeia crypt, mount e opções seguras.
# Antes disso, o audit selado recusa qualquer workload vizinho capaz de tocar
# o storage ou os segredos que este preparo criará.
env -i "PATH=$PATH" HOME=/root KASSINAO_ENV_FILE="$ENV_FILE" \
  "$NEIGHBOR_AUDITOR" --neighbors-only >/dev/null ||
  die 'auditoria read-only dos vizinhos recusou o preparo shared'
env -i "PATH=$PATH" HOME=/root KASSINAO_ENV_FILE="$ENV_FILE" "$VERIFIER" --root-only ||
  die 'raiz shared LUKS não passou na prova pré-mutation'

validate_runtime_tree() {
  local allow_missing="$1" require_owner="$2" mount_inventory
  mount_inventory="$(findmnt --json --output TARGET)" ||
    die 'não foi possível inventariar mounts antes de validar a árvore runtime shared'
  env -i "PATH=$PATH" HOME=/root LC_ALL=C python3 - \
    "$data_root" "$uid" "$gid" "$allow_missing" "$require_owner" \
    3<<<"$mount_inventory" <<'PY' || die 'árvore runtime shared contém symlink, hardlink, mount aninhado, tipo especial ou ownership divergente'
import json
import os
import stat
import sys

root, uid_raw, gid_raw, allow_missing_raw, require_owner_raw = sys.argv[1:]
uid, gid = int(uid_raw), int(gid_raw)
allow_missing = allow_missing_raw == 'true'
require_owner = require_owner_raw == 'true'
names = ('recordings', 'state', 'auth', 'cache')
root = os.path.realpath(root)
root_stat = os.lstat(root)
if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode):
    raise SystemExit(1)

try:
    mounts = json.load(os.fdopen(3, encoding='utf-8'))
except Exception:
    raise SystemExit(1)

def mount_targets(items):
    for item in items or []:
        target = item.get('target')
        if isinstance(target, str) and os.path.isabs(target):
            yield os.path.realpath(target)
        yield from mount_targets(item.get('children'))

for target in mount_targets(mounts.get('filesystems')):
    if target != root and os.path.commonpath([root, target]) == root:
        raise SystemExit(1)

def visit(path):
    metadata = os.lstat(path)
    if metadata.st_dev != root_stat.st_dev or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(1)
    mode = stat.S_IMODE(metadata.st_mode)
    if mode & 0o7000:
        raise SystemExit(1)
    if stat.S_ISDIR(metadata.st_mode):
        for child in sorted(os.listdir(path)):
            visit(os.path.join(path, child))
    elif not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise SystemExit(1)
    if require_owner and (metadata.st_uid != uid or metadata.st_gid != gid):
        raise SystemExit(1)

for name in names:
    path = os.path.join(root, name)
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        if allow_missing:
            continue
        raise SystemExit(1)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(1)
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        raise SystemExit(1)
    visit(path)
PY
}

# Valide toda a árvore existente antes da primeira alteração para não deixar
# preparo parcial quando um filho tardio ou a sentinel estiver irregular.
for child in "$recordings" "$state" "$auth" "$cache"; do
  if [ -e "$child" ] || [ -L "$child" ]; then
    [ -d "$child" ] && [ ! -L "$child" ] && [ "$(readlink -f -- "$child")" = "$child" ] ||
      die "diretório privado existente é irregular ou symlink: $child"
    child_target="$(findmnt -n -o TARGET -T "$child" 2>/dev/null)" ||
      die "não foi possível resolver o mount do diretório privado existente: $child"
    [ "$(readlink -f -- "$child_target")" = "$data_root" ] ||
      die "diretório privado existente não está no mount LUKS de DATA_ROOT: $child"
    [ "$(stat -c '%a:%u:%g' -- "$child" 2>/dev/null || true)" = "700:$uid:$gid" ] ||
      die "diretório privado existente precisa ser 0700 $uid:$gid: $child"
  fi
done

if [ -e "$config_dir" ] || [ -L "$config_dir" ]; then
  [ -d "$config_dir" ] && [ ! -L "$config_dir" ] && [ "$(readlink -f -- "$config_dir")" = "$config_dir" ] ||
    die "diretório de configuração existente é irregular ou symlink: $config_dir"
  config_target="$(findmnt -n -o TARGET -T "$config_dir" 2>/dev/null)" ||
    die 'não foi possível resolver o mount do diretório de configuração existente'
  [ "$(readlink -f -- "$config_target")" = "$data_root" ] ||
    die 'diretório de configuração existente não está no mount LUKS de DATA_ROOT'
  [ "$(stat -c '%a:%u:%g' -- "$config_dir" 2>/dev/null || true)" = '700:0:0' ] ||
    die 'diretório de configuração existente precisa ser 0700 root:root'
fi
for secret_spec in "$app_env:440:0:$gid" "$tunnel_token:444:0:0"; do
  secret_file="${secret_spec%%:*}"
  secret_metadata="${secret_spec#*:}"
  if [ -e "$secret_file" ] || [ -L "$secret_file" ]; then
    [ -f "$secret_file" ] && [ ! -L "$secret_file" ] && [ "$(readlink -f -- "$secret_file")" = "$secret_file" ] ||
      die "arquivo de segredo existente é irregular ou symlink: $secret_file"
    [ "$(stat -c '%h' -- "$secret_file" 2>/dev/null || true)" = 1 ] ||
      die "arquivo de segredo existente possui hardlink: $secret_file"
    secret_target="$(findmnt -n -o TARGET -T "$secret_file" 2>/dev/null)" ||
      die "não foi possível resolver o mount do arquivo de segredo existente: $secret_file"
    [ "$(readlink -f -- "$secret_target")" = "$data_root" ] ||
      die "arquivo de segredo existente não está no mount LUKS de DATA_ROOT: $secret_file"
    [ "$(stat -c '%a:%u:%g' -- "$secret_file" 2>/dev/null || true)" = "$secret_metadata" ] ||
      die "arquivo de segredo existente possui modo/ownership divergente: $secret_file"
  fi
done
unset secret_spec secret_file secret_metadata

sentinel="$data_root/.kassinao-mounted"
expected_sentinel="$(printf 'kassinao-shared-luks-v1\nuuid=%s\nmapper=%s' "$uuid" "$mapper")"
if [ -e "$sentinel" ] || [ -L "$sentinel" ]; then
  [ -f "$sentinel" ] && [ ! -L "$sentinel" ] && [ "$(readlink -f -- "$sentinel")" = "$sentinel" ] ||
    die 'sentinel .kassinao-mounted existente é irregular ou symlink'
  sentinel_target="$(findmnt -n -o TARGET -T "$sentinel" 2>/dev/null)" ||
    die 'não foi possível resolver o mount da sentinel existente'
  [ "$(readlink -f -- "$sentinel_target")" = "$data_root" ] ||
    die 'sentinel .kassinao-mounted existente não está no mount LUKS de DATA_ROOT'
  actual_sentinel="$(cat -- "$sentinel"; printf '\037')"
  expected_sentinel_with_marker="${expected_sentinel}"$'\n\037'
  [ "$actual_sentinel" = "$expected_sentinel_with_marker" ] ||
    die 'sentinel .kassinao-mounted existente diverge do mapper/UUID configurado'
  [ "$(stat -c '%a:%u:%g:%h' -- "$sentinel" 2>/dev/null || true)" = '400:0:0:1' ] ||
    die 'sentinel .kassinao-mounted existente precisa ser 0400 root:root sem hardlink'
fi

# O preparo moderno nunca assume uma árvore já existente. Qualquer objeto
# presente precisa chegar com ownership e modo finais; somente o migrador
# offline pode remapear uma instalação legada em staging cifrado.
validate_runtime_tree true true

# O injector shared adquire este lock antes de gravar os três arquivos como
# transação. Materialize a seam mínima somente depois de pré-validar toda a
# árvore existente; o installer posterior reutiliza o mesmo runtime root-owned.
RUNTIME_DIR=/run/lock/kassinao
MAINTENANCE_LOCK="$RUNTIME_DIR/maintenance.lock"
if [ -e "$RUNTIME_DIR" ] || [ -L "$RUNTIME_DIR" ]; then
  [ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] && [ "$(readlink -f -- "$RUNTIME_DIR")" = "$RUNTIME_DIR" ] &&
    [ "$(stat -c '%a:%u:%g' "$RUNTIME_DIR" 2>/dev/null || true)" = 700:0:0 ] ||
    die 'runtime shared existente precisa ser diretório 0700 root:root canônico'
else
  mkdir -m 0700 -- "$RUNTIME_DIR"
  chown root:root "$RUNTIME_DIR"
fi
if [ -e "$MAINTENANCE_LOCK" ] || [ -L "$MAINTENANCE_LOCK" ]; then
  [ -f "$MAINTENANCE_LOCK" ] && [ ! -L "$MAINTENANCE_LOCK" ] &&
    [ "$(readlink -f -- "$MAINTENANCE_LOCK")" = "$MAINTENANCE_LOCK" ] &&
    [ "$(stat -c '%h' "$MAINTENANCE_LOCK" 2>/dev/null || true)" = 1 ] &&
    [ "$(stat -c '%a:%u:%g' "$MAINTENANCE_LOCK" 2>/dev/null || true)" = 600:0:0 ] ||
    die 'maintenance.lock shared existente precisa ser 0600 root:root canônico, sem links'
else
  if ! (set -o noclobber; : > "$MAINTENANCE_LOCK") 2>/dev/null; then
    die 'não foi possível criar maintenance.lock shared sem sobrescrever'
  fi
  chown root:root "$MAINTENANCE_LOCK"
  chmod 0600 "$MAINTENANCE_LOCK"
fi

for child in "$recordings" "$state" "$auth" "$cache"; do
  if [ ! -e "$child" ]; then
    mkdir -m 0700 -- "$child"
    chown -- "$uid:$gid" "$child"
    chmod -- 0700 "$child"
  fi
done

if [ ! -e "$config_dir" ]; then
  mkdir -m 0700 -- "$config_dir"
  chown -- root:root "$config_dir"
  chmod -- 0700 "$config_dir"
fi

if [ ! -e "$app_env" ]; then
  if ! (set -o noclobber; cat -- "$APP_ENV_TEMPLATE" > "$app_env") 2>/dev/null; then
    die "não foi possível inicializar app.env com defaults públicos sem sobrescrever: $app_env"
  fi
  chown -- "root:$gid" "$app_env"
  chmod -- 0440 "$app_env"
fi
if [ ! -e "$tunnel_token" ]; then
  if ! (set -o noclobber; : > "$tunnel_token") 2>/dev/null; then
    die "não foi possível criar token do túnel sem sobrescrever: $tunnel_token"
  fi
  chown -- root:root "$tunnel_token"
  # cloudflared roda sem root. O parent 0700 bloqueia acesso no host, enquanto o
  # bind direto read-only permite que somente o processo isolado leia o arquivo.
  chmod -- 0444 "$tunnel_token"
fi

if [ ! -e "$sentinel" ]; then
  if ! (set -o noclobber; printf '%s\n' "$expected_sentinel" > "$sentinel") 2>/dev/null; then
    die 'não foi possível criar sentinel .kassinao-mounted sem sobrescrever arquivo existente'
  fi
  chown -- root:root "$sentinel"
  chmod -- 0400 "$sentinel"
fi

env -i "PATH=$PATH" HOME=/root KASSINAO_ENV_FILE="$ENV_FILE" "$VERIFIER" ||
  die 'storage shared LUKS não passou na prova completa pós-preparo'

printf 'Storage shared preparado com runtime e configuração privada vinculados ao LUKS.\n'
