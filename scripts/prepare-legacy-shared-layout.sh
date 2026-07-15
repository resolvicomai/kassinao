#!/bin/bash -p
# Consolida mounts de instalações anteriores no layout plaintext exato exigido
# pela migração shared. Originais permanecem como rollback até o purge explícito.
set -Eeuo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

MODE=prepare
CONFIRMATION=''
case "${1:-}" in
  --purge-originals)
    [ "$#" -eq 3 ] || die 'uso: prepare-legacy-shared-layout.sh --purge-originals CURRENT_ROOT --confirm-after-app-and-backup-validation'
    MODE=purge
    CURRENT_ROOT="$2"
    CONFIRMATION="$3"
    [ "$CONFIRMATION" = --confirm-after-app-and-backup-validation ] || die 'confirmação explícita de purge ausente'
    ;;
  *)
    [ "$#" -eq 1 ] || die 'uso: prepare-legacy-shared-layout.sh CURRENT_ROOT'
    CURRENT_ROOT="$1"
    ;;
esac

__kassinao_requested_mode="$MODE"
__kassinao_requested_root="$CURRENT_ROOT"
__kassinao_requested_confirmation="$CONFIRMATION"
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
_forbidden_docker_environment=''
for _name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$_name" >/dev/null 2>&1; then _forbidden_docker_environment="$_name"; break; fi
done

SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
while IFS= read -r inherited_name; do unset "$inherited_name" 2>/dev/null || true; done < <(compgen -e)
export PATH="$SAFE_SYSTEM_PATH" HOME=/root
MODE="$__kassinao_requested_mode"
CURRENT_ROOT="$__kassinao_requested_root"
CONFIRMATION="$__kassinao_requested_confirmation"
unset __kassinao_requested_mode __kassinao_requested_root __kassinao_requested_confirmation
[ -z "$_forbidden_docker_environment" ] || die "$_forbidden_docker_environment não pode vir do ambiente"

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do preparo legado não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'preparo legado precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/prepare-legacy-shared-layout.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do preparo legado não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[ "$_no_dump_filter" = 0 ] || die 'coredump_filter do preparo legado não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$(id -u)" -eq 0 ] || die 'execute como root'
for command in awk dirname docker env findmnt id python3 readlink sha256sum stat; do
  command -v "$command" >/dev/null 2>&1 || die "$command é obrigatório"
done
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
DOCKER_CONFIG="$ROOT/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] ||
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] ||
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG
ENV_FILE="$ROOT/.env"
MANIFEST="$ROOT/MANIFEST.sha256"
LEGACY_VALIDATOR="$ROOT/scripts/validate-legacy-dedicated-installation.sh"
STORAGE_VERIFIER="$ROOT/scripts/verify-shared-luks-storage.sh"

[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die 'kit operacional ausente ou irregular'
[ "$(stat -c '%a:%u:%g' "$ROOT" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'kit operacional precisa ser 0700 root:root'
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die 'MANIFEST.sha256 ausente ou irregular'
for required in scripts/prepare-legacy-shared-layout.sh scripts/validate-legacy-dedicated-installation.sh scripts/verify-shared-luks-storage.sh; do
  count="$(awk -v wanted="$required" '{ path=$2; sub(/^\.\//, "", path); if (path == wanted) count++ } END { print count + 0 }' "$MANIFEST")"
  [ "$count" -eq 1 ] || die "$required precisa aparecer exatamente uma vez no manifesto"
done
(cd -- "$ROOT" && sha256sum -c MANIFEST.sha256 --quiet) || die 'kit diverge do MANIFEST.sha256'
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] && [ "$(stat -c '%a:%u:%g' "$ENV_FILE")" = 600:0:0 ] ||
  die '.env novo precisa ser 0600 root:root'
for control in "$LEGACY_VALIDATOR" "$STORAGE_VERIFIER"; do
  [ -f "$control" ] && [ ! -L "$control" ] && [ -x "$control" ] || die 'controle selado ausente ou irregular'
done

[[ "$CURRENT_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'CURRENT_ROOT precisa ser caminho absoluto simples'
case "$CURRENT_ROOT" in *//* | */./* | */../* | */. | */.. | */) die 'CURRENT_ROOT precisa ser canônico' ;; esac

if [ "$MODE" = prepare ]; then
  env -i "PATH=$PATH" HOME=/root "$LEGACY_VALIDATOR" "$CURRENT_ROOT" >/dev/null ||
    die 'instalação anterior não passou na classificação legacy-dedicated'
fi

env -i "PATH=$PATH" HOME=/root "LD_PRELOAD=${LD_PRELOAD-}" DOCKER_HOST=unix:///var/run/docker.sock "DOCKER_CONFIG=$DOCKER_CONFIG" \
  KASSINAO_ENV_FILE="$ENV_FILE" KASSINAO_LEGACY_CURRENT_ROOT="$CURRENT_ROOT" \
  python3 - "$MODE" "$ROOT" "$ENV_FILE" "$CURRENT_ROOT" "$STORAGE_VERIFIER" <<'PY'
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time

mode, release_root, env_file, current_root, verifier = sys.argv[1:]
transient_state_dir = os.path.join(release_root, '.legacy-shared-transition')

def fail(message):
    print(f'ERRO: {message}', file=sys.stderr)
    raise SystemExit(1)

def env_values(path):
    result = {}
    counts = {}
    with open(path, encoding='utf-8') as handle:
        for raw in handle:
            if '=' not in raw or raw.startswith('#'):
                continue
            key, value = raw.rstrip('\n').split('=', 1)
            counts[key] = counts.get(key, 0) + 1
            result[key] = value
    duplicated = [key for key, count in counts.items() if count != 1]
    if duplicated:
        fail('chave duplicada no .env novo')
    return result

def canonical(raw, name):
    if not re.fullmatch(r'/[A-Za-z0-9._/-]+', raw or ''):
        fail(f'{name} precisa ser caminho absoluto simples')
    if '//' in raw or '/./' in raw or '/../' in raw or raw.endswith(('/.', '/..', '/')):
        fail(f'{name} precisa ser canônico')
    if os.path.realpath(raw) != raw:
        fail(f'{name} não pode conter symlink')
    return raw

current_root = canonical(current_root, 'CURRENT_ROOT')
sensitive_roots = {
    '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/media',
    '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp',
    '/usr', '/var', '/var/lib', '/var/lib/docker', '/var/lib/docker/volumes',
}
if current_root in sensitive_roots:
    fail('CURRENT_ROOT não pode ser root ou parent sensível do sistema')
legacy_env_path = os.path.join(current_root, '.env')

def capture_legacy_env_proof(path):
    metadata = os.lstat(path)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or metadata.st_nlink != 1
    ):
        fail('.env legado precisa ser arquivo regular 0600 root:root, sem symlink ou hardlink')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if opened.st_dev != metadata.st_dev or opened.st_ino != metadata.st_ino or opened.st_mode != metadata.st_mode:
            fail('.env legado mudou durante abertura')
        digest = hashlib.sha256()
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            digest.update(block)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    current = os.lstat(path)
    stable_fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    if any(getattr(metadata, field) != getattr(after, field) for field in stable_fields) or any(
        getattr(metadata, field) != getattr(current, field) for field in stable_fields
    ):
        fail('.env legado mudou durante leitura')
    return {
        'path': path,
        'dev': metadata.st_dev,
        'ino': metadata.st_ino,
        'mode': stat.S_IMODE(metadata.st_mode),
        'uid': metadata.st_uid,
        'gid': metadata.st_gid,
        'nlink': metadata.st_nlink,
        'size': metadata.st_size,
        'mtime_ns': metadata.st_mtime_ns,
        'ctime_ns': metadata.st_ctime_ns,
        'sha256': digest.hexdigest(),
    }

def assert_legacy_env_matches(expected):
    if expected.get('path') != legacy_env_path or capture_legacy_env_proof(legacy_env_path) != expected:
        fail('.env legado divergiu da identidade e hash registrados')

def unlink_legacy_env_fd_safe(expected):
    assert_legacy_env_matches(expected)
    parent_fd = os.open(current_root, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    try:
        metadata = os.stat('.env', dir_fd=parent_fd, follow_symlinks=False)
        if metadata.st_dev != expected['dev'] or metadata.st_ino != expected['ino'] or metadata.st_nlink != 1:
            fail('.env legado mudou imediatamente antes do expurgo')
        descriptor = os.open('.env', os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0), dir_fd=parent_fd)
        try:
            opened = os.fstat(descriptor)
            if opened.st_dev != expected['dev'] or opened.st_ino != expected['ino']:
                fail('.env legado mudou imediatamente antes do expurgo')
        finally:
            os.close(descriptor)
        current = os.stat('.env', dir_fd=parent_fd, follow_symlinks=False)
        if current.st_dev != expected['dev'] or current.st_ino != expected['ino'] or current.st_nlink != 1:
            fail('.env legado mudou imediatamente antes do unlink')
        os.unlink('.env', dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)

settings = env_values(env_file)
if settings.get('KASSINAO_HOST_SCOPE') != 'shared' or settings.get('KASSINAO_DEDICATED_DOCKER_HOST_ACK', ''):
    fail('novo kit precisa declarar apenas o adapter shared')
data_root = canonical(settings.get('KASSINAO_DATA_ROOT', ''), 'KASSINAO_DATA_ROOT')
expected_children = {
    'recordings': canonical(settings.get('KASSINAO_RECORDINGS_DIR', ''), 'KASSINAO_RECORDINGS_DIR'),
    'state': canonical(settings.get('KASSINAO_STATE_DIR', ''), 'KASSINAO_STATE_DIR'),
    'auth': canonical(settings.get('KASSINAO_AUTH_DIR', ''), 'KASSINAO_AUTH_DIR'),
    'cache': canonical(settings.get('KASSINAO_MODEL_CACHE_DIR', ''), 'KASSINAO_MODEL_CACHE_DIR'),
}
for name, path in expected_children.items():
    if path != os.path.join(data_root, name):
        fail('layout novo precisa usar recordings/state/auth/cache como filhos exatos')
try:
    run_uid = int(settings['KASSINAO_UID'])
    run_gid = int(settings['KASSINAO_GID'])
except Exception:
    fail('UID/GID do runtime são inválidos')
if not 61000 <= run_uid <= 61183 or not 61000 <= run_gid <= 61183:
    fail('UID/GID shared precisam ficar na faixa privada 61000..61183')

data_parent = os.path.dirname(data_root)
parent_stat = os.lstat(data_parent)
if not stat.S_ISDIR(parent_stat.st_mode) or stat.S_ISLNK(parent_stat.st_mode):
    fail('parent de DATA_ROOT é irregular')
if parent_stat.st_uid != 0 or parent_stat.st_gid != 0 or stat.S_IMODE(parent_stat.st_mode) & 0o022:
    fail('parent de DATA_ROOT precisa ser root-owned e não gravável por terceiros')
staging = data_root + '.legacy-staging'
private_state_dir = os.path.join(data_root, '.legacy-shared-transition')

def docker_inventory():
    subprocess.run(['docker', 'info', '--format', '{{.ServerVersion}}'], check=True, stdout=subprocess.DEVNULL)
    ids = subprocess.run(['docker', 'ps', '-aq', '--no-trunc'], check=True, text=True, capture_output=True).stdout.split()
    if not ids:
        return []
    for value in ids:
        if not re.fullmatch(r'[0-9a-f]{64}', value):
            fail('daemon retornou ID de container inválido')
    projection = (
        '{"Id":{{json .Id}},"Name":{{json .Name}},'
        '"Config":{"Labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},'
        '"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}}}},'
        '"State":{"Running":{{json .State.Running}},"Restarting":{{json .State.Restarting}}},'
        '"HostConfig":{"RestartPolicy":{"Name":{{json .HostConfig.RestartPolicy.Name}}},'
        '"VolumesFrom":{{json .HostConfig.VolumesFrom}}},'
        '"Mounts":[{{range $index, $mount := .Mounts}}{{if $index}},{{end}}'
        '{"Type":{{json $mount.Type}},"Name":{{json $mount.Name}},"Source":{{json $mount.Source}},'
        '"Destination":{{json $mount.Destination}},"RW":{{json $mount.RW}}}{{end}}]}'
    )
    output = subprocess.run(
        ['docker', 'inspect', '--format', projection, *ids], check=True, text=True, capture_output=True,
    ).stdout
    try:
        inventory = [json.loads(line) for line in output.splitlines() if line]
    except json.JSONDecodeError:
        fail('projeção mínima do inventário Docker é inválida')
    if len(inventory) != len(ids) or {item.get('Id') for item in inventory} != set(ids):
        fail('inventário Docker mudou durante a projeção mínima')
    return inventory

def inspect_named_volume(name, expected_mountpoint):
    if name != 'kassinao_model-cache':
        fail('cache legado precisa usar exatamente o volume kassinao_model-cache')
    projection = (
        '{"Name":{{json .Name}},"Driver":{{json .Driver}},"Scope":{{json .Scope}},'
        '"Mountpoint":{{json .Mountpoint}},"Labels":{'
        '"com.docker.compose.project":{{json (index .Labels "com.docker.compose.project")}},'
        '"com.docker.compose.volume":{{json (index .Labels "com.docker.compose.volume")}}}}'
    )
    payload = json.loads(subprocess.run(
        ['docker', 'volume', 'inspect', '--format', projection, name], check=True, text=True, capture_output=True,
    ).stdout)
    if not isinstance(payload, dict):
        fail('inspect do named volume legado é inválido')
    volume = payload
    labels = volume.get('Labels') or {}
    mountpoint = canonical(str(volume.get('Mountpoint') or ''), 'Mountpoint do named volume legado')
    if (
        volume.get('Name') != name
        or mountpoint != expected_mountpoint
        or volume.get('Driver') != 'local'
        or volume.get('Scope') not in (None, 'local')
        or labels.get('com.docker.compose.project') != 'kassinao'
        or labels.get('com.docker.compose.volume') != 'model-cache'
    ):
        fail('identidade do named volume legado diverge do volume Compose esperado')
    return {
        'kind': 'volume',
        'name': name,
        'mountpoint': mountpoint,
        'driver': 'local',
        'scope': volume.get('Scope'),
        'compose_project': 'kassinao',
        'compose_volume': 'model-cache',
    }

def assert_source_identity(path, proof):
    metadata = os.lstat(path)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail('source de mount legado precisa ser diretório regular')
    expected = proof.get('identity') or {}
    if metadata.st_dev != expected.get('dev') or metadata.st_ino != expected.get('ino'):
        fail('identidade filesystem do source legado mudou')
    if proof.get('kind') == 'volume':
        current = inspect_named_volume(proof.get('name'), path)
        for key in ('kind', 'name', 'mountpoint', 'driver', 'scope', 'compose_project', 'compose_volume'):
            if current.get(key) != proof.get(key):
                fail('identidade do named volume legado mudou')

def findmnt_targets():
    payload = json.loads(subprocess.run(
        ['findmnt', '--json', '--output', 'TARGET'], check=True, text=True, capture_output=True,
    ).stdout)
    targets = []
    def collect(items):
        for item in items or []:
            target = item.get('target')
            if isinstance(target, str) and os.path.isabs(target):
                targets.append(os.path.realpath(target))
            collect(item.get('children'))
    collect(payload.get('filesystems'))
    return targets

def assert_no_mounts_below(paths):
    protected = [os.path.realpath(path) for path in paths if os.path.exists(path)]
    for target in findmnt_targets():
        if any(target == root or target.startswith(root + os.sep) for root in protected):
            fail('mount ou nested mount detectado no layout legado')

def same_identity(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino and left.st_mode == right.st_mode

def empty_directory_fd_safe(path):
    before = os.lstat(path)
    if not stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode):
        fail('diretório de expurgo é irregular')
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    root_fd = os.open(path, flags)
    try:
        opened = os.fstat(root_fd)
        if not same_identity(before, opened):
            fail('diretório de expurgo mudou durante abertura')
        root_device = opened.st_dev

        def empty(parent_fd):
            for name in sorted(os.listdir(parent_fd)):
                metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                if stat.S_ISLNK(metadata.st_mode) or metadata.st_dev != root_device:
                    fail('expurgo recusou symlink, mount ou outro filesystem')
                if stat.S_ISDIR(metadata.st_mode):
                    child_fd = os.open(name, flags, dir_fd=parent_fd)
                    try:
                        opened_child = os.fstat(child_fd)
                        if not same_identity(metadata, opened_child) or opened_child.st_dev != root_device:
                            fail('diretório mudou durante expurgo')
                        empty(child_fd)
                    finally:
                        os.close(child_fd)
                    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                    if not same_identity(metadata, current):
                        fail('diretório mudou antes da remoção')
                    os.rmdir(name, dir_fd=parent_fd)
                elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
                    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                    if not same_identity(metadata, current):
                        fail('arquivo mudou antes da remoção')
                    os.unlink(name, dir_fd=parent_fd)
                else:
                    fail('expurgo recusou tipo irregular ou hardlink')

        empty(root_fd)
    finally:
        os.close(root_fd)

def remove_empty_directory(path):
    parent = os.path.dirname(path)
    name = os.path.basename(path)
    parent_fd = os.open(parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    try:
        os.rmdir(name, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)

def kassinao_items(items):
    reserved = {'kassinao': 'kassinao', 'kassinao-public': 'kassinao-public', 'cloudflared': 'kassinao-tunnel'}
    selected = []
    seen = set()
    for item in items:
        labels = (item.get('Config') or {}).get('Labels') or {}
        project = labels.get('com.docker.compose.project')
        service = labels.get('com.docker.compose.service')
        name = str(item.get('Name') or '').lstrip('/')
        if project != 'kassinao' and name not in reserved.values():
            continue
        if project != 'kassinao' or service not in reserved or reserved[service] != name or service in seen:
            fail('identidade de container Kassinão diverge')
        seen.add(service)
        selected.append((service, item))
    return selected

def assert_stopped(items, require_no_restart):
    selected = kassinao_items(items)
    if not any(service == 'kassinao' for service, _ in selected):
        fail('container core não foi encontrado para provar o lifecycle')
    for _, item in selected:
        state = item.get('State') or {}
        if state.get('Running') is not False or state.get('Restarting') is True:
            fail('todos os containers Kassinão precisam estar parados')
        if require_no_restart:
            restart = str((((item.get('HostConfig') or {}).get('RestartPolicy') or {}).get('Name') or 'no')).lower()
            if restart not in ('no', 'none'):
                fail('purge exige restart=no em todos os containers Kassinão')
    return selected

def assert_sources_isolated(items, sources):
    selected = kassinao_items(items)
    selected_objects = {id(item) for _, item in selected}
    managed_names = {str(item.get('Name') or '').lstrip('/') for _, item in selected}
    managed_ids = {str(item.get('Id') or '') for _, item in selected}
    protected = [os.path.realpath(value) for value in sources.values()]

    def overlaps(raw):
        value = str(raw or '')
        if not os.path.isabs(value):
            return False
        candidate = os.path.realpath(os.path.normpath(value))
        for source in protected:
            try:
                common = os.path.commonpath([candidate, source])
            except ValueError:
                continue
            if common == candidate or common == source:
                return True
        return False

    def references_managed(raw):
        reference = str(raw or '').split(':', 1)[0].lstrip('/')
        if reference in managed_names or reference in managed_ids:
            return True
        return len(reference) >= 12 and any(value.startswith(reference) for value in managed_ids)

    for item in items:
        if id(item) in selected_objects:
            continue
        host = item.get('HostConfig') or {}
        if any(references_managed(value) for value in host.get('VolumesFrom') or []):
            fail('workload vizinho usa volumes-from de container Kassinão')
        candidates = [mount.get('Source') for mount in item.get('Mounts') or []]
        if any(overlaps(value) for value in candidates):
            fail('workload vizinho possui mount sobre source legado protegido')

COLOCATED_FILE_TARGETS = {
    'guildconfig.json': ('state', 'guildconfig.json'),
    'autorecord.json': ('state', 'autorecord.json'),
    '.recording-admission.json': ('state', 'recording-admission.json'),
    '.discord-surface-inventory.json': ('state', 'discord-surface-inventory.json'),
    '.cookie-secret': ('auth', '.cookie-secret'),
    '.web-sessions.json': ('auth', 'web-sessions.json'),
    '.mcp-sessions.json': ('auth', 'mcp-sessions.json'),
}

def derive_colocated_files(mapping):
    recordings_source = mapping.get('recordings')
    if recordings_source is None:
        fail('layout legado não possui recordings para classificar estado co-located')
    result = {}
    for entry in os.scandir(recordings_source):
        metadata = entry.stat(follow_symlinks=False)
        if stat.S_ISDIR(metadata.st_mode):
            continue
        target = COLOCATED_FILE_TARGETS.get(entry.name)
        if (
            target is None or not stat.S_ISREG(metadata.st_mode)
            or stat.S_ISLNK(metadata.st_mode) or metadata.st_nlink != 1
        ):
            fail('recordings legado contém arquivo root desconhecido, link ou tipo especial')
        target_tree, target_name = target
        if target_tree in mapping:
            fail(f'estado co-located em recordings conflita com mount legado de {target_tree}')
        result[entry.name] = {'tree': target_tree, 'name': target_name}
    return result

def regular_tree_manifest(mapping, absent_metadata=None, exclude_private_control=False, colocated_files=None):
    absent_metadata = absent_metadata or {}
    colocated_files = colocated_files or {}
    lines = []
    active = 0

    def visit(path, relative, device):
        nonlocal active
        metadata = os.lstat(path)
        if metadata.st_dev != device:
            fail('nested mount detectado no layout legado')
        if stat.S_ISLNK(metadata.st_mode):
            fail('symlink proibido no layout legado')
        manifest_relative = relative
        if relative.startswith('recordings/') and relative.count('/') == 1:
            source_name = relative.split('/', 1)[1]
            target = colocated_files.get(source_name)
            if target is not None:
                manifest_relative = f"{target['tree']}/{target['name']}"
        record = {'path': manifest_relative, 'mode': stat.S_IMODE(metadata.st_mode), 'uid': metadata.st_uid, 'gid': metadata.st_gid}
        if stat.S_ISDIR(metadata.st_mode):
            record['type'] = 'directory'
            lines.append(json.dumps(record, sort_keys=True, separators=(',', ':')))
            for name in sorted(os.listdir(path)):
                if exclude_private_control and relative == 'state' and name == '.legacy-shared-transition':
                    continue
                visit(os.path.join(path, name), f'{relative}/{name}', device)
            return
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            fail('tipo irregular ou hardlink proibido no layout legado')
        digest = hashlib.sha256()
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(descriptor, 'rb') as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b''):
                digest.update(block)
        record.update(type='file', size=metadata.st_size, sha256=digest.hexdigest())
        lines.append(json.dumps(record, sort_keys=True, separators=(',', ':')))
        if relative.startswith('recordings/') and relative.count('/') == 2 and relative.endswith('/meta.json'):
            try:
                with open(path, encoding='utf-8') as handle:
                    payload = json.load(handle)
                if payload.get('status') == 'recording':
                    active += 1
            except Exception:
                fail('meta.json legado inválido')

    for name in ('recordings', 'state', 'auth', 'cache'):
        source = mapping.get(name)
        if source is None:
            metadata = absent_metadata[name]
            lines.append(json.dumps({'path': name, 'mode': metadata['mode'], 'uid': metadata['uid'], 'gid': metadata['gid'], 'type': 'directory'}, sort_keys=True, separators=(',', ':')))
        else:
            visit(source, name, os.lstat(source).st_dev)
    if active:
        fail(f'activeRecordings={active}; exigido activeRecordings=0')
    lines.sort(key=lambda raw: json.loads(raw)['path'])
    paths = [json.loads(raw)['path'] for raw in lines]
    if len(paths) != len(set(paths)):
        fail('layout legado projeta paths duplicados após separar estado co-located')
    return '\n'.join(lines) + '\n'

def single_legacy_runtime_owner(mapping):
    owner = None
    def visit(path, device):
        nonlocal owner
        metadata = os.lstat(path)
        if metadata.st_dev != device or stat.S_ISLNK(metadata.st_mode):
            fail('layout legado contém symlink ou nested mount')
        if not stat.S_ISDIR(metadata.st_mode) and (
            not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
        ):
            fail('layout legado contém tipo especial ou hardlink')
        current = (metadata.st_uid, metadata.st_gid)
        if current[0] <= 0 or current[1] <= 0:
            fail('layout legado precisa pertencer integralmente a um UID/GID não-root')
        if owner is None:
            owner = current
        elif current != owner:
            fail('layout legado possui ownership misto; migração automática recusada')
        if stat.S_ISDIR(metadata.st_mode):
            for name in sorted(os.listdir(path)):
                visit(os.path.join(path, name), device)
    for source in mapping.values():
        metadata = os.lstat(source)
        visit(source, metadata.st_dev)
    if owner is None:
        fail('não foi possível derivar ownership do runtime legado')
    return owner

def atomic_json(path, payload):
    temporary = path + '.tmp'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, sort_keys=True, separators=(',', ':'))
        handle.write('\n')
        handle.flush(); os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory = os.open(os.path.dirname(path), os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try: os.fsync(directory)
    finally: os.close(directory)

def write_exact(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(value); handle.flush(); os.fsync(handle.fileno())

def state_paths(directory):
    return os.path.join(directory, 'layout.json'), os.path.join(directory, 'source-manifest.jsonl')

def validate_control_state(directory):
    if os.path.realpath(directory) != directory:
        fail('marker privado não pode atravessar symlink')
    parent = os.path.dirname(directory)
    parent_metadata = os.lstat(parent)
    if (
        not stat.S_ISDIR(parent_metadata.st_mode)
        or stat.S_ISLNK(parent_metadata.st_mode)
        or parent_metadata.st_uid != 0
        or parent_metadata.st_gid != 0
        or stat.S_IMODE(parent_metadata.st_mode) & 0o022
    ):
        fail('parent direto do marker privado precisa ser root-owned e não gravável por terceiros')
    metadata = os.lstat(directory)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o700
        or metadata.st_uid != 0
        or metadata.st_gid != 0
    ):
        fail('marker privado precisa ser diretório 0700 root:root')
    if set(os.listdir(directory)) != {'layout.json', 'source-manifest.jsonl'}:
        fail('marker privado possui conteúdo inesperado')
    for path in state_paths(directory):
        item = os.lstat(path)
        if (
            not stat.S_ISREG(item.st_mode)
            or stat.S_ISLNK(item.st_mode)
            or stat.S_IMODE(item.st_mode) != 0o600
            or item.st_uid != 0
            or item.st_gid != 0
            or item.st_nlink != 1
        ):
            fail('arquivo do marker privado precisa ser 0600 root:root sem links')

def read_control_file(path):
    before = os.lstat(path)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        opened = os.fstat(descriptor)
        if not same_identity(before, opened):
            fail('arquivo do marker privado mudou durante abertura')
        with os.fdopen(descriptor, 'r', encoding='utf-8') as handle:
            descriptor = -1
            value = handle.read()
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    after = os.lstat(path)
    if not same_identity(before, after) or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        fail('arquivo do marker privado mudou durante leitura')
    return value

def load_state(directory):
    validate_control_state(directory)
    layout_file, manifest_file = state_paths(directory)
    layout = json.loads(read_control_file(layout_file))
    manifest = read_control_file(manifest_file)
    if layout.get('version') != 3 or layout.get('current_root') != current_root or layout.get('data_root') != data_root:
        fail('marker privado pertence a outra transição')
    if hashlib.sha256(manifest.encode()).hexdigest() != layout.get('source_manifest_sha256'):
        fail('manifesto privado diverge do marker')
    return layout, manifest

def install_control_state(source, destination):
    source_layout, source_manifest = load_state(source)
    if os.path.exists(destination) or os.path.islink(destination):
        fail('destino do marker privado já existe')
    os.mkdir(destination, 0o700)
    os.chown(destination, 0, 0)
    write_exact(os.path.join(destination, 'source-manifest.jsonl'), source_manifest)
    atomic_json(os.path.join(destination, 'layout.json'), source_layout)
    directory = os.open(destination, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try: os.fsync(directory)
    finally: os.close(directory)
    validate_control_state(destination)

def remove_transient_state_if_equivalent():
    if not os.path.isdir(transient_state_dir) or os.path.islink(transient_state_dir):
        if os.path.exists(transient_state_dir) or os.path.islink(transient_state_dir):
            fail('marker transitório plaintext é irregular')
        return
    private_layout, private_manifest = load_state(private_state_dir)
    transient_layout, transient_manifest = load_state(transient_state_dir)
    if private_layout != transient_layout or private_manifest != transient_manifest:
        fail('marker transitório plaintext diverge do marker privado')
    assert_no_mounts_below([transient_state_dir])
    empty_directory_fd_safe(transient_state_dir)
    remove_empty_directory(transient_state_dir)

if mode == 'prepare':
    legacy_env_proof = capture_legacy_env_proof(legacy_env_path)
    initial_inventory = docker_inventory()
    selected = assert_stopped(initial_inventory, require_no_restart=False)
    core = next(item for service, item in selected if service == 'kassinao')
    expected_destinations = {
        '/app/recordings': 'recordings',
        '/app/state': 'state',
        '/app/auth': 'auth',
        '/home/node/.cache': 'cache',
    }
    sources = {}
    source_proofs = {}
    for mount in core.get('Mounts') or []:
        destination = mount.get('Destination')
        if destination not in expected_destinations or mount.get('RW') is not True:
            fail('core legado possui mount inesperado ou read-only')
        name = expected_destinations[destination]
        if name in sources:
            fail('mount legado duplicado')
        mount_type = str(mount.get('Type') or '')
        source = canonical(str(mount.get('Source') or ''), 'source de mount legado')
        metadata = os.lstat(source)
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            fail('source de mount legado precisa ser diretório regular')
        if name == 'cache':
            if mount_type != 'volume' or str(mount.get('Name') or '') != 'kassinao_model-cache':
                fail('cache legado precisa ser o named volume Compose esperado')
            proof = inspect_named_volume(str(mount.get('Name')), source)
        else:
            expected_bind = os.path.join(current_root, name)
            if mount_type != 'bind' or source != expected_bind:
                fail(f'bind legado de {name} precisa ser o filho exato allowlisted de CURRENT_ROOT')
            proof = {'kind': 'bind', 'expected_path': expected_bind}
        proof['identity'] = {'dev': metadata.st_dev, 'ino': metadata.st_ino}
        sources[name] = source
        source_proofs[name] = proof
    if 'recordings' not in sources or 'cache' not in sources:
        fail('layout legado exige mounts de recordings e cache')
    if len(set(sources.values())) != len(sources):
        fail('mounts legados precisam usar sources distintos')
    for left_name, left in sources.items():
        if left == data_root or left.startswith(data_root + os.sep) or data_root.startswith(left + os.sep):
            fail('DATA_ROOT novo não pode sobrepor source legado')
        for right_name, right in sources.items():
            if left_name != right_name and (left.startswith(right + os.sep) or right.startswith(left + os.sep)):
                fail('sources legados não podem se sobrepor')
    assert_sources_isolated(initial_inventory, sources)
    for name, source in sources.items():
        assert_source_identity(source, source_proofs[name])
    assert_no_mounts_below(sources.values())

    legacy_runtime_uid, legacy_runtime_gid = single_legacy_runtime_owner(sources)
    colocated_files = derive_colocated_files(sources)
    absent_metadata = {
        name: {'mode': 0o700, 'uid': legacy_runtime_uid, 'gid': legacy_runtime_gid}
        for name in ('state', 'auth') if name not in sources
    }
    current_manifest = regular_tree_manifest(sources, absent_metadata)
    layout = None
    stored_manifest = None
    private_exists = os.path.isdir(private_state_dir) and not os.path.islink(private_state_dir)
    transient_exists = os.path.isdir(transient_state_dir) and not os.path.islink(transient_state_dir)
    for candidate in (private_state_dir, transient_state_dir):
        if (os.path.exists(candidate) or os.path.islink(candidate)) and not (
            os.path.isdir(candidate) and not os.path.islink(candidate)
        ):
            fail('marker privado existente é irregular')
    state_dir = private_state_dir if private_exists else transient_state_dir
    if private_exists or transient_exists:
        layout, stored_manifest = load_state(state_dir)
        if (
            layout.get('sources') != sources
            or layout.get('source_proofs') != source_proofs
            or layout.get('colocated_files') != colocated_files
            or layout.get('absent_metadata') != absent_metadata
            or layout.get('legacy_env_proof') != legacy_env_proof
            or layout.get('legacy_runtime_uid') != legacy_runtime_uid
            or layout.get('legacy_runtime_gid') != legacy_runtime_gid
        ):
            fail('runtime legado divergiu do marker privado existente')
        if current_manifest != stored_manifest:
            fail('sources legados mudaram desde o preparo anterior')
        if layout.get('status') == 'prepared':
            destination = {name: os.path.join(data_root, name) for name in ('recordings', 'state', 'auth', 'cache')}
            if state_dir != private_state_dir or not os.path.isdir(data_root) or regular_tree_manifest(
                destination, {}, exclude_private_control=True,
            ) != stored_manifest:
                fail('DATA_ROOT preparado divergiu do manifesto legado')
            remove_transient_state_if_equivalent()
            print('Layout legado já estava preparado e foi revalidado.')
            raise SystemExit(0)
        if layout.get('status') != 'preparing':
            fail('status privado não permite retomar o preparo')
    else:
        state_dir = transient_state_dir
        os.mkdir(state_dir, 0o700)
        os.chown(state_dir, 0, 0)
        layout_file, manifest_file = state_paths(state_dir)
        write_exact(manifest_file, current_manifest)
        layout = {
            'version': 3,
            'status': 'preparing',
            'current_root': current_root,
            'data_root': data_root,
            'sources': sources,
            'source_proofs': source_proofs,
            'colocated_files': colocated_files,
            'legacy_env_proof': legacy_env_proof,
            'legacy_env_status': 'present',
            'legacy_runtime_uid': legacy_runtime_uid,
            'legacy_runtime_gid': legacy_runtime_gid,
            'absent_metadata': absent_metadata,
            'source_manifest_sha256': hashlib.sha256(current_manifest.encode()).hexdigest(),
            'created_at': int(time.time()),
        }
        atomic_json(layout_file, layout)
        validate_control_state(state_dir)
        stored_manifest = current_manifest

    if os.path.exists(data_root):
        destination = {name: os.path.join(data_root, name) for name in ('recordings', 'state', 'auth', 'cache')}
        if not os.path.isdir(private_state_dir) or regular_tree_manifest(
            destination, {}, exclude_private_control=True,
        ) != stored_manifest:
            fail('DATA_ROOT apareceu com conteúdo divergente durante retomada')
    else:
        if os.path.exists(staging):
            assert_no_mounts_below([staging])
            empty_directory_fd_safe(staging)
            remove_empty_directory(staging)
        os.mkdir(staging, 0o700)
        os.chown(staging, 0, 0)
        total = 0
        for source in sources.values():
            for root, directories, files in os.walk(source, followlinks=False):
                for name in files:
                    total += os.lstat(os.path.join(root, name)).st_size
        if shutil.disk_usage(data_parent).free < total + max(64 * 1024 * 1024, total // 10):
            fail('espaço livre insuficiente para cópia legada e margem de segurança')
        copy_inventory = docker_inventory()
        assert_stopped(copy_inventory, require_no_restart=False)
        assert_sources_isolated(copy_inventory, sources)
        for name, source in sources.items():
            assert_source_identity(source, source_proofs[name])
        assert_no_mounts_below(sources.values())
        for name in ('recordings', 'state', 'auth', 'cache'):
            source = sources.get(name)
            destination = os.path.join(staging, name)
            if source is None:
                os.mkdir(destination, absent_metadata[name]['mode'])
                os.chown(destination, absent_metadata[name]['uid'], absent_metadata[name]['gid'])
            else:
                subprocess.run(['cp', '-a', '--', source, destination], check=True)
        destination = {name: os.path.join(staging, name) for name in ('recordings', 'state', 'auth', 'cache')}
        if regular_tree_manifest(destination, {}) != stored_manifest:
            fail('cópia consolidada divergiu dos mounts legados')
        install_control_state(state_dir, os.path.join(staging, '.legacy-shared-transition'))
        os.sync()
        os.rename(staging, data_root)
        os.sync()
    if not os.path.isdir(private_state_dir) or os.path.islink(private_state_dir):
        fail('marker privado não acompanhou o DATA_ROOT consolidado')
    remove_transient_state_if_equivalent()
    layout, stored_manifest = load_state(private_state_dir)
    layout['status'] = 'prepared'
    layout['prepared_at'] = int(time.time())
    layout_file, _ = state_paths(private_state_dir)
    atomic_json(layout_file, layout)
    validate_control_state(private_state_dir)
    print('Layout legado consolidado e verificado; sources originais permanecem como rollback.')
    raise SystemExit(0)

if not os.path.isdir(private_state_dir) or os.path.islink(private_state_dir):
    fail('marker privado precisa estar no root cifrado de DATA_ROOT, fora dos binds RW')
layout, stored_manifest = load_state(private_state_dir)
remove_transient_state_if_equivalent()
legacy_env_proof = layout.get('legacy_env_proof') or {}
legacy_env_status = layout.get('legacy_env_status')
if legacy_env_status == 'present':
    assert_legacy_env_matches(legacy_env_proof)
elif legacy_env_status == 'deleting':
    if os.path.lexists(legacy_env_path):
        assert_legacy_env_matches(legacy_env_proof)
elif legacy_env_status == 'removed':
    if os.path.lexists(legacy_env_path):
        fail('.env legado reapareceu após expurgo')
else:
    fail('estado privado do .env legado é inválido')
if layout.get('status') == 'purged':
    print('Sources legados já estavam logicamente expurgados.')
    raise SystemExit(0)
if layout.get('status') not in ('prepared', 'purging'):
    fail('status privado não permite purge dos sources legados')

subprocess.run([verifier], check=True, env={'PATH': os.environ['PATH'], 'HOME': '/root', 'KASSINAO_ENV_FILE': env_file}, stdout=subprocess.DEVNULL)
purge_inventory = docker_inventory()
selected = assert_stopped(purge_inventory, require_no_restart=True)
rollback = data_root + '.plaintext-before-shared-luks'
rollback_mapping = {name: os.path.join(rollback, name) for name in ('recordings', 'state', 'auth', 'cache')}
if not os.path.isdir(rollback) or regular_tree_manifest(
    rollback_mapping, {}, exclude_private_control=True,
) != stored_manifest:
    fail('rollback consolidado não prova cópia íntegra dos sources legados')

sources = layout['sources']
source_proofs = layout.get('source_proofs') or {}
if set(source_proofs) != set(sources):
    fail('provas de identidade dos sources legados estão incompletas')
for name, source in sources.items():
    source = canonical(source, f'source legado {name}')
    proof = source_proofs[name]
    if name == 'cache':
        if proof.get('kind') != 'volume' or proof.get('name') != 'kassinao_model-cache':
            fail('prova do named volume cache é inválida')
    elif proof.get('kind') != 'bind' or source != os.path.join(current_root, name):
        fail(f'prova do bind legado {name} diverge do filho allowlisted')
    assert_source_identity(source, proof)
assert_sources_isolated(purge_inventory, sources)
assert_no_mounts_below(sources.values())
if layout.get('status') == 'prepared':
    absent_metadata = layout['absent_metadata']
    if regular_tree_manifest(sources, absent_metadata) != stored_manifest:
        fail('sources legados mudaram; purge recusado')
    layout['status'] = 'purging'
    layout['purge_started_at'] = int(time.time())
    layout_file, _ = state_paths(private_state_dir)
    atomic_json(layout_file, layout)
    validate_control_state(private_state_dir)

delete_inventory = docker_inventory()
assert_stopped(delete_inventory, require_no_restart=True)
assert_sources_isolated(delete_inventory, sources)
for name, source in sources.items():
    assert_source_identity(source, source_proofs[name])
assert_no_mounts_below(sources.values())

for name, source in sources.items():
    assert_no_mounts_below(sources.values())
    assert_source_identity(source, source_proofs[name])
    empty_directory_fd_safe(source)
    if os.listdir(source):
        fail('source legado não ficou vazio após purge')
if layout['legacy_env_status'] == 'present':
    layout['legacy_env_status'] = 'deleting'
    layout['legacy_env_delete_started_at'] = int(time.time())
    layout_file, _ = state_paths(private_state_dir)
    atomic_json(layout_file, layout)
    validate_control_state(private_state_dir)
if layout['legacy_env_status'] == 'deleting':
    if os.path.lexists(legacy_env_path):
        unlink_legacy_env_fd_safe(legacy_env_proof)
    layout['legacy_env_status'] = 'removed'
    layout['legacy_env_removed_at'] = int(time.time())
    layout_file, _ = state_paths(private_state_dir)
    atomic_json(layout_file, layout)
    validate_control_state(private_state_dir)
if layout.get('legacy_env_status') != 'removed' or os.path.lexists(legacy_env_path):
    fail('.env legado não foi expurgado com segurança')
layout['status'] = 'purged'
layout['purged_at'] = int(time.time())
layout_file, _ = state_paths(private_state_dir)
atomic_json(layout_file, layout)
validate_control_state(private_state_dir)
print('Sources e .env legados expurgados logicamente; rollback consolidado permaneceu intacto. Rotacione os segredos legados para reduzir vestígios forenses em backups/snapshots anteriores.')
PY
