#!/bin/bash -p
# Migra uma árvore plaintext existente para o file-container LUKS2 do adapter
# shared. A chave é tratada fora deste script: o mapper precisa chegar aberto,
# ainda sem mount, e nunca recebemos passphrase/keyfile por argumento ou env.
set -Eeuo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 0 ] || die 'uso: migrate-shared-storage.sh'
[ "$EUID" -eq 0 ] || die 'execute como root'

# Nenhum subprocesso da migração herda tokens/chaves da sessão do operador.
# Apenas configuração não secreta de execução é preservada.
SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
source_app_env_override_set=false
source_app_env_override=''
if [ "${KASSINAO_MIGRATION_SOURCE_APP_ENV+x}" = x ]; then
  source_app_env_override_set=true
  source_app_env_override="$KASSINAO_MIGRATION_SOURCE_APP_ENV"
fi
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
inherited_docker_environment_name=''
for _inherited_name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$_inherited_name" >/dev/null 2>&1; then inherited_docker_environment_name="$_inherited_name"; break; fi
done
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente da migração shared'
while IFS='=' read -r -d '' inherited_name inherited_value; do
  unset "$inherited_name" 2>/dev/null || true
done < "/proc/$$/environ"
unset inherited_name inherited_value
export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C
if [ "$source_app_env_override_set" = true ]; then
  export KASSINAO_MIGRATION_SOURCE_APP_ENV="$source_app_env_override"
fi

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho da migração shared não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'migração shared precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/migrate-shared-storage.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit da migração shared não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter da migração shared não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$(id -u)" -eq 0 ] || die 'identidade root mudou durante o bootstrap'
for command in awk cat chmod chown cmp cp dirname docker env findmnt flock grep id mkdir mktemp mount mountpoint mv python3 readlink rm rmdir sha256sum stat sync umount; do
  command -v "$command" >/dev/null 2>&1 || die "$command é obrigatório"
done

[ -z "$inherited_docker_environment_name" ] || die "$inherited_docker_environment_name não pode vir do ambiente da migração"
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
[ "$ROOT" = "$PROJECT_DIR" ] || die 'raiz canônica divergiu do kit selado'
DOCKER_CONFIG="$ROOT/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] ||
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] ||
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG
ENV_FILE="$ROOT/.env"
APP_ENV_TEMPLATE="$ROOT/app.env.example"
MANIFEST="$ROOT/MANIFEST.sha256"
VERIFIER="$ROOT/scripts/verify-shared-luks-storage.sh"
NEIGHBOR_AUDITOR="$ROOT/scripts/audit-shared-vps-security.sh"

[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die 'diretório do kit ausente ou symlink'
[ "$(stat -c '%a:%u:%g' "$ROOT" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'diretório do kit precisa ser 0700 root:root'
[ ! -e "$ROOT/.git" ] || die 'migração privilegiada exige kit operacional fora de Git'

# Pais root-owned sem escrita alheia; um diretório sticky root-owned é aceito
# apenas como antecessor, nunca como a raiz 0700 do próprio kit.
cursor="$(dirname -- "$ROOT")"
while :; do
  [ ! -e "$cursor/.git" ] || die "migração privilegiada exige kit fora de Git: $cursor"
  metadata="$(stat -c '%a:%u:%g' "$cursor" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  owner_group="${metadata#*:}"
  [[ "$mode" =~ ^[0-7]+$ ]] && [ "$owner_group" = 0:0 ] ||
    die "parent do kit precisa ser root-owned: $cursor"
  if (( (8#$mode & 022) != 0 && (8#$mode & 01000) == 0 )); then
    die "parent do kit gravável precisa usar sticky bit: $cursor"
  fi
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done

[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die 'MANIFEST.sha256 ausente ou irregular'
manifest_metadata="$(stat -c '%a:%u:%g' "$MANIFEST" 2>/dev/null || true)"
manifest_mode="${manifest_metadata%%:*}"
[ "${manifest_metadata#*:}" = 0:0 ] && [[ "$manifest_mode" =~ ^[0-7]+$ ]] &&
  (( (8#$manifest_mode & 022) == 0 )) ||
  die 'MANIFEST.sha256 precisa ser root-owned e não gravável por terceiros'
for required in scripts/migrate-shared-storage.sh scripts/verify-shared-luks-storage.sh scripts/audit-shared-vps-security.sh app.env.example; do
  count="$(awk -v wanted="$required" '{ path=$2; sub(/^\.\//, "", path); if (path == wanted) count++ } END { print count + 0 }' "$MANIFEST")"
  [ "$count" -eq 1 ] || die "$required precisa aparecer exatamente uma vez no manifesto"
done
(cd -- "$ROOT" && sha256sum -c MANIFEST.sha256 --quiet) || die 'kit diverge do MANIFEST.sha256'
for control in "$ROOT/scripts/migrate-shared-storage.sh" "$VERIFIER" "$NEIGHBOR_AUDITOR"; do
  [ -f "$control" ] && [ ! -L "$control" ] || die "controle ausente ou symlink: $control"
  metadata="$(stat -c '%a:%u:%g' "$control" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  [ "${metadata#*:}" = 0:0 ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die "controle precisa ser root-owned e não gravável por terceiros: $control"
done
[ -f "$APP_ENV_TEMPLATE" ] && [ ! -L "$APP_ENV_TEMPLATE" ] || die 'app.env.example público ausente ou irregular'
template_metadata="$(stat -c '%a:%u:%g' "$APP_ENV_TEMPLATE" 2>/dev/null || true)"
template_mode="${template_metadata%%:*}"
[ "${template_metadata#*:}" = 0:0 ] && [[ "$template_mode" =~ ^[0-7]+$ ]] &&
  (( (8#$template_mode & 022) == 0 )) ||
  die 'app.env.example precisa ser root-owned e não gravável por terceiros'
[ -x "$VERIFIER" ] && [ -x "$NEIGHBOR_AUDITOR" ] ||
  die 'verifier e auditor shared precisam ser executáveis'

[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || die '.env privado ausente ou symlink'
[ "$(stat -c '%a:%u:%g' "$ENV_FILE" 2>/dev/null || true)" = 600:0:0 ] ||
  die '.env privado precisa ser 0600 root:root'

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
  case "$value" in *//* | */./* | */../* | */. | */.. | */) die "$key precisa ser canônico" ;; esac
  printf '%s' "$value"
}

[ "$(env_value KASSINAO_HOST_SCOPE)" = shared ] || die 'KASSINAO_HOST_SCOPE precisa ser shared'
[ -z "$(env_value KASSINAO_DEDICATED_DOCKER_HOST_ACK)" ] ||
  die 'KASSINAO_DEDICATED_DOCKER_HOST_ACK precisa permanecer vazio'

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
rollback_retention_hours="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS)"

[ "$recordings" = "$data_root/recordings" ] &&
  [ "$state" = "$data_root/state" ] &&
  [ "$auth" = "$data_root/auth" ] &&
  [ "$cache" = "$data_root/cache" ] ||
  die 'recordings/state/auth/cache precisam ser filhos exatos de KASSINAO_DATA_ROOT'
config_dir="$data_root/config"
[ "$app_env" = "$config_dir/app.env" ] && [ "$tunnel_token" = "$config_dir/cloudflared-token" ] ||
  die 'arquivos shared de configuração precisam usar DATA_ROOT/config'
[[ "$mapper" =~ ^[A-Za-z0-9][A-Za-z0-9_.+-]{0,126}$ ]] || die 'mapper LUKS possui formato inválido'
[[ "$uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
  die 'UUID LUKS precisa ser canônico em minúsculas'
[[ "$uid" =~ ^[0-9]+$ ]] && [ "$uid" -ge 61000 ] && [ "$uid" -le 61183 ] ||
  die 'KASSINAO_UID shared precisa ficar na faixa privada 61000..61183'
[[ "$gid" =~ ^[0-9]+$ ]] && [ "$gid" -ge 61000 ] && [ "$gid" -le 61183 ] ||
  die 'KASSINAO_GID shared precisa ficar na faixa privada 61000..61183'
[[ "$rollback_retention_hours" =~ ^[1-9][0-9]*$ ]] && [ "$rollback_retention_hours" -le 168 ] ||
  die 'KASSINAO_ROLLBACK_RETENTION_HOURS precisa ficar entre 1 e 168'
mapper_path="/dev/mapper/$mapper"
case "$backing_file" in "$data_root" | "$data_root"/*) die 'backing LUKS não pode ficar dentro da origem' ;; esac

[ -d "$data_root" ] && [ ! -L "$data_root" ] && [ "$(readlink -f -- "$data_root")" = "$data_root" ] ||
  die 'origem plaintext precisa ser diretório canônico, sem symlink'
[ "$(stat -c '%a:%u:%g' "$data_root" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'origem plaintext precisa ser 0700 root:root'
if mountpoint -q -- "$data_root"; then
  die 'DATA_ROOT já é mountpoint; nunca monte o LUKS novo sobre a origem'
fi

rollback_path="${data_root}.plaintext-before-shared-luks"
staging="${data_root}.luks-staging"
pending_marker="$data_root/.kassinao-plaintext-rollback.pending"
purged_marker="$data_root/.kassinao-plaintext-rollback.purged"
case "$backing_file" in "$rollback_path" | "$rollback_path"/*) die 'backing LUKS colide com rollback plaintext' ;; esac
case "$backing_file" in "$staging" | "$staging"/*) die 'backing LUKS colide com staging' ;; esac
[ ! -e "$rollback_path" ] && [ ! -L "$rollback_path" ] ||
  die "rollback plaintext já existe e nunca será sobrescrito: $rollback_path"
[ ! -e "$staging" ] && [ ! -L "$staging" ] ||
  die "staging sibling já existe e exige revisão manual: $staging"
data_parent="$(dirname -- "$data_root")"
[ -d "$data_parent" ] && [ ! -L "$data_parent" ] && [ "$(readlink -f -- "$data_parent")" = "$data_parent" ] ||
  die 'parent de DATA_ROOT precisa ser diretório canônico'
parent_metadata="$(stat -c '%a:%u:%g' "$data_parent" 2>/dev/null || true)"
parent_mode="${parent_metadata%%:*}"
[ "${parent_metadata#*:}" = 0:0 ] && [[ "$parent_mode" =~ ^[0-7]+$ ]] && (( (8#$parent_mode & 022) == 0 )) ||
  die 'parent de DATA_ROOT precisa ser root-owned e não gravável por terceiros'

RUNTIME_DIR=/run/lock/kassinao
paths_overlap() {
  local left="$1" right="$2"
  [ "$left" = "$right" ] || [[ "$left" = "$right/"* ]] || [[ "$right" = "$left/"* ]]
}
source_app_env=''
if [ "$source_app_env_override_set" = true ] && [ -n "$source_app_env_override" ]; then
  source_app_env="$source_app_env_override"
  [[ "$source_app_env" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
    die 'KASSINAO_MIGRATION_SOURCE_APP_ENV precisa ser caminho absoluto simples'
  case "$source_app_env" in *//* | */./* | */../* | */. | */.. | */) die 'KASSINAO_MIGRATION_SOURCE_APP_ENV precisa ser canônico' ;; esac
  [ -f "$source_app_env" ] && [ ! -L "$source_app_env" ] &&
    [ "$(readlink -f -- "$source_app_env")" = "$source_app_env" ] ||
    die 'app env legado precisa ser arquivo regular canônico, sem symlink'
  [ "$(stat -c '%a:%u:%g' "$source_app_env" 2>/dev/null || true)" = 600:0:0 ] ||
    die 'app env legado precisa ser 0600 root:root'
  [ "$(stat -c '%h' "$source_app_env" 2>/dev/null || true)" = 1 ] ||
    die 'app env legado não pode possuir hardlinks'
  [ "$source_app_env" != "$ENV_FILE" ] && ! paths_overlap "$source_app_env" "$data_root" &&
    ! paths_overlap "$source_app_env" "$backing_file" ||
    die 'app env legado precisa ficar fora do novo kit, DATA_ROOT e backing LUKS'
  source_parent="$(dirname -- "$source_app_env")"
  while :; do
    parent_metadata="$(stat -c '%a:%u:%g' "$source_parent" 2>/dev/null || true)"
    parent_mode="${parent_metadata%%:*}"
    [ "${parent_metadata#*:}" = 0:0 ] && [[ "$parent_mode" =~ ^[0-7]+$ ]] ||
      die "parent do app env legado precisa ser root-owned: $source_parent"
    if (( (8#$parent_mode & 022) != 0 && (8#$parent_mode & 01000) == 0 )); then
      die "parent gravável do app env legado precisa usar sticky bit: $source_parent"
    fi
    parent="$(dirname -- "$source_parent")"
    [ "$parent" != "$source_parent" ] || break
    source_parent="$parent"
  done
fi
[ -n "$source_app_env" ] || die 'migração legada exige KASSINAO_MIGRATION_SOURCE_APP_ENV capturado pelo preparo'

# O template público é também a allowlist de importação. Assim o .env combinado
# legado pode carregar provider, atas, MCP, retenção e limites sem levar token do
# túnel, paths do host ou knobs do Compose para o processo privado.
python3 - "$APP_ENV_TEMPLATE" "$source_app_env" "$data_root" <<'PY' || die 'template/import legado possui chave duplicada ou chave host/Compose proibida'
import hashlib, json, os, re, stat, sys

template, source, data_root = sys.argv[1:]
assignment = re.compile(r'^([A-Z][A-Z0-9_]*)=(.*)$')

def read_proven_source():
    control = os.path.join(data_root, '.legacy-shared-transition')
    directory = os.lstat(control)
    if (
        not stat.S_ISDIR(directory.st_mode) or stat.S_ISLNK(directory.st_mode)
        or stat.S_IMODE(directory.st_mode) != 0o700 or directory.st_uid != 0 or directory.st_gid != 0
    ):
        raise SystemExit(1)
    layout_path = os.path.join(control, 'layout.json')
    layout_stat = os.lstat(layout_path)
    if (
        not stat.S_ISREG(layout_stat.st_mode) or stat.S_ISLNK(layout_stat.st_mode)
        or stat.S_IMODE(layout_stat.st_mode) != 0o600 or layout_stat.st_uid != 0
        or layout_stat.st_gid != 0 or layout_stat.st_nlink != 1
    ):
        raise SystemExit(1)
    layout_fd = os.open(layout_path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(layout_fd, 'r', encoding='utf-8') as handle:
        layout = json.load(handle)
    expected = layout.get('legacy_env_proof') or {}
    if layout.get('version') != 3 or layout.get('status') != 'prepared' or layout.get('legacy_env_status') != 'present':
        raise SystemExit(1)
    before = os.lstat(source)
    fields = {
        'path': source, 'dev': before.st_dev, 'ino': before.st_ino,
        'mode': stat.S_IMODE(before.st_mode), 'uid': before.st_uid, 'gid': before.st_gid,
        'nlink': before.st_nlink, 'size': before.st_size,
        'mtime_ns': before.st_mtime_ns, 'ctime_ns': before.st_ctime_ns,
    }
    if (
        not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode)
        or fields['mode'] != 0o600 or fields['uid'] != 0 or fields['gid'] != 0 or fields['nlink'] != 1
    ):
        raise SystemExit(1)
    descriptor = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        opened = os.fstat(descriptor)
        if opened.st_dev != before.st_dev or opened.st_ino != before.st_ino:
            raise SystemExit(1)
        chunks = []
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            chunks.append(block)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    current = os.lstat(source)
    fields['sha256'] = hashlib.sha256(b''.join(chunks)).hexdigest()
    if fields != expected or any(
        getattr(before, name) != getattr(after, name) or getattr(before, name) != getattr(current, name)
        for name in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    ):
        raise SystemExit(1)
    return b''.join(chunks).decode('utf-8').splitlines(keepends=True)

source_lines = read_proven_source()
forbidden = {
    'TUNNEL_TOKEN', 'PORT', 'WEB_BIND_ADDRESS', 'COMPOSE_PROFILES',
    'KASSINAO_IMAGE', 'KASSINAO_RELEASE_DIGEST', 'KASSINAO_DEPLOYMENT_FINGERPRINT',
    'KASSINAO_PULL_POLICY', 'KASSINAO_APP_ENV_FILE', 'KASSINAO_DEPLOYMENT_MODE',
    'KASSINAO_HOST_SCOPE', 'KASSINAO_DEDICATED_DOCKER_HOST_ACK',
    'KASSINAO_DATA_ROOT', 'KASSINAO_RECORDINGS_DIR', 'KASSINAO_STATE_DIR',
    'KASSINAO_AUTH_DIR', 'KASSINAO_MODEL_CACHE_DIR', 'KASSINAO_UID', 'KASSINAO_GID',
    'KASSINAO_SHARED_LUKS_BACKING_FILE', 'KASSINAO_SHARED_LUKS_MAPPER',
    'KASSINAO_SHARED_LUKS_UUID', 'KASSINAO_SHARED_APP_ENV_FILE',
    'KASSINAO_SHARED_TUNNEL_TOKEN_FILE', 'KASSINAO_HOST_PORT', 'KASSINAO_PUBLIC_HOST_PORT',
}
allowed = set()
with open(template, encoding='utf-8') as handle:
    for raw in handle:
        match = assignment.match(raw.rstrip('\n'))
        if not match:
            continue
        key = match.group(1)
        if key in allowed or key in forbidden:
            raise SystemExit(1)
        allowed.add(key)
if not {'TRANSCRIBE_PROVIDER', 'MINUTES_ENABLED', 'MCP_SECRET', 'RETENTION_DAYS', 'TEXT_RETENTION_DAYS'} <= allowed:
    raise SystemExit(1)
seen = set()
for raw in source_lines:
    match = assignment.match(raw.rstrip('\n'))
    if not match or match.group(1) not in allowed:
        continue
    if match.group(1) in seen:
        raise SystemExit(1)
    seen.add(match.group(1))
PY

seed_shared_app_env() {
  local destination="$1"
  python3 - "$APP_ENV_TEMPLATE" "$source_app_env" "$data_root" "$destination" <<'PY'
import hashlib, json, os, re, stat, sys

template, source, data_root, destination = sys.argv[1:]
assignment = re.compile(r'^([A-Z][A-Z0-9_]*)=(.*)$')

def read_proven_source():
    control = os.path.join(data_root, '.legacy-shared-transition')
    layout_path = os.path.join(control, 'layout.json')
    control_stat = os.lstat(control)
    layout_stat = os.lstat(layout_path)
    if (
        not stat.S_ISDIR(control_stat.st_mode) or stat.S_ISLNK(control_stat.st_mode)
        or stat.S_IMODE(control_stat.st_mode) != 0o700 or control_stat.st_uid != 0 or control_stat.st_gid != 0
        or not stat.S_ISREG(layout_stat.st_mode) or stat.S_ISLNK(layout_stat.st_mode)
        or stat.S_IMODE(layout_stat.st_mode) != 0o600 or layout_stat.st_uid != 0
        or layout_stat.st_gid != 0 or layout_stat.st_nlink != 1
    ):
        raise SystemExit(1)
    layout_fd = os.open(layout_path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(layout_fd, 'r', encoding='utf-8') as handle:
        layout = json.load(handle)
    expected = layout.get('legacy_env_proof') or {}
    if layout.get('version') != 3 or layout.get('status') != 'prepared' or layout.get('legacy_env_status') != 'present':
        raise SystemExit(1)
    before = os.lstat(source)
    fields = {
        'path': source, 'dev': before.st_dev, 'ino': before.st_ino,
        'mode': stat.S_IMODE(before.st_mode), 'uid': before.st_uid, 'gid': before.st_gid,
        'nlink': before.st_nlink, 'size': before.st_size,
        'mtime_ns': before.st_mtime_ns, 'ctime_ns': before.st_ctime_ns,
    }
    if (
        not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode)
        or fields['mode'] != 0o600 or fields['uid'] != 0 or fields['gid'] != 0 or fields['nlink'] != 1
    ):
        raise SystemExit(1)
    descriptor = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        opened = os.fstat(descriptor)
        if opened.st_dev != before.st_dev or opened.st_ino != before.st_ino:
            raise SystemExit(1)
        chunks = []
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            chunks.append(block)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    current = os.lstat(source)
    fields['sha256'] = hashlib.sha256(b''.join(chunks)).hexdigest()
    if fields != expected or any(
        getattr(before, name) != getattr(after, name) or getattr(before, name) != getattr(current, name)
        for name in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    ):
        raise SystemExit(1)
    return b''.join(chunks).decode('utf-8').splitlines(keepends=True)

with open(template, encoding='utf-8') as handle:
    template_lines = handle.readlines()

allowed = {}
for index, raw in enumerate(template_lines):
    match = assignment.match(raw.rstrip('\n'))
    if match:
        allowed[match.group(1)] = index

imported = {}
for raw in read_proven_source():
    match = assignment.match(raw.rstrip('\n'))
    if not match or match.group(1) not in allowed:
        continue
    key = match.group(1)
    if key in imported:
        raise SystemExit(1)
    imported[key] = match.group(2)

for key, value in imported.items():
    template_lines[allowed[key]] = f'{key}={value}\n'

flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
descriptor = os.open(destination, flags, 0o600)
with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as handle:
    handle.writelines(template_lines)
    handle.flush()
    os.fsync(handle.fileno())
PY
}

mapfile -t legacy_runtime_identity < <(python3 - "$data_root/.legacy-shared-transition/layout.json" <<'PY'
import json, os, stat, sys
path = sys.argv[1]
metadata = os.lstat(path)
if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_nlink != 1:
    raise SystemExit(1)
descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
with os.fdopen(descriptor, encoding='utf-8') as handle:
    layout = json.load(handle)
if layout.get('version') != 3 or layout.get('status') != 'prepared':
    raise SystemExit(1)
legacy_uid = layout.get('legacy_runtime_uid')
legacy_gid = layout.get('legacy_runtime_gid')
if type(legacy_uid) is not int or type(legacy_gid) is not int or legacy_uid <= 0 or legacy_gid <= 0:
    raise SystemExit(1)
print(legacy_uid)
print(legacy_gid)
PY
) || die 'marker legado não contém ownership runtime único e válido'
[ "${#legacy_runtime_identity[@]}" -eq 2 ] || die 'marker legado não contém par UID/GID único'
legacy_uid="${legacy_runtime_identity[0]}"
legacy_gid="${legacy_runtime_identity[1]}"
for protected_path in "$data_root" "$rollback_path" "$staging" "$backing_file"; do
  ! paths_overlap "$RUNTIME_DIR" "$protected_path" ||
    die 'KASSINAO_RUNTIME_DIR não pode sobrepor origem, rollback, staging ou backing LUKS'
done
[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] && [ "$(readlink -f -- "$RUNTIME_DIR")" = "$RUNTIME_DIR" ] &&
  [ "$(stat -c '%a:%u:%g' "$RUNTIME_DIR" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'runtime de manutenção precisa preexistir como diretório canônico 0700 root:root'
maintenance_lock="$RUNTIME_DIR/maintenance.lock"
[ -f "$maintenance_lock" ] && [ ! -L "$maintenance_lock" ] &&
  [ "$(readlink -f -- "$maintenance_lock")" = "$maintenance_lock" ] &&
  [ "$(stat -c '%a:%u:%g:%h' "$maintenance_lock" 2>/dev/null || true)" = 600:0:0:1 ] ||
  die 'maintenance.lock precisa preexistir como regular 0600 root:root sem links'
exec 9<>"$maintenance_lock"
[ "$(stat -Lc '%a:%u:%g:%h' "/proc/$$/fd/9" 2>/dev/null || true)" = 600:0:0:1 ] &&
  [ "$(readlink -f -- "/proc/$$/fd/9" 2>/dev/null || true)" = "$maintenance_lock" ] &&
  [ "$(stat -c '%d:%i' "$maintenance_lock" 2>/dev/null || true)" = "$(stat -Lc '%d:%i' "/proc/$$/fd/9" 2>/dev/null || true)" ] ||
  die 'maintenance.lock mudou durante a abertura'
flock -w 120 9 || die 'outra manutenção não liberou a instância em 120 segundos'

stage_env="$RUNTIME_DIR/.shared-migration.env"
source_before="$RUNTIME_DIR/.shared-source-before.manifest"
source_after="$RUNTIME_DIR/.shared-source-after.manifest"
source_expected="$RUNTIME_DIR/.shared-source-expected.manifest"
source_final="$RUNTIME_DIR/.shared-source-final.manifest"
destination_manifest="$RUNTIME_DIR/.shared-destination.manifest"
final_manifest="$RUNTIME_DIR/.shared-final.manifest"
mount_inventory="$RUNTIME_DIR/.shared-mount-inventory.json"
for temporary in "$staging" "$stage_env" "$source_before" "$source_after" "$source_expected" "$source_final" \
  "$destination_manifest" "$final_manifest" "$mount_inventory"; do
  [ ! -e "$temporary" ] && [ ! -L "$temporary" ] || die "resíduo de migração exige revisão manual: $temporary"
done

staging_mounted=false
source_moved=false
new_mount_at_data_root=false
migration_succeeded=false
marker_tmp=''

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$migration_succeeded" != true ]; then
    # Não confie apenas nos flags: Bash pode entregar HUP/INT/TERM exatamente
    # depois de mount --move retornar e antes das atribuições seguintes.
    if mountpoint -q -- "$data_root"; then
      new_mount_at_data_root=true
      staging_mounted=false
    elif mountpoint -q -- "$staging"; then
      new_mount_at_data_root=false
      staging_mounted=true
    else
      new_mount_at_data_root=false
      staging_mounted=false
    fi
    # Um sinal pode chegar depois de mv(1) concluir o rename da origem e antes
    # da atribuição source_moved=true. Reconcilie pelo estado observável: o
    # rollback foi provado ausente no preflight e nunca é sobrescrito aqui.
    if [ "$source_moved" != true ] && [ ! -e "$data_root" ] && [ ! -L "$data_root" ] && \
      [ -d "$rollback_path" ] && [ ! -L "$rollback_path" ]; then
      source_moved=true
    fi
    if [ "$new_mount_at_data_root" = true ]; then
      if ! umount -- "$data_root"; then
        printf 'ERRO CRÍTICO: não foi possível desmontar o destino após falha; origem preservada em %s\n' "$rollback_path" >&2
        status=1
      else
        new_mount_at_data_root=false
      fi
    elif [ "$staging_mounted" = true ]; then
      if umount -- "$staging"; then
        staging_mounted=false
      else
        printf 'ERRO CRÍTICO: staging LUKS permaneceu montado após falha: %s\n' "$staging" >&2
        status=1
      fi
    fi
    if [ "$source_moved" = true ] && [ "$new_mount_at_data_root" != true ]; then
      if [ -d "$data_root" ] && [ ! -L "$data_root" ]; then rmdir -- "$data_root" || status=1; fi
      if [ ! -e "$data_root" ] && [ ! -L "$data_root" ]; then
        mv -- "$rollback_path" "$data_root" || status=1
        source_moved=false
      fi
    fi
  fi
  if [ "$staging_mounted" = true ]; then umount -- "$staging" || status=1; fi
  [ ! -d "$staging" ] || rmdir -- "$staging" 2>/dev/null || true
  rm -f -- "$stage_env" "$source_before" "$source_after" "$source_expected" "$source_final" \
    "$destination_manifest" "$final_manifest" "$mount_inventory"
  [ -z "$marker_tmp" ] || rm -f -- "$marker_tmp" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

assert_containers_stopped() {
  docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || die 'daemon Docker local indisponível'
  local ids_raw projection
  ids_raw="$(docker ps -aq --no-trunc)" || die 'não foi possível enumerar containers'
  projection='{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}}}},"State":{"Running":{{json .State.Running}}},"HostConfig":{"RestartPolicy":{"Name":{{json .HostConfig.RestartPolicy.Name}}},"HasDevices":{{if .HostConfig.Devices}}true{{else}}false{{end}},"HasDeviceCgroupRules":{{if .HostConfig.DeviceCgroupRules}}true{{else}}false{{end}},"HasDeviceRequests":{{if .HostConfig.DeviceRequests}}true{{else}}false{{end}},"HasVolumesFrom":{{if .HostConfig.VolumesFrom}}true{{else}}false{{end}}},"Mounts":[{{range $index, $mount := .Mounts}}{{if $index}},{{end}}{"Type":{{json $mount.Type}},"Name":{{json (index $mount "Name")}},"Source":{{json $mount.Source}},"Destination":{{json $mount.Destination}},"RW":{{json $mount.RW}}}{{end}}]}'
  if [ -n "$ids_raw" ]; then
    mapfile -t ids <<<"$ids_raw"
  fi
  if ! {
    if [ -n "$ids_raw" ]; then
      docker inspect --format "$projection" "${ids[@]}" || exit 1
    fi
  } | python3 /dev/fd/3 "$data_root" "$rollback_path" "$backing_file" 3<<'PY'
import json, os, sys

items = []
for line in sys.stdin:
    try:
        item = json.loads(line)
    except Exception:
        raise SystemExit(1)
    if not isinstance(item, dict):
        raise SystemExit(1)
    items.append(item)

expected = {
    'kassinao': 'kassinao',
    'kassinao-public': 'kassinao-public',
    'cloudflared': 'kassinao-tunnel',
}
seen = set()
protected_paths = [os.path.realpath(value) for value in sys.argv[1:]]

def overlaps_protected(raw):
    source = str(raw or '')
    if not os.path.isabs(source):
        return False
    source = os.path.realpath(source)
    for protected in protected_paths:
        try:
            common = os.path.commonpath([source, protected])
        except ValueError:
            continue
        if common == source or common == protected:
            return True
    return False

for item in items:
    mounts = item.get('Mounts')
    if not isinstance(mounts, list):
        raise SystemExit(1)
    for mount in mounts:
        if not isinstance(mount, dict):
            raise SystemExit(1)
        mount_type = mount.get('Type')
        source = mount.get('Source')
        destination = mount.get('Destination')
        if mount_type not in ('bind', 'volume', 'tmpfs'):
            raise SystemExit(1)
        if not isinstance(destination, str) or not os.path.isabs(destination):
            raise SystemExit(1)
        if type(mount.get('RW')) is not bool:
            raise SystemExit(1)
        if mount_type in ('bind', 'volume') and (not isinstance(source, str) or not os.path.isabs(source)):
            raise SystemExit(1)
        if mount_type == 'volume' and (not isinstance(mount.get('Name'), str) or not mount.get('Name')):
            raise SystemExit(1)
    labels = (item.get('Config') or {}).get('Labels') or {}
    project = labels.get('com.docker.compose.project')
    service = labels.get('com.docker.compose.service')
    name = str(item.get('Name') or '').lstrip('/')
    belongs = project == 'kassinao' or name in expected.values()
    if not belongs:
        host = item.get('HostConfig') or {}
        if (host.get('HasDevices') or host.get('HasDeviceCgroupRules') or
                host.get('HasDeviceRequests') or host.get('HasVolumesFrom')):
            raise SystemExit(1)
        for mount in mounts:
            if overlaps_protected(mount.get('Source')):
                raise SystemExit(1)
        continue
    if project != 'kassinao' or service not in expected or name != expected[service] or service in seen:
        raise SystemExit(1)
    seen.add(service)
    state = item.get('State') or {}
    restart = ((item.get('HostConfig') or {}).get('RestartPolicy') or {}).get('Name') or 'no'
    if state.get('Running') is not False or str(restart).lower() not in ('no', 'none'):
        raise SystemExit(1)
PY
  then
    die 'containers Kassinão precisam estar parados e nenhum vizinho pode alcançar o storage'
  fi
}

assert_shared_neighbors() {
  env -i "PATH=$PATH" HOME=/root LC_ALL=C "LD_PRELOAD=${LD_PRELOAD-}" "KASSINAO_ENV_FILE=$ENV_FILE" \
    "$NEIGHBOR_AUDITOR" --neighbors-only >/dev/null ||
    die 'auditoria read-only dos vizinhos recusou a migração shared'
}

tree_manifest() {
  local output="$1" root_path="$2" normalized_uid="${3:-}" normalized_gid="${4:-}"
  python3 - "$output" "$root_path" "$normalized_uid" "$normalized_gid" <<'PY'
import hashlib
import json
import os
import stat
import sys

output, root, normalized_uid_raw, normalized_gid_raw = sys.argv[1:]
normalized_owner = None
if normalized_uid_raw or normalized_gid_raw:
    if not normalized_uid_raw.isdecimal() or not normalized_gid_raw.isdecimal():
        raise SystemExit(1)
    normalized_owner = (int(normalized_uid_raw), int(normalized_gid_raw))
top_levels = ('recordings', 'state', 'auth', 'cache', '.legacy-shared-transition')
active_recordings = 0

def fail(message):
    print(f'ERRO: {message}', file=sys.stderr)
    raise SystemExit(1)

def stable_stat(left, right):
    return (
        left.st_dev, left.st_ino, left.st_mode, left.st_uid, left.st_gid,
        left.st_size, left.st_mtime_ns, left.st_ctime_ns,
    ) == (
        right.st_dev, right.st_ino, right.st_mode, right.st_uid, right.st_gid,
        right.st_size, right.st_mtime_ns, right.st_ctime_ns,
    )

def visit(path, relative, device, lines):
    global active_recordings
    before = os.lstat(path)
    if before.st_dev != device:
        fail(f'nested mount detectado em {relative}')
    if stat.S_ISLNK(before.st_mode):
        fail(f'symlink proibido em {relative}')
    owner = (before.st_uid, before.st_gid)
    if normalized_owner is not None and relative.split('/', 1)[0] in {'recordings', 'state', 'auth', 'cache'}:
        owner = normalized_owner
    record = {
        'path': relative,
        'mode': stat.S_IMODE(before.st_mode),
        'uid': owner[0],
        'gid': owner[1],
    }
    if stat.S_ISDIR(before.st_mode):
        record['type'] = 'directory'
        try:
            names = sorted(os.listdir(path))
        except Exception as error:
            fail(f'não foi possível enumerar {relative}: {error}')
        after_list = os.lstat(path)
        if not stable_stat(before, after_list):
            fail(f'diretório mudou durante inventário: {relative}')
        lines.append(json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(',', ':')))
        for name in names:
            visit(os.path.join(path, name), f'{relative}/{name}', device, lines)
        after_walk = os.lstat(path)
        if not stable_stat(after_list, after_walk):
            fail(f'diretório mudou durante inventário: {relative}')
        return
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        fail(f'tipo irregular ou hardlink proibido em {relative}')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if not stable_stat(before, opened):
            fail(f'arquivo mudou antes da leitura: {relative}')
        digest = hashlib.sha256()
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            digest.update(block)
        after = os.fstat(descriptor)
        if not stable_stat(opened, after):
            fail(f'arquivo mudou durante checksum: {relative}')
    finally:
        os.close(descriptor)
    record.update(type='file', size=before.st_size, sha256=digest.hexdigest())
    lines.append(json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(',', ':')))
    if relative.startswith('recordings/') and relative.count('/') == 2 and relative.endswith('/meta.json'):
        try:
            with open(path, encoding='utf-8') as handle:
                metadata = json.load(handle)
        except Exception:
            fail(f'meta.json inválido em {relative}')
        if metadata.get('status') == 'recording':
            active_recordings += 1

lines = []
for name in top_levels:
    path = os.path.join(root, name)
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        fail(f'diretório obrigatório ausente: {name}')
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail(f'diretório obrigatório irregular: {name}')
    visit(path, name, metadata.st_dev, lines)

if active_recordings != 0:
    fail(f'activeRecordings={active_recordings}; exigido activeRecordings=0')
lines.sort(key=lambda raw: json.loads(raw)['path'])
with open(output, 'x', encoding='utf-8', newline='\n') as handle:
    handle.write('\n'.join(lines) + '\n')
PY
}

validate_legacy_colocated_contract() {
  local actual_manifest="$1"
  python3 - \
    "$data_root/.legacy-shared-transition/layout.json" \
    "$data_root/.legacy-shared-transition/source-manifest.jsonl" \
    "$actual_manifest" "$legacy_uid" "$legacy_gid" <<'PY'
import hashlib
import json
import os
import stat
import sys

layout_path, stored_path, actual_path, legacy_uid_raw, legacy_gid_raw = sys.argv[1:]
legacy_uid, legacy_gid = int(legacy_uid_raw), int(legacy_gid_raw)
targets = {
    'guildconfig.json': {'tree': 'state', 'name': 'guildconfig.json'},
    'autorecord.json': {'tree': 'state', 'name': 'autorecord.json'},
    '.recording-admission.json': {'tree': 'state', 'name': 'recording-admission.json'},
    '.discord-surface-inventory.json': {'tree': 'state', 'name': 'discord-surface-inventory.json'},
    '.cookie-secret': {'tree': 'auth', 'name': '.cookie-secret'},
    '.web-sessions.json': {'tree': 'auth', 'name': 'web-sessions.json'},
    '.mcp-sessions.json': {'tree': 'auth', 'name': 'mcp-sessions.json'},
}

def fail():
    raise SystemExit(1)

def read_stable(path):
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or before.st_nlink != 1:
        fail()
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        opened = os.fstat(descriptor)
        identity = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        if any(getattr(before, field) != getattr(opened, field) for field in identity):
            fail()
        chunks = []
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            chunks.append(block)
        after = os.fstat(descriptor)
        if any(getattr(opened, field) != getattr(after, field) for field in identity):
            fail()
    finally:
        os.close(descriptor)
    current = os.lstat(path)
    if any(getattr(before, field) != getattr(current, field) for field in identity):
        fail()
    return b''.join(chunks)

def load_manifest(raw):
    if not raw.endswith(b'\n') or b'\r' in raw or b'\0' in raw:
        fail()
    records = []
    for line in raw[:-1].split(b'\n'):
        if not line:
            fail()
        try:
            item = json.loads(line)
        except Exception:
            fail()
        canonical = json.dumps(item, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode()
        if line != canonical or not isinstance(item, dict):
            fail()
        records.append(item)
    paths = [item.get('path') for item in records]
    if any(not isinstance(path, str) or not path for path in paths) or paths != sorted(paths) or len(paths) != len(set(paths)):
        fail()
    return records

layout_raw = read_stable(layout_path)
stored_raw = read_stable(stored_path)
actual_raw = read_stable(actual_path)
try:
    layout = json.loads(layout_raw)
except Exception:
    fail()
if (
    not isinstance(layout, dict) or layout.get('version') != 3 or layout.get('status') != 'prepared'
    or layout.get('legacy_runtime_uid') != legacy_uid or layout.get('legacy_runtime_gid') != legacy_gid
    or layout.get('source_manifest_sha256') != hashlib.sha256(stored_raw).hexdigest()
):
    fail()

stored = load_manifest(stored_raw)
actual = load_manifest(actual_raw)
runtime_actual = [
    item for item in actual
    if str(item.get('path', '')).split('/', 1)[0] != '.legacy-shared-transition'
]
if stored != runtime_actual:
    fail()

for item in stored:
    if item.get('uid') != legacy_uid or item.get('gid') != legacy_gid:
        fail()

absent = layout.get('absent_metadata')
if not isinstance(absent, dict):
    fail()
for name, metadata in absent.items():
    if name not in {'state', 'auth'} or metadata != {'mode': 0o700, 'uid': legacy_uid, 'gid': legacy_gid}:
        fail()

by_path = {item['path']: item for item in stored}
for tree in ('state', 'auth'):
    descendants = [path for path in by_path if path.startswith(tree + '/')]
    if tree in absent:
        root = by_path.get(tree)
        if root != {'path': tree, 'mode': 0o700, 'uid': legacy_uid, 'gid': legacy_gid, 'type': 'directory'} or descendants:
            fail()

root_entries = {
    item['path'].split('/', 1)[1]: item
    for item in stored
    if item['path'].startswith('recordings/') and item['path'].count('/') == 1
}
root_files = {}
for name, item in root_entries.items():
    if item.get('type') == 'directory':
        if name in targets:
            fail()
        continue
    if item.get('type') != 'file' or name not in targets:
        fail()
    root_files[name] = targets[name]

mapping = layout.get('colocated_files')
if mapping != root_files:
    fail()
sources = layout.get('sources')
if not isinstance(sources, dict):
    fail()
for target in mapping.values():
    tree = target['tree']
    if tree in sources or tree not in absent:
        fail()
PY
}

normalize_legacy_colocated_layout() {
  local root_path="$1"
  python3 - "$root_path" "$legacy_uid" "$legacy_gid" <<'PY'
import json
import os
import stat
import sys

root, legacy_uid_raw, legacy_gid_raw = sys.argv[1:]
legacy_uid, legacy_gid = int(legacy_uid_raw), int(legacy_gid_raw)
layout_path = os.path.join(root, '.legacy-shared-transition', 'layout.json')
layout_fd = os.open(layout_path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
with os.fdopen(layout_fd, encoding='utf-8') as handle:
    layout = json.load(handle)
mapping = layout.get('colocated_files')
if not isinstance(mapping, dict):
    raise SystemExit(1)

flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
root_fd = os.open(root, flags)
descriptors = {}
try:
    for name in ('recordings', 'state', 'auth'):
        descriptors[name] = os.open(name, flags, dir_fd=root_fd)
        metadata = os.fstat(descriptors[name])
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != legacy_uid or metadata.st_gid != legacy_gid:
            raise SystemExit(1)
    if os.listdir(descriptors['state']) or os.listdir(descriptors['auth']):
        raise SystemExit(1)
    for source_name in sorted(mapping):
        target = mapping[source_name]
        if not isinstance(target, dict) or set(target) != {'tree', 'name'}:
            raise SystemExit(1)
        target_tree, target_name = target['tree'], target['name']
        if target_tree not in {'state', 'auth'} or not isinstance(target_name, str) or '/' in target_name or target_name in ('', '.', '..'):
            raise SystemExit(1)
        source_metadata = os.stat(source_name, dir_fd=descriptors['recordings'], follow_symlinks=False)
        if (
            not stat.S_ISREG(source_metadata.st_mode) or stat.S_ISLNK(source_metadata.st_mode)
            or source_metadata.st_nlink != 1 or source_metadata.st_uid != legacy_uid or source_metadata.st_gid != legacy_gid
        ):
            raise SystemExit(1)
        try:
            os.stat(target_name, dir_fd=descriptors[target_tree], follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise SystemExit(1)
        os.rename(source_name, target_name, src_dir_fd=descriptors['recordings'], dst_dir_fd=descriptors[target_tree])
        os.fsync(descriptors[target_tree])
        os.fsync(descriptors['recordings'])

    marker_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    marker_fd = os.open('.layout-v2', marker_flags, 0o600, dir_fd=descriptors['state'])
    try:
        os.write(marker_fd, b'2\n')
        os.fchown(marker_fd, legacy_uid, legacy_gid)
        os.fchmod(marker_fd, 0o600)
        os.fsync(marker_fd)
    finally:
        os.close(marker_fd)
    os.fsync(descriptors['state'])
    for tree in ('state', 'auth'):
        try:
            os.stat('.instance-id', dir_fd=descriptors[tree], follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise SystemExit(1)
finally:
    for descriptor in descriptors.values():
        os.close(descriptor)
    os.close(root_fd)
PY
}

project_normalized_manifest() {
  local old_manifest="$1" output="$2"
  python3 - \
    "$old_manifest" "$output" "$data_root/.legacy-shared-transition/layout.json" "$uid" "$gid" <<'PY'
import hashlib
import json
import sys

old_path, output_path, layout_path, uid_raw, gid_raw = sys.argv[1:]
uid, gid = int(uid_raw), int(gid_raw)
with open(layout_path, encoding='utf-8') as handle:
    layout = json.load(handle)
mapping = layout.get('colocated_files')
if not isinstance(mapping, dict):
    raise SystemExit(1)

records = []
seen = set()
with open(old_path, encoding='utf-8') as handle:
    for raw in handle:
        item = json.loads(raw)
        source_path = item.get('path')
        if not isinstance(source_path, str):
            raise SystemExit(1)
        if source_path.startswith('recordings/') and source_path.count('/') == 1:
            source_name = source_path.split('/', 1)[1]
            target = mapping.get(source_name)
            if target is not None:
                item['path'] = f"{target['tree']}/{target['name']}"
        if item['path'].split('/', 1)[0] in {'recordings', 'state', 'auth', 'cache'}:
            item['uid'] = uid
            item['gid'] = gid
        if item['path'] in seen:
            raise SystemExit(1)
        seen.add(item['path'])
        records.append(item)

marker_path = 'state/.layout-v2'
if marker_path in seen:
    raise SystemExit(1)
records.append({
    'path': marker_path,
    'mode': 0o600,
    'uid': uid,
    'gid': gid,
    'type': 'file',
    'size': 2,
    'sha256': hashlib.sha256(b'2\n').hexdigest(),
})
records.sort(key=lambda item: item['path'])
with open(output_path, 'x', encoding='utf-8', newline='\n') as output:
    for item in records:
        output.write(json.dumps(item, ensure_ascii=True, sort_keys=True, separators=(',', ':')) + '\n')
PY
}

normalize_runtime_tree_ownership() {
  local root_path="$1" mount_inventory_json child
  mount_inventory_json="$(findmnt --json --output TARGET)" ||
    die 'não foi possível inventariar mounts antes de normalizar ownership do destino cifrado'
  if ! env -i "PATH=$PATH" HOME=/root LC_ALL=C python3 - \
    "$root_path" "$legacy_uid" "$legacy_gid" "$uid" "$gid" 3<<<"$mount_inventory_json" <<'PY'
import json, os, stat, sys
root, legacy_uid_raw, legacy_gid_raw, uid_raw, gid_raw = sys.argv[1:]
legacy_uid, legacy_gid = int(legacy_uid_raw), int(legacy_gid_raw)
uid, gid = int(uid_raw), int(gid_raw)
root = os.path.realpath(root)
root_stat = os.lstat(root)
try:
    mounts = json.load(os.fdopen(3, encoding='utf-8'))
except Exception:
    raise SystemExit(1)
def targets(items):
    for item in items or []:
        target = item.get('target')
        if isinstance(target, str) and os.path.isabs(target):
            yield os.path.realpath(target)
        yield from targets(item.get('children'))
for target in targets(mounts.get('filesystems')):
    if target != root and os.path.commonpath([root, target]) == root:
        raise SystemExit(1)
def visit(path):
    item = os.lstat(path)
    if item.st_dev != root_stat.st_dev or stat.S_ISLNK(item.st_mode) or stat.S_IMODE(item.st_mode) & 0o7000:
        raise SystemExit(1)
    if stat.S_ISDIR(item.st_mode):
        for name in sorted(os.listdir(path)):
            visit(os.path.join(path, name))
    elif not stat.S_ISREG(item.st_mode) or item.st_nlink != 1:
        raise SystemExit(1)
    if item.st_uid != legacy_uid or item.st_gid != legacy_gid:
        raise SystemExit(1)
for name in ('recordings', 'state', 'auth', 'cache'):
    path = os.path.join(root, name)
    item = os.lstat(path)
    if not stat.S_ISDIR(item.st_mode) or stat.S_ISLNK(item.st_mode):
        raise SystemExit(1)
    visit(path)
PY
  then
    die 'destino cifrado contém symlink, hardlink, nested mount ou tipo especial antes do chown'
  fi
  for child in recordings state auth cache; do
    find -P "$root_path/$child" -xdev -exec chown --no-dereference -- "$uid:$gid" {} +
  done
  if ! env -i "PATH=$PATH" HOME=/root LC_ALL=C python3 - "$root_path" "$uid" "$gid" <<'PY'
import os, stat, sys
root, uid_raw, gid_raw = sys.argv[1:]
uid, gid = int(uid_raw), int(gid_raw)
root = os.path.realpath(root)
root_stat = os.lstat(root)
def visit(path):
    item = os.lstat(path)
    if item.st_dev != root_stat.st_dev or stat.S_ISLNK(item.st_mode):
        raise SystemExit(1)
    if item.st_uid != uid or item.st_gid != gid:
        raise SystemExit(1)
    if stat.S_ISDIR(item.st_mode):
        for name in sorted(os.listdir(path)):
            visit(os.path.join(path, name))
    elif not stat.S_ISREG(item.st_mode) or item.st_nlink != 1:
        raise SystemExit(1)
for name in ('recordings', 'state', 'auth', 'cache'):
    visit(os.path.join(root, name))
PY
  then
    die 'ownership recursivo do destino cifrado não ficou no UID/GID shared selecionado'
  fi
}

assert_plaintext_top_level() {
  local root_path="$1"
  python3 - "$root_path" <<'PY' || die 'origem plaintext possui top-level extra ou não contém o controle legado root-only esperado'
import os, stat, sys

root = sys.argv[1]
expected = {'recordings', 'state', 'auth', 'cache', '.legacy-shared-transition'}
if set(os.listdir(root)) != expected:
    raise SystemExit(1)
control = os.path.join(root, '.legacy-shared-transition')
metadata = os.lstat(control)
if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700:
    raise SystemExit(1)
if metadata.st_uid != 0 or metadata.st_gid != 0:
    raise SystemExit(1)
if set(os.listdir(control)) != {'layout.json', 'source-manifest.jsonl'}:
    raise SystemExit(1)
for name in os.listdir(control):
    item = os.lstat(os.path.join(control, name))
    if not stat.S_ISREG(item.st_mode) or stat.S_ISLNK(item.st_mode) or stat.S_IMODE(item.st_mode) != 0o600:
        raise SystemExit(1)
    if item.st_uid != 0 or item.st_gid != 0 or item.st_nlink != 1:
        raise SystemExit(1)
PY
}

assert_no_nested_mounts() {
  findmnt --json --output TARGET > "$mount_inventory" || die 'não foi possível inventariar mounts do host'
  python3 - "$mount_inventory" "$data_root" <<'PY' || die 'nested mount detectado dentro da origem plaintext'
import json, os, sys

with open(sys.argv[1], encoding='utf-8') as handle:
    payload = json.load(handle)
root = os.path.realpath(sys.argv[2])

def walk(items):
    for item in items or []:
        target = item.get('target')
        if isinstance(target, str):
            resolved = os.path.realpath(target)
            if resolved == root or resolved.startswith(root + os.sep):
                raise SystemExit(1)
        walk(item.get('children'))

walk(payload.get('filesystems'))
PY
}

assert_containers_stopped
assert_no_nested_mounts
assert_plaintext_top_level "$data_root"
tree_manifest "$source_before" "$data_root" || die 'origem plaintext reprovou inventário; activeRecordings precisa ser 0'
python3 - "$source_before" "$legacy_uid" "$legacy_gid" <<'PY' || die 'origem plaintext possui ownership misto ou diverge do par legado selado'
import json, sys
manifest, uid_raw, gid_raw = sys.argv[1:]
uid, gid = int(uid_raw), int(gid_raw)
with open(manifest, encoding='utf-8') as handle:
    for raw in handle:
        item = json.loads(raw)
        if str(item.get('path', '')).split('/', 1)[0] in {'recordings', 'state', 'auth', 'cache'}:
            if item.get('uid') != uid or item.get('gid') != gid:
                raise SystemExit(1)
PY
validate_legacy_colocated_contract "$source_before" ||
  die 'marker legado, manifesto ou layout co-located diverge da origem plaintext'
assert_shared_neighbors

if mapper_mounts="$(findmnt -rn -o TARGET -S "$mapper_path" 2>/dev/null)" && [ -n "$mapper_mounts" ]; then
  die 'mapper LUKS já está montado; a migração exige staging ainda desmontado'
fi

mkdir -m 0700 -- "$staging"
chown root:root "$staging"
mount -o rw,nodev,nosuid,noexec "$mapper_path" "$staging" || die 'não foi possível montar mapper LUKS no staging'
staging_mounted=true
mountpoint -q -- "$staging" || die 'staging não foi confirmado como mountpoint'

python3 - "$staging" <<'PY' || die 'filesystem LUKS de staging já contém dados; nunca sobrescrevemos destino existente'
import os, stat, sys
entries = os.listdir(sys.argv[1])
for name in entries:
    path = os.path.join(sys.argv[1], name)
    metadata = os.lstat(path)
    if name != 'lost+found' or not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(1)
    if os.listdir(path):
        raise SystemExit(1)
PY
chown root:root "$staging"
chmod 0700 "$staging"

stage_config="$staging/config"
stage_app_env="$stage_config/app.env"
stage_tunnel_token="$stage_config/cloudflared-token"
printf '%s\n' \
  "KASSINAO_DATA_ROOT=$staging" \
  "KASSINAO_RECORDINGS_DIR=$staging/recordings" \
  "KASSINAO_STATE_DIR=$staging/state" \
  "KASSINAO_AUTH_DIR=$staging/auth" \
  "KASSINAO_MODEL_CACHE_DIR=$staging/cache" \
  "KASSINAO_SHARED_APP_ENV_FILE=$stage_app_env" \
  "KASSINAO_SHARED_TUNNEL_TOKEN_FILE=$stage_tunnel_token" \
  "KASSINAO_SHARED_LUKS_BACKING_FILE=$backing_file" \
  "KASSINAO_SHARED_LUKS_MAPPER=$mapper" \
  "KASSINAO_SHARED_LUKS_UUID=$uuid" \
  "KASSINAO_UID=$uid" \
  "KASSINAO_GID=$gid" > "$stage_env"
chown root:root "$stage_env"
chmod 0600 "$stage_env"
env -i "PATH=$PATH" HOME=/root LC_ALL=C "LD_PRELOAD=${LD_PRELOAD-}" "KASSINAO_ENV_FILE=$stage_env" "$VERIFIER" --root-only >/dev/null ||
  die 'staging não passou na prova root-only do verifier shared'

python3 - "$data_root" "$staging" <<'PY' || die 'espaço livre insuficiente no LUKS para cópia e margem de segurança'
import os, shutil, stat, sys

source, destination = sys.argv[1:]
required = 0
for root, directories, files in os.walk(source, followlinks=False):
    for name in directories + files:
        metadata = os.lstat(os.path.join(root, name))
        if stat.S_ISREG(metadata.st_mode):
            required += metadata.st_size
margin = max(64 * 1024 * 1024, required // 10)
if shutil.disk_usage(destination).free < required + margin:
    raise SystemExit(1)
PY

for source in "$recordings" "$state" "$auth" "$cache" "$data_root/.legacy-shared-transition"; do
  cp -a -- "$source" "$staging/"
done
sync -f "$staging"
tree_manifest "$source_after" "$data_root" || die 'origem mudou ou ficou irregular durante a cópia'
cmp -s "$source_before" "$source_after" || die 'origem mudou durante a migração; troca cancelada'
validate_legacy_colocated_contract "$source_after" ||
  die 'marker legado, manifesto ou layout co-located mudou durante a cópia'
normalize_legacy_colocated_layout "$staging" ||
  die 'não foi possível normalizar estado/autenticação co-located apenas no staging cifrado'
normalize_runtime_tree_ownership "$staging"
project_normalized_manifest "$source_after" "$source_expected" ||
  die 'não foi possível projetar o manifesto normalizado esperado'
tree_manifest "$destination_manifest" "$staging" || die 'destino cifrado reprovou inventário após a cópia'
cmp -s "$source_expected" "$destination_manifest" || die 'checksum/mode/ownership normalizado do destino diverge da origem; troca cancelada'

mkdir -m 0700 -- "$stage_config"
chown root:root "$stage_config"
seed_shared_app_env "$stage_app_env" || die 'não foi possível criar app.env cifrado a partir da allowlist pública'
: > "$stage_tunnel_token"
chown "root:$gid" "$stage_app_env"
chmod 0440 "$stage_app_env"
chown root:root "$stage_tunnel_token"
chmod 0444 "$stage_tunnel_token"
sentinel="$staging/.kassinao-mounted"
printf 'kassinao-shared-luks-v1\nuuid=%s\nmapper=%s\n' "$uuid" "$mapper" > "$sentinel"
chown root:root "$sentinel"
chmod 0400 "$sentinel"
cp -- "$source_after" "$staging/.kassinao-migration-manifest.jsonl"
chown root:root "$staging/.kassinao-migration-manifest.jsonl"
chmod 0400 "$staging/.kassinao-migration-manifest.jsonl"
sync -f "$staging"
env -i "PATH=$PATH" HOME=/root LC_ALL=C "LD_PRELOAD=${LD_PRELOAD-}" "KASSINAO_ENV_FILE=$stage_env" "$VERIFIER" >/dev/null ||
  die 'destino cifrado copiado não passou na prova completa do verifier shared'

# Revalida writers e bytes imediatamente antes da única fronteira de troca.
assert_shared_neighbors
assert_containers_stopped
assert_no_nested_mounts
assert_plaintext_top_level "$data_root"
tree_manifest "$source_final" "$data_root" || die 'origem mudou antes da troca'
cmp -s "$source_after" "$source_final" || die 'origem mudou antes da troca; rollback plaintext mantido no lugar'
[ ! -e "$rollback_path" ] && [ ! -L "$rollback_path" ] || die 'rollback plaintext apareceu durante a migração'
if mountpoint -q -- "$data_root"; then
  die 'DATA_ROOT virou mountpoint antes da troca; operação cancelada'
fi

mv -- "$data_root" "$rollback_path"
source_moved=true
mkdir -m 0700 -- "$data_root"
chown root:root "$data_root"
mount --move "$staging" "$data_root" || die 'falha ao mover mount cifrado para DATA_ROOT; restaurando origem'
staging_mounted=false
new_mount_at_data_root=true
mountpoint -q -- "$data_root" || die 'DATA_ROOT não foi confirmado como mountpoint após a troca'

env -i "PATH=$PATH" HOME=/root LC_ALL=C "LD_PRELOAD=${LD_PRELOAD-}" "KASSINAO_ENV_FILE=$ENV_FILE" "$VERIFIER" >/dev/null ||
  die 'storage cifrado final não passou no verifier; restaurando origem plaintext'
tree_manifest "$final_manifest" "$data_root" || die 'destino final divergiu após a troca'
cmp -s "$source_expected" "$final_manifest" || die 'manifesto final diverge; restaurando origem plaintext'
rm -f -- "$source_final"
assert_plaintext_top_level "$rollback_path"
tree_manifest "$source_final" "$rollback_path" || die 'rollback plaintext ficou irregular após a troca'
cmp -s "$source_before" "$source_final" || die 'rollback plaintext divergiu; storage novo não será aprovado'
cmp -s "$source_after" "$data_root/.kassinao-migration-manifest.jsonl" ||
  die 'manifesto persistido no LUKS divergiu; restaurando origem plaintext'

# O rollback nunca é apagado aqui. O marker cifrado cria um contrato explícito
# para validação, prazo e finalização posterior sob confirmação humana.
[ ! -e "$pending_marker" ] && [ ! -L "$pending_marker" ] &&
  [ ! -e "$purged_marker" ] && [ ! -L "$purged_marker" ] ||
  die 'marker de rollback plaintext já existe; migração não será aprovada'
mapfile -t marker_seed < <(python3 - <<'PY'
import secrets, time
print(secrets.token_hex(16))
print(int(time.time()))
PY
)
[ "${#marker_seed[@]}" -eq 2 ] || die 'não foi possível gerar identidade/epoch do marker de rollback'
migration_id="${marker_seed[0]}"
created_at="${marker_seed[1]}"
[[ "$migration_id" =~ ^[0-9a-f]{32}$ ]] && [[ "$created_at" =~ ^[1-9][0-9]*$ ]] ||
  die 'identidade/epoch inválido para marker de rollback'
deadline="$((created_at + rollback_retention_hours * 3600))"
manifest_sha256="$(python3 - "$data_root/.kassinao-migration-manifest.jsonl" 2>/dev/null <<'PY'
import hashlib, sys
with open(sys.argv[1], 'rb') as source:
    print(hashlib.sha256(source.read()).hexdigest())
PY
)"
[[ "$manifest_sha256" =~ ^[0-9a-f]{64}$ ]] || die 'não foi possível selar manifesto persistido no marker'
marker_tmp="$data_root/.kassinao-plaintext-rollback.pending.tmp.$migration_id"
[ ! -e "$marker_tmp" ] && [ ! -L "$marker_tmp" ] || die 'resíduo de marker exige revisão manual'
(
  set -o noclobber
  printf '%s\n' \
    'kassinao-shared-plaintext-rollback-v1' \
    'status=pending' \
    "migration_id=$migration_id" \
    "manifest_sha256=$manifest_sha256" \
    "rollback_path=$rollback_path" \
    "created_at=$created_at" \
    "deadline=$deadline" > "$marker_tmp"
) 2>/dev/null || die 'não foi possível criar marker pending sem sobrescrever estado'
chown root:root "$marker_tmp" 2>/dev/null || die 'não foi possível proteger marker pending temporário'
chmod 0400 "$marker_tmp" 2>/dev/null || die 'não foi possível proteger marker pending temporário'
sync -f "$marker_tmp" 2>/dev/null || die 'não foi possível tornar marker pending temporário durável'
mv -- "$marker_tmp" "$pending_marker" 2>/dev/null || die 'não foi possível publicar marker pending'
marker_tmp=''
sync -f "$data_root" 2>/dev/null || die 'não foi possível tornar marker pending durável'

migration_succeeded=true
printf 'Migração shared concluída; storage cifrado ativo em %s.\n' "$data_root"
printf 'Rollback de dados plaintext preservado integralmente em %s; este script nunca o apaga.\n' "$rollback_path"
printf 'Este não é um rollback operacional: não religue o Compose legado nem reinstale controles dedicated; a recuperação do serviço é fix-forward pelo adapter shared.\n'
printf 'A remoção futura do rollback de dados exige decisão e runbook privado após validar app/backup e rotacionar auth/credenciais expostas em plaintext.\n'
