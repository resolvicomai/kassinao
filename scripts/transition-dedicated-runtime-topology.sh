#!/bin/bash -p
# Retira e, antes da troca dos controles do host, restaura a topologia
# dedicated publicada em v1.4.14..v1.4.16. O módulo só aceita aquele Compose
# exato e mantém todos os processos parados durante a troca da policy.
set -Eeuo pipefail
umask 077

die() {
  printf 'ERRO: %s\n' "$*" >&2
  exit 1
}

# KASSINAO_DEDICATED_TRANSITION_ENV_SCRUB_BEGIN
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
_forbidden_docker_environment=''
for _name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION \
  COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES KASSINAO_ENV_FILE KASSINAO_DEPLOY_DIR; do
  if declare -p "$_name" >/dev/null 2>&1; then _forbidden_docker_environment="$_name"; break; fi
done
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente da transição dedicated'
while IFS='=' read -r -d '' _name _value; do unset "$_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset _name _value
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C
[ -z "$_forbidden_docker_environment" ] ||
  die "$_forbidden_docker_environment não pode vir do ambiente da transição dedicated"
# KASSINAO_DEDICATED_TRANSITION_ENV_SCRUB_END

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho da transição dedicated não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) CURRENT_BUNDLE="${_script_dir%/scripts}" ;; *) die 'transição dedicated precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$CURRENT_BUNDLE/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_DEDICATED_TRANSITION_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$CURRENT_BUNDLE/scripts/no-dump-exec.py" \
    --bundle-root "$CURRENT_BUNDLE" --script-relative scripts/transition-dedicated-runtime-topology.sh \
    --arch "$_no_dump_arch" -- "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit da transição dedicated não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter da transição dedicated não ficou selado'
# KASSINAO_DEDICATED_TRANSITION_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

usage() {
  cat >&2 <<'EOF'
uso: transition-dedicated-runtime-topology.sh COMANDO \
  --legacy-bundle ABS --state-file ABS \
  [--inherited-first-lock-fd 7 --inherited-second-lock-fd 8 \
   --inherited-maintenance-lock-fd 9]

COMANDO: inspect | retire-legacy | restore-legacy
EOF
  exit 1
}

[ "$#" -ge 1 ] || usage
COMMAND="$1"
shift
case "$COMMAND" in inspect | retire-legacy | restore-legacy) ;; *) usage ;; esac
LEGACY_BUNDLE=''
STATE_FILE=''
INHERITED_FIRST_LOCK_FD=''
INHERITED_SECOND_LOCK_FD=''
INHERITED_MAINTENANCE_LOCK_FD=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --legacy-bundle)
      [ "$#" -ge 2 ] && [ -z "$LEGACY_BUNDLE" ] || usage
      LEGACY_BUNDLE="$2"
      shift 2
      ;;
    --state-file)
      [ "$#" -ge 2 ] && [ -z "$STATE_FILE" ] || usage
      STATE_FILE="$2"
      shift 2
      ;;
    --inherited-first-lock-fd)
      [ "$#" -ge 2 ] && [ -z "$INHERITED_FIRST_LOCK_FD" ] || usage
      INHERITED_FIRST_LOCK_FD="$2"
      shift 2
      ;;
    --inherited-second-lock-fd)
      [ "$#" -ge 2 ] && [ -z "$INHERITED_SECOND_LOCK_FD" ] || usage
      INHERITED_SECOND_LOCK_FD="$2"
      shift 2
      ;;
    --inherited-maintenance-lock-fd)
      [ "$#" -ge 2 ] && [ -z "$INHERITED_MAINTENANCE_LOCK_FD" ] || usage
      INHERITED_MAINTENANCE_LOCK_FD="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done
[ -n "$LEGACY_BUNDLE" ] && [ -n "$STATE_FILE" ] || usage
if [ -n "$INHERITED_FIRST_LOCK_FD$INHERITED_SECOND_LOCK_FD$INHERITED_MAINTENANCE_LOCK_FD" ]; then
  [ "$INHERITED_FIRST_LOCK_FD" = 7 ] && [ "$INHERITED_SECOND_LOCK_FD" = 8 ] &&
    [ "$INHERITED_MAINTENANCE_LOCK_FD" = 9 ] ||
    die 'handoff de locks exige exatamente os FDs fixos 7, 8 e 9'
  INHERITED_LOCK_HANDOFF=true
else
  INHERITED_LOCK_HANDOFF=false
fi
[ "$(id -u)" -eq 0 ] || die 'execute como root'
for executable_name in awk cmp dirname docker env findmnt flock grep id ip6tables iptables mv python3 readlink sha256sum sort stat systemctl; do
  command -v "$executable_name" >/dev/null 2>&1 || die "$executable_name é obrigatório"
done

canonical_absolute() {
  local value="$1" description="$2"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "$description precisa ser caminho absoluto simples"
  case "$value" in / | *//* | */./* | */../* | */. | */.. | */) die "$description precisa ser canônico e dedicado" ;; esac
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
  shift 2
  manifest="$root/MANIFEST.sha256"
  assert_root_directory "$root" 700 "bundle $role"
  assert_root_file "$manifest" 644 "MANIFEST do bundle $role"
  for relative in \
    scripts/harden-docker-egress.sh \
    scripts/health-watch.sh \
    scripts/no-dump-exec.py \
    scripts/verify-storage-encryption.sh \
    deploy/docker-client/config.json \
    docker-compose.yml \
    "$@"; do
    [ "$(manifest_count "$manifest" "$relative")" -eq 1 ] ||
      die "$relative precisa aparecer uma vez no MANIFEST do bundle $role"
  done
  (cd -- "$root" && sha256sum -c MANIFEST.sha256 --quiet) ||
    die "bundle $role diverge do MANIFEST.sha256"
}

canonical_absolute "$CURRENT_BUNDLE" 'bundle current'
canonical_absolute "$LEGACY_BUNDLE" 'bundle legacy'
[ "$CURRENT_BUNDLE" != "$LEGACY_BUNDLE" ] || die 'bundles current e legacy precisam ser distintos'
verify_bundle "$CURRENT_BUNDLE" current scripts/transition-dedicated-runtime-topology.sh
verify_bundle "$LEGACY_BUNDLE" legacy
LEGACY_COMPOSE="$LEGACY_BUNDLE/docker-compose.yml"
[ "$(sha256sum "$LEGACY_COMPOSE" | awk '{print $1}')" = f4d545edbdfe50910126afc441fe7dd47de5eacf3a9cf171c6d2c1a47a1ad2ef ] ||
  die 'bundle legacy não corresponde à topologia dedicated publicada em v1.4.14..v1.4.16'
[ "$(sha256sum "$LEGACY_BUNDLE/scripts/harden-docker-egress.sh" | awk '{print $1}')" = 50bfe17476580357f3f18439caeefdbd565fc0b09b7156899fe0cb461e8e3829 ] &&
  [ "$(sha256sum "$LEGACY_BUNDLE/scripts/health-watch.sh" | awk '{print $1}')" = 08e3d81f9caab710db565b9ac9e71f4249197633a7294e26618b1645aba4de48 ] ||
  die 'controles legacy não correspondem às releases v1.4.14..v1.4.16'

CURRENT_ENV="$CURRENT_BUNDLE/.env"
LEGACY_ENV="$LEGACY_BUNDLE/.env"
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
  ' "$file" || die "$key precisa aparecer exatamente uma vez no arquivo esperado"
}

for file in "$CURRENT_ENV" "$LEGACY_ENV"; do
  [ "$(env_value KASSINAO_HOST_SCOPE "$file")" = dedicated ] ||
    die 'transição dedicated recusa qualquer outro adapter'
  [ "$(env_value KASSINAO_DEDICATED_DOCKER_HOST_ACK "$file")" = I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO ] ||
    die 'adapter dedicated exige a frase explícita de aceite do host exclusivo'
done

DATA_ROOT="$(env_value KASSINAO_DATA_ROOT "$CURRENT_ENV")"
RECORDINGS_ROOT="$(env_value KASSINAO_RECORDINGS_DIR "$CURRENT_ENV")"
STATE_ROOT="$(env_value KASSINAO_STATE_DIR "$CURRENT_ENV")"
AUTH_ROOT="$(env_value KASSINAO_AUTH_DIR "$CURRENT_ENV")"
CACHE_ROOT="$(env_value KASSINAO_MODEL_CACHE_DIR "$CURRENT_ENV")"
APP_UID="$(env_value KASSINAO_UID "$CURRENT_ENV")"
APP_GID="$(env_value KASSINAO_GID "$CURRENT_ENV")"
RETENTION_HOURS="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS "$CURRENT_ENV")"
for key in KASSINAO_DATA_ROOT KASSINAO_RECORDINGS_DIR KASSINAO_STATE_DIR KASSINAO_AUTH_DIR \
  KASSINAO_MODEL_CACHE_DIR KASSINAO_UID KASSINAO_GID KASSINAO_ROLLBACK_RETENTION_HOURS; do
  [ "$(env_value "$key" "$CURRENT_ENV")" = "$(env_value "$key" "$LEGACY_ENV")" ] ||
    die "$key precisa coincidir entre current e legacy"
done
for path in "$DATA_ROOT" "$RECORDINGS_ROOT" "$STATE_ROOT" "$AUTH_ROOT" "$CACHE_ROOT"; do
  canonical_absolute "$path" 'caminho de storage dedicated'
done
[ "$RECORDINGS_ROOT" = "$DATA_ROOT/recordings" ] &&
  [ "$STATE_ROOT" = "$DATA_ROOT/state" ] &&
  [ "$AUTH_ROOT" = "$DATA_ROOT/auth" ] &&
  [ "$CACHE_ROOT" = "$DATA_ROOT/cache" ] ||
  die 'mounts dedicated precisam ser filhos exatos de DATA_ROOT'
[[ "$APP_UID" =~ ^[1-9][0-9]*$ ]] && [[ "$APP_GID" =~ ^[1-9][0-9]*$ ]] ||
  die 'KASSINAO_UID/GID dedicated precisam ser inteiros não-root'
[[ "$RETENTION_HOURS" =~ ^[1-9][0-9]*$ ]] && [ "$RETENTION_HOURS" -le 168 ] ||
  die 'retenção dedicated precisa ficar entre 1 e 168 horas'
for bundle in "$CURRENT_BUNDLE" "$LEGACY_BUNDLE"; do
  app_env_name="$(env_value KASSINAO_APP_ENV_FILE "$bundle/.env")"
  [[ "$app_env_name" =~ ^[A-Za-z0-9._-]+$ ]] || die 'KASSINAO_APP_ENV_FILE precisa ser nome local simples'
  app_env="$bundle/$app_env_name"
  assert_root_file "$app_env" 600 'app.env dedicated'
  [ "$(env_value TRUST_PROXY_HOPS "$app_env")" = 1 ] ||
    die 'TRUST_PROXY_HOPS precisa ser exatamente 1 antes da transição dedicated'
done
env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" \
  "$CURRENT_BUNDLE/scripts/verify-storage-encryption.sh" \
  "$DATA_ROOT" "$RECORDINGS_ROOT" "$STATE_ROOT" "$AUTH_ROOT" "$CACHE_ROOT" >/dev/null ||
  die 'storage dedicated não passou na prova de criptografia'

STATE_FILE_PARENT="$(dirname -- "$STATE_FILE")"
[ "${STATE_FILE##*/}" = dedicated-runtime-topology.json ] ||
  die '--state-file precisa terminar em dedicated-runtime-topology.json'
[ "$(dirname -- "$STATE_FILE_PARENT")" = "$DATA_ROOT" ] ||
  die 'state root da transição dedicated precisa ser filho direto de DATA_ROOT'
case "$STATE_FILE_PARENT" in
  "$DATA_ROOT"/recordings | "$DATA_ROOT"/state | "$DATA_ROOT"/auth | "$DATA_ROOT"/cache | "$DATA_ROOT"/rollback)
    die 'state root da transição dedicated não pode pertencer ao app ou rollback'
    ;;
esac
assert_root_directory "$STATE_FILE_PARENT" 700 'state root da transição dedicated'
[ "$(stat -c '%d' "$STATE_FILE_PARENT")" = "$(stat -c '%d' "$DATA_ROOT")" ] ||
  die 'state root da transição dedicated precisa ficar no mesmo filesystem de DATA_ROOT'
state_mount="$(findmnt -n -o TARGET -T "$STATE_FILE_PARENT" 2>/dev/null)" ||
  die 'não foi possível provar o mount do state root dedicated'
[ "$(readlink -f -- "$state_mount" 2>/dev/null || true)" = "$DATA_ROOT" ] ||
  die 'state root dedicated não pode ser mount aninhado ou externo'
if [ -e "$STATE_FILE" ] || [ -L "$STATE_FILE" ]; then
  assert_root_file "$STATE_FILE" 600 'estado da transição dedicated'
fi

DOCKER_CONFIG="$CURRENT_BUNDLE/deploy/docker-client"
assert_root_directory "$DOCKER_CONFIG" 755 'diretório Docker client'
assert_root_file "$DOCKER_CONFIG/config.json" 444 'configuração Docker client'
[ "$(sha256sum "$DOCKER_CONFIG/config.json" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] ||
  die 'configuração Docker client diverge do objeto vazio selado'
export DOCKER_HOST=unix:///var/run/docker.sock DOCKER_CONFIG
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || die 'daemon Docker local indisponível'

HOST_CONTROLS=/etc/kassinao/host-controls.env
HEALTH_DISPATCHER=/usr/local/sbin/kassinao-health-watch
HARDENER_DISPATCHER=/usr/local/sbin/kassinao-harden-docker-egress
HEALTH_SERVICE=kassinao-health-watch.service
HEALTH_TIMER=kassinao-health-watch.timer
MAINTENANCE_LOCK=/run/lock/kassinao/maintenance.lock
assert_root_file "$HOST_CONTROLS" 600 'marker de controles'
assert_root_file "$HEALTH_DISPATCHER" 755 'dispatcher do health-watch'
assert_root_file "$HARDENER_DISPATCHER" 755 'dispatcher do hardener'
cmp -s "$LEGACY_BUNDLE/scripts/health-watch.sh" "$HEALTH_DISPATCHER" ||
  die 'dispatcher instalado do health-watch não pertence ao bundle legacy'
cmp -s "$LEGACY_BUNDLE/scripts/harden-docker-egress.sh" "$HARDENER_DISPATCHER" ||
  die 'dispatcher instalado do hardener não pertence ao bundle legacy'
assert_root_file "$MAINTENANCE_LOCK" 600 maintenance.lock

marker_deploy_dir() {
  python3 - "$HOST_CONTROLS" "$DATA_ROOT" "$RETENTION_HOURS" <<'PY'
import pathlib
import sys

lines = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8').splitlines()
values = {}
for line in lines:
    if '=' not in line:
        raise SystemExit(1)
    key, value = line.split('=', 1)
    if key in values:
        raise SystemExit(1)
    values[key] = value
if set(values) != {
    'KASSINAO_DEPLOY_DIR',
    'KASSINAO_DATA_ROOT',
    'KASSINAO_ROLLBACK_RETENTION_HOURS',
}:
    raise SystemExit(1)
if values['KASSINAO_DATA_ROOT'] != sys.argv[2] or values['KASSINAO_ROLLBACK_RETENTION_HOURS'] != sys.argv[3]:
    raise SystemExit(1)
print(values['KASSINAO_DEPLOY_DIR'])
PY
}

publish_marker() {
  local deploy_dir="$1"
  [ "$deploy_dir" = "$CURRENT_BUNDLE" ] || [ "$deploy_dir" = "$LEGACY_BUNDLE" ] ||
    die 'destino do marker dedicated não é um bundle aprovado'
  python3 - "$HOST_CONTROLS" "$deploy_dir" "$DATA_ROOT" "$RETENTION_HOURS" <<'PY' || die 'gravação atômica do marker dedicated falhou'
import os
import pathlib
import secrets
import sys
target = pathlib.Path(sys.argv[1])
deploy_dir, data_root, retention = sys.argv[2:]
temporary = target.parent / f'.host-controls.env.{os.getpid()}.{secrets.token_hex(6)}'
payload = (
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
parent_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(parent_fd)
finally:
    os.close(parent_fd)
PY
  assert_root_file "$HOST_CONTROLS" 600 'marker dedicated publicado'
  [ "$(marker_deploy_dir)" = "$deploy_dir" ] || die 'marker dedicated publicado divergiu'
}

INITIAL_MARKER_BUNDLE="$(marker_deploy_dir)" || die 'marker dedicated instalado é inválido'
case "$INITIAL_MARKER_BUNDLE" in
  "$LEGACY_BUNDLE") MARKER_FENCED_CURRENT=false ;;
  "$CURRENT_BUNDLE") MARKER_FENCED_CURRENT=true ;;
  *) die 'controles instalados não apontam para o bundle legacy nem para um recovery fenced aprovado' ;;
esac

ensure_lock_file() {
  local path="$1"
  if [ ! -e "$path" ]; then
    (set -o noclobber; : > "$path") 2>/dev/null || die "não foi possível criar $path sem colisão"
    chmod 600 "$path"
  fi
  assert_root_file "$path" 600 '.deploy.lock'
}
CURRENT_LOCK="$CURRENT_BUNDLE/.deploy.lock"
LEGACY_LOCK="$LEGACY_BUNDLE/.deploy.lock"
ensure_lock_file "$CURRENT_LOCK"
ensure_lock_file "$LEGACY_LOCK"
if [[ "$CURRENT_LOCK" < "$LEGACY_LOCK" ]]; then
  FIRST_LOCK="$CURRENT_LOCK"
  SECOND_LOCK="$LEGACY_LOCK"
else
  FIRST_LOCK="$LEGACY_LOCK"
  SECOND_LOCK="$CURRENT_LOCK"
fi
assert_fd_lock() {
  local fd="$1" path="$2" description="$3"
  [ "$(readlink -f -- "/proc/$$/fd/$fd" 2>/dev/null || true)" = "$path" ] &&
    [ "$(stat -c '%d:%i' "$path" 2>/dev/null || true)" = "$(stat -Lc '%d:%i' "/proc/$$/fd/$fd" 2>/dev/null || true)" ] &&
    [ "$(stat -Lc '%a:%u:%g:%h' "/proc/$$/fd/$fd" 2>/dev/null || true)" = 600:0:0:1 ] ||
    die "$description mudou durante a abertura ou herança"
}

assert_lock_contended_by_our_open_description() {
  local fd="$1" path="$2" description="$3" status
  assert_fd_lock "$fd" "$path" "$description"
  flock -n "$fd" || die "$description não pertence ao open-file description herdado"
  if flock -E 75 -n "$path" -c ':' >/dev/null 2>&1; then
    status=0
  else
    status=$?
  fi
  [ "$status" -eq 75 ] || die "$description herdado não chegou adquirido de forma exclusiva"
  assert_fd_lock "$fd" "$path" "$description"
}

if [ "$INHERITED_LOCK_HANDOFF" = true ]; then
  assert_lock_contended_by_our_open_description 7 "$FIRST_LOCK" 'primeiro deploy lock'
  assert_lock_contended_by_our_open_description 8 "$SECOND_LOCK" 'segundo deploy lock'
  assert_lock_contended_by_our_open_description 9 "$MAINTENANCE_LOCK" maintenance.lock
else
  exec 7<>"$FIRST_LOCK"
  exec 8<>"$SECOND_LOCK"
  exec 9<>"$MAINTENANCE_LOCK"
  assert_fd_lock 7 "$FIRST_LOCK" 'primeiro deploy lock'
  assert_fd_lock 8 "$SECOND_LOCK" 'segundo deploy lock'
  assert_fd_lock 9 "$MAINTENANCE_LOCK" maintenance.lock
  flock -w 120 7 || die 'primeiro bundle não liberou o deploy lock'
  flock -w 120 8 || die 'segundo bundle não liberou o deploy lock'
  flock -w 120 9 || die 'maintenance.lock não foi liberado'
  assert_lock_contended_by_our_open_description 7 "$FIRST_LOCK" 'primeiro deploy lock'
  assert_lock_contended_by_our_open_description 8 "$SECOND_LOCK" 'segundo deploy lock'
  assert_lock_contended_by_our_open_description 9 "$MAINTENANCE_LOCK" maintenance.lock
fi

LEGACY_MANIFEST_DIGEST="$(sha256sum "$LEGACY_BUNDLE/MANIFEST.sha256" | awk '{print $1}')"
LEGACY_PROFILES="$(env_value COMPOSE_PROFILES "$LEGACY_ENV")"
TUNNEL="$(
  python3 - "$LEGACY_PROFILES" <<'PY'
import sys
values = [item.strip() for item in sys.argv[1].split(',')]
if not values or any(not item for item in values) or len(values) != len(set(values)):
    raise SystemExit(1)
allowed = {'split-public', 'tunnel'}
if set(values) - allowed or 'split-public' not in values:
    raise SystemExit(1)
print('true' if 'tunnel' in values else 'false')
PY
)" || die 'COMPOSE_PROFILES legacy precisa ser split-public[,tunnel] sem duplicados'

read_state() {
  if [ ! -e "$STATE_FILE" ]; then
    printf 'neutral\n'
    return
  fi
  python3 - "$STATE_FILE" "$LEGACY_MANIFEST_DIGEST" "$TUNNEL" <<'PY'
import json
import pathlib
import sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
if not isinstance(value, dict) or set(value) != {'legacy_manifest_sha256', 'schema_version', 'state', 'tunnel'}:
    raise SystemExit(1)
if value['schema_version'] != 1 or value['legacy_manifest_sha256'] != sys.argv[2]:
    raise SystemExit(1)
if value['state'] not in {'neutral', 'legacy_stopped', 'legacy_retired', 'legacy_prepared', 'legacy_running'}:
    raise SystemExit(1)
if value['tunnel'] is not (sys.argv[3] == 'true'):
    raise SystemExit(1)
print(value['state'])
PY
}

write_state() {
  local state="$1"
  python3 - "$STATE_FILE" "$state" "$TUNNEL" "$LEGACY_MANIFEST_DIGEST" <<'PY' || die 'gravação atômica do estado dedicated falhou'
import json
import os
import pathlib
import secrets
import sys
target = pathlib.Path(sys.argv[1])
payload = (json.dumps({
    'legacy_manifest_sha256': sys.argv[4],
    'schema_version': 1,
    'state': sys.argv[2],
    'tunnel': sys.argv[3] == 'true',
}, ensure_ascii=True, separators=(',', ':'), sort_keys=True) + '\n').encode()
temporary = target.parent / f'.dedicated-runtime.{os.getpid()}.{secrets.token_hex(6)}'
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
  assert_root_file "$STATE_FILE" 600 'estado publicado da transição dedicated'
  [ "$(read_state)" = "$state" ] || die 'estado dedicated publicado divergiu'
}

compose_command() {
  local -a command_line=(
    env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "DOCKER_HOST=$DOCKER_HOST" "DOCKER_CONFIG=$DOCKER_CONFIG"
    docker compose --project-name kassinao --project-directory "$LEGACY_BUNDLE" --env-file "$LEGACY_ENV"
    -f "$LEGACY_COMPOSE" --profile split-public
  )
  [ "$TUNNEL" = false ] || command_line+=(--profile tunnel)
  "${command_line[@]}" "$@"
}

validate_compose_contract() {
  local services networks expected_services
  services="$(compose_command config --services | sort -u)" || die 'Compose legacy não pôde ser resolvido'
  networks="$(compose_command config --networks | sort -u)" || die 'redes Compose legacy não puderam ser resolvidas'
  expected_services=$'kassinao\nkassinao-public'
  [ "$TUNNEL" = false ] || expected_services+=$'\ncloudflared'
  [ "$services" = "$(sort <<<"$expected_services")" ] && [ "$networks" = $'private\npublic' ] ||
    die 'Compose legacy diverge do conjunto dedicated publicado'
  if ! compose_command config --format json |
    python3 /dev/fd/3 "$TUNNEL" 3<<'PY'
import json
import sys
value = json.load(sys.stdin)
tunnel = sys.argv[1] == 'true'
services = value.get('services') or {}
networks = value.get('networks') or {}
expected = {'kassinao', 'kassinao-public'} | ({'cloudflared'} if tunnel else set())
if set(services) != expected or set(networks) != {'private', 'public'}:
    raise SystemExit(1)
names = {'kassinao': 'kassinao', 'kassinao-public': 'kassinao-public', 'cloudflared': 'kassinao-tunnel'}
for name, service in services.items():
    if service.get('container_name') != names[name] or service.get('restart') != 'unless-stopped':
        raise SystemExit(1)
PY
  then
    die 'Compose legacy não preserva nomes/restart/topologia published'
  fi
}
validate_compose_contract

declare -A LIVE_IDS=()
declare -A LIVE_NETWORK_IDS=()
LIVE_RUNNING=0
LIVE_READY=0
LIVE_UNHEALTHY=0
LIVE_TOTAL=0

topology_services() {
  printf 'kassinao\nkassinao-public\n'
  [ "$TUNNEL" = false ] || printf 'cloudflared\n'
}

container_name_for_service() {
  case "$1" in
    kassinao) printf 'kassinao\n' ;;
    kassinao-public) printf 'kassinao-public\n' ;;
    cloudflared) printf 'kassinao-tunnel\n' ;;
    *) die 'serviço legacy inesperado' ;;
  esac
}

expected_container_networks() {
  case "$1" in
    kassinao) printf 'kassinao_private\n' ;;
    kassinao-public) printf 'kassinao_public\n' ;;
    cloudflared) printf 'kassinao_private\nkassinao_public\n' ;;
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
  local service="$1" mode="$2" restart_mode="$3" health_mode="${4:-ready}" name candidate details
  local actual_id actual_name project actual_service working_dir configs running status restart health extra
  local actual_networks expected_networks restarting=false
  name="$(container_name_for_service "$service")"
  candidate="$(container_id_by_name "$name")" || die "inventário de $name falhou"
  if [ -z "$candidate" ]; then
    [ "$mode" = subset ] && return 1
    die "$name está ausente"
  fi
  [[ "$candidate" =~ ^[0-9a-f]{64}$ ]] || die "$name não possui ID completo"
  details="$(
    docker inspect --format \
      '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{.State.Running}}|{{.State.Status}}|{{.HostConfig.RestartPolicy.Name}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$candidate" 2>/dev/null
  )" || die "não foi possível provar identidade de $name"
  IFS='|' read -r actual_id actual_name project actual_service working_dir configs running status restart health extra <<<"$details"
  [ -z "$extra" ] && [ "$actual_id" = "$candidate" ] && [ "$actual_name" = "/$name" ] &&
    [ "$project" = kassinao ] && [ "$actual_service" = "$service" ] &&
    [ "$working_dir" = "$LEGACY_BUNDLE" ] && [ "$configs" = "$LEGACY_COMPOSE" ] ||
    die "$name diverge de ID/nome/labels/config-files legacy"
  case "$running:$status" in
    true:running | false:created | false:exited | false:dead) ;;
    true:restarting)
      [ "$health_mode" = structural ] ||
        die "$name está restarting fora de recovery estrutural"
      restarting=true
      ;;
    *) die "$name possui estado Docker incompatível com a transição" ;;
  esac
  case "$restart_mode:$restart" in
    normal:unless-stopped | stopped:no | either:no | either:unless-stopped) ;;
    *) die "$name possui restart policy incompatível com o estado da transição" ;;
  esac
  actual_networks="$(
    docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{printf "%s\n" $name}}{{end}}' "$candidate" |
      sort -u
  )" || die "não foi possível provar redes de $name"
  expected_networks="$(expected_container_networks "$service" | sort -u)"
  if [ "$mode" = exact ]; then
    [ "$actual_networks" = "$expected_networks" ] || die "$name diverge da topologia legacy exata"
  else
    while IFS= read -r network; do
      [ -z "$network" ] || grep -Fqx "$network" <<<"$expected_networks" ||
        die "$name participa de rede fora da topologia legacy"
    done <<<"$actual_networks"
  fi
  LIVE_IDS["$service"]="$candidate"
  LIVE_TOTAL=$((LIVE_TOTAL + 1))
  if [ "$running" = true ]; then
    LIVE_RUNNING=$((LIVE_RUNNING + 1))
    if [ "$restarting" = true ]; then
      LIVE_UNHEALTHY=$((LIVE_UNHEALTHY + 1))
    elif [ "$service" = cloudflared ]; then
      LIVE_READY=$((LIVE_READY + 1))
    else
      case "$health_mode:$health" in
        ready:healthy | starting:healthy | structural:healthy) LIVE_READY=$((LIVE_READY + 1)) ;;
        starting:starting | structural:starting) ;;
        structural:unhealthy) LIVE_UNHEALTHY=$((LIVE_UNHEALTHY + 1)) ;;
        *) die "$name running possui readiness incompatível com a transição" ;;
      esac
    fi
  fi
}

validate_network() {
  local key="$1" bridge="$2" internal="$3" gateway4="$4" gateway6="$5" mode="$6"
  local name="kassinao_$key" candidate details
  local actual_id actual_name driver actual_internal project actual_key actual_bridge actual_gateway4 actual_gateway6 extra
  local member_id member_name member members
  candidate="$(network_id_by_name "$name")" || die "inventário da rede $name falhou"
  if [ -z "$candidate" ]; then
    [ "$mode" = subset ] && return 1
    die "rede $name está ausente"
  fi
  [[ "$candidate" =~ ^[0-9a-f]{64}$ ]] || die "rede $name não possui ID completo"
  details="$(
    docker network inspect -f \
      '{{.Id}}|{{.Name}}|{{.Driver}}|{{.Internal}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.network"}}|{{index .Options "com.docker.network.bridge.name"}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv6"}}' \
      "$candidate" 2>/dev/null
  )" || die "não foi possível provar rede $name"
  IFS='|' read -r actual_id actual_name driver actual_internal project actual_key actual_bridge actual_gateway4 actual_gateway6 extra <<<"$details"
  [ -z "$extra" ] && [ "$actual_id" = "$candidate" ] && [ "$actual_name" = "$name" ] &&
    [ "$driver" = bridge ] && [ "$actual_internal" = "$internal" ] &&
    [ "$project" = kassinao ] && [ "$actual_key" = "$key" ] && [ "$actual_bridge" = "$bridge" ] &&
    { [ "$gateway4" = any ] || [ "$actual_gateway4" = "$gateway4" ]; } &&
    { [ "$gateway6" = any ] || [ "$actual_gateway6" = "$gateway6" ]; } ||
    die "rede $name diverge de ID/nome/labels/bridge/opções"
  members="$(
    docker network inspect -f '{{range $id, $member := .Containers}}{{printf "%s|%s\n" $id $member.Name}}{{end}}' "$candidate" |
      sort -u
  )" || die "não foi possível provar endpoints da rede $name"
  while IFS='|' read -r member_id member_name; do
    [ -z "$member_id" ] && continue
    case "$member_name" in
      kassinao) member=kassinao ;;
      kassinao-public) member=kassinao-public ;;
      kassinao-tunnel) member=cloudflared ;;
      *) die "rede $name contém endpoint inesperado" ;;
    esac
    [ "${LIVE_IDS[$member]-}" = "$member_id" ] || die "rede $name contém ID de endpoint divergente"
    grep -Fqx "$name" <<<"$(expected_container_networks "$member")" ||
      die "rede $name conecta serviço fora do mapa legacy"
  done <<<"$members"
  LIVE_NETWORK_IDS["$key"]="$candidate"
}

validate_topology() {
  local mode="$1" restart_mode="$2" health_mode="${3:-ready}" service id name container_inventory network_inventory
  LIVE_IDS=()
  LIVE_NETWORK_IDS=()
  LIVE_RUNNING=0
  LIVE_READY=0
  LIVE_UNHEALTHY=0
  LIVE_TOTAL=0
  while IFS= read -r service; do
    validate_container "$service" "$mode" "$restart_mode" "$health_mode" || true
  done < <(topology_services)
  validate_network private kas-private0 false any any "$mode" || true
  validate_network public kas-public0 true isolated isolated "$mode" || true
  container_inventory="$(docker ps -aq --no-trunc --filter label=com.docker.compose.project=kassinao)" ||
    die 'não foi possível inventariar containers do projeto kassinao'
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null)" || die 'inventário de containers mudou'
    case "${name#/}" in kassinao | kassinao-public | kassinao-tunnel) ;; *) die "container Compose inesperado: ${name#/}" ;; esac
  done <<<"$container_inventory"
  network_inventory="$(docker network ls -q --no-trunc --filter label=com.docker.compose.project=kassinao)" ||
    die 'não foi possível inventariar redes do projeto kassinao'
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    name="$(docker network inspect -f '{{.Name}}' "$id" 2>/dev/null)" || die 'inventário de redes mudou'
    case "$name" in kassinao_private | kassinao_public) ;; *) die "rede Compose inesperada: $name" ;; esac
  done <<<"$network_inventory"
  [ "$mode" = subset ] || [ "$LIVE_TOTAL" -eq "$(topology_services | wc -l | tr -d ' ')" ] ||
    die 'topologia legacy está incompleta'
}

assert_reserved_absent() {
  local name container_inventory network_inventory
  for name in kassinao kassinao-router kassinao-public kassinao-tunnel; do
    candidate="$(container_id_by_name "$name")" || die "não foi possível provar ausência de $name"
    [ -z "$candidate" ] || die "nome Docker reservado ainda está ocupado: $name"
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

legacy_hardener() {
  env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" \
    "$LEGACY_BUNDLE/scripts/harden-docker-egress.sh" "$@"
}

legacy_adapter() {
  env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" \
    "$CURRENT_BUNDLE/scripts/harden-docker-egress.sh" "$@"
}

legacy_removal_state() {
  local output
  if ! output="$(legacy_adapter --legacy-removal-state 2>/dev/null)"; then
    printf 'invalid\n'
    return
  fi
  case "$output" in present | absent | owned-progress) printf '%s\n' "$output" ;; *) printf 'invalid\n' ;; esac
}

remove_legacy_policy() {
  case "$(legacy_removal_state)" in
    present | owned-progress)
      legacy_adapter --remove-legacy-policy || die 'adapter current falhou ao remover a policy legacy'
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
      legacy_hardener --check >/dev/null ||
        die 'policy legacy present divergiu do hardener publicado'
      return
      ;;
    owned-progress) remove_legacy_policy || die 'policy legacy parcial não pôde ser removida' ;;
    absent) ;;
    invalid) die 'policy legacy não pode ser reconstruída sobre estado inválido' ;;
  esac
  legacy_hardener --preload || die 'preload da policy legacy falhou'
  legacy_hardener --check >/dev/null || die 'policy legacy reconstruída não passou no check'
}

assert_recordings_idle() {
  python3 - "$RECORDINGS_ROOT" <<'PY'
import json
import os
import pathlib
import stat
import sys
root = pathlib.Path(sys.argv[1])
active = 0
invalid = 0
with os.scandir(root) as entries:
    for entry in entries:
        try:
            info = entry.stat(follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode):
                continue
            meta = pathlib.Path(entry.path) / 'meta.json'
            if not meta.exists():
                continue
            meta_info = meta.stat(follow_symlinks=False)
            if not stat.S_ISREG(meta_info.st_mode) or meta_info.st_nlink != 1 or meta_info.st_size > 1024 * 1024:
                invalid += 1
                continue
            value = json.loads(meta.read_text(encoding='utf-8'))
            if not isinstance(value, dict):
                invalid += 1
            else:
                status = value.get('status')
                if status not in {'recording', 'done'}:
                    invalid += 1
                elif status == 'recording':
                    active += 1
        except (OSError, ValueError, json.JSONDecodeError):
            invalid += 1
if invalid or active:
    raise SystemExit(1)
PY
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
  local reason="$1"
  validate_topology subset stopped structural
  [ "$LIVE_RUNNING" -eq 0 ] || die "$reason; fence recusou desabilitar supervisão com runtime running"
  if ! (disable_watchdog); then
    publish_marker "$CURRENT_BUNDLE" || die "$reason; watchdog indeterminado e fence current falhou"
    [ "$(marker_deploy_dir)" = "$CURRENT_BUNDLE" ] || die "$reason; fence current não pôde ser provado"
  fi
  die "$reason; residual legacy ficou parado sem remover policy/objetos"
}

enable_watchdog() {
  [ "$(marker_deploy_dir)" = "$LEGACY_BUNDLE" ] || die 'marker deixou de apontar para o legacy'
  cmp -s "$LEGACY_BUNDLE/scripts/health-watch.sh" "$HEALTH_DISPATCHER" ||
    die 'dispatcher legacy do health-watch mudou'
  legacy_hardener --check >/dev/null || die 'policy legacy não está válida antes do watchdog'
  systemctl enable "$HEALTH_TIMER" >/dev/null || die 'não foi possível habilitar health-watch.timer'
  systemctl restart "$HEALTH_TIMER" >/dev/null || die 'não foi possível reiniciar health-watch.timer'
  systemctl is-enabled --quiet "$HEALTH_TIMER" && systemctl is-active --quiet "$HEALTH_TIMER" ||
    die 'health-watch.timer não ficou enabled/active'
  prove_watchdog_enabled || die 'estado textual do health-watch.timer não ficou enabled/active'
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

topology_objects_present() {
  local containers networks
  containers="$(docker ps -aq --no-trunc --filter label=com.docker.compose.project=kassinao)" ||
    die 'não foi possível inventariar containers legacy'
  networks="$(docker network ls -q --no-trunc --filter label=com.docker.compose.project=kassinao)" ||
    die 'não foi possível inventariar redes legacy'
  [ -n "$containers" ] || [ -n "$networks" ]
}

remove_objects() {
  local service id key bridge internal gateway4 gateway6 members
  validate_topology subset stopped
  for service in cloudflared kassinao-public kassinao; do
    id="${LIVE_IDS[$service]-}"
    [ -z "$id" ] || docker rm "$id" >/dev/null || die "não foi possível remover $service"
  done
  LIVE_IDS=()
  for spec in 'private:kas-private0:false:any:any' 'public:kas-public0:true:isolated:isolated'; do
    IFS=: read -r key bridge internal gateway4 gateway6 <<<"$spec"
    id="${LIVE_NETWORK_IDS[$key]-}"
    [ -n "$id" ] || continue
    validate_network "$key" "$bridge" "$internal" "$gateway4" "$gateway6" subset
    [ "${LIVE_NETWORK_IDS[$key]-}" = "$id" ] || die "ID da rede kassinao_$key mudou"
    members="$(docker network inspect -f '{{range $id, $member := .Containers}}{{printf "%s|%s\n" $id $member.Name}}{{end}}' "$id" | sort -u)" ||
      die "não foi possível revalidar membros de kassinao_$key"
    [ -z "$members" ] || die "rede kassinao_$key ainda possui endpoint"
    docker network rm "$id" >/dev/null || die "não foi possível remover a rede kassinao_$key"
  done
  assert_reserved_absent
}

wait_legacy_ready() {
  local deadline service id status all_ready
  deadline=$((SECONDS + 240))
  while [ "$SECONDS" -lt "$deadline" ]; do
    validate_topology exact either structural
    [ "$LIVE_UNHEALTHY" -eq 0 ] || return 1
    all_ready=true
    [ "$LIVE_RUNNING" -eq "$LIVE_TOTAL" ] || all_ready=false
    [ "$LIVE_READY" -eq "$LIVE_TOTAL" ] || all_ready=false
    if [ "$all_ready" = true ]; then return 0; fi
    sleep 3
  done
  return 1
}

normalize_exact_stopped() {
  local require_policy="${1:-true}" service id
  [ "$require_policy" = false ] ||
    legacy_hardener --check >/dev/null ||
    die 'policy legacy divergiu antes de normalizar recovery'
  assert_recordings_idle || die 'recordings não estão ociosas para normalizar recovery'
  validate_topology exact either structural
  for service in cloudflared kassinao-public kassinao; do
    id="${LIVE_IDS[$service]-}"
    [ -z "$id" ] || docker update --restart=no "$id" >/dev/null ||
      die "não foi possível desarmar restart de $service"
  done
  for service in cloudflared kassinao-public kassinao; do
    id="${LIVE_IDS[$service]-}"
    [ -z "$id" ] || [ "$(docker inspect -f '{{.State.Running}}' "$id")" = false ] ||
      docker stop --timeout 60 "$id" >/dev/null || die "não foi possível parar $service"
  done
  validate_topology exact stopped
  [ "$LIVE_RUNNING" -eq 0 ] || die 'recovery legacy não ficou parado após falha de readiness'
}

finalize_legacy_running() {
  validate_topology exact normal || die 'topologia legacy final divergiu'
  [ "$LIVE_RUNNING" -eq "$LIVE_TOTAL" ] && [ "$LIVE_READY" -eq "$LIVE_TOTAL" ] ||
    die 'topologia legacy não permaneceu running/ready no commit'
  legacy_hardener --check >/dev/null || die 'policy legacy final divergiu'
  prove_watchdog_enabled || die 'watchdog legacy não permaneceu enabled/active no commit'
  write_state legacy_running || die 'estado legacy_running não pôde ser persistido'
}

contain_legacy_subset() {
  local service id
  validate_topology subset either structural
  for service in cloudflared kassinao-public kassinao; do
    id="${LIVE_IDS[$service]-}"
    [ -z "$id" ] || docker update --restart=no "$id" >/dev/null 2>&1 || true
  done
  for service in cloudflared kassinao-public kassinao; do
    id="${LIVE_IDS[$service]-}"
    [ -z "$id" ] || [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)" = false ] ||
      docker stop --timeout 60 "$id" >/dev/null 2>&1 || true
  done
  validate_topology subset either structural
  for service in cloudflared kassinao-public kassinao; do
    id="${LIVE_IDS[$service]-}"
    [ -z "$id" ] || docker update --restart=no "$id" >/dev/null 2>&1 || true
  done
  validate_topology subset stopped structural
  [ "$LIVE_RUNNING" -eq 0 ] || die 'subset legacy permaneceu running durante contenção'
}

reverify_transition_inputs() {
  verify_bundle "$CURRENT_BUNDLE" current scripts/transition-dedicated-runtime-topology.sh
  verify_bundle "$LEGACY_BUNDLE" legacy
  assert_root_file "$CURRENT_ENV" 600 '.env current'
  assert_root_file "$LEGACY_ENV" 600 '.env legacy'
  assert_lock_contended_by_our_open_description 7 "$FIRST_LOCK" 'primeiro deploy lock'
  assert_lock_contended_by_our_open_description 8 "$SECOND_LOCK" 'segundo deploy lock'
  assert_lock_contended_by_our_open_description 9 "$MAINTENANCE_LOCK" maintenance.lock
  cmp -s "$LEGACY_BUNDLE/scripts/health-watch.sh" "$HEALTH_DISPATCHER" ||
    die 'dispatcher legacy do health-watch mudou sob lock'
  cmp -s "$LEGACY_BUNDLE/scripts/harden-docker-egress.sh" "$HARDENER_DISPATCHER" ||
    die 'dispatcher legacy do hardener mudou sob lock'
  marker_deploy_dir >/dev/null || die 'marker dedicated divergiu sob lock'
  read_state >/dev/null || die 'estado dedicated divergiu sob lock'
}

can_preserve_active_legacy() {
  [ "$(marker_deploy_dir 2>/dev/null || true)" = "$LEGACY_BUNDLE" ] &&
    prove_watchdog_enabled &&
    legacy_hardener --check >/dev/null 2>&1 &&
    (validate_topology exact either structural &&
      [ "$(docker inspect -f '{{.State.Running}}' "${LIVE_IDS[kassinao]}")" = true ] &&
      [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${LIVE_IDS[kassinao]}")" = healthy ]) >/dev/null 2>&1
}

fail_closed_legacy() {
  local reason="$1" exact_state="$2" marker_fenced=false watchdog_disabled=false exact=false
  flock -w 120 9 || die "$reason; maintenance.lock não voltou para o cleanup"
  assert_lock_contended_by_our_open_description 9 "$MAINTENANCE_LOCK" maintenance.lock
  reverify_transition_inputs
  if ! (assert_recordings_idle); then
    can_preserve_active_legacy &&
      die "$reason; gravação ativa detectada após o start, runtime íntegro foi preservado sob watchdog legacy"
  fi
  contain_legacy_subset
  if ! (assert_recordings_idle); then
    if ! (disable_watchdog); then
      publish_marker "$CURRENT_BUNDLE" ||
        die "$reason; gravação ativa permaneceu após contain e nenhum fence pôde ser publicado"
      [ "$(marker_deploy_dir)" = "$CURRENT_BUNDLE" ] || die "$reason; fence current não pôde ser provado"
    fi
    die "$reason; gravação ativa permaneceu marcada; residual ficou parado sem remover policy/objetos"
  fi
  if (disable_watchdog); then watchdog_disabled=true; fi
  if [ "$watchdog_disabled" = false ]; then
    publish_marker "$CURRENT_BUNDLE" ||
      die "$reason; watchdog indeterminado e fence current não pôde ser publicado antes do cleanup"
    [ "$(marker_deploy_dir)" = "$CURRENT_BUNDLE" ] || die "$reason; fence current não pôde ser provado"
    marker_fenced=true
  fi
  if (validate_topology exact stopped structural) >/dev/null 2>&1; then exact=true; fi
  if [ "$exact" = true ]; then
    rebuild_legacy_policy
    write_state "$exact_state"
  else
    remove_objects
    remove_legacy_policy
    write_state legacy_retired
  fi
  if [ "$watchdog_disabled" = true ]; then
    publish_marker "$LEGACY_BUNDLE"
  fi
  if [ "$(marker_deploy_dir 2>/dev/null || true)" = "$CURRENT_BUNDLE" ]; then marker_fenced=true; fi
  [ "$marker_fenced" = true ] || [ "$watchdog_disabled" = true ] ||
    die "$reason; runtime parado, mas nenhum fence persistente pôde ser provado"
  if [ "$watchdog_disabled" = true ]; then
    prove_watchdog_disabled || die "$reason; prova disabled/inactive mudou durante o cleanup"
  fi
  validate_topology subset stopped structural
  [ "$LIVE_RUNNING" -eq 0 ] || die "$reason; subset legacy escapou running"
  die "$reason; runtime legacy foi contido e cercado para retry"
}

run_health_watch_once() {
  local result exit_status
  flock -u 9
  systemctl reset-failed "$HEALTH_SERVICE" >/dev/null 2>&1 || true
  if ! systemctl start "$HEALTH_SERVICE" >/dev/null; then
    flock -w 120 9 || die 'maintenance.lock não voltou após falha do health-watch dedicated'
    die 'health-watch legacy falhou ao reconciliar a topologia prepared'
  fi
  result="$(systemctl show "$HEALTH_SERVICE" -p Result --value 2>/dev/null || true)"
  exit_status="$(systemctl show "$HEALTH_SERVICE" -p ExecMainStatus --value 2>/dev/null || true)"
  [ "$result" = success ] && [ "$exit_status" = 0 ] || {
    flock -w 120 9 || die 'maintenance.lock não voltou após resultado inválido do health-watch dedicated'
    die "health-watch legacy terminou com Result=$result ExecMainStatus=$exit_status"
  }
  flock -w 120 9 || die 'health-watch dedicated não liberou maintenance.lock'
  assert_lock_contended_by_our_open_description 7 "$FIRST_LOCK" 'primeiro deploy lock'
  assert_lock_contended_by_our_open_description 8 "$SECOND_LOCK" 'segundo deploy lock'
  assert_lock_contended_by_our_open_description 9 "$MAINTENANCE_LOCK" maintenance.lock
  cmp -s "$LEGACY_BUNDLE/scripts/health-watch.sh" "$HEALTH_DISPATCHER" ||
    die 'dispatcher legacy do health-watch mudou durante reconcile'
  [ "$(marker_deploy_dir)" = "$LEGACY_BUNDLE" ] || die 'marker legacy mudou durante reconcile'
}

print_state() {
  local state="$1" topology="$2" runtime="$3" watchdog
  watchdog="$(watchdog_status)"
  python3 - "$state" "$topology" "$runtime" "$TUNNEL" "$watchdog" <<'PY'
import json
import sys
print(json.dumps({
    'runtime': sys.argv[3],
    'schema_version': 1,
    'state': sys.argv[1],
    'topology': sys.argv[2],
    'tunnel': sys.argv[4] == 'true',
    'watchdog': sys.argv[5],
}, ensure_ascii=True, separators=(',', ':'), sort_keys=True))
PY
}

PERSISTED_STATE="$(read_state)" || die 'estado persisted da transição dedicated divergiu'
if [ "$MARKER_FENCED_CURRENT" = true ]; then
  case "$PERSISTED_STATE" in
    neutral | legacy_stopped | legacy_retired | legacy_prepared | legacy_running) ;;
    *) die 'marker current fenced não corresponde a estado dedicated retomável' ;;
  esac
fi

case "$COMMAND" in
  inspect)
    if [ "$MARKER_FENCED_CURRENT" = true ]; then
      prove_watchdog_disabled || die 'inspect fenced exige watchdog positivamente disabled/inactive'
    fi
    if container_exists kassinao; then
      validate_topology exact either
      [ "$MARKER_FENCED_CURRENT" = false ] || [ "$LIVE_RUNNING" -eq 0 ] ||
        die 'inspect fenced recusa runtime legacy running sob marker current'
      if [ "$LIVE_RUNNING" -eq "$LIVE_TOTAL" ]; then
        print_state legacy_running legacy running
      elif [ "$LIVE_RUNNING" -eq 0 ]; then
        if [ "$PERSISTED_STATE" = legacy_prepared ]; then
          print_state legacy_prepared legacy stopped
        else
          print_state legacy_stopped legacy stopped
        fi
      else
        die 'topologia legacy está parcialmente running'
      fi
    else
      assert_reserved_absent
      [ "$PERSISTED_STATE" = legacy_retired ] || [ "$PERSISTED_STATE" = neutral ] ||
        die 'estado persisted diverge da ausência de runtime'
      print_state "$PERSISTED_STATE" none absent
    fi
    ;;

  retire-legacy)
    case "$PERSISTED_STATE" in neutral | legacy_running | legacy_stopped | legacy_retired | legacy_prepared) ;; *)
      die "retire-legacy não aceita estado $PERSISTED_STATE"
      ;;
    esac
    if topology_objects_present; then
      if [ "$MARKER_FENCED_CURRENT" = true ] || [ "$PERSISTED_STATE" = legacy_stopped ]; then
        validate_topology subset stopped
      else
        validate_topology exact either structural
      fi
      assert_recordings_idle || die 'recordings não estão canonicamente ociosas antes do stop legacy'
    else
      assert_reserved_absent
      assert_recordings_idle || die 'recordings não estão canonicamente ociosas antes da retirada legacy'
    fi
    if [ "$MARKER_FENCED_CURRENT" = false ]; then
      if topology_objects_present; then contain_legacy_subset; else assert_reserved_absent; fi
      (assert_recordings_idle) ||
        fence_stopped_active_recording 'gravação apareceu durante a contenção de retirada legacy'
    else
      validate_topology subset stopped structural
      [ "$LIVE_RUNNING" -eq 0 ] || die 'retirada fenced exige residual legacy parado'
    fi
    if ! (disable_watchdog); then
      publish_marker "$CURRENT_BUNDLE" || die 'watchdog indeterminado e fence current não pôde ser publicado'
      die 'watchdog não pôde ser provado disabled/inactive; residual legacy ficou parado e cercado'
    fi
    publish_marker "$LEGACY_BUNDLE"
    if ! (
      if topology_objects_present; then
        assert_recordings_idle || die 'recordings deixaram de estar ociosas após stop legacy'
        if (validate_topology exact stopped structural) >/dev/null 2>&1; then
          write_state legacy_stopped
        fi
      else
        assert_reserved_absent
      fi
      remove_legacy_policy
      if topology_objects_present; then remove_objects; else assert_reserved_absent; fi
      write_state legacy_retired
      publish_marker "$CURRENT_BUNDLE"
    ); then
      fail_closed_legacy 'retirada legacy dedicated falhou após desabilitar o watchdog' legacy_stopped
    fi
    print_state legacy_retired none absent
    ;;

  restore-legacy)
    case "$PERSISTED_STATE" in neutral | legacy_stopped | legacy_retired | legacy_prepared | legacy_running) ;; *)
      die "restore-legacy não aceita estado $PERSISTED_STATE"
      ;;
    esac
    if [ "$PERSISTED_STATE" = neutral ] && ! topology_objects_present; then
      assert_reserved_absent
      print_state neutral none absent
      exit 0
    fi
    if [ "$MARKER_FENCED_CURRENT" = false ] && topology_objects_present; then
      if (validate_topology exact normal && [ "$LIVE_RUNNING" -eq "$LIVE_TOTAL" ] &&
        [ "$LIVE_READY" -eq "$LIVE_TOTAL" ]) >/dev/null 2>&1 &&
        [ "$(legacy_removal_state)" = present ] && prove_watchdog_enabled; then
        legacy_hardener --check >/dev/null || die 'policy legacy running divergiu'
        write_state legacy_running
        print_state legacy_running legacy running
        exit 0
      fi
      assert_recordings_idle || die 'recordings não estão ociosas antes de conter recovery legacy'
      contain_legacy_subset
      (assert_recordings_idle) ||
        fence_stopped_active_recording 'gravação apareceu durante a contenção de recovery legacy'
    elif [ "$MARKER_FENCED_CURRENT" = true ]; then
      validate_topology subset stopped structural
      [ "$LIVE_RUNNING" -eq 0 ] || die 'recovery fenced exige residual legacy parado'
    fi
    if ! (disable_watchdog); then
      publish_marker "$CURRENT_BUNDLE" || die 'watchdog indeterminado e fence current não pôde ser publicado'
      die 'watchdog não pôde ser provado disabled/inactive; residual legacy ficou parado e cercado'
    fi
    if ! (
      if topology_objects_present; then
        contain_legacy_subset
        if ! (validate_topology exact stopped structural) >/dev/null 2>&1; then
          remove_objects
          remove_legacy_policy
          write_state legacy_retired
        fi
      fi
      if ! topology_objects_present; then
        assert_reserved_absent
        compose_command create --no-build --force-recreate || die 'Compose legacy falhou durante create'
        contain_legacy_subset
      fi
      validate_topology exact stopped structural
      case "$(legacy_removal_state)" in
        present) legacy_hardener --check >/dev/null || die 'policy legacy present divergiu' ;;
        absent | owned-progress) rebuild_legacy_policy ;;
        invalid) die 'policy legacy existe em estado inválido; restauração recusada' ;;
      esac
      write_state legacy_prepared
      assert_recordings_idle || die 'recordings não estão ociosas antes de iniciar recovery legacy'
      prove_watchdog_disabled || die 'watchdog não está positivamente disabled/inactive antes do marker legacy'
      publish_marker "$LEGACY_BUNDLE"
      enable_watchdog || die 'watchdog legacy não pôde ser habilitado antes do reconcile'
      run_health_watch_once
      wait_legacy_ready || die 'topologia legacy não ficou healthy em 240 segundos'
      validate_topology exact either structural
      for service in kassinao kassinao-public cloudflared; do
        id="${LIVE_IDS[$service]-}"
        [ -z "$id" ] || docker update --restart=unless-stopped "$id" >/dev/null ||
          die "não foi possível armar restart de $service após readiness"
      done
      validate_topology exact normal
      finalize_legacy_running
    ); then
      fail_closed_legacy 'recovery legacy falhou após desabilitar o watchdog' legacy_prepared
    fi
    print_state legacy_running legacy running
    ;;
esac
