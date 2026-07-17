#!/bin/bash -p
# Finaliza, somente sob confirmação explícita, o rollback plaintext preservado
# por migrate-shared-storage.sh. Isto remove uma árvore lógica; não promete
# secure erase em SSD, snapshots, backups ou storage do provedor.
set -Eeuo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 1 ] && [ "$1" = --confirm-destroy-plaintext-rollback ] ||
  die 'uso: finalize-shared-migration.sh --confirm-destroy-plaintext-rollback'

# KASSINAO_HOST_ENV_SCRUB_BEGIN
SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
_inherited_docker_environment_name=''
for inherited_name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$inherited_name" >/dev/null 2>&1; then
    _inherited_docker_environment_name="$inherited_name"
    break
  fi
done
_runtime_override_present=false
[ "${KASSINAO_RUNTIME_DIR+x}" != x ] || _runtime_override_present=true
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente da finalização'
while IFS='=' read -r -d '' inherited_name inherited_value; do
  unset "$inherited_name" 2>/dev/null || true
done < "/proc/$$/environ"
unset inherited_name inherited_value
export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C TMPDIR=/tmp
[ -z "$_inherited_docker_environment_name" ] || die "$_inherited_docker_environment_name não pode vir do ambiente"
[ "$_runtime_override_present" = false ] || die 'KASSINAO_RUNTIME_DIR não pode vir do ambiente; o runtime é fixo'
# KASSINAO_HOST_ENV_SCRUB_END

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho da finalização não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'finalização precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/finalize-shared-migration.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit da finalização não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter da finalização não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$EUID" -eq 0 ] || die 'execute como root'
for command in awk chmod chown cmp dirname docker env findmnt flock grep id mkdir mountpoint mv python3 readlink rm sha256sum stat sync; do
  command -v "$command" >/dev/null 2>&1 || die "$command é obrigatório"
done
rm_version="$(rm --version 2>/dev/null | awk 'NR == 1 { print; exit }')"
[[ "$rm_version" == *GNU*coreutils* ]] || die 'GNU rm é obrigatório para --one-file-system'

export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
[ "$ROOT" = "$PROJECT_DIR" ] || die 'raiz canônica divergiu do kit selado'
DOCKER_CONFIG="$ROOT/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && \
  [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] || \
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] || \
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG
ENV_FILE="$ROOT/.env"
MANIFEST="$ROOT/MANIFEST.sha256"
SELF="$ROOT/scripts/finalize-shared-migration.sh"
VERIFIER="$ROOT/scripts/verify-shared-luks-storage.sh"
NEIGHBOR_AUDITOR="$ROOT/scripts/audit-shared-vps-security.sh"

[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die 'diretório do kit ausente ou symlink'
[ "$(stat -c '%a:%u:%g' "$ROOT" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'diretório do kit precisa ser 0700 root:root'
cursor="$ROOT"
while :; do
  [ ! -e "$cursor/.git" ] || die 'finalização privilegiada exige kit operacional fora de Git'
  metadata="$(stat -c '%a:%u:%g' "$cursor" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  [ "${metadata#*:}" = 0:0 ] && [[ "$mode" =~ ^[0-7]+$ ]] ||
    die 'kit e parents precisam ser root-owned'
  if (( (8#$mode & 022) != 0 && (8#$mode & 01000) == 0 )); then
    die 'parent gravável do kit precisa usar sticky bit'
  fi
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done

[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die 'MANIFEST.sha256 ausente ou irregular'
manifest_metadata="$(stat -c '%a:%u:%g:%h' "$MANIFEST" 2>/dev/null || true)"
IFS=: read -r manifest_mode manifest_uid manifest_gid manifest_links <<<"$manifest_metadata"
[ "$manifest_uid:$manifest_gid:$manifest_links" = 0:0:1 ] && [[ "$manifest_mode" =~ ^[0-7]+$ ]] &&
  (( (8#$manifest_mode & 022) == 0 )) ||
  die 'MANIFEST.sha256 precisa ser root-owned, sem hardlink e não gravável por terceiros'
for required in scripts/finalize-shared-migration.sh scripts/verify-shared-luks-storage.sh scripts/audit-shared-vps-security.sh; do
  count="$(awk -v wanted="$required" '{ path=$2; sub(/^\.\//, "", path); if (path == wanted) count++ } END { print count + 0 }' "$MANIFEST")"
  [ "$count" -eq 1 ] || die 'controle obrigatório precisa aparecer exatamente uma vez no manifesto'
done
(cd -- "$ROOT" && sha256sum -c MANIFEST.sha256 --quiet) || die 'kit diverge do MANIFEST.sha256'
for control in "$SELF" "$VERIFIER" "$NEIGHBOR_AUDITOR"; do
  [ -f "$control" ] && [ ! -L "$control" ] && [ -x "$control" ] ||
    die 'controle obrigatório ausente, sem execução ou symlink'
  metadata="$(stat -c '%a:%u:%g:%h' "$control" 2>/dev/null || true)"
  IFS=: read -r mode owner_uid owner_gid links <<<"$metadata"
  [ "$owner_uid:$owner_gid:$links" = 0:0:1 ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die 'controle obrigatório precisa ser root-owned, sem hardlink e não gravável por terceiros'
done

[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || die '.env privado ausente ou symlink'
[ "$(stat -c '%a:%u:%g:%h' "$ENV_FILE" 2>/dev/null || true)" = 600:0:0:1 ] ||
  die '.env privado precisa ser 0600 root:root sem hardlink'

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
retention_hours="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS)"
[ "$recordings" = "$data_root/recordings" ] && [ "$state" = "$data_root/state" ] &&
  [ "$auth" = "$data_root/auth" ] && [ "$cache" = "$data_root/cache" ] ||
  die 'recordings/state/auth/cache precisam ser filhos exatos de KASSINAO_DATA_ROOT'
[[ "$retention_hours" =~ ^[1-9][0-9]*$ ]] && [ "$retention_hours" -le 168 ] ||
  die 'KASSINAO_ROLLBACK_RETENTION_HOURS precisa ficar entre 1 e 168'
[ -d "$data_root" ] && [ ! -L "$data_root" ] && [ "$(readlink -f -- "$data_root")" = "$data_root" ] ||
  die 'DATA_ROOT cifrado precisa ser diretório canônico'
[ "$(stat -c '%a:%u:%g' "$data_root" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'DATA_ROOT cifrado precisa ser 0700 root:root'

rollback_path="${data_root}.plaintext-before-shared-luks"
data_parent="$(dirname -- "$data_root")"
pending_marker="$data_root/.kassinao-plaintext-rollback.pending"
purging_marker="$data_root/.kassinao-plaintext-rollback.purging"
purged_marker="$data_root/.kassinao-plaintext-rollback.purged"
persisted_manifest="$data_root/.kassinao-migration-manifest.jsonl"
purging_tmp="$data_root/.kassinao-plaintext-rollback.purging.tmp"
purged_tmp="$data_root/.kassinao-plaintext-rollback.purged.tmp"

[ -d "$data_parent" ] && [ ! -L "$data_parent" ] && [ "$(readlink -f -- "$data_parent")" = "$data_parent" ] ||
  die 'parent de DATA_ROOT precisa ser canônico'
parent_metadata="$(stat -c '%a:%u:%g' "$data_parent" 2>/dev/null || true)"
parent_mode="${parent_metadata%%:*}"
[ "${parent_metadata#*:}" = 0:0 ] && [[ "$parent_mode" =~ ^[0-7]+$ ]] &&
  (( (8#$parent_mode & 022) == 0 )) || die 'parent de DATA_ROOT precisa ser root-owned e não gravável'

RUNTIME_DIR=/run/lock/kassinao
case "$RUNTIME_DIR" in
  "$data_root" | "$data_root"/* | "$rollback_path" | "$rollback_path"/*)
    die 'runtime de manutenção não pode sobrepor dados ou rollback'
    ;;
esac
[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] && [ "$(readlink -f -- "$RUNTIME_DIR")" = "$RUNTIME_DIR" ] ||
  die 'runtime de manutenção precisa preexistir como diretório canônico'
[ "$(stat -c '%a:%u:%g' "$RUNTIME_DIR" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'runtime de manutenção precisa ser 0700 root:root'
maintenance_lock="$RUNTIME_DIR/maintenance.lock"
[ -f "$maintenance_lock" ] && [ ! -L "$maintenance_lock" ] &&
  [ "$(readlink -f -- "$maintenance_lock")" = "$maintenance_lock" ] &&
  [ "$(stat -c '%a:%u:%g:%h' "$maintenance_lock" 2>/dev/null || true)" = 600:0:0:1 ] ||
  die 'maintenance.lock precisa ser canônico, 0600 root:root e sem hardlink'
exec 9<>"$maintenance_lock"
# KASSINAO_LOCK_FD_PROOF_BEGIN
[ "$(stat -Lc '%a:%u:%g:%h' "/proc/$$/fd/9" 2>/dev/null || true)" = 600:0:0:1 ] &&
  [ "$(readlink -f -- "/proc/$$/fd/9" 2>/dev/null || true)" = "$maintenance_lock" ] &&
  [ "$(stat -c '%d:%i' "$maintenance_lock" 2>/dev/null || true)" = "$(stat -Lc '%d:%i' "/proc/$$/fd/9" 2>/dev/null || true)" ] ||
  die 'maintenance.lock mudou durante a abertura'
# KASSINAO_LOCK_FD_PROOF_END
flock -w 120 9 || die 'outra manutenção não liberou a instância em 120 segundos'

mount_inventory="$RUNTIME_DIR/.shared-finalize-mounts.json"
recomputed_manifest="$RUNTIME_DIR/.shared-finalize-tree.manifest"

reconcile_interrupted_temp() {
  local temporary="$1" metadata mode temporary_parent
  { [ -e "$temporary" ] || [ -L "$temporary" ]; } || return 0
  [ -f "$temporary" ] && [ ! -L "$temporary" ] && [ "$(readlink -f -- "$temporary")" = "$temporary" ] ||
    die 'resíduo de finalização interrompida ficou irregular'
  metadata="$(stat -c '%a:%u:%g:%h' "$temporary" 2>/dev/null || true)"
  IFS=: read -r mode owner_uid owner_gid links <<<"$metadata"
  [ "$owner_uid:$owner_gid:$links" = 0:0:1 ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die 'resíduo de finalização interrompida ficou desprotegido'
  rm -f -- "$temporary" 2>/dev/null || die 'não foi possível reconciliar resíduo de finalização interrompida'
  { [ ! -e "$temporary" ] && [ ! -L "$temporary" ]; } || die 'resíduo de finalização permaneceu após reconciliação'
  temporary_parent="$(dirname -- "$temporary")"
  sync -f "$temporary_parent" 2>/dev/null || die 'não foi possível tornar a reconciliação de resíduo durável'
}

for temporary in "$mount_inventory" "$recomputed_manifest" "$purging_tmp" "$purged_tmp"; do
  reconcile_interrupted_temp "$temporary"
done
finalization_succeeded=false

cleanup() {
  local status=$?
  trap - EXIT
  rm -f -- "$mount_inventory" "$recomputed_manifest" 2>/dev/null || true
  if [ "$finalization_succeeded" != true ]; then
    for marker_tmp in "$purging_tmp" "$purged_tmp"; do
      if [ -e "$marker_tmp" ] && [ ! -L "$marker_tmp" ]; then rm -f -- "$marker_tmp" 2>/dev/null || true; fi
    done
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

assert_shared_neighbors() {
  env -i "PATH=$PATH" HOME=/root "KASSINAO_ENV_FILE=$ENV_FILE" \
    "$NEIGHBOR_AUDITOR" --neighbors-only >/dev/null 2>&1 ||
    die 'auditoria read-only dos vizinhos recusou a finalização'
}

assert_kassinao_stopped() {
  docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || die 'daemon Docker local indisponível'
  local ids_raw projection
  ids_raw="$(docker ps -aq --no-trunc)" || die 'não foi possível enumerar containers'
  projection='{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}}}},"State":{"Running":{{json .State.Running}}},"HostConfig":{"RestartPolicy":{"Name":{{json .HostConfig.RestartPolicy.Name}}}}}'
  if [ -n "$ids_raw" ]; then
    mapfile -t ids <<<"$ids_raw"
  fi
  {
    if [ -n "$ids_raw" ]; then
      docker inspect --format "$projection" "${ids[@]}" || exit 1
    fi
  } | python3 /dev/fd/3 3<<'PY' || die 'containers Kassinão precisam estar parados com restart=no'
import json, sys
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
    'kassinao-router': 'kassinao-router',
    'kassinao-public': 'kassinao-public',
    'cloudflared': 'kassinao-tunnel',
}
seen = set()
for item in items:
    labels = (item.get('Config') or {}).get('Labels') or {}
    project = labels.get('com.docker.compose.project')
    service = labels.get('com.docker.compose.service')
    name = str(item.get('Name') or '').lstrip('/')
    if project != 'kassinao' and name not in expected.values():
        continue
    if project != 'kassinao' or service not in expected or name != expected[service] or service in seen:
        raise SystemExit(1)
    seen.add(service)
    state = item.get('State') or {}
    restart = str((((item.get('HostConfig') or {}).get('RestartPolicy') or {}).get('Name') or 'no')).lower()
    if state.get('Running') is not False or restart not in ('no', 'none'):
        raise SystemExit(1)
PY
}

assert_no_rollback_mounts() {
  mountpoint -q -- "$rollback_path" && die 'rollback plaintext não pode ser mountpoint'
  findmnt --json --output TARGET > "$mount_inventory" 2>/dev/null || die 'não foi possível inventariar mounts'
  python3 - "$mount_inventory" "$rollback_path" 2>/dev/null <<'PY' || die 'nested mount detectado no rollback plaintext'
import json, os, sys
with open(sys.argv[1], encoding='utf-8') as source:
    payload = json.load(source)
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

tree_manifest() {
  local output="$1" root_path="$2"
  python3 - "$output" "$root_path" 2>/dev/null <<'PY'
import hashlib, json, os, stat, sys
output, root = sys.argv[1:]
base_levels = ('recordings', 'state', 'auth', 'cache')
entries = set(os.listdir(root))
if entries == set(base_levels):
    top_levels = base_levels
elif entries == set(base_levels) | {'.legacy-shared-transition'}:
    top_levels = base_levels + ('.legacy-shared-transition',)
else:
    raise SystemExit(1)

def fail():
    raise SystemExit(1)

def stable(left, right):
    return (left.st_dev, left.st_ino, left.st_mode, left.st_uid, left.st_gid, left.st_size,
            left.st_mtime_ns, left.st_ctime_ns) == (
            right.st_dev, right.st_ino, right.st_mode, right.st_uid, right.st_gid, right.st_size,
            right.st_mtime_ns, right.st_ctime_ns)

def visit(path, relative, device, lines):
    before = os.lstat(path)
    if before.st_dev != device:
        fail()
    if stat.S_ISLNK(before.st_mode):
        fail()
    record = {'path': relative, 'mode': stat.S_IMODE(before.st_mode), 'uid': before.st_uid, 'gid': before.st_gid}
    if stat.S_ISDIR(before.st_mode):
        record['type'] = 'directory'
        names = sorted(os.listdir(path))
        after_list = os.lstat(path)
        if not stable(before, after_list):
            fail()
        lines.append(json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(',', ':')))
        for name in names:
            visit(os.path.join(path, name), f'{relative}/{name}', device, lines)
        if not stable(after_list, os.lstat(path)):
            fail()
        return
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        fail()
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        opened = os.fstat(descriptor)
        if not stable(before, opened):
            fail()
        digest = hashlib.sha256()
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            digest.update(block)
        if not stable(opened, os.fstat(descriptor)):
            fail()
    finally:
        os.close(descriptor)
    record.update(type='file', size=before.st_size, sha256=digest.hexdigest())
    lines.append(json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(',', ':')))

lines = []
for name in top_levels:
    path = os.path.join(root, name)
    metadata = os.lstat(path)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail()
    visit(path, name, metadata.st_dev, lines)
lines.sort(key=lambda raw: json.loads(raw)['path'])
with open(output, 'x', encoding='utf-8', newline='\n') as target:
    target.write('\n'.join(lines) + '\n')
PY
}

path_present() { [ -e "$1" ] || [ -L "$1" ]; }

load_marker() {
  local marker="$1" expected_status="$2" output_name="$3" expected_count=4
  local -n output="$output_name"
  [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(readlink -f -- "$marker")" = "$marker" ] ||
    die "marker $expected_status ausente ou irregular"
  [ "$(stat -c '%a:%u:%g:%h' "$marker" 2>/dev/null || true)" = 400:0:0:1 ] ||
    die "marker $expected_status precisa ser 0400 root:root sem hardlink"
  [ "$expected_status" = pending ] || expected_count=5
  output=()
  mapfile -t output < <(python3 - "$marker" "$rollback_path" "$expected_status" 2>/dev/null <<'PY'
import re, sys, time

marker, expected_path, expected_status = sys.argv[1:]
raw = open(marker, 'rb').read()
if not raw.endswith(b'\n') or b'\r' in raw or b'\0' in raw:
    raise SystemExit(1)
try:
    lines = raw[:-1].decode('ascii').split('\n')
except UnicodeDecodeError:
    raise SystemExit(1)
event_key = {'pending': None, 'purging': 'purge_started_at', 'purged': 'purged_at'}.get(expected_status)
if expected_status not in ('pending', 'purging', 'purged'):
    raise SystemExit(1)
keys = ['status', 'migration_id', 'manifest_sha256', 'rollback_path', 'created_at', 'deadline']
if event_key:
    keys.append(event_key)
if len(lines) != len(keys) + 1 or lines[0] != 'kassinao-shared-plaintext-rollback-v1':
    raise SystemExit(1)
values = {}
for line, key in zip(lines[1:], keys):
    prefix = key + '='
    if not line.startswith(prefix) or len(line) == len(prefix):
        raise SystemExit(1)
    values[key] = line[len(prefix):]
if values['status'] != expected_status:
    raise SystemExit(1)
if not re.fullmatch(r'[0-9a-f]{32}', values['migration_id']):
    raise SystemExit(1)
if not re.fullmatch(r'[0-9a-f]{64}', values['manifest_sha256']):
    raise SystemExit(1)
if values['rollback_path'] != expected_path:
    raise SystemExit(1)

def epoch(name):
    value = values[name]
    if not re.fullmatch(r'[1-9][0-9]*', value) or str(int(value)) != value:
        raise SystemExit(1)
    return int(value)

created = epoch('created_at')
deadline = epoch('deadline')
now = int(time.time())
delta = deadline - created
if created > now or delta < 3600 or delta > 168 * 3600 or delta % 3600:
    raise SystemExit(1)
event = None
if event_key:
    event = epoch(event_key)
    if event < created or event > now:
        raise SystemExit(1)
print(values['migration_id'])
print(values['manifest_sha256'])
print(created)
print(deadline)
if event is not None:
    print(event)
PY
)
  [ "${#output[@]}" -eq "$expected_count" ] || die "conteúdo do marker $expected_status é inválido"
}

markers_match() {
  local left_name="$1" right_name="$2" index
  local -n left="$left_name" right="$right_name"
  for index in 0 1 2 3; do [ "${left[$index]}" = "${right[$index]}" ] || return 1; done
}

validate_rollback_root() {
  [ -d "$rollback_path" ] && [ ! -L "$rollback_path" ] && [ "$(readlink -f -- "$rollback_path")" = "$rollback_path" ] ||
    die 'rollback plaintext presente ficou irregular ou não canônico'
  [ "$(stat -c '%a:%u:%g' "$rollback_path" 2>/dev/null || true)" = 700:0:0 ] ||
    die 'rollback plaintext presente precisa ser 0700 root:root'
}

validate_legacy_purge_gate() {
  local control="$data_root/.legacy-shared-transition"
  { [ -e "$control" ] || [ -L "$control" ]; } || return 0
  python3 - "$control" 2>/dev/null <<'PY' || die 'controle legado cifrado não prova purge prévio de sources e .env'
import hashlib, json, os, stat, sys

control = sys.argv[1]

def fail():
    raise SystemExit(1)

def stable(left, right):
    return (left.st_dev, left.st_ino, left.st_mode, left.st_size, left.st_mtime_ns) == (
        right.st_dev, right.st_ino, right.st_mode, right.st_size, right.st_mtime_ns,
    )

metadata = os.lstat(control)
if (
    not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
    or stat.S_IMODE(metadata.st_mode) != 0o700 or metadata.st_uid != 0 or metadata.st_gid != 0
    or set(os.listdir(control)) != {'layout.json', 'source-manifest.jsonl'}
):
    fail()

def read_control(name):
    path = os.path.join(control, name)
    before = os.lstat(path)
    if (
        not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode)
        or stat.S_IMODE(before.st_mode) != 0o600 or before.st_uid != 0 or before.st_gid != 0
        or before.st_nlink != 1
    ):
        fail()
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        opened = os.fstat(descriptor)
        if not stable(before, opened):
            fail()
        chunks = []
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            chunks.append(block)
        if not stable(opened, os.fstat(descriptor)):
            fail()
    finally:
        os.close(descriptor)
    if not stable(before, os.lstat(path)):
        fail()
    return b''.join(chunks)

layout = json.loads(read_control('layout.json'))
manifest = read_control('source-manifest.jsonl')
if (
    layout.get('version') != 3 or layout.get('status') != 'purged'
    or layout.get('legacy_env_status') != 'removed'
    or hashlib.sha256(manifest).hexdigest() != layout.get('source_manifest_sha256')
):
    fail()
current_root = layout.get('current_root')
legacy_env = (layout.get('legacy_env_proof') or {}).get('path')
if not isinstance(current_root, str) or legacy_env != os.path.join(current_root, '.env') or os.path.lexists(legacy_env):
    fail()
sources = layout.get('sources') or {}
proofs = layout.get('source_proofs') or {}
if set(sources) != set(proofs) or not {'recordings', 'cache'} <= set(sources):
    fail()
for name, source in sources.items():
    proof = proofs[name]
    if not isinstance(source, str) or os.path.realpath(source) != source:
        fail()
    item = os.lstat(source)
    identity = proof.get('identity') or {}
    if (
        not stat.S_ISDIR(item.st_mode) or stat.S_ISLNK(item.st_mode) or os.listdir(source)
        or item.st_dev != identity.get('dev') or item.st_ino != identity.get('ino')
    ):
        fail()
    if name == 'cache':
        if proof.get('kind') != 'volume' or proof.get('name') != 'kassinao_model-cache':
            fail()
    elif proof.get('kind') != 'bind' or source != os.path.join(current_root, name):
        fail()
PY
}

env -i "PATH=$PATH" HOME=/root "KASSINAO_ENV_FILE=$ENV_FILE" "$VERIFIER" >/dev/null 2>&1 ||
  die 'storage shared LUKS não passou na prova completa'
assert_shared_neighbors
assert_kassinao_stopped

pending_present=false; path_present "$pending_marker" && pending_present=true
purging_present=false; path_present "$purging_marker" && purging_present=true
purged_present=false; path_present "$purged_marker" && purged_present=true
case "$pending_present:$purging_present:$purged_present" in
  true:false:false) lifecycle_state=initial ;;
  true:true:false) lifecycle_state=purging ;;
  true:false:true | true:true:true) lifecycle_state=cleanup ;;
  false:false:true) lifecycle_state=complete ;;
  *) die 'combinação de markers do rollback não é retomável' ;;
esac
if [ "$lifecycle_state" = initial ] || [ "$lifecycle_state" = purging ]; then
  validate_legacy_purge_gate
fi

pending_fields=(); purging_fields=(); purged_fields=()
if [ "$pending_present" = true ]; then load_marker "$pending_marker" pending pending_fields; fi
if [ "$purging_present" = true ]; then load_marker "$purging_marker" purging purging_fields; fi
if [ "$purged_present" = true ]; then load_marker "$purged_marker" purged purged_fields; fi
if [ "$pending_present" = true ]; then
  base_fields=("${pending_fields[@]}")
else
  base_fields=("${purged_fields[@]}")
fi
if [ "$purging_present" = true ]; then
  markers_match base_fields purging_fields || die 'marker purging diverge da transição pending'
fi
if [ "$purged_present" = true ]; then
  markers_match base_fields purged_fields || die 'marker purged diverge da transição validada'
fi
if [ "$purging_present" = true ] && [ "$purged_present" = true ]; then
  [ "${purged_fields[4]}" -ge "${purging_fields[4]}" ] || die 'ordem temporal dos markers é inválida'
fi
migration_id="${base_fields[0]}"
marker_manifest_sha="${base_fields[1]}"
created_at="${base_fields[2]}"
deadline="${base_fields[3]}"

[ -f "$persisted_manifest" ] && [ ! -L "$persisted_manifest" ] &&
  [ "$(readlink -f -- "$persisted_manifest")" = "$persisted_manifest" ] ||
  die 'manifesto persistido ausente ou irregular'
[ "$(stat -c '%a:%u:%g:%h' "$persisted_manifest" 2>/dev/null || true)" = 400:0:0:1 ] ||
  die 'manifesto persistido precisa ser 0400 root:root sem hardlink'
actual_manifest_sha="$(python3 - "$persisted_manifest" 2>/dev/null <<'PY'
import hashlib, sys
with open(sys.argv[1], 'rb') as source:
    print(hashlib.sha256(source.read()).hexdigest())
PY
)"
[ "$actual_manifest_sha" = "$marker_manifest_sha" ] || die 'hash do manifesto persistido diverge do marker'

if [ "$lifecycle_state" = complete ]; then
  path_present "$rollback_path" && die 'rollback plaintext reapareceu depois do receipt final'
  finalization_succeeded=true
  printf 'Rollback plaintext já estava finalizado com receipt purged íntegro.\n'
  printf 'Esta operação não comprova secure erase em SSD, snapshots, backups ou storage do provedor.\n'
  exit 0
fi

if [ "$lifecycle_state" = cleanup ]; then
  path_present "$rollback_path" && die 'receipt purged coexistiu com rollback plaintext'
else
  if path_present "$rollback_path"; then
    validate_rollback_root
    assert_no_rollback_mounts
  elif [ "$lifecycle_state" = initial ]; then
    die 'rollback plaintext ausente antes da autorização durável de purge'
  fi
fi

purge_gates_current=false
if [ "$lifecycle_state" = initial ]; then
  tree_manifest "$recomputed_manifest" "$rollback_path" || die 'rollback plaintext reprovou inventário seguro'
  cmp -s "$recomputed_manifest" "$persisted_manifest" || die 'rollback plaintext diverge do manifesto persistido'
  pending_sha_before="$(python3 - "$pending_marker" 2>/dev/null <<'PY'
import hashlib, sys
with open(sys.argv[1], 'rb') as source:
    print(hashlib.sha256(source.read()).hexdigest())
PY
)"

  # Revalida writers, storage, bytes e marker antes de tornar o purge autorizado e retomável.
  assert_shared_neighbors
  assert_kassinao_stopped
  env -i "PATH=$PATH" HOME=/root "KASSINAO_ENV_FILE=$ENV_FILE" "$VERIFIER" >/dev/null 2>&1 ||
    die 'storage shared mudou antes da finalização'
  purge_gates_current=true
  assert_no_rollback_mounts
  rm -f -- "$recomputed_manifest"
  tree_manifest "$recomputed_manifest" "$rollback_path" || die 'rollback plaintext mudou antes da finalização'
  cmp -s "$recomputed_manifest" "$persisted_manifest" || die 'rollback plaintext mudou antes da finalização'
  pending_sha_final="$(python3 - "$pending_marker" 2>/dev/null <<'PY'
import hashlib, sys
with open(sys.argv[1], 'rb') as source:
    print(hashlib.sha256(source.read()).hexdigest())
PY
)"
  [ "$pending_sha_final" = "$pending_sha_before" ] || die 'marker pending mudou antes da finalização'
  ! path_present "$purging_marker" && ! path_present "$purged_marker" && ! path_present "$purging_tmp" ||
    die 'estado de marker mudou antes da autorização durável'

  purge_started_at="$(python3 - <<'PY'
import time
print(int(time.time()))
PY
)"
  [[ "$purge_started_at" =~ ^[1-9][0-9]*$ ]] && [ "$purge_started_at" -ge "$created_at" ] ||
    die 'epoch de início do purge inválido'
  (
    set -o noclobber
    printf '%s\n' \
      'kassinao-shared-plaintext-rollback-v1' \
      'status=purging' \
      "migration_id=$migration_id" \
      "manifest_sha256=$marker_manifest_sha" \
      "rollback_path=$rollback_path" \
      "created_at=$created_at" \
      "deadline=$deadline" \
      "purge_started_at=$purge_started_at" > "$purging_tmp"
  ) 2>/dev/null || die 'não foi possível criar marker purging sem sobrescrever estado'
  chown root:root "$purging_tmp" 2>/dev/null || die 'não foi possível proteger o marker purging temporário'
  chmod 0400 "$purging_tmp" 2>/dev/null || die 'não foi possível proteger o marker purging temporário'
  sync -f "$purging_tmp" 2>/dev/null || die 'não foi possível tornar o marker purging temporário durável'
  mv -- "$purging_tmp" "$purging_marker" 2>/dev/null || die 'não foi possível publicar o marker purging'
  sync -f "$data_root" 2>/dev/null || die 'não foi possível tornar a autorização de purge durável'
  purging_fields=()
  load_marker "$purging_marker" purging purging_fields
  markers_match base_fields purging_fields || die 'marker purging publicado diverge da transição pending'
  lifecycle_state=purging
fi

if [ "$lifecycle_state" = purging ]; then
  # Toda retomada ainda revalida storage, vizinhos, containers, markers e mounts.
  if [ "$purge_gates_current" = false ]; then
    assert_shared_neighbors
    assert_kassinao_stopped
    env -i "PATH=$PATH" HOME=/root "KASSINAO_ENV_FILE=$ENV_FILE" "$VERIFIER" >/dev/null 2>&1 ||
      die 'storage shared mudou antes da retomada do purge'
  fi
  pending_fields_final=(); purging_fields_final=()
  load_marker "$pending_marker" pending pending_fields_final
  load_marker "$purging_marker" purging purging_fields_final
  markers_match base_fields pending_fields_final && markers_match base_fields purging_fields_final ||
    die 'markers mudaram antes da retomada do purge'
  ! path_present "$purged_marker" || die 'receipt purged apareceu antes da publicação controlada'
  if path_present "$rollback_path"; then
    validate_rollback_root
    assert_no_rollback_mounts
    rm -rf --one-file-system -- "$rollback_path" 2>/dev/null || die 'GNU rm não concluiu a remoção lógica do rollback'
    ! path_present "$rollback_path" || die 'rollback plaintext permaneceu após GNU rm'
  fi
  sync -f "$data_parent" 2>/dev/null || die 'não foi possível tornar a remoção lógica durável'

  purged_at="$(python3 - <<'PY'
import time
print(int(time.time()))
PY
)"
  [[ "$purged_at" =~ ^[1-9][0-9]*$ ]] && [ "$purged_at" -ge "${purging_fields_final[4]}" ] ||
    die 'epoch de finalização inválido'
  ! path_present "$purged_marker" && ! path_present "$purged_tmp" || die 'estado purged mudou antes da publicação'
  (
    set -o noclobber
    printf '%s\n' \
      'kassinao-shared-plaintext-rollback-v1' \
      'status=purged' \
      "migration_id=$migration_id" \
      "manifest_sha256=$marker_manifest_sha" \
      "rollback_path=$rollback_path" \
      "created_at=$created_at" \
      "deadline=$deadline" \
      "purged_at=$purged_at" > "$purged_tmp"
  ) 2>/dev/null || die 'não foi possível criar marker purged sem sobrescrever estado'
  chown root:root "$purged_tmp" 2>/dev/null || die 'não foi possível proteger o marker purged temporário'
  chmod 0400 "$purged_tmp" 2>/dev/null || die 'não foi possível proteger o marker purged temporário'
  sync -f "$purged_tmp" 2>/dev/null || die 'não foi possível tornar o marker purged temporário durável'
  mv -- "$purged_tmp" "$purged_marker" 2>/dev/null || die 'não foi possível publicar o marker purged'
  sync -f "$data_root" 2>/dev/null || die 'não foi possível tornar o marker purged durável'
  purged_fields=()
  load_marker "$purged_marker" purged purged_fields
  markers_match base_fields purged_fields && [ "${purged_fields[4]}" -ge "${purging_fields_final[4]}" ] ||
    die 'marker purged publicado diverge da transição validada'
fi

# O receipt já é durável; retirar purging e pending é uma limpeza retomável e ordenada.
if path_present "$purging_marker"; then
  rm -f -- "$purging_marker" 2>/dev/null || die 'não foi possível retirar o marker purging antigo'
  ! path_present "$purging_marker" || die 'marker purging permaneceu após publicação purged'
  sync -f "$data_root" 2>/dev/null || die 'não foi possível tornar a limpeza do marker purging durável'
fi
if path_present "$pending_marker"; then
  rm -f -- "$pending_marker" 2>/dev/null || die 'não foi possível retirar o marker pending antigo'
  ! path_present "$pending_marker" || die 'marker pending permaneceu após publicação purged'
  sync -f "$data_root" 2>/dev/null || die 'não foi possível tornar a transição final de markers durável'
fi
final_fields=()
load_marker "$purged_marker" purged final_fields
markers_match base_fields final_fields || die 'marker purged final diverge da transição validada'
! path_present "$rollback_path" && ! path_present "$pending_marker" && ! path_present "$purging_marker" ||
  die 'estado final do rollback plaintext ficou incompleto'

finalization_succeeded=true
printf 'Rollback plaintext removido logicamente e marker purged publicado.\n'
printf 'Esta operação não comprova secure erase em SSD, snapshots, backups ou storage do provedor.\n'
