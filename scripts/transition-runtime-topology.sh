#!/bin/bash -p
# Transição reversível, selada e sem Git entre a topologia shared anterior
# (core/public/tunnel) e a topologia com router dedicado. O script só opera
# bundles imutáveis, Compose files explícitos e objetos Docker cuja identidade
# completa foi provada.
set -Eeuo pipefail
umask 077

die() {
  printf 'ERRO: %s\n' "$*" >&2
  exit 1
}

# KASSINAO_HOST_ENV_SCRUB_BEGIN
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
_forbidden_docker_environment=''
for _name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION \
  COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES KASSINAO_ENV_FILE KASSINAO_DEPLOY_DIR; do
  if declare -p "$_name" >/dev/null 2>&1; then _forbidden_docker_environment="$_name"; break; fi
done
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente da transição'
while IFS='=' read -r -d '' _name _value; do unset "$_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset _name _value
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C
[ -z "$_forbidden_docker_environment" ] ||
  die "$_forbidden_docker_environment não pode vir do ambiente da transição"
# KASSINAO_HOST_ENV_SCRUB_END

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho da transição não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'transição precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/transition-runtime-topology.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit da transição não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter da transição não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

usage() {
  cat >&2 <<'EOF'
uso: transition-runtime-topology.sh COMANDO \
  --current-bundle ABS --current-env ABS \
  --current-compose ABS --current-compose ABS \
  --legacy-bundle ABS --legacy-env ABS \
  --legacy-compose ABS --legacy-compose ABS \
  --state-file ABS

COMANDO: inspect | retire-current | prepare-legacy | retire-legacy
EOF
  exit 1
}

[ "$#" -ge 1 ] || usage
COMMAND="$1"
shift
case "$COMMAND" in inspect | retire-current | prepare-legacy | retire-legacy) ;; *) usage ;; esac

CURRENT_BUNDLE=''
CURRENT_ENV=''
LEGACY_BUNDLE=''
LEGACY_ENV=''
STATE_FILE=''
CURRENT_COMPOSE=()
LEGACY_COMPOSE=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --current-bundle)
      [ "$#" -ge 2 ] && [ -z "$CURRENT_BUNDLE" ] || usage
      CURRENT_BUNDLE="$2"
      shift 2
      ;;
    --current-env)
      [ "$#" -ge 2 ] && [ -z "$CURRENT_ENV" ] || usage
      CURRENT_ENV="$2"
      shift 2
      ;;
    --current-compose) [ "$#" -ge 2 ] || usage; CURRENT_COMPOSE+=("$2"); shift 2 ;;
    --legacy-bundle)
      [ "$#" -ge 2 ] && [ -z "$LEGACY_BUNDLE" ] || usage
      LEGACY_BUNDLE="$2"
      shift 2
      ;;
    --legacy-env)
      [ "$#" -ge 2 ] && [ -z "$LEGACY_ENV" ] || usage
      LEGACY_ENV="$2"
      shift 2
      ;;
    --legacy-compose) [ "$#" -ge 2 ] || usage; LEGACY_COMPOSE+=("$2"); shift 2 ;;
    --state-file)
      [ "$#" -ge 2 ] && [ -z "$STATE_FILE" ] || usage
      STATE_FILE="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done
[ -n "$CURRENT_BUNDLE" ] && [ -n "$CURRENT_ENV" ] && [ -n "$LEGACY_BUNDLE" ] &&
  [ -n "$LEGACY_ENV" ] && [ -n "$STATE_FILE" ] || usage
[ "${#CURRENT_COMPOSE[@]}" -eq 2 ] && [ "${#LEGACY_COMPOSE[@]}" -eq 2 ] ||
  die 'shared exige exatamente Compose base + overlay em cada bundle'

[ "$(id -u)" -eq 0 ] || die 'execute como root'
for executable_name in awk cmp dirname docker env findmnt flock grep id ip6tables iptables mv python3 readlink sha256sum sort stat systemctl; do
  command -v "$executable_name" >/dev/null 2>&1 || die "$executable_name é obrigatório"
done

canonical_absolute() {
  local value="$1" description="$2"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "$description precisa ser caminho absoluto simples"
  case "$value" in *//* | */./* | */../* | */. | */.. | */) die "$description precisa ser canônico" ;; esac
}

assert_root_directory() {
  local path="$1" mode="$2" description="$3"
  canonical_absolute "$path" "$description"
  [ -d "$path" ] && [ ! -L "$path" ] && [ "$(readlink -f -- "$path" 2>/dev/null || true)" = "$path" ] ||
    die "$description precisa ser diretório real canônico"
  [ "$(stat -c '%a:%u:%g' "$path" 2>/dev/null || true)" = "$mode:0:0" ] ||
    die "$description precisa ser $mode root:root"
}

assert_root_file() {
  local path="$1" mode="$2" description="$3"
  canonical_absolute "$path" "$description"
  [ -f "$path" ] && [ ! -L "$path" ] && [ "$(readlink -f -- "$path" 2>/dev/null || true)" = "$path" ] ||
    die "$description precisa ser arquivo real canônico"
  [ "$(stat -c '%a:%u:%g:%h' "$path" 2>/dev/null || true)" = "$mode:0:0:1" ] ||
    die "$description precisa ser $mode root:root sem hardlink"
}

manifest_count() {
  local manifest="$1" wanted="$2"
  awk -v wanted="$wanted" '
    {
      path=$2
      sub(/^\.\//, "", path)
      if (path == wanted) count++
    }
    END { print count + 0 }
  ' "$manifest"
}

verify_bundle() {
  local root="$1" role="$2" manifest relative
  manifest="$root/MANIFEST.sha256"
  shift 2
  assert_root_directory "$root" 700 "bundle $role"
  assert_root_file "$manifest" 644 "MANIFEST do bundle $role"
  for relative in \
    scripts/harden-docker-egress.sh \
    scripts/health-watch.sh \
    scripts/no-dump-exec.py \
    deploy/docker-client/config.json \
    "$@"; do
    [ "$(manifest_count "$manifest" "$relative")" -eq 1 ] ||
      die "$relative precisa aparecer uma vez no MANIFEST do bundle $role"
  done
  (cd -- "$root" && sha256sum -c MANIFEST.sha256 --quiet) ||
    die "bundle $role diverge do MANIFEST.sha256"
}

[ "$CURRENT_BUNDLE" = "$PROJECT_DIR" ] || die '--current-bundle precisa ser o kit que executa a transição'
canonical_absolute "$LEGACY_BUNDLE" 'bundle legacy'
for index in 0 1; do
  canonical_absolute "${CURRENT_COMPOSE[$index]}" 'Compose current'
  canonical_absolute "${LEGACY_COMPOSE[$index]}" 'Compose legacy'
done
[ "${CURRENT_COMPOSE[0]}" = "$CURRENT_BUNDLE/docker-compose.yml" ] &&
  [ "${CURRENT_COMPOSE[1]}" = "$CURRENT_BUNDLE/docker-compose.shared.yml" ] ||
  die 'Compose current precisa ser base + overlay oficiais do bundle'
[ "${LEGACY_COMPOSE[0]}" = "$LEGACY_BUNDLE/docker-compose.yml" ] &&
  [ "${LEGACY_COMPOSE[1]}" = "$LEGACY_BUNDLE/docker-compose.shared.yml" ] ||
  die 'Compose legacy precisa ser base + overlay oficiais do bundle'

verify_bundle "$CURRENT_BUNDLE" current \
  scripts/transition-runtime-topology.sh docker-compose.yml docker-compose.shared.yml
verify_bundle "$LEGACY_BUNDLE" legacy docker-compose.yml docker-compose.shared.yml
[ "$(sha256sum "$LEGACY_BUNDLE/docker-compose.yml" | awk '{print $1}')" = f4d545edbdfe50910126afc441fe7dd47de5eacf3a9cf171c6d2c1a47a1ad2ef ] &&
  [ "$(sha256sum "$LEGACY_BUNDLE/docker-compose.shared.yml" | awk '{print $1}')" = 18553d4bc3200b8cbe8dce44251956266fb7cac9334ac8550f426fe7c03a2e3b ] &&
  [ "$(sha256sum "$LEGACY_BUNDLE/scripts/harden-docker-egress.sh" | awk '{print $1}')" = 50bfe17476580357f3f18439caeefdbd565fc0b09b7156899fe0cb461e8e3829 ] &&
  [ "$(sha256sum "$LEGACY_BUNDLE/scripts/health-watch.sh" | awk '{print $1}')" = 08e3d81f9caab710db565b9ac9e71f4249197633a7294e26618b1645aba4de48 ] ||
  die 'bundle legacy não corresponde aos artefatos shared publicados em v1.4.14..v1.4.16'

[ "$CURRENT_ENV" = "$CURRENT_BUNDLE/.env" ] && [ "$LEGACY_ENV" = "$LEGACY_BUNDLE/.env" ] ||
  die 'health-watch selado exige o .env canônico dentro de cada bundle'
assert_root_file "$CURRENT_ENV" 600 '.env current'
assert_root_file "$LEGACY_ENV" 600 '.env legacy'

env_value() {
  local key="$1" file="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      count++
      value=substr($0, length(key) + 2)
    }
    END {
      if (count != 1) exit 2
      print value
    }
  ' "$file" || die "$key precisa aparecer exatamente uma vez em ${file%/*}/.env"
}

CURRENT_SCOPE="$(env_value KASSINAO_HOST_SCOPE "$CURRENT_ENV")"
LEGACY_SCOPE="$(env_value KASSINAO_HOST_SCOPE "$LEGACY_ENV")"
[ "$CURRENT_SCOPE" = shared ] && [ "$LEGACY_SCOPE" = shared ] ||
  die 'transição segura suporta somente o adapter shared com restart=no'
CURRENT_PROFILES="$(env_value COMPOSE_PROFILES "$CURRENT_ENV")"
LEGACY_PROFILES="$(env_value COMPOSE_PROFILES "$LEGACY_ENV")"
TUNNEL="$(
  python3 - "$CURRENT_PROFILES" "$LEGACY_PROFILES" <<'PY'
import sys

def parse(raw):
    values = [item.strip() for item in raw.split(',')]
    if not values or any(not item for item in values):
        raise SystemExit(1)
    if len(values) != len(set(values)):
        raise SystemExit(1)
    allowed = {'split-public', 'tunnel'}
    if set(values) - allowed or 'split-public' not in values:
        raise SystemExit(1)
    return set(values)

current = parse(sys.argv[1])
legacy = parse(sys.argv[2])
if current != legacy:
    raise SystemExit(1)
print('true' if 'tunnel' in current else 'false')
PY
)" || die 'COMPOSE_PROFILES precisa ser o mesmo conjunto sem duplicados: split-public[,tunnel]'

DATA_ROOT="$(env_value KASSINAO_DATA_ROOT "$CURRENT_ENV")"
STATE_ROOT="$(env_value KASSINAO_STATE_DIR "$CURRENT_ENV")"
RECORDINGS_ROOT="$(env_value KASSINAO_RECORDINGS_DIR "$CURRENT_ENV")"
APP_ENV_FILE="$(env_value KASSINAO_SHARED_APP_ENV_FILE "$CURRENT_ENV")"
RETENTION_HOURS="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS "$CURRENT_ENV")"
APP_UID="$(env_value KASSINAO_UID "$CURRENT_ENV")"
APP_GID="$(env_value KASSINAO_GID "$CURRENT_ENV")"
for key in KASSINAO_DATA_ROOT KASSINAO_STATE_DIR KASSINAO_RECORDINGS_DIR KASSINAO_SHARED_APP_ENV_FILE KASSINAO_ROLLBACK_RETENTION_HOURS KASSINAO_UID KASSINAO_GID; do
  [ "$(env_value "$key" "$CURRENT_ENV")" = "$(env_value "$key" "$LEGACY_ENV")" ] ||
    die "$key precisa coincidir entre current e legacy"
done
canonical_absolute "$DATA_ROOT" KASSINAO_DATA_ROOT
canonical_absolute "$STATE_ROOT" KASSINAO_STATE_DIR
canonical_absolute "$RECORDINGS_ROOT" KASSINAO_RECORDINGS_DIR
canonical_absolute "$APP_ENV_FILE" KASSINAO_SHARED_APP_ENV_FILE
assert_root_directory "$DATA_ROOT" 700 KASSINAO_DATA_ROOT
[ "$STATE_ROOT" = "$DATA_ROOT/state" ] && [ "$RECORDINGS_ROOT" = "$DATA_ROOT/recordings" ] ||
  die 'state/recordings precisam ser filhos canônicos do mesmo DATA_ROOT'
[ "$APP_ENV_FILE" = "$DATA_ROOT/config/app.env" ] ||
  die 'KASSINAO_SHARED_APP_ENV_FILE precisa ser DATA_ROOT/config/app.env'
[[ "$RETENTION_HOURS" =~ ^[1-9][0-9]*$ ]] && [ "$RETENTION_HOURS" -le 168 ] ||
  die 'retenção compartilhada precisa ficar entre 1 e 168 horas'
[[ "$APP_UID" =~ ^[0-9]+$ ]] && [ "$APP_UID" -ge 61000 ] && [ "$APP_UID" -le 61183 ] ||
  die 'KASSINAO_UID shared precisa ficar na faixa privada 61000..61183'
[[ "$APP_GID" =~ ^[0-9]+$ ]] && [ "$APP_GID" -ge 61000 ] && [ "$APP_GID" -le 61183 ] ||
  die 'KASSINAO_GID shared precisa ficar na faixa privada 61000..61183'
assert_private_directory() {
  local path="$1" description="$2"
  canonical_absolute "$path" "$description"
  [ -d "$path" ] && [ ! -L "$path" ] && [ "$(readlink -f -- "$path" 2>/dev/null || true)" = "$path" ] ||
    die "$description precisa ser diretório real canônico"
  [ "$(stat -c '%a:%u:%g' "$path" 2>/dev/null || true)" = "700:$APP_UID:$APP_GID" ] ||
    die "$description precisa ser 0700 $APP_UID:$APP_GID"
}
assert_private_directory "$STATE_ROOT" KASSINAO_STATE_DIR
assert_private_directory "$RECORDINGS_ROOT" KASSINAO_RECORDINGS_DIR
assert_shared_app_env() {
  local config_root app_env_mount
  config_root="$DATA_ROOT/config"
  assert_root_directory "$config_root" 700 'diretório de configuração shared'
  [ -f "$APP_ENV_FILE" ] && [ ! -L "$APP_ENV_FILE" ] &&
    [ "$(readlink -f -- "$APP_ENV_FILE" 2>/dev/null || true)" = "$APP_ENV_FILE" ] ||
    die 'KASSINAO_SHARED_APP_ENV_FILE precisa ser arquivo real canônico'
  [ "$(stat -c '%a:%u:%g:%h' "$APP_ENV_FILE" 2>/dev/null || true)" = "440:0:$APP_GID:1" ] ||
    die "KASSINAO_SHARED_APP_ENV_FILE precisa ser 0440 root:$APP_GID sem hardlink"
  app_env_mount="$(findmnt -n -o TARGET -T "$APP_ENV_FILE" 2>/dev/null)" ||
    die 'não foi possível provar o mount de KASSINAO_SHARED_APP_ENV_FILE'
  [ "$(readlink -f -- "$app_env_mount" 2>/dev/null || true)" = "$DATA_ROOT" ] ||
    die 'KASSINAO_SHARED_APP_ENV_FILE precisa ficar no mesmo mount de DATA_ROOT'
  [ "$(env_value TRUST_PROXY_HOPS "$APP_ENV_FILE")" = 1 ] ||
    die 'TRUST_PROXY_HOPS precisa ser exatamente 1 no app.env antes da transição'
}
assert_shared_app_env
STATE_FILE_PARENT="$(dirname -- "$STATE_FILE")"
[ "${STATE_FILE##*/}" = topology-transition.json ] ||
  die '--state-file precisa terminar em topology-transition.json'
[ "$(dirname -- "$STATE_FILE_PARENT")" = "$DATA_ROOT" ] ||
  die 'state root da transição precisa ser filho direto de KASSINAO_DATA_ROOT'
case "$STATE_FILE_PARENT" in
  "$DATA_ROOT"/recordings | "$DATA_ROOT"/state | "$DATA_ROOT"/auth | "$DATA_ROOT"/cache | "$DATA_ROOT"/config | "$DATA_ROOT"/rollback)
    die 'state root da transição não pode pertencer ao app, segredos ou rollback'
    ;;
esac
assert_root_directory "$STATE_FILE_PARENT" 700 'state root da transição'
[ "$(stat -c '%d' "$STATE_FILE_PARENT" 2>/dev/null || true)" = "$(stat -c '%d' "$DATA_ROOT" 2>/dev/null || true)" ] ||
  die 'state root da transição precisa ficar no mesmo filesystem de DATA_ROOT'
STATE_FILE_MOUNT="$(findmnt -n -o TARGET -T "$STATE_FILE_PARENT" 2>/dev/null)" ||
  die 'não foi possível provar o mount do state root da transição'
[ "$(readlink -f -- "$STATE_FILE_MOUNT" 2>/dev/null || true)" = "$DATA_ROOT" ] ||
  die 'state root da transição não pode ser mount aninhado ou externo a DATA_ROOT'
if [ -e "$STATE_FILE" ] || [ -L "$STATE_FILE" ]; then
  assert_root_file "$STATE_FILE" 600 'estado da transição'
fi

DOCKER_CONFIG="$CURRENT_BUNDLE/deploy/docker-client"
assert_root_directory "$DOCKER_CONFIG" 755 'diretório Docker client'
assert_root_file "$DOCKER_CONFIG/config.json" 444 'configuração Docker client'
[ "$(sha256sum -- "$DOCKER_CONFIG/config.json" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] ||
  die 'configuração Docker client diverge do objeto vazio selado'
export DOCKER_HOST=unix:///var/run/docker.sock DOCKER_CONFIG
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || die 'daemon Docker local indisponível'

HOST_CONTROLS=/etc/kassinao/host-controls.env
HEALTH_DISPATCHER=/usr/local/sbin/kassinao-health-watch
HARDENER_DISPATCHER=/usr/local/sbin/kassinao-harden-docker-egress
HEALTH_SERVICE=kassinao-health-watch.service
HEALTH_TIMER=kassinao-health-watch.timer
RUNTIME_DIR=/run/lock/kassinao
MAINTENANCE_LOCK="$RUNTIME_DIR/maintenance.lock"

assert_root_directory /etc/kassinao 755 '/etc/kassinao'
assert_root_file "$HOST_CONTROLS" 600 'marker de controles'
assert_root_file "$HEALTH_DISPATCHER" 755 'dispatcher do health-watch'
assert_root_file "$HARDENER_DISPATCHER" 755 'dispatcher do hardener'
if cmp -s "$CURRENT_BUNDLE/scripts/health-watch.sh" "$HEALTH_DISPATCHER" &&
  cmp -s "$CURRENT_BUNDLE/scripts/harden-docker-egress.sh" "$HARDENER_DISPATCHER"; then
  INSTALLED_DISPATCHER_BUNDLE="$CURRENT_BUNDLE"
elif cmp -s "$LEGACY_BUNDLE/scripts/health-watch.sh" "$HEALTH_DISPATCHER" &&
  cmp -s "$LEGACY_BUNDLE/scripts/harden-docker-egress.sh" "$HARDENER_DISPATCHER"; then
  INSTALLED_DISPATCHER_BUNDLE="$LEGACY_BUNDLE"
else
  die 'dispatchers instalados não pertencem integralmente ao bundle current nem ao legacy'
fi
assert_root_directory "$RUNTIME_DIR" 700 'runtime de locks'
assert_root_file "$MAINTENANCE_LOCK" 600 maintenance.lock

marker_deploy_dir() {
  python3 - "$HOST_CONTROLS" "$DATA_ROOT" "$RETENTION_HOURS" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
expected_data_root = sys.argv[2]
expected_retention = sys.argv[3]
lines = path.read_text(encoding='utf-8').splitlines()
if len(lines) != 4:
    raise SystemExit(71)
values = {}
for line in lines:
    if '=' not in line:
        raise SystemExit(71)
    key, value = line.split('=', 1)
    if key in values:
        raise SystemExit(71)
    values[key] = value
if set(values) != {
    'KASSINAO_HOST_SCOPE',
    'KASSINAO_DEPLOY_DIR',
    'KASSINAO_DATA_ROOT',
    'KASSINAO_ROLLBACK_RETENTION_HOURS',
}:
    raise SystemExit(71)
if values['KASSINAO_HOST_SCOPE'] != 'shared':
    raise SystemExit(71)
if values['KASSINAO_DATA_ROOT'] != expected_data_root:
    raise SystemExit(71)
if values['KASSINAO_ROLLBACK_RETENTION_HOURS'] != expected_retention:
    raise SystemExit(71)
print(values['KASSINAO_DEPLOY_DIR'])
PY
}

publish_marker() {
  local deploy_dir="$1"
  [ "$deploy_dir" = "$CURRENT_BUNDLE" ] || [ "$deploy_dir" = "$LEGACY_BUNDLE" ] ||
    die 'destino do marker não é um bundle aprovado'
  python3 - "$HOST_CONTROLS" "$deploy_dir" "$DATA_ROOT" "$RETENTION_HOURS" <<'PY' || die 'gravação atômica do marker shared falhou'
import os
import pathlib
import secrets
import sys

target = pathlib.Path(sys.argv[1])
deploy_dir, data_root, retention = sys.argv[2:]
parent = target.parent
temporary = parent / f'.host-controls.env.{os.getpid()}.{secrets.token_hex(6)}'
payload = (
    'KASSINAO_HOST_SCOPE=shared\n'
    f'KASSINAO_DEPLOY_DIR={deploy_dir}\n'
    f'KASSINAO_DATA_ROOT={data_root}\n'
    f'KASSINAO_ROLLBACK_RETENTION_HOURS={retention}\n'
).encode()
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.write(fd, payload)
    os.fsync(fd)
finally:
    os.close(fd)
os.chown(temporary, 0, 0, follow_symlinks=False)
os.replace(temporary, target)
parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(parent_fd)
finally:
    os.close(parent_fd)
PY
  assert_root_file "$HOST_CONTROLS" 600 'marker publicado'
  [ "$(marker_deploy_dir)" = "$deploy_dir" ] || die 'marker publicado divergiu do bundle escolhido'
}

read_state() {
  if [ ! -e "$STATE_FILE" ]; then
    printf 'neutral\n'
    return
  fi
  python3 - "$STATE_FILE" "$TUNNEL" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
if not isinstance(value, dict) or set(value) != {'schema_version', 'state', 'tunnel'}:
    raise SystemExit(72)
if value['schema_version'] != 1:
    raise SystemExit(72)
if value['state'] not in {
    'current_stopped',
    'neutral',
    'legacy_prepared',
    'legacy_running',
    'legacy_stopped',
}:
    raise SystemExit(72)
expected_tunnel = sys.argv[2] == 'true'
if value['tunnel'] is not expected_tunnel:
    raise SystemExit(72)
print(value['state'])
PY
}

write_state() {
  local state="$1"
  case "$state" in current_stopped | neutral | legacy_prepared | legacy_running | legacy_stopped) ;; *) die 'estado interno inválido' ;; esac
  python3 - "$STATE_FILE" "$state" "$TUNNEL" <<'PY' || die 'gravação atômica do estado shared falhou'
import json
import os
import pathlib
import secrets
import sys

target = pathlib.Path(sys.argv[1])
state = sys.argv[2]
tunnel = sys.argv[3] == 'true'
temporary = target.parent / f'.topology-transition.{os.getpid()}.{secrets.token_hex(6)}'
payload = (json.dumps(
    {'schema_version': 1, 'state': state, 'tunnel': tunnel},
    ensure_ascii=True,
    separators=(',', ':'),
    sort_keys=True,
) + '\n').encode()
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.write(fd, payload)
    os.fsync(fd)
finally:
    os.close(fd)
os.chown(temporary, 0, 0, follow_symlinks=False)
os.replace(temporary, target)
parent_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(parent_fd)
finally:
    os.close(parent_fd)
PY
  assert_root_file "$STATE_FILE" 600 'estado publicado'
  [ "$(read_state)" = "$state" ] || die 'estado publicado divergiu'
}

assert_recordings_idle() {
  python3 - "$RECORDINGS_ROOT" <<'PY'
import json
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
invalid = 0
active = 0
with os.scandir(root) as entries:
    for entry in entries:
        try:
            info = entry.stat(follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode):
                continue
            meta = pathlib.Path(entry.path) / 'meta.json'
            meta_info = os.stat(meta, follow_symlinks=False)
            if not stat.S_ISREG(meta_info.st_mode) or meta_info.st_nlink != 1 or meta_info.st_size > 1024 * 1024:
                raise ValueError('unsafe metadata')
            value = json.loads(meta.read_text(encoding='utf-8'))
            if not isinstance(value, dict):
                raise ValueError('metadata is not object')
            status = value.get('status')
            if status not in {'recording', 'done'}:
                raise ValueError('metadata status is not canonical')
            if status == 'recording':
                active += 1
        except FileNotFoundError:
            continue
        except Exception:
            invalid += 1
if invalid:
    print(f'metadados canônicos inválidos: {invalid}', file=sys.stderr)
    raise SystemExit(73)
if active:
    print(f'activeRecordings={active}; exigido activeRecordings=0', file=sys.stderr)
    raise SystemExit(74)
PY
}

CURRENT_LOCK="$CURRENT_BUNDLE/.deploy.lock"
LEGACY_LOCK="$LEGACY_BUNDLE/.deploy.lock"
assert_root_file "$CURRENT_LOCK" 600 '.deploy.lock current'
assert_root_file "$LEGACY_LOCK" 600 '.deploy.lock legacy'
[ "$CURRENT_LOCK" != "$LEGACY_LOCK" ] || die 'bundles current e legacy precisam ser distintos'
if [[ "$CURRENT_LOCK" < "$LEGACY_LOCK" ]]; then
  FIRST_LOCK="$CURRENT_LOCK"
  SECOND_LOCK="$LEGACY_LOCK"
else
  FIRST_LOCK="$LEGACY_LOCK"
  SECOND_LOCK="$CURRENT_LOCK"
fi
exec 7<>"$FIRST_LOCK"
exec 8<>"$SECOND_LOCK"
exec 9<>"$MAINTENANCE_LOCK"
assert_fd_lock() {
  local fd="$1" path="$2" description="$3"
  [ "$(readlink -f -- "/proc/$$/fd/$fd" 2>/dev/null || true)" = "$path" ] &&
    [ "$(stat -c '%d:%i' "$path" 2>/dev/null || true)" = "$(stat -Lc '%d:%i' "/proc/$$/fd/$fd" 2>/dev/null || true)" ] &&
    [ "$(stat -Lc '%a:%u:%g:%h' "/proc/$$/fd/$fd" 2>/dev/null || true)" = 600:0:0:1 ] ||
    die "$description mudou durante a abertura"
}
assert_fd_lock 7 "$FIRST_LOCK" 'primeiro deploy lock'
assert_fd_lock 8 "$SECOND_LOCK" 'segundo deploy lock'
assert_fd_lock 9 "$MAINTENANCE_LOCK" maintenance.lock
flock -w 120 7 || die 'primeiro bundle não liberou o deploy lock'
flock -w 120 8 || die 'segundo bundle não liberou o deploy lock'
flock -w 120 9 || die 'maintenance.lock não foi liberado'

reverify_locked_inputs() {
  verify_bundle "$CURRENT_BUNDLE" current \
    scripts/transition-runtime-topology.sh docker-compose.yml docker-compose.shared.yml
  verify_bundle "$LEGACY_BUNDLE" legacy docker-compose.yml docker-compose.shared.yml
  assert_root_file "$CURRENT_ENV" 600 '.env current'
  assert_root_file "$LEGACY_ENV" 600 '.env legacy'
  assert_shared_app_env
  assert_fd_lock 7 "$FIRST_LOCK" 'primeiro deploy lock'
  assert_fd_lock 8 "$SECOND_LOCK" 'segundo deploy lock'
  assert_fd_lock 9 "$MAINTENANCE_LOCK" maintenance.lock
  assert_root_file "$HEALTH_DISPATCHER" 755 'dispatcher do health-watch'
  assert_root_file "$HARDENER_DISPATCHER" 755 'dispatcher do hardener'
  cmp -s "$INSTALLED_DISPATCHER_BUNDLE/scripts/health-watch.sh" "$HEALTH_DISPATCHER" ||
    die 'dispatcher do health-watch mudou sob lock'
  cmp -s "$INSTALLED_DISPATCHER_BUNDLE/scripts/harden-docker-egress.sh" "$HARDENER_DISPATCHER" ||
    die 'dispatcher do hardener mudou sob lock'
  marker_deploy_dir >/dev/null || die 'marker de controles divergiu sob lock'
  [ "$(read_state)" ] || die 'estado persistido divergiu sob lock'
}
reverify_locked_inputs

compose_command() {
  local topology="$1"
  shift
  local bundle env_file
  local -a compose_files command_line
  case "$topology" in
    current) bundle="$CURRENT_BUNDLE"; env_file="$CURRENT_ENV"; compose_files=("${CURRENT_COMPOSE[@]}") ;;
    legacy) bundle="$LEGACY_BUNDLE"; env_file="$LEGACY_ENV"; compose_files=("${LEGACY_COMPOSE[@]}") ;;
    *) die 'topologia Compose interna inválida' ;;
  esac
  command_line=(
    env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "DOCKER_HOST=$DOCKER_HOST" "DOCKER_CONFIG=$DOCKER_CONFIG"
    docker compose --project-name kassinao --project-directory "$bundle" --env-file "$env_file"
    -f "${compose_files[0]}" -f "${compose_files[1]}" --profile split-public
  )
  [ "$TUNNEL" = false ] || command_line+=(--profile tunnel)
  "${command_line[@]}" "$@"
}

validate_compose_contract() {
  local topology="$1" services networks expected_services expected_networks
  services="$(compose_command "$topology" config --services | sort -u)" ||
    die "Compose $topology não pôde ser resolvido"
  networks="$(compose_command "$topology" config --networks | sort -u)" ||
    die "redes Compose $topology não puderam ser resolvidas"
  if [ "$topology" = current ]; then
    expected_services=$'kassinao\nkassinao-public\nkassinao-router'
    expected_networks=$'core_egress\ncore_link\nedge_ingress\nhost_ingress\npublic_link'
    if [ "$TUNNEL" = true ]; then
      expected_services+=$'\ncloudflared'
      expected_networks+=$'\ntunnel_egress'
    fi
  else
    expected_services=$'kassinao\nkassinao-public'
    expected_networks=$'private\npublic'
    [ "$TUNNEL" = false ] || expected_services+=$'\ncloudflared'
  fi
  [ "$services" = "$(sort <<<"$expected_services")" ] ||
    die "Compose $topology contém conjunto de serviços inesperado"
  [ "$networks" = "$(sort <<<"$expected_networks")" ] ||
    die "Compose $topology contém conjunto de redes inesperado"
  if ! compose_command "$topology" config --format json |
    python3 /dev/fd/3 "$topology" "$TUNNEL" 3<<'PY'
import json
import sys

topology = sys.argv[1]
tunnel = sys.argv[2] == 'true'
value = json.load(sys.stdin)
if not isinstance(value, dict):
    raise SystemExit(1)
services = value.get('services')
networks = value.get('networks')
if not isinstance(services, dict) or not isinstance(networks, dict):
    raise SystemExit(1)
expected_services = {
    'current': {'kassinao', 'kassinao-router', 'kassinao-public'} | ({'cloudflared'} if tunnel else set()),
    'legacy': {'kassinao', 'kassinao-public'} | ({'cloudflared'} if tunnel else set()),
}[topology]
expected_networks = {
    'current': {'edge_ingress', 'host_ingress', 'core_link', 'public_link', 'core_egress'} | ({'tunnel_egress'} if tunnel else set()),
    'legacy': {'private', 'public'},
}[topology]
if set(services) != expected_services or set(networks) != expected_networks:
    raise SystemExit(1)
for name, service in services.items():
    if str(service.get('restart', '')).lower() not in {'no', 'none'}:
        raise SystemExit(1)
    if service.get('container_name') != {
        'kassinao': 'kassinao',
        'kassinao-router': 'kassinao-router',
        'kassinao-public': 'kassinao-public',
        'cloudflared': 'kassinao-tunnel',
    }[name]:
        raise SystemExit(1)
PY
  then
    die "Compose $topology não preserva restart=no/nome/topologia shared"
  fi
}
validate_compose_contract current
validate_compose_contract legacy

declare -A LIVE_IDS=()
declare -A LIVE_NETWORK_IDS=()
LIVE_RUNNING=0
LIVE_READY=0
LIVE_UNHEALTHY=0
LIVE_TOTAL=0

expected_container_networks() {
  local topology="$1" service="$2"
  case "$topology:$service" in
    current:kassinao) printf 'kassinao_core_egress\nkassinao_core_link\n' ;;
    current:kassinao-router) printf 'kassinao_core_link\nkassinao_edge_ingress\nkassinao_host_ingress\nkassinao_public_link\n' ;;
    current:kassinao-public) printf 'kassinao_public_link\n' ;;
    current:cloudflared) printf 'kassinao_edge_ingress\nkassinao_tunnel_egress\n' ;;
    legacy:kassinao) printf 'kassinao_private\n' ;;
    legacy:kassinao-public) printf 'kassinao_public\n' ;;
    legacy:cloudflared) printf 'kassinao_private\nkassinao_public\n' ;;
    *) die 'serviço/topologia inesperado' ;;
  esac
}

container_name_for_service() {
  case "$1" in
    kassinao) printf 'kassinao\n' ;;
    kassinao-router) printf 'kassinao-router\n' ;;
    kassinao-public) printf 'kassinao-public\n' ;;
    cloudflared) printf 'kassinao-tunnel\n' ;;
    *) die 'serviço inesperado' ;;
  esac
}

topology_services() {
  local topology="$1"
  if [ "$topology" = current ]; then
    printf 'kassinao\nkassinao-router\nkassinao-public\n'
  else
    printf 'kassinao\nkassinao-public\n'
  fi
  [ "$TUNNEL" = false ] || printf 'cloudflared\n'
}

topology_networks() {
  local topology="$1"
  if [ "$topology" = current ]; then
    printf 'edge_ingress:kas-edge0:true:any:any:isolated:isolated:any\n'
    printf 'host_ingress:kas-host0:false:false:127.0.0.1:nat:absent:false\n'
    printf 'core_link:kas-core0:true:any:any:isolated:isolated:any\n'
    printf 'public_link:kas-public0:true:any:any:isolated:isolated:any\n'
    printf 'core_egress:kas-core-eg0:false:any:any:any:any:false\n'
    [ "$TUNNEL" = false ] || printf 'tunnel_egress:kas-tunnel-eg0:false:any:any:any:any:false\n'
  else
    printf 'private:kas-private0:false:any:any:any:any:any\n'
    printf 'public:kas-public0:true:any:any:isolated:isolated:any\n'
  fi
}

network_contract_value_matches() {
  local expected="$1" actual="$2"
  case "$expected" in
    any) return 0 ;;
    absent) [ -z "$actual" ] || [ "$actual" = '<no value>' ] ;;
    *) [ "$actual" = "$expected" ] ;;
  esac
}

container_id_by_name() {
  local name="$1" output
  output="$(docker ps -aq --no-trunc --filter "name=^/${name}$")" ||
    die "não foi possível inventariar o nome Docker $name"
  [ -z "$output" ] || [[ "$output" =~ ^[0-9a-f]{64}$ ]] ||
    die "inventário do nome Docker $name não é singular/canônico"
  printf '%s\n' "$output"
}

network_id_by_name() {
  local name="$1" output
  output="$(docker network ls -q --no-trunc --filter "name=^${name}$")" ||
    die "não foi possível inventariar a rede Docker $name"
  [ -z "$output" ] || [[ "$output" =~ ^[0-9a-f]{64}$ ]] ||
    die "inventário da rede Docker $name não é singular/canônico"
  printf '%s\n' "$output"
}

container_exists() {
  local candidate
  candidate="$(container_id_by_name "$1")" || die "não foi possível provar presença de $1"
  [ -n "$candidate" ]
}

validate_container() {
  local topology="$1" service="$2" mode="$3" health_mode="$4" bundle config_files name candidate details
  local actual_id actual_name project actual_service working_dir actual_configs running status restart_policy health extra
  local actual_networks expected_networks
  case "$topology" in
    current) bundle="$CURRENT_BUNDLE"; config_files="${CURRENT_COMPOSE[0]},${CURRENT_COMPOSE[1]}" ;;
    legacy) bundle="$LEGACY_BUNDLE"; config_files="${LEGACY_COMPOSE[0]},${LEGACY_COMPOSE[1]}" ;;
  esac
  name="$(container_name_for_service "$service")"
  candidate="$(container_id_by_name "$name")" || die "inventário de $name falhou"
  if [ -z "$candidate" ]; then
    [ "$mode" = subset ] && return 1
    die "$name está ausente"
  fi
  [[ "$candidate" =~ ^[0-9a-f]{64}$ ]] || die "$name não possui ID Docker completo"
  details="$(
    docker inspect --format \
      '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{.State.Running}}|{{.State.Status}}|{{.HostConfig.RestartPolicy.Name}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$candidate" 2>/dev/null
  )" || die "não foi possível provar identidade de $name"
  IFS='|' read -r actual_id actual_name project actual_service working_dir actual_configs running status restart_policy health extra <<<"$details"
  [ -z "$extra" ] && [ "$actual_id" = "$candidate" ] && [ "$actual_name" = "/$name" ] &&
    [ "$project" = kassinao ] && [ "$actual_service" = "$service" ] &&
    [ "$working_dir" = "$bundle" ] && [ "$actual_configs" = "$config_files" ] ||
    die "$name diverge de ID/nome/labels/config-files aprovados"
  case "$running:$status" in
    true:running | false:created | false:exited | false:dead) ;;
    *) die "$name possui estado Docker incompatível com a transição" ;;
  esac
  [ "$restart_policy" = no ] || die "$name precisa usar restart=no no adapter shared"
  actual_networks="$(
    docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{printf "%s\n" $name}}{{end}}' "$candidate" |
      sort -u
  )" || die "não foi possível provar redes de $name"
  expected_networks="$(expected_container_networks "$topology" "$service" | sort -u)"
  if [ "$mode" = exact ]; then
    [ "$actual_networks" = "$expected_networks" ] || die "$name diverge da topologia $topology exata"
  else
    while IFS= read -r network; do
      [ -z "$network" ] || grep -Fqx "$network" <<<"$expected_networks" ||
        die "$name participa de rede fora da topologia $topology"
    done <<<"$actual_networks"
  fi
  LIVE_IDS["$service"]="$candidate"
  LIVE_TOTAL=$((LIVE_TOTAL + 1))
  if [ "$running" = true ]; then
    LIVE_RUNNING=$((LIVE_RUNNING + 1))
    case "$service" in
      cloudflared) LIVE_READY=$((LIVE_READY + 1)) ;;
      *)
        case "$health_mode:$health" in
          healthy:healthy | starting:healthy | structural:healthy) LIVE_READY=$((LIVE_READY + 1)) ;;
          starting:starting | structural:starting) ;;
          structural:unhealthy) LIVE_UNHEALTHY=$((LIVE_UNHEALTHY + 1)) ;;
          *) die "$name running possui readiness incompatível com a transição" ;;
        esac
        ;;
    esac
  fi
}

validate_network() {
  local topology="$1" key="$2" bridge="$3" internal="$4" enable_ipv6="$5" host_binding_ipv4="$6"
  local gateway4="$7" gateway6="$8" icc="$9" mode="${10}"
  local name="kassinao_$key" candidate details
  local actual_id actual_name driver actual_internal actual_enable_ipv6 project actual_key actual_bridge
  local actual_host_binding_ipv4 actual_gateway4 actual_gateway6 actual_icc
  local extra member member_id member_name members
  candidate="$(network_id_by_name "$name")" || die "inventário da rede $name falhou"
  if [ -z "$candidate" ]; then
    [ "$mode" = subset ] && return 1
    die "rede $name está ausente"
  fi
  [[ "$candidate" =~ ^[0-9a-f]{64}$ ]] || die "rede $name não possui ID completo"
  details="$(
    docker network inspect -f \
      '{{.Id}}|{{.Name}}|{{.Driver}}|{{.Internal}}|{{.EnableIPv6}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.network"}}|{{index .Options "com.docker.network.bridge.name"}}|{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv6"}}|{{index .Options "com.docker.network.bridge.enable_icc"}}' \
      "$candidate" 2>/dev/null
  )" || die "não foi possível provar rede $name"
  IFS='|' read -r actual_id actual_name driver actual_internal actual_enable_ipv6 project actual_key actual_bridge \
    actual_host_binding_ipv4 actual_gateway4 actual_gateway6 actual_icc extra <<<"$details"
  [ -z "$extra" ] && [ "$actual_id" = "$candidate" ] && [ "$actual_name" = "$name" ] &&
    [ "$driver" = bridge ] && [ "$actual_internal" = "$internal" ] &&
    [ "$project" = kassinao ] && [ "$actual_key" = "$key" ] && [ "$actual_bridge" = "$bridge" ] &&
    network_contract_value_matches "$enable_ipv6" "$actual_enable_ipv6" &&
    network_contract_value_matches "$host_binding_ipv4" "$actual_host_binding_ipv4" &&
    network_contract_value_matches "$gateway4" "$actual_gateway4" &&
    network_contract_value_matches "$gateway6" "$actual_gateway6" &&
    network_contract_value_matches "$icc" "$actual_icc" ||
    die "rede $name diverge de ID/nome/labels/bridge/opções/topologia"
  members="$(
    docker network inspect -f '{{range $id, $member := .Containers}}{{printf "%s|%s\n" $id $member.Name}}{{end}}' "$candidate" |
      sort -u
  )" || die "não foi possível provar endpoints da rede $name"
  while IFS='|' read -r member_id member_name; do
    [ -z "$member_id" ] && continue
    case "$member_name" in
      kassinao) member=kassinao ;;
      kassinao-router) member=kassinao-router ;;
      kassinao-public) member=kassinao-public ;;
      kassinao-tunnel) member=cloudflared ;;
      *) die "rede $name contém endpoint inesperado" ;;
    esac
    [ "${LIVE_IDS[$member]-}" = "$member_id" ] || die "rede $name contém ID de endpoint divergente"
    grep -Fqx "$name" <<<"$(expected_container_networks "$topology" "$member")" ||
      die "rede $name conecta serviço fora do mapa $topology"
  done <<<"$members"
  LIVE_NETWORK_IDS["$key"]="$candidate"
}

validate_project_inventory() {
  local topology="$1" mode="$2" id name allowed=false service network_key _bridge _internal
  local _enable_ipv6 _host_binding_ipv4 _gateway4 _gateway6 _icc
  local container_inventory network_inventory
  local -a project_ids=()
  container_inventory="$(docker ps -aq --no-trunc --filter label=com.docker.compose.project=kassinao)" ||
    die 'não foi possível inventariar containers do projeto kassinao'
  while IFS= read -r id; do [ -z "$id" ] || project_ids+=("$id"); done <<<"$container_inventory"
  for id in "${project_ids[@]}"; do
    name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null)" || die 'inventário de containers mudou'
    name="${name#/}"
    allowed=false
    while IFS= read -r service; do
      [ "$name" = "$(container_name_for_service "$service")" ] && allowed=true
    done < <(topology_services "$topology")
    [ "$allowed" = true ] || die "container Compose inesperado no projeto: $name"
  done
  network_inventory="$(docker network ls -q --no-trunc --filter label=com.docker.compose.project=kassinao)" ||
    die 'não foi possível inventariar redes do projeto kassinao'
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    name="$(docker network inspect -f '{{.Name}}' "$id" 2>/dev/null)" || die 'inventário de redes mudou'
    allowed=false
    while IFS=: read -r network_key _bridge _internal _enable_ipv6 _host_binding_ipv4 _gateway4 _gateway6 _icc; do
      [ "$name" = "kassinao_$network_key" ] && allowed=true
    done < <(topology_networks "$topology")
    [ "$allowed" = true ] || die "rede Compose inesperada no projeto: $name"
  done <<<"$network_inventory"
  [ "$mode" = subset ] || [ "$LIVE_TOTAL" -eq "$(topology_services "$topology" | wc -l | tr -d ' ')" ] ||
    die "topologia $topology está incompleta"
}

validate_topology() {
  local topology="$1" mode="$2" health_mode="${3:-healthy}" service key bridge internal
  local enable_ipv6 host_binding_ipv4 gateway4 gateway6 icc
  LIVE_IDS=()
  LIVE_NETWORK_IDS=()
  LIVE_RUNNING=0
  LIVE_READY=0
  LIVE_UNHEALTHY=0
  LIVE_TOTAL=0
  while IFS= read -r service; do
    validate_container "$topology" "$service" "$mode" "$health_mode" || true
  done < <(topology_services "$topology")
  while IFS=: read -r key bridge internal enable_ipv6 host_binding_ipv4 gateway4 gateway6 icc; do
    validate_network "$topology" "$key" "$bridge" "$internal" "$enable_ipv6" "$host_binding_ipv4" \
      "$gateway4" "$gateway6" "$icc" "$mode" || true
  done < <(topology_networks "$topology")
  validate_project_inventory "$topology" "$mode"
}

assert_reserved_absent() {
  local name id container_inventory network_inventory
  for name in kassinao kassinao-router kassinao-public kassinao-tunnel; do
    id="$(container_id_by_name "$name")" || die "não foi possível provar ausência de $name"
    if [ -n "$id" ]; then
      die "nome Docker reservado ainda está ocupado: $name ($id)"
    fi
  done
  container_inventory="$(docker ps -aq --no-trunc --filter label=com.docker.compose.project=kassinao)" ||
    die 'não foi possível provar ausência de containers do projeto kassinao'
  [ -z "$container_inventory" ] ||
    die 'containers residuais do projeto kassinao permanecem'
  network_inventory="$(docker network ls -q --no-trunc --filter label=com.docker.compose.project=kassinao)" ||
    die 'não foi possível provar ausência de redes do projeto kassinao'
  [ -z "$network_inventory" ] ||
    die 'redes residuais do projeto kassinao permanecem'
}

hardener() {
  local bundle="$1"
  shift
  env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" \
    "$bundle/scripts/harden-docker-egress.sh" --shared-host "$@"
}

current_removal_state() {
  local output
  if ! output="$(hardener "$CURRENT_BUNDLE" --removal-state 2>/dev/null)"; then
    printf 'invalid\n'
    return
  fi
  case "$output" in present | absent | owned-progress) printf '%s\n' "$output" ;; *) printf 'invalid\n' ;; esac
}

remove_policy_if_present() {
  local status
  status="$(current_removal_state)"
  case "$status" in
    present | owned-progress)
      hardener "$CURRENT_BUNDLE" --remove || die 'adapter current falhou ao remover a policy current'
      [ "$(current_removal_state)" = absent ] ||
        die 'policy current não ficou ausente após --remove'
      ;;
    absent) ;;
    invalid) die 'policy current existe em estado inválido; remoção automática recusada' ;;
  esac
}

legacy_removal_state() {
  local output
  if ! output="$(hardener "$CURRENT_BUNDLE" --legacy-removal-state 2>/dev/null)"; then
    printf 'invalid\n'
    return
  fi
  case "$output" in present | absent | owned-progress) printf '%s\n' "$output" ;; *) printf 'invalid\n' ;; esac
}

remove_legacy_policy() {
  local status
  status="$(legacy_removal_state)"
  case "$status" in
    present | owned-progress)
      hardener "$CURRENT_BUNDLE" --remove-legacy-policy ||
        die 'adapter current falhou ao remover a policy legacy'
      [ "$(legacy_removal_state)" = absent ] ||
        die 'adapter current não concluiu a remoção da policy legacy'
      ;;
    absent) ;;
    invalid) die 'policy legacy não corresponde a estado removível próprio' ;;
  esac
}

rebuild_legacy_policy() {
  case "$(legacy_removal_state)" in
    present)
      hardener "$LEGACY_BUNDLE" --check ||
        die 'policy legacy classificada como present divergiu do hardener publicado'
      return
      ;;
    owned-progress) remove_legacy_policy || die 'policy legacy parcial não pôde ser removida' ;;
    absent) ;;
    invalid) die 'policy legacy não pode ser reconstruída sobre estado inválido' ;;
  esac
  hardener "$LEGACY_BUNDLE" --preload || die 'preload da policy legacy falhou'
  hardener "$LEGACY_BUNDLE" --check || die 'policy legacy reconstruída não passou no check'
}

prove_watchdog_disabled() {
  local unit_file timer_active service_active
  unit_file="$(systemctl show "$HEALTH_TIMER" -p UnitFileState --value 2>/dev/null)" || return 1
  timer_active="$(systemctl show "$HEALTH_TIMER" -p ActiveState --value 2>/dev/null)" || return 1
  service_active="$(systemctl show "$HEALTH_SERVICE" -p ActiveState --value 2>/dev/null)" || return 1
  case "$unit_file" in disabled | masked) ;; *) return 1 ;; esac
  case "$timer_active" in inactive | failed) ;; *) return 1 ;; esac
  case "$service_active" in inactive | failed) ;; *) return 1 ;; esac
}

prove_watchdog_enabled() {
  [ "$(systemctl show "$HEALTH_TIMER" -p UnitFileState --value 2>/dev/null)" = enabled ] &&
    [ "$(systemctl show "$HEALTH_TIMER" -p ActiveState --value 2>/dev/null)" = active ]
}

disable_watchdog() {
  systemctl disable --now "$HEALTH_TIMER" >/dev/null || die 'não foi possível desabilitar health-watch.timer'
  systemctl stop "$HEALTH_SERVICE" >/dev/null || die 'não foi possível parar health-watch.service'
  prove_watchdog_disabled || die 'watchdog não pôde ser provado disabled/inactive'
}

fence_stopped_active_recording() {
  local topology="$1" fence_bundle="$2" reason="$3"
  validate_topology "$topology" subset structural
  [ "$LIVE_RUNNING" -eq 0 ] || die "$reason; fence recusou desabilitar supervisão com runtime running"
  if ! (disable_watchdog); then
    publish_marker "$fence_bundle" || die "$reason; watchdog indeterminado e marker oposto falhou"
    [ "$(marker_deploy_dir)" = "$fence_bundle" ] || die "$reason; marker oposto não pôde ser provado"
  fi
  die "$reason; residual ficou parado sem remover policy/objetos"
}

prove_watchdog_target() {
  local bundle="$1"
  [ "$(marker_deploy_dir)" = "$bundle" ] || die 'marker não aponta para o alvo do watchdog'
  if [ "$bundle" = "$CURRENT_BUNDLE" ]; then
    [ "$INSTALLED_DISPATCHER_BUNDLE" = "$CURRENT_BUNDLE" ] ||
      die 'watchdog current exige dispatchers current instalados'
  else
    [ "$bundle" = "$LEGACY_BUNDLE" ] ||
      die 'alvo interno inesperado do watchdog'
  fi
  assert_root_file "$HEALTH_DISPATCHER" 755 'dispatcher do health-watch'
  assert_root_file "$HARDENER_DISPATCHER" 755 'dispatcher do hardener'
  cmp -s "$INSTALLED_DISPATCHER_BUNDLE/scripts/health-watch.sh" "$HEALTH_DISPATCHER" ||
    die 'dispatcher instalado do health-watch mudou antes do enable'
  cmp -s "$INSTALLED_DISPATCHER_BUNDLE/scripts/harden-docker-egress.sh" "$HARDENER_DISPATCHER" ||
    die 'dispatcher instalado do hardener mudou antes do enable'
  hardener "$bundle" --check
}

enable_watchdog() {
  local bundle="$1"
  prove_watchdog_target "$bundle"
  systemctl enable "$HEALTH_TIMER" >/dev/null || die 'não foi possível habilitar health-watch.timer'
  systemctl restart "$HEALTH_TIMER" >/dev/null || die 'não foi possível reiniciar health-watch.timer'
  systemctl is-enabled --quiet "$HEALTH_TIMER" || die 'health-watch.timer não ficou enabled'
  systemctl is-active --quiet "$HEALTH_TIMER" || die 'health-watch.timer não ficou active'
  prove_watchdog_enabled || die 'estado textual do health-watch.timer não ficou enabled/active'
  prove_watchdog_target "$bundle"
}

watchdog_status() {
  if prove_watchdog_enabled; then
    printf 'enabled\n'
  elif prove_watchdog_disabled; then
    printf 'disabled\n'
  else
    die 'estado do watchdog não pôde ser provado'
  fi
}

stop_topology() {
  local topology="$1" health_mode="${2:-healthy}" service id
  validate_topology "$topology" exact "$health_mode"
  for service in cloudflared kassinao-router kassinao-public kassinao; do
    id="${LIVE_IDS[$service]-}"
    [ -z "$id" ] || docker update --restart=no "$id" >/dev/null ||
      die "não foi possível desarmar restart de $service"
  done
  for service in cloudflared kassinao-router kassinao-public kassinao; do
    id="${LIVE_IDS[$service]-}"
    [ -z "$id" ] || docker stop --timeout 60 "$id" >/dev/null || die "não foi possível parar $service"
  done
  validate_topology "$topology" exact
  [ "$LIVE_RUNNING" -eq 0 ] || die "topologia $topology permaneceu running após stop"
}

remove_topology_objects() {
  local topology="$1" service key bridge internal enable_ipv6 host_binding_ipv4 gateway4 gateway6 icc id members
  validate_topology "$topology" subset
  [ "$LIVE_RUNNING" -eq 0 ] || die "topologia $topology precisa estar parada antes da remoção"
  for service in cloudflared kassinao-router kassinao-public kassinao; do
    id="${LIVE_IDS[$service]-}"
    [ -z "$id" ] || docker rm "$id" >/dev/null || die "não foi possível remover $service"
  done
  LIVE_IDS=()
  for line in $(topology_networks "$topology"); do
    IFS=: read -r key bridge internal enable_ipv6 host_binding_ipv4 gateway4 gateway6 icc <<<"$line"
    id="${LIVE_NETWORK_IDS[$key]-}"
    [ -z "$id" ] && continue
    validate_network "$topology" "$key" "$bridge" "$internal" "$enable_ipv6" "$host_binding_ipv4" \
      "$gateway4" "$gateway6" "$icc" subset
    [ "${LIVE_NETWORK_IDS[$key]-}" = "$id" ] || die "ID da rede kassinao_$key mudou antes do rm"
    members="$(
      docker network inspect -f \
        '{{range $id, $member := .Containers}}{{printf "%s|%s\n" $id $member.Name}}{{end}}' \
        "$id" | sort -u
    )" || die "não foi possível revalidar membros de kassinao_$key"
    [ -z "$members" ] || die "rede kassinao_$key ainda possui endpoints antes do rm"
    docker network rm "$id" >/dev/null || die "não foi possível remover a rede kassinao_$key"
  done
  assert_reserved_absent
}

run_health_watch_once() {
  flock -u 9
  systemctl reset-failed "$HEALTH_SERVICE" >/dev/null 2>&1 || true
  if ! systemctl start "$HEALTH_SERVICE" >/dev/null; then
    flock -w 120 9 || die 'maintenance.lock não voltou após falha do health-watch'
    die 'health-watch legado falhou ao reconciliar a topologia prepared'
  fi
  result="$(systemctl show "$HEALTH_SERVICE" -p Result --value 2>/dev/null || true)"
  exit_status="$(systemctl show "$HEALTH_SERVICE" -p ExecMainStatus --value 2>/dev/null || true)"
  [ "$result" = success ] && [ "$exit_status" = 0 ] || {
    flock -w 120 9 || die 'maintenance.lock não voltou após resultado inválido do health-watch'
    die "health-watch legado terminou com Result=$result ExecMainStatus=$exit_status"
  }
  flock -w 120 9 || die 'health-watch não liberou maintenance.lock'
  assert_fd_lock 9 "$MAINTENANCE_LOCK" maintenance.lock
  reverify_locked_inputs
}

wait_legacy_ready() {
  local deadline
  deadline=$((SECONDS + 240))
  while [ "$SECONDS" -lt "$deadline" ]; do
    validate_topology legacy exact structural
    [ "$LIVE_UNHEALTHY" -eq 0 ] || return 1
    if [ "$LIVE_RUNNING" -eq "$LIVE_TOTAL" ] && [ "$LIVE_READY" -eq "$LIVE_TOTAL" ]; then return 0; fi
    sleep 3
  done
  return 1
}

finalize_legacy_running() {
  validate_topology legacy exact || die 'topologia legacy final divergiu'
  [ "$LIVE_RUNNING" -eq "$LIVE_TOTAL" ] && [ "$LIVE_READY" -eq "$LIVE_TOTAL" ] ||
    die 'health-watch não manteve toda a topologia legacy running/ready'
  hardener "$LEGACY_BUNDLE" --check || die 'policy legacy final divergiu'
  prove_watchdog_enabled || die 'watchdog legacy não permaneceu enabled/active no commit'
  write_state legacy_running || die 'estado legacy_running não pôde ser persistido'
}

contain_topology_subset() {
  local topology="$1" service id
  validate_topology "$topology" subset structural
  for service in cloudflared kassinao-router kassinao-public kassinao; do
    id="${LIVE_IDS[$service]-}"
    [ -z "$id" ] || docker update --restart=no "$id" >/dev/null 2>&1 || true
  done
  for service in cloudflared kassinao-router kassinao-public kassinao; do
    id="${LIVE_IDS[$service]-}"
    [ -z "$id" ] || [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)" = false ] ||
      docker stop --timeout 60 "$id" >/dev/null 2>&1 || true
  done
  validate_topology "$topology" subset structural
  [ "$LIVE_RUNNING" -eq 0 ] || die "subset $topology permaneceu running durante contenção"
}

can_preserve_active_topology() {
  local topology="$1" target_bundle="$2"
  [ "$(marker_deploy_dir 2>/dev/null || true)" = "$target_bundle" ] &&
    prove_watchdog_enabled &&
    (validate_topology "$topology" exact structural &&
      [ "$(docker inspect -f '{{.State.Running}}' "${LIVE_IDS[kassinao]}")" = true ] &&
      [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${LIVE_IDS[kassinao]}")" = healthy ]) >/dev/null 2>&1 ||
    return 1
  if [ "$topology" = current ]; then
    hardener "$CURRENT_BUNDLE" --check >/dev/null 2>&1
  else
    hardener "$LEGACY_BUNDLE" --check >/dev/null 2>&1
  fi
}

fail_closed_topology() {
  local reason="$1" topology="$2" target_bundle="$3" fence_bundle="$4" exact_state="$5"
  local watchdog_disabled=false marker_fenced=false exact=false
  flock -w 120 9 || die "$reason; maintenance.lock não voltou para o cleanup"
  assert_fd_lock 9 "$MAINTENANCE_LOCK" maintenance.lock
  reverify_locked_inputs
  if ! (assert_recordings_idle); then
    can_preserve_active_topology "$topology" "$target_bundle" &&
      die "$reason; gravação ativa detectada após o start, runtime íntegro foi preservado sob watchdog correto"
  fi
  contain_topology_subset "$topology"
  if ! (assert_recordings_idle); then
    if ! (disable_watchdog); then
      publish_marker "$fence_bundle" ||
        die "$reason; gravação ativa permaneceu após contain e nenhum fence pôde ser publicado"
      [ "$(marker_deploy_dir)" = "$fence_bundle" ] || die "$reason; marker oposto não pôde ser provado"
    fi
    die "$reason; gravação ativa permaneceu marcada; residual ficou parado sem remover policy/objetos"
  fi
  if (disable_watchdog); then watchdog_disabled=true; fi
  if [ "$watchdog_disabled" = false ]; then
    publish_marker "$fence_bundle" ||
      die "$reason; watchdog indeterminado e marker oposto não pôde ser publicado antes do cleanup"
    [ "$(marker_deploy_dir)" = "$fence_bundle" ] || die "$reason; marker oposto não pôde ser provado"
    marker_fenced=true
  fi
  if (validate_topology "$topology" exact structural && [ "$LIVE_RUNNING" -eq 0 ]) >/dev/null 2>&1; then
    exact=true
  fi
  if [ "$topology" = legacy ]; then
    if [ "$exact" = true ]; then
      rebuild_legacy_policy
      write_state "$exact_state"
    else
      remove_legacy_policy
      remove_topology_objects legacy
      write_state neutral
    fi
  else
    if [ "$exact" = false ]; then
      remove_policy_if_present
      remove_topology_objects current
    fi
    write_state current_stopped
  fi
  if [ "$watchdog_disabled" = true ]; then
    publish_marker "$target_bundle"
  fi
  if [ "$(marker_deploy_dir 2>/dev/null || true)" = "$fence_bundle" ]; then marker_fenced=true; fi
  [ "$marker_fenced" = true ] || [ "$watchdog_disabled" = true ] ||
    die "$reason; runtime parado, mas nenhum fence persistente pôde ser provado"
  validate_topology "$topology" subset structural
  [ "$LIVE_RUNNING" -eq 0 ] || die "$reason; subset $topology escapou running"
  die "$reason; runtime $topology foi contido e cercado para retry"
}

inspect_state() {
  local persisted="$1" derived marker watchdog topology runtime
  derived="$persisted"
  topology=none
  runtime=absent
  marker="$(marker_deploy_dir)" || die 'marker de controles inválido'
  watchdog="$(watchdog_status)"
  if container_exists kassinao-router; then
    validate_topology current exact
    topology=current
    if [ "$LIVE_RUNNING" -eq 0 ]; then
      derived=current_stopped
      runtime=stopped
    elif [ "$LIVE_RUNNING" -eq "$LIVE_TOTAL" ]; then
      derived=neutral
      runtime=running
    else
      die 'inspect encontrou topologia current parcialmente running'
    fi
  elif container_exists kassinao; then
    validate_topology legacy exact
    topology=legacy
    if [ "$LIVE_RUNNING" -eq "$LIVE_TOTAL" ]; then
      derived=legacy_running
      runtime=running
    elif [ "$LIVE_RUNNING" -eq 0 ]; then
      if [ "$persisted" = legacy_prepared ]; then
        derived=legacy_prepared
        runtime=prepared
      else
        derived=legacy_stopped
        runtime=stopped
      fi
    else
      die 'inspect encontrou topologia legacy parcialmente running'
    fi
  else
    assert_reserved_absent
    case "$persisted" in
      neutral | current_stopped | legacy_stopped) derived="$persisted" ;;
      legacy_prepared | legacy_running)
        die "estado $persisted diverge da ausência de runtime; transição interrompida exige retry"
        ;;
    esac
  fi
  if { [ "$topology" = current ] && [ "$marker" != "$CURRENT_BUNDLE" ]; } ||
    { [ "$topology" = legacy ] && [ "$marker" != "$LEGACY_BUNDLE" ]; }; then
    [ "$runtime" != running ] || die 'inspect recusa runtime running sob marker oposto'
    [ "$watchdog" = disabled ] || die 'inspect fenced exige watchdog positivamente disabled/inactive'
  fi
  case "$derived" in
    legacy_prepared)
      [ "$marker" = "$LEGACY_BUNDLE" ] || [ "$marker" = "$CURRENT_BUNDLE" ] ||
        die 'marker não aponta para bundle aprovado durante legacy_prepared'
      ;;
    legacy_running)
      [ "$marker" = "$LEGACY_BUNDLE" ] ||
        die 'marker não aponta para o bundle legacy no estado legacy_running'
      ;;
    legacy_stopped)
      [ "$marker" = "$LEGACY_BUNDLE" ] || [ "$marker" = "$CURRENT_BUNDLE" ] ||
        die 'marker não aponta para bundle aprovado durante legacy_stopped'
      ;;
    current_stopped)
      [ "$marker" = "$CURRENT_BUNDLE" ] || [ "$marker" = "$LEGACY_BUNDLE" ] ||
        die 'marker não aponta para bundle aprovado durante current_stopped'
      ;;
    neutral)
      [ "$marker" = "$CURRENT_BUNDLE" ] || [ "$marker" = "$LEGACY_BUNDLE" ] ||
        die 'marker neutral não aponta para bundle aprovado'
      ;;
    *) [ "$marker" = "$CURRENT_BUNDLE" ] || die 'marker não aponta para o bundle current' ;;
  esac
  python3 - "$derived" "$topology" "$runtime" "$TUNNEL" "$watchdog" <<'PY'
import json
import sys

print(json.dumps(
    {
        'schema_version': 1,
        'state': sys.argv[1],
        'topology': sys.argv[2],
        'runtime': sys.argv[3],
        'tunnel': sys.argv[4] == 'true',
        'watchdog': sys.argv[5],
    },
    ensure_ascii=True,
    separators=(',', ':'),
    sort_keys=True,
))
PY
}

PERSISTED_STATE="$(read_state)" || die 'estado persistido possui schema divergente'
INSTALLED_MARKER_BUNDLE="$(marker_deploy_dir)" || die 'marker shared instalado é inválido'
[ "$INSTALLED_MARKER_BUNDLE" = "$CURRENT_BUNDLE" ] || [ "$INSTALLED_MARKER_BUNDLE" = "$LEGACY_BUNDLE" ] ||
  die 'marker shared não aponta para bundle aprovado'

case "$COMMAND" in
  inspect)
    inspect_state "$PERSISTED_STATE"
    ;;

  retire-current)
    case "$PERSISTED_STATE" in neutral | current_stopped) ;; *) die "retire-current não aceita estado $PERSISTED_STATE" ;; esac
    assert_recordings_idle || die 'recordings não estão ociosas antes de conter current'
    if [ "$INSTALLED_MARKER_BUNDLE" = "$CURRENT_BUNDLE" ]; then
      validate_topology current subset structural
      if [ "$LIVE_TOTAL" -gt 0 ]; then contain_topology_subset current; fi
    else
      validate_topology current subset structural
      [ "$LIVE_RUNNING" -eq 0 ] || die 'retire-current fenced exige residual current parado'
    fi
    (assert_recordings_idle) ||
      fence_stopped_active_recording current "$LEGACY_BUNDLE" 'gravação apareceu durante a contenção current'
    if ! (disable_watchdog); then
      publish_marker "$LEGACY_BUNDLE" || die 'watchdog current indeterminado e fence legacy não pôde ser publicado'
      die 'watchdog current não pôde ser provado disabled/inactive; residual ficou parado e cercado'
    fi
    publish_marker "$CURRENT_BUNDLE"
    if ! (
      validate_topology current subset structural
      [ "$LIVE_RUNNING" -eq 0 ] || die 'current_stopped contém container running'
      write_state current_stopped
      remove_policy_if_present
      if [ "$LIVE_TOTAL" -gt 0 ] || [ "${#LIVE_NETWORK_IDS[@]}" -gt 0 ]; then
        remove_topology_objects current
      else
        assert_reserved_absent
      fi
      write_state neutral
      publish_marker "$LEGACY_BUNDLE"
    ); then
      fail_closed_topology 'retirada current shared falhou após desabilitar o watchdog' current \
        "$CURRENT_BUNDLE" "$LEGACY_BUNDLE" current_stopped
    fi
    inspect_state neutral
    ;;

  prepare-legacy)
    case "$PERSISTED_STATE" in neutral | legacy_prepared | legacy_running | legacy_stopped) ;; *) die "prepare-legacy não aceita estado $PERSISTED_STATE" ;; esac
    if [ "$INSTALLED_MARKER_BUNDLE" = "$LEGACY_BUNDLE" ]; then
      validate_topology legacy subset structural
      if [ "$LIVE_TOTAL" -gt 0 ] || [ "${#LIVE_NETWORK_IDS[@]}" -gt 0 ]; then
        if (validate_topology legacy exact && [ "$LIVE_RUNNING" -eq "$LIVE_TOTAL" ] &&
          [ "$LIVE_READY" -eq "$LIVE_TOTAL" ]) >/dev/null 2>&1 &&
          [ "$(legacy_removal_state)" = present ] && prove_watchdog_enabled; then
          hardener "$LEGACY_BUNDLE" --check || die 'policy legacy running divergiu'
          write_state legacy_running
          inspect_state legacy_running
          exit 0
        fi
        assert_recordings_idle || die 'recordings não estão ociosas antes de conter recovery legacy'
        contain_topology_subset legacy
        (assert_recordings_idle) ||
          fence_stopped_active_recording legacy "$CURRENT_BUNDLE" 'gravação apareceu durante a contenção de recovery legacy'
      fi
    elif [ "$INSTALLED_MARKER_BUNDLE" = "$CURRENT_BUNDLE" ]; then
      validate_topology legacy subset structural
      [ "$LIVE_RUNNING" -eq 0 ] || die 'prepare-legacy fenced exige residual legacy parado'
    fi
    if ! (disable_watchdog); then
      publish_marker "$CURRENT_BUNDLE" || die 'watchdog legacy indeterminado e fence current não pôde ser publicado'
      die 'watchdog legacy não pôde ser provado disabled/inactive; residual ficou parado e cercado'
    fi
    publish_marker "$LEGACY_BUNDLE"
    if ! (
      validate_topology legacy subset structural
      if ! (validate_topology legacy exact structural && [ "$LIVE_RUNNING" -eq 0 ]) >/dev/null 2>&1; then
        if [ "$LIVE_TOTAL" -gt 0 ] || [ "${#LIVE_NETWORK_IDS[@]}" -gt 0 ]; then
          remove_legacy_policy
          remove_topology_objects legacy
        fi
        assert_reserved_absent
        write_state neutral
      fi
      if ! container_exists kassinao; then
        compose_command legacy create --no-build --no-recreate || die 'Compose legacy falhou durante create'
        contain_topology_subset legacy
      fi
      validate_topology legacy exact structural
      [ "$LIVE_RUNNING" -eq 0 ] || die 'legacy prepared precisa permanecer parado'
      case "$(legacy_removal_state)" in
        present) hardener "$LEGACY_BUNDLE" --check || die 'policy legacy present divergiu' ;;
        absent | owned-progress) rebuild_legacy_policy ;;
        invalid) die 'policy legacy inválida; recovery recusada' ;;
      esac
      write_state legacy_prepared
      assert_recordings_idle || die 'recordings não estão ociosas antes de iniciar recovery legacy'
      prove_watchdog_disabled || die 'watchdog não ficou disabled/inactive antes do commit prepared'
      publish_marker "$LEGACY_BUNDLE"
      enable_watchdog "$LEGACY_BUNDLE" || die 'watchdog legacy não pôde ser habilitado antes do reconcile'
      run_health_watch_once
      wait_legacy_ready || die 'topologia legacy não ficou running e healthy em 240 segundos'
      finalize_legacy_running
    ); then
      fail_closed_topology 'recovery legacy shared falhou após desabilitar o watchdog' legacy \
        "$LEGACY_BUNDLE" "$CURRENT_BUNDLE" legacy_prepared
    fi
    inspect_state legacy_running
    ;;

  retire-legacy)
    case "$PERSISTED_STATE" in neutral | legacy_prepared | legacy_running | legacy_stopped) ;; *) die "retire-legacy não aceita estado $PERSISTED_STATE" ;; esac
    assert_recordings_idle || die 'recordings não estão ociosas antes de conter legacy'
    if [ "$INSTALLED_MARKER_BUNDLE" = "$LEGACY_BUNDLE" ]; then
      validate_topology legacy subset structural
      if [ "$LIVE_TOTAL" -gt 0 ]; then contain_topology_subset legacy; fi
    else
      validate_topology legacy subset structural
      [ "$LIVE_RUNNING" -eq 0 ] || die 'retire-legacy fenced exige residual legacy parado'
    fi
    (assert_recordings_idle) ||
      fence_stopped_active_recording legacy "$CURRENT_BUNDLE" 'gravação apareceu durante a contenção legacy'
    if ! (disable_watchdog); then
      publish_marker "$CURRENT_BUNDLE" || die 'watchdog legacy indeterminado e fence current não pôde ser publicado'
      die 'watchdog legacy não pôde ser provado disabled/inactive; residual ficou parado e cercado'
    fi
    publish_marker "$LEGACY_BUNDLE"
    if ! (
      validate_topology legacy subset structural
      [ "$LIVE_RUNNING" -eq 0 ] || die 'legacy_stopped contém container running'
      write_state legacy_stopped
      remove_legacy_policy
      if [ "$LIVE_TOTAL" -gt 0 ] || [ "${#LIVE_NETWORK_IDS[@]}" -gt 0 ]; then
        remove_topology_objects legacy
      else
        assert_reserved_absent
      fi
      write_state neutral
      publish_marker "$CURRENT_BUNDLE"
    ); then
      fail_closed_topology 'retirada legacy shared falhou após desabilitar o watchdog' legacy \
        "$LEGACY_BUNDLE" "$CURRENT_BUNDLE" legacy_stopped
    fi
    inspect_state neutral
    ;;
esac
