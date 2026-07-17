#!/bin/bash -p
# Classifica somente o layout dedicado anterior a KASSINAO_HOST_SCOPE. Este
# preflight é read-only: ele não para containers nem altera Docker/host.
set -Eeuo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 1 ] || die 'uso: validate-legacy-dedicated-installation.sh CURRENT_RELEASE_ROOT'
CURRENT_ROOT="$1"
_saved_current_root="$CURRENT_ROOT"
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
_forbidden_docker_environment=''
for _name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$_name" >/dev/null 2>&1; then _forbidden_docker_environment="$_name"; break; fi
done

SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
while IFS= read -r inherited_name; do unset "$inherited_name" 2>/dev/null || true; done < <(compgen -e)
export PATH="$SAFE_SYSTEM_PATH" HOME=/root
CURRENT_ROOT="$_saved_current_root"
unset _saved_current_root
[ -z "$_forbidden_docker_environment" ] || die "$_forbidden_docker_environment não pode vir do ambiente"

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do validador legado não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'validador legado precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/validate-legacy-dedicated-installation.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do validador legado não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter do validador legado não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$(id -u)" -eq 0 ] || die 'execute como root'
for command in awk dirname docker id python3 readlink sha256sum stat; do
  command -v "$command" >/dev/null 2>&1 || die "$command é obrigatório"
done
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
DOCKER_CONFIG="$PROJECT_DIR/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] ||
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] ||
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG

[[ "$CURRENT_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'CURRENT_RELEASE_ROOT precisa ser caminho absoluto simples'
case "$CURRENT_ROOT" in *//* | */./* | */../* | */. | */.. | */) die 'CURRENT_RELEASE_ROOT precisa ser canônico' ;; esac
[ -d "$CURRENT_ROOT" ] && [ ! -L "$CURRENT_ROOT" ] && [ "$(readlink -f -- "$CURRENT_ROOT")" = "$CURRENT_ROOT" ] ||
  die 'CURRENT_RELEASE_ROOT precisa ser diretório canônico, sem symlink'

assert_root_file() {
  local path="$1" expected_mode="$2" description="$3" metadata mode
  [ -f "$path" ] && [ ! -L "$path" ] && [ "$(readlink -f -- "$path")" = "$path" ] ||
    die "$description ausente, irregular ou symlink"
  metadata="$(stat -c '%a:%u:%g' "$path" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  [ "${metadata#*:}" = 0:0 ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die "$description precisa ser root-owned e não gravável por grupo/outros"
  [ -z "$expected_mode" ] || [ "$mode" = "$expected_mode" ] || die "$description precisa usar modo $expected_mode"
  [ "$(stat -c '%h' "$path" 2>/dev/null || true)" = 1 ] || die "$description não pode possuir hardlinks"
}

cursor="$CURRENT_ROOT"
while :; do
  metadata="$(stat -c '%a:%u:%g' "$cursor" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  [ "${metadata#*:}" = 0:0 ] && [[ "$mode" =~ ^[0-7]+$ ]] ||
    die "CURRENT_RELEASE_ROOT e parents precisam ser root-owned: $cursor"
  if (( (8#$mode & 022) != 0 && (8#$mode & 01000) == 0 )); then
    die "parent gravável de CURRENT_RELEASE_ROOT precisa usar sticky bit: $cursor"
  fi
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done

ENV_FILE="$CURRENT_ROOT/.env"
COMPOSE_FILE="$CURRENT_ROOT/docker-compose.yml"
assert_root_file "$ENV_FILE" 600 '.env legado'
assert_root_file "$COMPOSE_FILE" '' 'docker-compose.yml legado'

env_count() {
  local key="$1"
  awk -v key="$key" 'index($0, key "=") == 1 { count++ } END { print count + 0 }' "$ENV_FILE"
}
env_optional_value() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count > 1) exit 2; print value }
  ' "$ENV_FILE" || die "$key não pode aparecer mais de uma vez no .env legado"
}

[ "$(env_count KASSINAO_HOST_SCOPE)" -eq 0 ] ||
  die 'esta validação aceita somente layout legado sem KASSINAO_HOST_SCOPE'
ack_count="$(env_count KASSINAO_DEDICATED_DOCKER_HOST_ACK)"
[ "$ack_count" -le 1 ] || die 'KASSINAO_DEDICATED_DOCKER_HOST_ACK duplicado no .env legado'
ack="$(env_optional_value KASSINAO_DEDICATED_DOCKER_HOST_ACK)"
case "$ack" in '' | I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO) ;; *)
  die 'ACK legado possui valor inesperado; perímetro não será inferido'
esac

docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || die 'daemon Docker local indisponível'
ids=()
while IFS= read -r container_id; do [ -z "$container_id" ] || ids+=("$container_id"); done < <(docker ps -aq --no-trunc)
[ "${#ids[@]}" -gt 0 ] || die 'nenhum runtime Docker permite provar a instalação legada'

base_projection='{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}}}}}'
official_ids="$({
  docker inspect --format "$base_projection" "${ids[@]}"
} | python3 /dev/fd/3 3<<'PY'
import json, os, sys

expected = {
    'kassinao': 'kassinao',
    'kassinao-router': 'kassinao-router',
    'kassinao-public': 'kassinao-public',
    'cloudflared': 'kassinao-tunnel',
}
seen = set()
for line in sys.stdin:
    try:
        item = json.loads(line)
    except Exception:
        raise SystemExit(1)
    if not isinstance(item, dict):
        raise SystemExit(1)
    labels = (item.get('Config') or {}).get('Labels') or {}
    project = labels.get('com.docker.compose.project')
    service = labels.get('com.docker.compose.service')
    name = str(item.get('Name') or '').lstrip('/')
    belongs = project == 'kassinao' or name in expected.values()
    if not belongs:
        continue
    if project != 'kassinao' or service not in expected or expected[service] != name or service in seen:
        raise SystemExit(1)
    item_id = item.get('Id')
    if not isinstance(item_id, str) or not item_id:
        raise SystemExit(1)
    seen.add(service)
    print(item_id)

if 'kassinao' not in seen:
    raise SystemExit(1)
PY
)" || die 'Docker não prova project/name/service exclusivos do layout legado'
official_id_list=()
while IFS= read -r container_id; do [ -z "$container_id" ] || official_id_list+=("$container_id"); done <<<"$official_ids"
[ "${#official_id_list[@]}" -gt 0 ] || die 'Docker não identificou o core do layout legado'
detail_projection='{"Id":{{json .Id}},"WorkingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"ConfigFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}'
if ! docker inspect --format "$detail_projection" "${official_id_list[@]}" | \
  python3 /dev/fd/3 "$CURRENT_ROOT" "${official_id_list[@]}" 3<<'PY'
import json, os, sys
root = os.path.realpath(sys.argv[1])
expected_ids = set(sys.argv[2:])
seen_ids = set()
base_compose = os.path.join(root, 'docker-compose.yml')
for line in sys.stdin:
    try:
        item = json.loads(line)
    except Exception:
        raise SystemExit(1)
    if not isinstance(item, dict) or item.get('Id') not in expected_ids or item.get('Id') in seen_ids:
        raise SystemExit(1)
    seen_ids.add(item['Id'])
    working_dir = item.get('WorkingDir')
    config_files = item.get('ConfigFiles')
    if not isinstance(working_dir, str) or os.path.realpath(working_dir) != root:
        raise SystemExit(1)
    if not isinstance(config_files, str):
        raise SystemExit(1)
    configured = [os.path.realpath(value.strip()) for value in config_files.split(',') if value.strip()]
    if configured != [base_compose]:
        raise SystemExit(1)
if seen_ids != expected_ids:
    raise SystemExit(1)
PY
then
  die 'Docker não prova projeto/nome/service/working_dir e Compose-base exclusivos do layout legado'
fi

printf 'legacy-dedicated\n'
