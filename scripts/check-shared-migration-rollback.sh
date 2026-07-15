#!/bin/bash -p
# Prova read-only do ciclo de vida do rollback plaintext criado pela migração
# shared. Nunca remove, renomeia ou corrige estado; qualquer combinação parcial
# falha sem revelar caminhos, IDs ou hashes privados.
set -Eeuo pipefail
umask 077

env_file_override_set=false
env_file_override=''
if [ "${KASSINAO_ENV_FILE+x}" = x ]; then
  env_file_override_set=true
  env_file_override="$KASSINAO_ENV_FILE"
fi
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# KASSINAO_HOST_ENV_SCRUB_BEGIN
[ -r "/proc/$$/environ" ] || { printf 'ERRO: estado do rollback plaintext inválido ou expirado\n' >&2; exit 1; }
while IFS='=' read -r -d '' inherited_name inherited_value; do unset "$inherited_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset inherited_name inherited_value
export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C
if [ "$env_file_override_set" = true ]; then export KASSINAO_ENV_FILE="$env_file_override"; fi
# KASSINAO_HOST_ENV_SCRUB_END

fail() {
  printf 'ERRO: estado do rollback plaintext inválido ou expirado\n' >&2
  exit 1
}

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) fail ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in
  */scripts)
    PROJECT_DIR="${_script_dir%/scripts}"
    if [ "$env_file_override_set" = false ]; then
      env_file_override="$PROJECT_DIR/.env"
    fi
    ;;
  /usr/local/sbin)
    marker=/etc/kassinao/host-controls.env
    [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(stat -c '%a:%u:%g:%h' "$marker" 2>/dev/null || true)" = 600:0:0:1 ] || fail
    PROJECT_DIR="$(awk -F= '$1 == "KASSINAO_DEPLOY_DIR" { if (seen++) exit 2; print substr($0, index($0,"=")+1) } END { if (seen != 1) exit 2 }' "$marker")" || fail
    _script_path="$PROJECT_DIR/scripts/check-shared-migration-rollback.sh"
    if [ "$env_file_override_set" = false ]; then
      env_file_override=/etc/kassinao/shared.env
    fi
    ;;
  *) fail ;;
esac
if [ "$env_file_override_set" = false ]; then
  env_file_override_set=true
  export KASSINAO_ENV_FILE="$env_file_override"
fi
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) fail ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/check-shared-migration-rollback.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || fail
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[ "$_no_dump_filter" = 0 ] || fail
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$#" -eq 0 ] || fail
[ "$(id -u)" -eq 0 ] || fail
for command in awk findmnt python3 readlink stat; do
  command -v "$command" >/dev/null 2>&1 || fail
done

[ "$env_file_override_set" = true ] || fail
ENV_FILE="$env_file_override"
case "$ENV_FILE" in /*) ;; *) fail ;; esac
[[ "$ENV_FILE" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail
case "$ENV_FILE" in *//* | */./* | */../* | */. | */.. | */) fail ;; esac
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || fail
[ "$(readlink -f -- "$ENV_FILE" 2>/dev/null || true)" = "$ENV_FILE" ] || fail
[ "$(stat -c '%a:%u:%g:%h' -- "$ENV_FILE" 2>/dev/null || true)" = 600:0:0:1 ] || fail

data_root="$(awk '
  index($0, "KASSINAO_DATA_ROOT=") == 1 {
    count++; value = substr($0, length("KASSINAO_DATA_ROOT=") + 1)
  }
  END { if (count != 1) exit 2; print value }
' "$ENV_FILE")" || fail
[[ "$data_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail
case "$data_root" in / | *//* | */./* | */../* | */. | */.. | */) fail ;; esac
[ -d "$data_root" ] && [ ! -L "$data_root" ] || fail
[ "$(readlink -f -- "$data_root" 2>/dev/null || true)" = "$data_root" ] || fail
[ "$(stat -c '%a:%u:%g' -- "$data_root" 2>/dev/null || true)" = 700:0:0 ] || fail

pending="$data_root/.kassinao-plaintext-rollback.pending"
purging="$data_root/.kassinao-plaintext-rollback.purging"
purged="$data_root/.kassinao-plaintext-rollback.purged"
manifest="$data_root/.kassinao-migration-manifest.jsonl"
rollback="${data_root}.plaintext-before-shared-luks"

path_present() { [ -e "$1" ] || [ -L "$1" ]; }
pending_present=false; path_present "$pending" && pending_present=true
purging_present=false; path_present "$purging" && purging_present=true
purged_present=false; path_present "$purged" && purged_present=true
rollback_present=false; path_present "$rollback" && rollback_present=true
manifest_present=false; path_present "$manifest" && manifest_present=true

if [ "$pending_present" = false ] && [ "$purging_present" = false ] && [ "$purged_present" = false ]; then
  [ "$rollback_present" = false ] || fail
  [ "$manifest_present" = false ] || fail
  printf 'Estado de rollback plaintext aprovado: fresh\n'
  exit 0
fi

case "$pending_present:$purging_present:$purged_present" in
  true:false:false) lifecycle_state=pending ;;
  false:false:true) lifecycle_state=purged ;;
  true:true:false | true:true:true | true:false:true) lifecycle_state=interrupted ;;
  *) fail ;;
esac

protected_files=("$manifest")
[ "$pending_present" = false ] || protected_files+=("$pending")
[ "$purging_present" = false ] || protected_files+=("$purging")
[ "$purged_present" = false ] || protected_files+=("$purged")
for protected_file in "${protected_files[@]}"; do
  [ -f "$protected_file" ] && [ ! -L "$protected_file" ] || fail
  [ "$(readlink -f -- "$protected_file" 2>/dev/null || true)" = "$protected_file" ] || fail
  [ "$(stat -c '%a:%u:%g:%h' -- "$protected_file" 2>/dev/null || true)" = 400:0:0:1 ] || fail
done

mount_inventory=''
if [ "$lifecycle_state" = pending ]; then [ "$rollback_present" = true ] || fail; fi
if [ "$lifecycle_state" = purged ] || [ "$purged_present" = true ]; then
  [ "$rollback_present" = false ] || fail
fi
if [ "$rollback_present" = true ]; then
  [ -d "$rollback" ] && [ ! -L "$rollback" ] || fail
  [ "$(readlink -f -- "$rollback" 2>/dev/null || true)" = "$rollback" ] || fail
  [ "$(stat -c '%a:%u:%g' -- "$rollback" 2>/dev/null || true)" = 700:0:0 ] || fail
  mount_inventory="$(findmnt --json --output TARGET 2>/dev/null)" || fail
fi

env -i "PATH=$PATH" HOME=/root python3 - \
  "$pending" "$purging" "$purged" "$manifest" "$rollback" "$lifecycle_state" \
  "$pending_present" "$purging_present" "$purged_present" "$rollback_present" \
  3<<<"$mount_inventory" <<'PY' || fail
import hashlib
import json
import os
import re
import sys
import time


def reject():
    raise ValueError


try:
    (pending_path, purging_path, purged_path, manifest_path, expected_rollback, lifecycle_state,
     pending_raw, purging_raw, purged_raw, rollback_raw) = sys.argv[1:]
    present = {
        'pending': pending_raw == 'true',
        'purging': purging_raw == 'true',
        'purged': purged_raw == 'true',
    }
    if any(raw not in ('true', 'false') for raw in (pending_raw, purging_raw, purged_raw, rollback_raw)):
        reject()

    with open(manifest_path, 'rb') as source:
        actual_manifest_hash = hashlib.sha256(source.read()).hexdigest()

    def canonical_epoch(values, name):
        raw_value = values[name]
        if not re.fullmatch(r'[1-9][0-9]*', raw_value):
            reject()
        parsed = int(raw_value)
        if str(parsed) != raw_value:
            reject()
        return parsed

    def parse_marker(marker_path, expected_status):
        with open(marker_path, 'rb') as source:
            raw = source.read()
        if not raw.endswith(b'\n') or b'\r' in raw or b'\0' in raw:
            reject()
        lines = raw[:-1].decode('ascii').split('\n')
        event_key = {'pending': None, 'purging': 'purge_started_at', 'purged': 'purged_at'}[expected_status]
        keys = [
            'status', 'migration_id', 'manifest_sha256', 'rollback_path',
            'created_at', 'deadline',
        ]
        if event_key:
            keys.append(event_key)
        if len(lines) != len(keys) + 1 or lines[0] != 'kassinao-shared-plaintext-rollback-v1':
            reject()
        values = {}
        for line, key in zip(lines[1:], keys):
            prefix = key + '='
            if not line.startswith(prefix) or len(line) == len(prefix):
                reject()
            values[key] = line[len(prefix):]
        if values['status'] != expected_status:
            reject()
        if not re.fullmatch(r'[0-9a-f]{32}', values['migration_id']):
            reject()
        if not re.fullmatch(r'[0-9a-f]{64}', values['manifest_sha256']):
            reject()
        if values['manifest_sha256'] != actual_manifest_hash:
            reject()
        if values['rollback_path'] != expected_rollback:
            reject()
        created_at = canonical_epoch(values, 'created_at')
        deadline = canonical_epoch(values, 'deadline')
        delta = deadline - created_at
        now = int(time.time())
        if created_at > now or delta < 3600 or delta > 168 * 3600 or delta % 3600:
            reject()
        if event_key:
            event = canonical_epoch(values, event_key)
            if event < created_at or event > now:
                reject()
        return values

    paths = {'pending': pending_path, 'purging': purging_path, 'purged': purged_path}
    markers = {status: parse_marker(paths[status], status) for status in paths if present[status]}
    baseline = markers['pending'] if present['pending'] else markers['purged']
    common_keys = ('migration_id', 'manifest_sha256', 'rollback_path', 'created_at', 'deadline')
    for marker in markers.values():
        if any(marker[key] != baseline[key] for key in common_keys):
            reject()
    now = int(time.time())
    if lifecycle_state == 'pending' and now > int(baseline['deadline']):
        reject()
    if present['purging'] and present['purged']:
        if int(markers['purged']['purged_at']) < int(markers['purging']['purge_started_at']):
            reject()

    if rollback_raw == 'true':
        inventory = json.load(os.fdopen(3, encoding='utf-8'))

        def visit(entries):
            for entry in entries or []:
                if not isinstance(entry, dict):
                    reject()
                target = entry.get('target')
                if isinstance(target, str):
                    resolved = os.path.realpath(target)
                    if resolved == expected_rollback or resolved.startswith(expected_rollback + os.sep):
                        reject()
                visit(entry.get('children'))

        if not isinstance(inventory, dict) or not isinstance(inventory.get('filesystems'), list):
            reject()
        visit(inventory['filesystems'])
except Exception:
    raise SystemExit(1)
PY

if [ "$lifecycle_state" = interrupted ]; then
  printf 'ERRO: finalização do rollback plaintext interrompida; execute novamente o finalizador\n' >&2
  exit 1
fi
printf 'Estado de rollback plaintext aprovado: %s\n' "$lifecycle_state"
