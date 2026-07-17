#!/bin/bash -p
# Remove somente controles de host de uma instalação dedicated anterior a
# KASSINAO_HOST_SCOPE. Estado ausente é no-op; estado parcial sempre falha.
set -Eeuo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 2 ] ||
  die 'uso: remove-legacy-dedicated-host-controls.sh CURRENT_ROOT --confirm-remove-exact-legacy-dedicated-host-controls'
CURRENT_ROOT="$1"
[ "$2" = --confirm-remove-exact-legacy-dedicated-host-controls ] || die 'confirmação explícita ausente'

__kassinao_current_root="$CURRENT_ROOT"
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
_forbidden_docker_environment=''
for _name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$_name" >/dev/null 2>&1; then _forbidden_docker_environment="$_name"; break; fi
done
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente da transição legada'
while IFS='=' read -r -d '' inherited_name inherited_value; do unset "$inherited_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset inherited_name inherited_value
SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C
CURRENT_ROOT="$__kassinao_current_root"
unset __kassinao_current_root
[ -z "$_forbidden_docker_environment" ] || die "$_forbidden_docker_environment não pode vir do ambiente"

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho da transição legada não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'transição legada precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/remove-legacy-dedicated-host-controls.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit da transição legada não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter da transição legada não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$(id -u)" -eq 0 ] || die 'execute como root'
for command in awk cmp dirname docker flock grep id ip6tables iptables python3 readlink rm rmdir sed sha256sum sort stat systemctl tr; do
  command -v "$command" >/dev/null 2>&1 || die "$command é obrigatório"
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
[ "$ROOT" = "$PROJECT_DIR" ] || die 'raiz canônica divergiu do kit selado'
MANIFEST="$ROOT/MANIFEST.sha256"

verify_current_bundle() {
  local required=scripts/remove-legacy-dedicated-host-controls.sh count
  [ -d "$ROOT" ] && [ ! -L "$ROOT" ] && [ "$(readlink -f -- "$ROOT")" = "$ROOT" ] ||
    die 'kit operacional ausente ou irregular'
  [ "$(stat -c '%a:%u:%g' "$ROOT" 2>/dev/null || true)" = 700:0:0 ] ||
    die 'kit operacional precisa ser 0700 root:root'
  [ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die 'MANIFEST.sha256 ausente ou irregular'
  count="$(awk -v wanted="$required" '{ path=$2; sub(/^\.\//, "", path); if (path == wanted) count++ } END { print count + 0 }' "$MANIFEST")"
  [ "$count" -eq 1 ] || die "$required precisa aparecer exatamente uma vez no manifesto"
  (cd -- "$ROOT" && sha256sum -c MANIFEST.sha256 --quiet) || die 'kit diverge do MANIFEST.sha256'
}
verify_current_bundle

[[ "$CURRENT_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'CURRENT_ROOT precisa ser caminho absoluto simples'
case "$CURRENT_ROOT" in *//* | */./* | */../* | */. | */.. | */) die 'CURRENT_ROOT precisa ser canônico' ;; esac
[ -d "$CURRENT_ROOT" ] && [ ! -L "$CURRENT_ROOT" ] && [ "$(readlink -f -- "$CURRENT_ROOT")" = "$CURRENT_ROOT" ] ||
  die 'CURRENT_ROOT precisa ser diretório canônico, sem symlink'

SYSTEMD_DIR=/etc/systemd/system
SBIN_DIR=/usr/local/sbin
TMPFILES_DIR=/etc/tmpfiles.d
ETC_KASSINAO=/etc/kassinao
RUNTIME_DIR=/run/lock/kassinao

health_artifacts=(
  "$SBIN_DIR/kassinao-health-watch"
  "$SYSTEMD_DIR/kassinao-health-watch.service"
  "$SYSTEMD_DIR/kassinao-health-watch.timer"
)
legacy_artifacts=(
  "$SBIN_DIR/kassinao-verify-storage-encryption"
  "$SBIN_DIR/kassinao-harden-docker-egress"
  "$SBIN_DIR/kassinao-egress-fail-closed"
  "$SYSTEMD_DIR/kassinao-docker-egress.service"
  "$SYSTEMD_DIR/kassinao-egress-fail-closed.service"
  "$SYSTEMD_DIR/kassinao-rollback-clean.service"
  "$SYSTEMD_DIR/kassinao-rollback-clean.timer"
  "$SYSTEMD_DIR/docker.service.d/kassinao-egress.conf"
  "$TMPFILES_DIR/kassinao.conf"
  "$TMPFILES_DIR/kassinao-rollback.conf"
  "$ETC_KASSINAO/storage-paths"
  "$ETC_KASSINAO/host-controls.env"
)

count_present_paths() {
  local path_name count=0
  for path_name in "$@"; do
    if [ -e "$path_name" ] || [ -L "$path_name" ]; then count=$((count + 1)); fi
  done
  printf '%s' "$count"
}

legacy_present="$(count_present_paths "${legacy_artifacts[@]}")"

systemctl_value() {
  local unit="$1" property="$2" value
  value="$(systemctl show "$unit" -p "$property" --value 2>/dev/null)" ||
    die "systemd não respondeu por $property de $unit"
  printf '%s' "$value"
}

assert_unit_absent() {
  local unit="$1" description="$2" active_state unit_file_state
  [ -z "$(systemctl_value "$unit" FragmentPath)" ] || die "fragmento de $description ainda está carregado"
  [ -z "$(systemctl_value "$unit" DropInPaths)" ] || die "drop-in de $description ainda está carregado"
  active_state="$(systemctl_value "$unit" ActiveState)"
  [ "$active_state" = inactive ] || die "$description ainda possui estado ativo no systemd: $active_state"
  unit_file_state="$(systemctl_value "$unit" UnitFileState)"
  case "$unit_file_state" in '' | disabled | not-found) ;; *) die "$description ainda possui UnitFileState=$unit_file_state" ;; esac
}

DOCKER_CONFIG="$ROOT/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] ||
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] ||
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION

assert_no_kassinao_containers() {
  local id project name docker_ids
  local ids=()
  docker_ids="$(docker ps -aq --no-trunc)" || die 'inventário Docker local falhou'
  while IFS= read -r id; do [ -z "$id" ] || ids+=("$id"); done <<<"$docker_ids"
  for id in "${ids[@]}"; do
    project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$id" 2>/dev/null)" ||
      die "não foi possível inspecionar o projeto Docker de $id"
    name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null)" || die "não foi possível inspecionar o nome Docker de $id"
    name="${name#/}"
    [ "$project" != kassinao ] || die 'container do projeto Kassinão permaneceu após compose down'
    case "$name" in kassinao | kassinao-router | kassinao-public | kassinao-tunnel) die 'container reservado do Kassinão permaneceu após compose down' ;; esac
  done
}

assert_no_legacy_effective_state() {
  local unit docker_dropins docker_pre
  for unit in kassinao-docker-egress.service kassinao-egress-fail-closed.service kassinao-rollback-clean.service kassinao-rollback-clean.timer; do
    assert_unit_absent "$unit" "unit dedicated $unit"
  done
  docker_dropins="$(systemctl_value docker.service DropInPaths)"
  case "$docker_dropins" in *kassinao*) die 'docker.service ainda carrega drop-in do Kassinão' ;; esac
  docker_pre="$(systemctl_value docker.service ExecStartPre)"
  case "$docker_pre" in *kassinao-*) die 'docker.service ainda carrega pre-hook do Kassinão' ;; esac
}

assert_health_watch_absent() {
  local health_unit
  [ "$(count_present_paths "${health_artifacts[@]}")" -eq 0 ] ||
    die 'health-watch legado ainda está instalado; execute primeiro remove-legacy-health-watch.sh'
  for health_unit in kassinao-health-watch.service kassinao-health-watch.timer; do
    assert_unit_absent "$health_unit" 'health-watch legado'
  done
}
assert_health_watch_absent

if [ "$legacy_present" -eq 0 ]; then
  assert_no_legacy_effective_state
  if [ -e "$ETC_KASSINAO" ] || [ -L "$ETC_KASSINAO" ]; then
    [ -d "$ETC_KASSINAO" ] && [ ! -L "$ETC_KASSINAO" ] && [ "$(readlink -f -- "$ETC_KASSINAO")" = "$ETC_KASSINAO" ] &&
      [ "$(stat -c '%a:%u:%g' "$ETC_KASSINAO" 2>/dev/null || true)" = 755:0:0 ] ||
      die '/etc/kassinao residual é irregular'
    shopt -s nullglob dotglob
    no_op_etc_entries=("$ETC_KASSINAO"/*)
    shopt -u nullglob dotglob
    [ "${#no_op_etc_entries[@]}" -eq 0 ] || die '/etc/kassinao contém estado residual desconhecido'
  fi
  if [ -e "$RUNTIME_DIR" ] || [ -L "$RUNTIME_DIR" ]; then
    [ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] && [ "$(readlink -f -- "$RUNTIME_DIR")" = "$RUNTIME_DIR" ] &&
      [ "$(stat -c '%a:%u:%g' "$RUNTIME_DIR" 2>/dev/null || true)" = 700:0:0 ] ||
      die 'runtime Kassinão residual é irregular'
    shopt -s nullglob dotglob
    no_op_runtime_entries=("$RUNTIME_DIR"/*)
    shopt -u nullglob dotglob
    for lock_path in "${no_op_runtime_entries[@]}"; do
      case "${lock_path##*/}" in backup.lock | backup-retention.lock | docker-egress.lock | maintenance.lock) ;; *) die 'runtime Kassinão contém estado residual desconhecido' ;; esac
      [ -f "$lock_path" ] && [ ! -L "$lock_path" ] && [ "$(readlink -f -- "$lock_path")" = "$lock_path" ] &&
        [ "$(stat -c '%a:%u:%g:%h' "$lock_path" 2>/dev/null || true)" = 600:0:0:1 ] ||
        die 'runtime Kassinão contém lock residual inseguro'
    done
  fi
  docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || die 'daemon Docker local indisponível'
  assert_no_kassinao_containers
  for firewall_tool in iptables ip6tables; do
    firewall_rules="$("$firewall_tool" -w 10 -S 2>/dev/null)" || die "não foi possível auditar regras residuais em $firewall_tool"
    ! grep -Fq KASSINAO- <<<"$firewall_rules" || die "policy KASSINAO residual permaneceu em $firewall_tool"
  done
  printf 'Nenhum controle dedicated legado instalado; nenhuma mutação foi realizada.\n'
  exit 0
fi

assert_complete_legacy_set() {
  [ "$(count_present_paths "${legacy_artifacts[@]}")" -eq "${#legacy_artifacts[@]}" ] ||
    die 'conjunto de controles dedicated legados está parcial; remoção automática recusada'
}
assert_complete_legacy_set

assert_exact_file() {
  local path="$1" expected_mode="$2" description="$3" metadata
  [ -f "$path" ] && [ ! -L "$path" ] && [ "$(readlink -f -- "$path")" = "$path" ] ||
    die "$description ausente, irregular ou symlink"
  metadata="$(stat -c '%a:%u:%g:%h' "$path" 2>/dev/null || true)"
  [ "$metadata" = "$expected_mode:0:0:1" ] ||
    die "$description precisa ser $expected_mode root:root sem hardlinks"
}

assert_exact_directory() {
  local path="$1" expected_mode="$2" description="$3"
  [ -d "$path" ] && [ ! -L "$path" ] && [ "$(readlink -f -- "$path")" = "$path" ] ||
    die "$description ausente, irregular ou symlink"
  [ "$(stat -c '%a:%u:%g' "$path" 2>/dev/null || true)" = "$expected_mode:0:0" ] ||
    die "$description precisa ser $expected_mode root:root"
}

ENV_FILE="$ROOT/.env"
env_value() {
  local key="$1" file="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count > 1) exit 2; print value }
  ' "$file" || die "$key aparece mais de uma vez em $file"
}
env_count() {
  local key="$1" file="$2"
  awk -v key="$key" 'index($0, key "=") == 1 { count++ } END { print count + 0 }' "$file"
}

verify_shared_transition_config() {
  local candidate_data_root
  assert_exact_file "$ENV_FILE" 600 '.env shared novo'
  [ "$(env_value KASSINAO_HOST_SCOPE "$ENV_FILE")" = shared ] || die 'novo kit precisa estar configurado com KASSINAO_HOST_SCOPE=shared'
  [ -z "$(env_value KASSINAO_DEDICATED_DOCKER_HOST_ACK "$ENV_FILE")" ] || die 'ACK dedicated precisa ficar vazio na transição shared'
  candidate_data_root="$(env_value KASSINAO_DATA_ROOT "$ENV_FILE")"
  [[ "$candidate_data_root" =~ ^/[A-Za-z0-9._/-]+$ ]] && [ "$candidate_data_root" != / ] || die 'KASSINAO_DATA_ROOT novo é inválido'
  case "$candidate_data_root" in *//* | */./* | */../* | */. | */.. | */) die 'KASSINAO_DATA_ROOT novo precisa ser canônico' ;; esac
  if [ -n "${EXPECTED_DATA_ROOT-}" ] && [ "$candidate_data_root" != "$EXPECTED_DATA_ROOT" ]; then
    die 'KASSINAO_DATA_ROOT novo mudou enquanto a transição aguardava locks'
  fi
  assert_exact_directory "$candidate_data_root" 700 'DATA_ROOT plaintext preparado'
  DATA_ROOT="$candidate_data_root"
  TRANSITION_DIR="$DATA_ROOT/.legacy-shared-transition"
}
verify_shared_transition_config
EXPECTED_DATA_ROOT="$DATA_ROOT"

verify_transition_marker() {
  python3 - "$CURRENT_ROOT" "$DATA_ROOT" "$TRANSITION_DIR" <<'PY'
import hashlib
import json
import os
import stat
import sys

current_root, data_root, transition = sys.argv[1:]

def fail(message):
    print(f'ERRO: {message}', file=sys.stderr)
    raise SystemExit(1)

def exact_file(path, mode):
    metadata = os.lstat(path)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != mode
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or metadata.st_nlink != 1
    ):
        fail('marker de transição possui arquivo inseguro')
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            fail('marker mudou durante abertura')
        chunks = []
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            chunks.append(block)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    current = os.lstat(path)
    stable = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    if any(getattr(metadata, key) != getattr(after, key) for key in stable) or any(
        getattr(metadata, key) != getattr(current, key) for key in stable
    ):
        fail('marker mudou durante leitura')
    return b''.join(chunks), metadata

metadata = os.lstat(transition)
if (
    not stat.S_ISDIR(metadata.st_mode)
    or stat.S_ISLNK(metadata.st_mode)
    or stat.S_IMODE(metadata.st_mode) != 0o700
    or metadata.st_uid != 0
    or metadata.st_gid != 0
):
    fail('diretório do marker precisa ser 0700 root:root')
if sorted(os.listdir(transition)) != ['layout.json', 'source-manifest.jsonl']:
    fail('marker de transição contém entrada inesperada')

layout_raw, _ = exact_file(os.path.join(transition, 'layout.json'), 0o600)
manifest_raw, _ = exact_file(os.path.join(transition, 'source-manifest.jsonl'), 0o600)
try:
    layout = json.loads(layout_raw)
except Exception:
    fail('layout do marker não é JSON válido')
if not isinstance(layout, dict) or set(('version', 'status', 'current_root', 'data_root', 'legacy_env_proof', 'legacy_env_status', 'source_manifest_sha256')) - set(layout):
    fail('layout do marker está incompleto')
if layout.get('version') != 3 or layout.get('status') != 'prepared':
    fail('marker legado não está no estado prepared v3')
if layout.get('current_root') != current_root or layout.get('data_root') != data_root:
    fail('marker legado pertence a outra transição')
if layout.get('legacy_env_status') != 'present':
    fail('marker legado não preserva a .env original')
if hashlib.sha256(manifest_raw).hexdigest() != layout.get('source_manifest_sha256'):
    fail('manifesto privado diverge do marker legado')

legacy_env = os.path.join(current_root, '.env')
env_raw, env_metadata = exact_file(legacy_env, 0o600)
proof = {
    'path': legacy_env,
    'dev': env_metadata.st_dev,
    'ino': env_metadata.st_ino,
    'mode': stat.S_IMODE(env_metadata.st_mode),
    'uid': env_metadata.st_uid,
    'gid': env_metadata.st_gid,
    'nlink': env_metadata.st_nlink,
    'size': env_metadata.st_size,
    'mtime_ns': env_metadata.st_mtime_ns,
    'ctime_ns': env_metadata.st_ctime_ns,
    'sha256': hashlib.sha256(env_raw).hexdigest(),
}
if layout.get('legacy_env_proof') != proof:
    fail('.env legada divergiu da identidade e hash registrados')
PY
}
verify_transition_marker

LEGACY_MANIFEST="$CURRENT_ROOT/MANIFEST.sha256"
LEGACY_ENV="$CURRENT_ROOT/.env"
legacy_script_names=(verify-storage-encryption harden-docker-egress egress-fail-closed)
legacy_unit_names=(
  kassinao-docker-egress.service
  kassinao-egress-fail-closed.service
  kassinao-rollback-clean.service
  kassinao-rollback-clean.timer
)
manifest_requires=(
  scripts/verify-storage-encryption.sh
  scripts/harden-docker-egress.sh
  scripts/egress-fail-closed.sh
  deploy/systemd/kassinao-docker-egress.service
  deploy/systemd/kassinao-egress-fail-closed.service
  deploy/systemd/kassinao-rollback-clean.service.in
  deploy/systemd/kassinao-rollback-clean.timer
  deploy/systemd/docker.service.d/kassinao-egress.conf
  deploy/tmpfiles.d/kassinao.conf
  deploy/tmpfiles.d/kassinao-rollback.conf.in
)

verify_legacy_bundle_and_config() {
  local legacy_root_mode legacy_ack_count candidate_data_root candidate_retention relative count
  [ -d "$CURRENT_ROOT" ] && [ ! -L "$CURRENT_ROOT" ] && [ "$(readlink -f -- "$CURRENT_ROOT")" = "$CURRENT_ROOT" ] ||
    die 'CURRENT_ROOT legado mudou ou deixou de ser canônico'
  assert_exact_file "$LEGACY_MANIFEST" 644 'MANIFEST.sha256 legado'
  legacy_root_mode="$(stat -c '%a:%u:%g' "$CURRENT_ROOT" 2>/dev/null || true)"
  case "$legacy_root_mode" in 700:0:0 | 500:0:0) ;; *) die 'CURRENT_ROOT precisa ser 0700/0500 root:root' ;; esac
  (cd -- "$CURRENT_ROOT" && sha256sum -c MANIFEST.sha256 --quiet) || die 'CURRENT_ROOT diverge do MANIFEST.sha256 legado'
  for relative in "${manifest_requires[@]}"; do
    count="$(awk -v wanted="$relative" '{ path=$2; sub(/^\.\//, "", path); if (path == wanted) count++ } END { print count + 0 }' "$LEGACY_MANIFEST")"
    [ "$count" -eq 1 ] || die "$relative precisa aparecer exatamente uma vez no manifesto legado"
  done

  assert_exact_file "$LEGACY_ENV" 600 '.env legada'
  [ "$(env_count KASSINAO_HOST_SCOPE "$LEGACY_ENV")" -eq 0 ] || die '.env legada não pode declarar KASSINAO_HOST_SCOPE'
  legacy_ack_count="$(env_count KASSINAO_DEDICATED_DOCKER_HOST_ACK "$LEGACY_ENV")"
  [ "$legacy_ack_count" -le 1 ] || die 'ACK dedicated legado está duplicado'
  case "$(env_value KASSINAO_DEDICATED_DOCKER_HOST_ACK "$LEGACY_ENV")" in '' | I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO) ;; *) die 'ACK dedicated legado é inválido' ;; esac
  candidate_data_root="$(env_value KASSINAO_DATA_ROOT "$LEGACY_ENV")"
  [[ "$candidate_data_root" =~ ^/[A-Za-z0-9._/-]+$ ]] && [ "$candidate_data_root" != / ] && [ "$candidate_data_root" != /var ] && [ "$candidate_data_root" != /var/lib ] ||
    die 'KASSINAO_DATA_ROOT legado é inválido'
  case "$candidate_data_root" in *//* | */./* | */../* | */. | */.. | */) die 'KASSINAO_DATA_ROOT legado precisa ser canônico' ;; esac
  if [ -n "${EXPECTED_LEGACY_DATA_ROOT-}" ] && [ "$candidate_data_root" != "$EXPECTED_LEGACY_DATA_ROOT" ]; then
    die 'KASSINAO_DATA_ROOT legado mudou enquanto a transição aguardava locks'
  fi
  assert_exact_directory "$candidate_data_root" 700 'DATA_ROOT legado'
  candidate_retention="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS "$LEGACY_ENV")"
  [[ "$candidate_retention" =~ ^[1-9][0-9]*$ ]] && [ "$candidate_retention" -le 168 ] || die 'retenção legada precisa ficar em 1..168h'
  if [ -n "${EXPECTED_RETENTION_HOURS-}" ] && [ "$candidate_retention" != "$EXPECTED_RETENTION_HOURS" ]; then
    die 'retenção legada mudou enquanto a transição aguardava locks'
  fi
  LEGACY_DATA_ROOT="$candidate_data_root"
  retention_hours="$candidate_retention"
  cleanup_age="$((retention_hours * 60 - 31))min"
}
verify_legacy_bundle_and_config
EXPECTED_LEGACY_DATA_ROOT="$LEGACY_DATA_ROOT"
EXPECTED_RETENTION_HOURS="$retention_hours"

verify_legacy_artifacts() {
  local name source destination unit expected_fragment docker_dropins docker_pre loaded_dropin kassinao_dropin_count
  for name in "${legacy_script_names[@]}"; do
    source="$CURRENT_ROOT/scripts/$name.sh"
    destination="$SBIN_DIR/kassinao-$name"
    assert_exact_file "$source" 755 'script na release legada'
    assert_exact_file "$destination" 755 'script dedicated instalado'
    cmp -s -- "$source" "$destination" || die "script dedicated instalado divergiu: $destination"
  done

  for unit in kassinao-docker-egress.service kassinao-egress-fail-closed.service kassinao-rollback-clean.timer; do
    source="$CURRENT_ROOT/deploy/systemd/$unit"
    destination="$SYSTEMD_DIR/$unit"
    assert_exact_file "$source" 644 'unit na release legada'
    assert_exact_file "$destination" 644 'unit dedicated instalada'
    cmp -s -- "$source" "$destination" || die "unit dedicated instalada divergiu: $unit"
  done
  source="$CURRENT_ROOT/deploy/systemd/kassinao-rollback-clean.service.in"
  destination="$SYSTEMD_DIR/kassinao-rollback-clean.service"
  assert_exact_file "$source" 644 'template de rollback legado'
  assert_exact_file "$destination" 644 'unit de rollback instalada'
  cmp -s -- "$destination" <(sed \
    -e "s|@ROLLBACK_DIR@|$LEGACY_DATA_ROOT/rollback|g" \
    -e "s|@RETENTION_HOURS@|$retention_hours|g" \
    -e "s|@CLEANUP_AGE@|$cleanup_age|g" "$source") || die 'unit de rollback instalada divergiu'

  source="$CURRENT_ROOT/deploy/systemd/docker.service.d/kassinao-egress.conf"
  destination="$SYSTEMD_DIR/docker.service.d/kassinao-egress.conf"
  assert_exact_file "$source" 644 'drop-in Docker na release legada'
  assert_exact_file "$destination" 644 'drop-in Docker dedicated instalado'
  cmp -s -- "$source" "$destination" || die 'drop-in Docker dedicated divergiu'

  source="$CURRENT_ROOT/deploy/tmpfiles.d/kassinao.conf"
  destination="$TMPFILES_DIR/kassinao.conf"
  assert_exact_file "$source" 644 'tmpfiles na release legada'
  assert_exact_file "$destination" 644 'tmpfiles dedicated instalado'
  cmp -s -- "$source" "$destination" || die 'tmpfiles dedicated divergiu'
  source="$CURRENT_ROOT/deploy/tmpfiles.d/kassinao-rollback.conf.in"
  destination="$TMPFILES_DIR/kassinao-rollback.conf"
  assert_exact_file "$source" 644 'template tmpfiles rollback legado'
  assert_exact_file "$destination" 644 'tmpfiles rollback instalado'
  cmp -s -- "$destination" <(sed \
    -e "s|@ROLLBACK_DIR@|$LEGACY_DATA_ROOT/rollback|g" \
    -e "s|@CLEANUP_AGE@|$cleanup_age|g" "$source") || die 'tmpfiles rollback instalado divergiu'

  assert_exact_file "$ETC_KASSINAO/storage-paths" 600 'allowlist de storage dedicated'
  cmp -s -- "$ETC_KASSINAO/storage-paths" <(
    for key in KASSINAO_DATA_ROOT KASSINAO_RECORDINGS_DIR KASSINAO_STATE_DIR KASSINAO_AUTH_DIR KASSINAO_MODEL_CACHE_DIR; do
      env_value "$key" "$LEGACY_ENV"
    done
  ) || die 'allowlist de storage dedicated divergiu'
  assert_exact_file "$ETC_KASSINAO/host-controls.env" 600 'marker dedicated legado'
  cmp -s -- "$ETC_KASSINAO/host-controls.env" <(printf \
    'KASSINAO_DATA_ROOT=%s\nKASSINAO_ROLLBACK_RETENTION_HOURS=%s\n' "$LEGACY_DATA_ROOT" "$retention_hours") ||
    die 'marker dedicated legado divergiu do formato v1.4.9'

  for unit in "${legacy_unit_names[@]}"; do
    expected_fragment="$SYSTEMD_DIR/$unit"
    [ "$(systemctl_value "$unit" FragmentPath)" = "$expected_fragment" ] ||
      die "unit effective não usa o fragmento dedicated exato: $unit"
    [ -z "$(systemctl_value "$unit" DropInPaths)" ] ||
      die "unit dedicated possui drop-in inesperado: $unit"
    [ ! -e "$expected_fragment.d" ] && [ ! -L "$expected_fragment.d" ] || die "unit dedicated possui diretório de drop-in: $unit"
  done
  docker_dropins="$(systemctl_value docker.service DropInPaths)"
  kassinao_dropin_count=0
  for loaded_dropin in $docker_dropins; do
    case "$loaded_dropin" in
      *kassinao*)
        [ "$loaded_dropin" = "$SYSTEMD_DIR/docker.service.d/kassinao-egress.conf" ] ||
          die "docker.service carrega drop-in Kassinão alheio: $loaded_dropin"
        kassinao_dropin_count=$((kassinao_dropin_count + 1))
        ;;
    esac
  done
  [ "$kassinao_dropin_count" -eq 1 ] || die 'drop-in dedicated exato não está efetivo uma única vez no docker.service'
  docker_pre="$(systemctl_value docker.service ExecStartPre)"
  python3 - "$docker_pre" "$SBIN_DIR/kassinao-harden-docker-egress" "$SBIN_DIR/kassinao-verify-storage-encryption" <<'PY' ||
import sys

value, hardener, verifier = sys.argv[1:]
required = [
    f'path={hardener} ;',
    f'argv[]={hardener} --offline-preload ;',
    f'path={verifier} ;',
]
if any(value.count(item) != 1 for item in required):
    raise SystemExit(1)
for item in required + [f'argv[]={verifier} ;']:
    value = value.replace(item, '')
if 'kassinao-' in value:
    raise SystemExit(1)
PY
    die 'pre-hooks dedicated não são o conjunto Kassinão exato no docker.service'
}

verify_legacy_host_directories() {
  local lock_path
  local etc_entries=() runtime_entries=()
  assert_exact_directory "$ETC_KASSINAO" 755 'diretório /etc/kassinao legado'
  shopt -s nullglob dotglob
  etc_entries=("$ETC_KASSINAO"/*)
  shopt -u nullglob dotglob
  [ "${#etc_entries[@]}" -eq 2 ] || die '/etc/kassinao contém entrada fora do conjunto v1.4.9'
  assert_exact_directory "$RUNTIME_DIR" 700 'diretório de locks legado'
  assert_exact_file "$RUNTIME_DIR/maintenance.lock" 600 'maintenance.lock legado'
  shopt -s nullglob dotglob
  runtime_entries=("$RUNTIME_DIR"/*)
  shopt -u nullglob dotglob
  for lock_path in "${runtime_entries[@]}"; do
    case "${lock_path##*/}" in backup.lock | docker-egress.lock | maintenance.lock) ;; *) die 'runtime legado contém entrada desconhecida' ;; esac
    assert_exact_file "$lock_path" 600 'lock legado'
  done
}
verify_legacy_host_directories
assert_rollback_empty() {
  local rollback_entries=()
  shopt -s nullglob dotglob
  rollback_entries=("$LEGACY_DATA_ROOT/rollback"/*)
  shopt -u nullglob dotglob
  [ "${#rollback_entries[@]}" -eq 0 ] || die 'rollback legado ainda contém snapshot; retenção não será removida'
}
assert_rollback_empty

snapshot_proof_identities() {
  local path_name relative metadata
  local proof_paths=(
    "$ROOT"
    "$MANIFEST"
    "$ENV_FILE"
    "$DATA_ROOT"
    "$TRANSITION_DIR"
    "$TRANSITION_DIR/layout.json"
    "$TRANSITION_DIR/source-manifest.jsonl"
    "$CURRENT_ROOT"
    "$LEGACY_MANIFEST"
    "$LEGACY_ENV"
    "$CURRENT_ROOT/.deploy.lock"
    "$LEGACY_DATA_ROOT"
    "$LEGACY_DATA_ROOT/rollback"
    "$ETC_KASSINAO"
    "$RUNTIME_DIR"
    "${legacy_artifacts[@]}"
  )
  for relative in "${manifest_requires[@]}"; do proof_paths+=("$CURRENT_ROOT/$relative"); done
  for path_name in "${proof_paths[@]}"; do
    [ -e "$path_name" ] || [ -L "$path_name" ] || die "prova de identidade perdeu path obrigatório: $path_name"
    metadata="$(stat -c '%d:%i:%f:%u:%g:%h:%s:%Y:%Z' "$path_name" 2>/dev/null)" ||
      die "não foi possível capturar identidade de $path_name"
    printf 'present\t%s\t%s\n' "$path_name" "$metadata"
  done
  for path_name in "$RUNTIME_DIR/backup.lock" "$RUNTIME_DIR/docker-egress.lock"; do
    if [ -e "$path_name" ] || [ -L "$path_name" ]; then
      metadata="$(stat -c '%d:%i:%f:%u:%g:%h:%s:%Y:%Z' "$path_name" 2>/dev/null)" ||
        die "não foi possível capturar identidade de $path_name"
      printf 'present\t%s\t%s\n' "$path_name" "$metadata"
    else
      printf 'absent\t%s\n' "$path_name"
    fi
  done
}

verify_legacy_artifacts
proof_identity_before="$(snapshot_proof_identities)"
docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || die 'daemon Docker local indisponível'

snapshot_neighbors() {
  local id project docker_ids details
  local lines=()
  local ids=()
  docker_ids="$(docker ps -aq --no-trunc)" || die 'inventário Docker local falhou'
  while IFS= read -r id; do [ -z "$id" ] || ids+=("$id"); done <<<"$docker_ids"
  for id in "${ids[@]}"; do
    project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$id" 2>/dev/null)" ||
      die "não foi possível inspecionar o projeto Docker de $id"
    [ "$project" = kassinao ] && continue
    details="$(docker inspect -f '{{.Id}} {{.State.Running}} {{.State.Restarting}} {{.RestartCount}}' "$id" 2>/dev/null)" ||
      die "não foi possível inspecionar o estado Docker de $id"
    lines+=("$details")
  done
  if [ "${#lines[@]}" -gt 0 ]; then printf '%s\n' "${lines[@]}" | sort; fi
}

# Capture a referência anterior à espera. Qualquer mudança de daemon ou
# workload vizinho enquanto os locks são disputados cancela a transição.
assert_no_kassinao_containers
[ "$(systemctl_value docker.service ActiveState)" = active ] || die 'docker.service precisa estar ativo'
docker_main_pid_before="$(systemctl_value docker.service MainPID)"
[[ "$docker_main_pid_before" =~ ^[1-9][0-9]*$ ]] || die 'MainPID do docker.service é inválido'
neighbors_before="$(snapshot_neighbors)"
env -i "PATH=$PATH" HOME=/root "$SBIN_DIR/kassinao-harden-docker-egress" --check >/dev/null ||
  die 'policy dedicated legada divergiu antes da espera pelos locks'

DEPLOY_LOCK="$CURRENT_ROOT/.deploy.lock"
assert_exact_file "$DEPLOY_LOCK" 600 '.deploy.lock legado'
exec 8<>"$DEPLOY_LOCK"
[ "$(readlink -f -- "/proc/$$/fd/8" 2>/dev/null || true)" = "$DEPLOY_LOCK" ] &&
  [ "$(stat -c '%d:%i' "$DEPLOY_LOCK" 2>/dev/null || true)" = "$(stat -L -c '%d:%i' "/proc/$$/fd/8" 2>/dev/null || true)" ] ||
  die '.deploy.lock mudou durante a abertura'
flock -w 120 8 || die 'outro deploy legado ainda usa a instância'

exec 9<>"$RUNTIME_DIR/maintenance.lock"
[ "$(readlink -f -- "/proc/$$/fd/9" 2>/dev/null || true)" = "$RUNTIME_DIR/maintenance.lock" ] &&
  [ "$(stat -c '%d:%i' "$RUNTIME_DIR/maintenance.lock" 2>/dev/null || true)" = "$(stat -L -c '%d:%i' "/proc/$$/fd/9" 2>/dev/null || true)" ] ||
  die 'maintenance.lock mudou durante a abertura'
flock -w 120 9 || die 'deploy, backup ou manutenção ainda usa a instância'

assert_held_lock_identity() {
  [ "$(readlink -f -- "/proc/$$/fd/8" 2>/dev/null || true)" = "$DEPLOY_LOCK" ] &&
    [ "$(stat -c '%d:%i' "$DEPLOY_LOCK" 2>/dev/null || true)" = "$(stat -L -c '%d:%i' "/proc/$$/fd/8" 2>/dev/null || true)" ] ||
    die '.deploy.lock mudou depois da aquisição'
  [ "$(readlink -f -- "/proc/$$/fd/9" 2>/dev/null || true)" = "$RUNTIME_DIR/maintenance.lock" ] &&
    [ "$(stat -c '%d:%i' "$RUNTIME_DIR/maintenance.lock" 2>/dev/null || true)" = "$(stat -L -c '%d:%i' "/proc/$$/fd/9" 2>/dev/null || true)" ] ||
    die 'maintenance.lock mudou depois da aquisição'
}

verify_locked_pre_mutation_state() {
  local current_pid current_neighbors
  verify_current_bundle
  verify_shared_transition_config
  verify_transition_marker
  verify_legacy_bundle_and_config
  assert_health_watch_absent
  assert_complete_legacy_set
  verify_legacy_host_directories
  assert_rollback_empty
  verify_legacy_artifacts
  assert_held_lock_identity
  [ "$(snapshot_proof_identities)" = "$proof_identity_before" ] ||
    die 'identidade dos artefatos mudou enquanto a transição aguardava os locks'
  assert_no_kassinao_containers
  [ "$(systemctl_value docker.service ActiveState)" = active ] || die 'docker.service precisa estar ativo'
  current_pid="$(systemctl_value docker.service MainPID)"
  [ "$current_pid" = "$docker_main_pid_before" ] || die 'MainPID do docker.service mudou enquanto aguardava os locks'
  current_neighbors="$(snapshot_neighbors)"
  [ "$current_neighbors" = "$neighbors_before" ] || die 'workload vizinho mudou enquanto a transição aguardava os locks'
  env -i "PATH=$PATH" HOME=/root "$SBIN_DIR/kassinao-harden-docker-egress" --check >/dev/null ||
    die 'policy dedicated legada divergiu antes da remoção'
}

# A partir daqui começam as mutações. Todos os arquivos, o marker, o runtime,
# os containers ausentes, os vizinhos e a policy já foram provados juntos.
verify_locked_pre_mutation_state
systemctl disable --now kassinao-docker-egress.service kassinao-rollback-clean.timer >/dev/null
systemctl stop kassinao-egress-fail-closed.service kassinao-rollback-clean.service >/dev/null
for unit in kassinao-docker-egress.service kassinao-egress-fail-closed.service kassinao-rollback-clean.service kassinao-rollback-clean.timer; do
  [ "$(systemctl_value "$unit" ActiveState)" = inactive ] || die "$unit continuou ativo"
done

verify_legacy_artifacts
assert_rollback_empty
assert_no_kassinao_containers
[ "$(systemctl_value docker.service MainPID)" = "$docker_main_pid_before" ] ||
  die 'docker.service reiniciou durante o stop dos controles dedicated'
[ "$(snapshot_neighbors)" = "$neighbors_before" ] || die 'workload vizinho mudou antes da remoção da policy dedicated'
env -i "PATH=$PATH" HOME=/root "$SBIN_DIR/kassinao-harden-docker-egress" --remove >/dev/null
verify_legacy_artifacts
assert_rollback_empty
assert_no_kassinao_containers
[ "$(systemctl_value docker.service MainPID)" = "$docker_main_pid_before" ] ||
  die 'docker.service reiniciou durante a remoção da policy dedicated'
[ "$(snapshot_neighbors)" = "$neighbors_before" ] || die 'workload vizinho mudou durante a remoção da policy dedicated'

# Reabra o boundary de bytes/pathnames imediatamente antes dos unlinks. Os
# locks coordenam deploy e manutenção; esta repetição também recusa qualquer
# substituição ocorrida durante a remoção do firewall.
verify_legacy_artifacts
assert_rollback_empty
for unit in "${legacy_unit_names[@]}"; do rm -- "$SYSTEMD_DIR/$unit"; done
rm -- \
  "$SYSTEMD_DIR/docker.service.d/kassinao-egress.conf" \
  "$TMPFILES_DIR/kassinao.conf" \
  "$TMPFILES_DIR/kassinao-rollback.conf" \
  "$ETC_KASSINAO/storage-paths" \
  "$ETC_KASSINAO/host-controls.env"
for name in "${legacy_script_names[@]}"; do rm -- "$SBIN_DIR/kassinao-$name"; done
rmdir -- "$ETC_KASSINAO" || die '/etc/kassinao ganhou entrada durante a remoção'
systemctl daemon-reload
systemctl reset-failed "${legacy_unit_names[@]}" >/dev/null 2>&1 || true

for path_name in "${legacy_artifacts[@]}"; do
  [ ! -e "$path_name" ] && [ ! -L "$path_name" ] || die "controle dedicated permaneceu após remoção: $path_name"
done
assert_no_legacy_effective_state
[ "$(systemctl_value docker.service NeedDaemonReload)" = no ] || die 'systemd ainda exige daemon-reload'

assert_no_kassinao_containers
docker_main_pid_after="$(systemctl_value docker.service MainPID)"
[ "$docker_main_pid_after" = "$docker_main_pid_before" ] || die 'docker.service reiniciou durante a transição'
[ "$(systemctl_value docker.service ActiveState)" = active ] || die 'docker.service deixou de ficar ativo durante a transição'
[ "$(snapshot_neighbors)" = "$neighbors_before" ] || die 'workload vizinho mudou durante a transição'
assert_exact_directory "$RUNTIME_DIR" 700 'diretório de locks preservado'
assert_exact_file "$RUNTIME_DIR/maintenance.lock" 600 'maintenance.lock preservado'

printf 'Controles dedicated v1.4.9 exatos removidos; Docker, dados e workloads vizinhos foram preservados.\n'
