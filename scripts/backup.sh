#!/bin/bash -p
#
# Backup consistente de recordings/ + state/ para um remoto rclone crypt.
# auth/ nunca entra no arquivo: cookies, identidade e sessões pertencem somente
# à instância original. O writer precisa estar parado durante TODO o snapshot.
#
# Por padrão, o script recusa um container em execução. Para uma janela de
# manutenção automatizada, use BACKUP_STOP_CONTAINER=true: o shutdown respeita
# o StopTimeout do container e ele é iniciado novamente mesmo se o upload falhar.
# Sem Docker/container verificável, somente BACKUP_ASSUME_QUIESCED=true permite
# continuar; essa opção afirma explicitamente que nenhum processo escreve nos
# diretórios durante o backup.
#
# Restauração (com o core parado):
#   1. baixe o .tar.gz do remoto crypt e valide `tar -tzf ARQUIVO`;
#   2. extraia em uma pasta vazia e confira BACKUP-MANIFEST.txt;
#   3. substitua DATA_ROOT/recordings e DATA_ROOT/state pelos dois diretórios
#      extraídos, preserve DATA_ROOT/auth da MESMA instância e ajuste owner/mode;
#   4. inicie o core e valide /health antes de remover a cópia anterior.
# Nunca extraia diretamente sobre dados ativos.
set -euo pipefail
umask 077

_saved_deploy_dir="${KASSINAO_DEPLOY_DIR-}"
_saved_env_file="${KASSINAO_ENV_FILE-}"
_saved_remote="${RCLONE_REMOTE-}"
_saved_rclone_config="${RCLONE_CONFIG-}"
_saved_stop_container="${BACKUP_STOP_CONTAINER-}"
_saved_assume_quiesced="${BACKUP_ASSUME_QUIESCED-}"
_saved_host_scope_present=false
_saved_data_root_present=false
_saved_recordings_present=false
_saved_recordings_alias_present=false
_saved_state_present=false
_saved_state_alias_present=false
_saved_auth_present=false
_saved_auth_alias_present=false
_saved_cache_present=false
[[ -v KASSINAO_HOST_SCOPE ]] && _saved_host_scope_present=true && _saved_host_scope="$KASSINAO_HOST_SCOPE"
[[ -v KASSINAO_DATA_ROOT ]] && _saved_data_root_present=true && _saved_data_root="$KASSINAO_DATA_ROOT"
[[ -v KASSINAO_RECORDINGS_DIR ]] && _saved_recordings_present=true && _saved_recordings="$KASSINAO_RECORDINGS_DIR"
[[ -v RECORDINGS_DIR ]] && _saved_recordings_alias_present=true && _saved_recordings_alias="$RECORDINGS_DIR"
[[ -v KASSINAO_STATE_DIR ]] && _saved_state_present=true && _saved_state="$KASSINAO_STATE_DIR"
[[ -v STATE_DIR ]] && _saved_state_alias_present=true && _saved_state_alias="$STATE_DIR"
[[ -v KASSINAO_AUTH_DIR ]] && _saved_auth_present=true && _saved_auth="$KASSINAO_AUTH_DIR"
[[ -v AUTH_STATE_DIR ]] && _saved_auth_alias_present=true && _saved_auth_alias="$AUTH_STATE_DIR"
[[ -v KASSINAO_MODEL_CACHE_DIR ]] && _saved_cache_present=true && _saved_cache="$KASSINAO_MODEL_CACHE_DIR"
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
_inherited_docker_environment_name=''
for _inherited_name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$_inherited_name" >/dev/null 2>&1; then
    _inherited_docker_environment_name="$_inherited_name"
    break
  fi
done
[ -r "/proc/$$/environ" ] || { printf 'ERRO: /proc é obrigatório para limpar o ambiente do backup.\n' >&2; exit 1; }
while IFS='=' read -r -d '' _inherited_name _inherited_value; do
  unset "$_inherited_name" 2>/dev/null || true
done < "/proc/$$/environ"
unset _inherited_name _inherited_value

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME=/root
LC_ALL=C
export PATH HOME LC_ALL
KASSINAO_DEPLOY_DIR="$_saved_deploy_dir" KASSINAO_ENV_FILE="$_saved_env_file"
RCLONE_REMOTE="$_saved_remote" RCLONE_CONFIG="$_saved_rclone_config"
BACKUP_STOP_CONTAINER="$_saved_stop_container" BACKUP_ASSUME_QUIESCED="$_saved_assume_quiesced"
export KASSINAO_DEPLOY_DIR KASSINAO_ENV_FILE RCLONE_REMOTE RCLONE_CONFIG
export BACKUP_STOP_CONTAINER BACKUP_ASSUME_QUIESCED
if [ "$_saved_host_scope_present" = true ]; then KASSINAO_HOST_SCOPE="$_saved_host_scope"; export KASSINAO_HOST_SCOPE; fi
if [ "$_saved_data_root_present" = true ]; then KASSINAO_DATA_ROOT="$_saved_data_root"; export KASSINAO_DATA_ROOT; fi
if [ "$_saved_recordings_present" = true ]; then KASSINAO_RECORDINGS_DIR="$_saved_recordings"; export KASSINAO_RECORDINGS_DIR; fi
if [ "$_saved_recordings_alias_present" = true ]; then RECORDINGS_DIR="$_saved_recordings_alias"; export RECORDINGS_DIR; fi
if [ "$_saved_state_present" = true ]; then KASSINAO_STATE_DIR="$_saved_state"; export KASSINAO_STATE_DIR; fi
if [ "$_saved_state_alias_present" = true ]; then STATE_DIR="$_saved_state_alias"; export STATE_DIR; fi
if [ "$_saved_auth_present" = true ]; then KASSINAO_AUTH_DIR="$_saved_auth"; export KASSINAO_AUTH_DIR; fi
if [ "$_saved_auth_alias_present" = true ]; then AUTH_STATE_DIR="$_saved_auth_alias"; export AUTH_STATE_DIR; fi
if [ "$_saved_cache_present" = true ]; then KASSINAO_MODEL_CACHE_DIR="$_saved_cache"; export KASSINAO_MODEL_CACHE_DIR; fi
[ -z "$_inherited_docker_environment_name" ] || {
  printf 'ERRO: %s não pode vir do ambiente; o backup aceita somente o daemon local da VPS.\n' \
    "$_inherited_docker_environment_name" >&2
  exit 1
}

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) printf 'ERRO: caminho do backup não é canônico.\n' >&2; exit 1 ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) printf 'ERRO: backup precisa executar do kit selado.\n' >&2; exit 1 ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) printf 'ERRO: arquitetura sem runtime no-dump.\n' >&2; exit 1 ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/backup.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || { printf 'ERRO: core limit do backup não ficou selado.\n' >&2; exit 1; }
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[ "$_no_dump_filter" = 0 ] || { printf 'ERRO: coredump_filter do backup não ficou selado.\n' >&2; exit 1; }
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_DIR="${KASSINAO_DEPLOY_DIR:-$PROJECT_DIR}"
ENV_FILE="${KASSINAO_ENV_FILE:-$DEPLOY_DIR/.env}"
REMOTE="${RCLONE_REMOTE:?Defina RCLONE_REMOTE com um remoto rclone crypt}"
RCLONE_CONFIG_FILE="${RCLONE_CONFIG:?Defina RCLONE_CONFIG com o config de upload}"
CONTAINER=kassinao
STOP_CONTAINER="${BACKUP_STOP_CONTAINER:-false}"
ASSUME_QUIESCED="${BACKUP_ASSUME_QUIESCED:-false}"
DOCKER=docker
SYSTEMCTL=systemctl
HARDENER="$DEPLOY_DIR/scripts/harden-docker-egress.sh"
STORAGE_VERIFIER=''
ROLLBACK_CHECKER=''
SHARED_AUDITOR=''
EGRESS_UNIT=kassinao-docker-egress.service
TMP=""
RESTART_CONTAINER=false
CONTAINER_ID=''
CONTAINER_IMAGE=''

die() {
  printf 'ERRO: %s\n' "$*" >&2
  exit 1
}
ulimit -c 0 2>/dev/null || die 'não foi possível desabilitar core dumps do backup'

export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
DOCKER_CONFIG="$DEPLOY_DIR/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && \
  [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] || \
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] || \
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG

# KASSINAO_CLEAN_CHILD_BEGIN
clean_child() {
  env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" "$@"
}
docker_local() {
  env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" \
    DOCKER_HOST=unix:///var/run/docker.sock "DOCKER_CONFIG=$DOCKER_CONFIG" "$DOCKER" "$@"
}
# KASSINAO_CLEAN_CHILD_END

bool_value() {
  case "$2" in
    true | false) ;;
    *) die "$1 aceita somente true ou false" ;;
  esac
}

portable_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

portable_owner_group() {
  stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"
}

portable_link_count() {
  stat -c '%h' "$1" 2>/dev/null || stat -f '%l' "$1"
}

# O nome configurado serve apenas para descobrir o ID completo. Backup nunca
# para ou reinicia um container que não tenha nome e labels Compose exatos.
managed_container_id() {
  local reference="$1" candidate identity
  local actual_id actual_name actual_project actual_service extra
  candidate="$(docker_local inspect --format '{{.Id}}' "$reference" 2>/dev/null)" || return 1
  [[ "$candidate" =~ ^[0-9a-f]{64}$ ]] || return 2
  identity="$(
    docker_local inspect \
      --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
      "$candidate" 2>/dev/null
  )" || return 2
  IFS='|' read -r actual_id actual_name actual_project actual_service extra <<<"$identity"
  [ -z "$extra" ] && [ "$actual_id" = "$candidate" ] && [ "$actual_name" = "/$CONTAINER" ] && \
    [ "$actual_project" = kassinao ] && [ "$actual_service" = kassinao ] || return 2
  printf '%s\n' "$candidate"
}

revalidate_container_id() {
  local confirmed
  [ -n "$CONTAINER_ID" ] || return 1
  confirmed="$(managed_container_id "$CONTAINER_ID")" || return 1
  [ "$confirmed" = "$CONTAINER_ID" ]
}

# Faz inventário por descritores de diretório (openat/O_NOFOLLOW), calcula hash
# dos regulares e recusa qualquer inode que o tar não possa copiar com segurança.
# O mesmo inventário é repetido depois do tar para detectar mudança no snapshot.
inventory_backup_tree() {
  local output="$1"
  python3 - "$REC_REAL" "$STATE_REAL" "$output" <<'PY'
import hashlib
import json
import os
import stat
import sys

roots = (("recordings", sys.argv[1]), ("state", sys.argv[2]))
output = sys.argv[3]
no_follow = getattr(os, "O_NOFOLLOW", 0)
directory_flag = getattr(os, "O_DIRECTORY", 0)
expected_device = None
records = []


def fail(message):
    print(f"ERRO: inventário seguro do backup recusou {message}", file=sys.stderr)
    raise SystemExit(1)


def metadata(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid, st.st_nlink, st.st_size, st.st_mtime_ns)


def mountinfo_path(raw):
    for encoded, decoded in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
        raw = raw.replace(encoded, decoded)
    return os.path.realpath(raw)


def reject_nested_mounts(root, label):
    if not sys.platform.startswith("linux"):
        return
    try:
        with open("/proc/self/mountinfo", "r", encoding="utf-8") as source:
            mountpoints = [mountinfo_path(line.split(" - ", 1)[0].split()[4]) for line in source]
    except Exception:
        fail("inventário de mounts do processo indisponível")
    canonical = os.path.realpath(root)
    for mountpoint in mountpoints:
        if mountpoint == canonical or mountpoint.startswith(canonical + os.sep):
            fail(f"mount/filesystem aninhado em {label}")


def check_device(st, relative):
    global expected_device
    if expected_device is None:
        expected_device = st.st_dev
    if st.st_dev != expected_device:
        fail(f"filesystem aninhado em {relative}")


def walk(fd, relative):
    before = os.fstat(fd)
    check_device(before, relative)
    if not stat.S_ISDIR(before.st_mode):
        fail(f"raiz não diretório em {relative}")
    records.append({"kind": "dir", "path": relative, "meta": metadata(before)})
    try:
        entries = sorted(os.scandir(fd), key=lambda entry: os.fsencode(entry.name))
    except OSError as error:
        fail(f"diretório ilegível em {relative}: {error.strerror}")
    for entry in entries:
        name = entry.name
        child_relative = f"{relative}/{name}"
        try:
            observed = entry.stat(follow_symlinks=False)
        except OSError as error:
            fail(f"entrada instável em {child_relative}: {error.strerror}")
        mode = observed.st_mode
        if stat.S_ISLNK(mode):
            fail(f"symlink em {child_relative}")
        if stat.S_ISDIR(mode):
            try:
                child_fd = os.open(name, os.O_RDONLY | directory_flag | no_follow, dir_fd=fd)
            except OSError as error:
                fail(f"diretório inseguro em {child_relative}: {error.strerror}")
            try:
                opened = os.fstat(child_fd)
                if metadata(opened) != metadata(observed):
                    fail(f"troca concorrente em {child_relative}")
                walk(child_fd, child_relative)
            finally:
                os.close(child_fd)
            continue
        if not stat.S_ISREG(mode):
            fail(f"arquivo especial em {child_relative}")
        try:
            file_fd = os.open(name, os.O_RDONLY | no_follow | getattr(os, "O_NONBLOCK", 0), dir_fd=fd)
        except OSError as error:
            fail(f"arquivo inseguro em {child_relative}: {error.strerror}")
        try:
            opened = os.fstat(file_fd)
            if metadata(opened) != metadata(observed) or not stat.S_ISREG(opened.st_mode):
                fail(f"troca concorrente em {child_relative}")
            check_device(opened, child_relative)
            if opened.st_nlink != 1:
                fail(f"hardlink em {child_relative}")
            digest = hashlib.sha256()
            while True:
                chunk = os.read(file_fd, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            after = os.fstat(file_fd)
            if metadata(after) != metadata(opened):
                fail(f"arquivo alterado durante leitura em {child_relative}")
            records.append({"kind": "file", "path": child_relative, "meta": metadata(after), "sha256": digest.hexdigest()})
        finally:
            os.close(file_fd)
    after = os.fstat(fd)
    if metadata(after) != metadata(before):
        fail(f"diretório alterado durante leitura em {relative}")


for label, root in roots:
    reject_nested_mounts(root, label)
    try:
        root_fd = os.open(root, os.O_RDONLY | directory_flag | no_follow)
    except OSError as error:
        fail(f"raiz insegura {label}: {error.strerror}")
    try:
        walk(root_fd, label)
    finally:
        os.close(root_fd)

payload = json.dumps(records, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | no_follow
fd = os.open(output, flags, 0o600)
with os.fdopen(fd, "wb") as stream:
    stream.write(payload)
    stream.flush()
    os.fsync(stream.fileno())
PY
}

validate_backup_archive() {
  local archive="$1" inventory="$2" manifest="$3"
  python3 - "$archive" "$inventory" "$manifest" <<'PY'
import json
import hashlib
import pathlib
import tarfile
import sys

archive_path, inventory_path, manifest_path = sys.argv[1:]
sensitive_names = {
    ".cookie-secret", ".instance-id", ".web-sessions.json", "web-sessions.json",
    ".mcp-sessions.json", "mcp-sessions.json",
}


def fail(message):
    print(f"ERRO: validação estrutural do arquivo recusou {message}", file=sys.stderr)
    raise SystemExit(1)


def excluded(path):
    parts = path.split("/")
    return (
        any(part in {"cache", ".cache"} for part in parts[1:2])
        or parts[-1] in sensitive_names
        or parts[-1].endswith(".tmp")
    )


try:
    inventory = json.loads(pathlib.Path(inventory_path).read_text(encoding="utf-8"))
except Exception:
    fail("inventário final inválido")
expected = {}
for record in inventory:
    path = record.get("path")
    kind = record.get("kind")
    if not isinstance(path, str) or kind not in {"dir", "file"}:
        fail("entrada inválida no inventário final")
    if excluded(path):
        continue
    if kind == "file":
        metadata = record.get("meta")
        digest = record.get("sha256")
        if not isinstance(metadata, list) or len(metadata) != 8 or not isinstance(metadata[6], int):
            fail("metadata de regular inválida no inventário final")
        if not isinstance(digest, str) or len(digest) != 64:
            fail("hash de regular inválido no inventário final")
        expected[path] = {"kind": kind, "size": metadata[6], "sha256": digest}
    else:
        expected[path] = {"kind": kind}
manifest_bytes = pathlib.Path(manifest_path).read_bytes()
expected["BACKUP-MANIFEST.txt"] = {
    "kind": "file", "size": len(manifest_bytes), "sha256": hashlib.sha256(manifest_bytes).hexdigest()
}

seen = {}
try:
    archive = tarfile.open(archive_path, mode="r:gz")
except Exception:
    fail("tar.gz ilegível")
with archive:
    if archive.pax_headers:
        fail("PAX global não permitido")
    for member in archive:
        raw = member.name
        if not isinstance(raw, str) or not raw or "\\" in raw or "\x00" in raw or raw.startswith("/"):
            fail("nome absoluto ou inválido")
        while raw.startswith("./"):
            raw = raw[2:]
        raw = raw.rstrip("/")
        parts = raw.split("/")
        if not raw or any(part in {"", ".", ".."} for part in parts):
            fail("nome não canônico")
        if parts[0] not in {"recordings", "state", "BACKUP-MANIFEST.txt"}:
            fail(f"top-level não permitido: {parts[0]}")
        if parts[0] == "BACKUP-MANIFEST.txt" and len(parts) != 1:
            fail("nome de manifesto inválido")
        if raw in seen:
            fail(f"membro duplicado: {raw}")
        if member.isdir():
            kind = "dir"
        elif member.isreg():
            kind = "file"
        else:
            fail(f"link ou arquivo especial: {raw}")
        if member.pax_headers or getattr(member, "sparse", None):
            fail(f"PAX/sparse não permitido: {raw}")
        seen[raw] = kind
        contract = expected.get(raw)
        if contract is None or contract["kind"] != kind:
            fail(f"membro inesperado ou tipo divergente: {raw}")
        if kind == "file":
            if member.size != contract["size"]:
                fail(f"tamanho divergente: {raw}")
            stream = archive.extractfile(member)
            if stream is None:
                fail(f"regular ilegível: {raw}")
            digest = hashlib.sha256()
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            if digest.hexdigest() != contract["sha256"]:
                fail(f"conteúdo/hash divergente: {raw}")
    expected_kinds = {name: contract["kind"] for name, contract in expected.items()}
    if seen != expected_kinds:
        missing = sorted(set(expected) - set(seen))
        extra = sorted(set(seen) - set(expected))
        fail(f"membros divergentes (ausentes={missing[:3]}, extras={extra[:3]})")
    manifest_member = archive.getmember("./BACKUP-MANIFEST.txt") if "./BACKUP-MANIFEST.txt" in archive.getnames() else archive.getmember("BACKUP-MANIFEST.txt")
    manifest_stream = archive.extractfile(manifest_member)
    if manifest_stream is None or manifest_stream.read() != manifest_bytes:
        fail("conteúdo do manifesto divergente")
PY
}

command -v flock >/dev/null 2>&1 || die 'flock não instalado'
command -v "$SYSTEMCTL" >/dev/null 2>&1 || die 'systemctl não encontrado'
command -v env >/dev/null 2>&1 || die 'env não encontrado'
[ -x "$HARDENER" ] && [ ! -L "$HARDENER" ] || die 'hardener de egress ausente, sem execução ou symlink'

# O diretório é provisionado uma vez no host. Não há fallback por usuário:
# deploy, backup e watchdog precisam abrir exatamente o mesmo lock. O lock é
# obtido antes de ler a configuração ou o estado que um deploy pode substituir.
RUNTIME_DIR=/run/lock/kassinao
[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] && \
  [ "$(cd -- "$RUNTIME_DIR" && pwd -P)" = "$RUNTIME_DIR" ] && \
  [ "$(portable_mode "$RUNTIME_DIR"):$(portable_owner_group "$RUNTIME_DIR")" = 700:0:0 ] || \
  die 'runtime shared precisa ser /run/lock/kassinao canônico 0700 root:root'
JOB_LOCK_FILE="$RUNTIME_DIR/backup.lock"
MAINTENANCE_LOCK_FILE="$RUNTIME_DIR/maintenance.lock"
for lock_file in "$JOB_LOCK_FILE" "$MAINTENANCE_LOCK_FILE"; do
  [ -f "$lock_file" ] && [ ! -L "$lock_file" ] && \
    [ "$(portable_mode "$lock_file"):$(portable_owner_group "$lock_file"):$(portable_link_count "$lock_file")" = 600:0:0:1 ] || \
    die 'lock shared precisa preexistir como regular 0600 root:root sem hardlink'
done
exec 8<>"$JOB_LOCK_FILE"
flock -n 8 || die 'já existe um backup em execução'
exec 9<>"$MAINTENANCE_LOCK_FILE"
flock -w 120 9 || die 'outra manutenção não liberou o core em 120 segundos'
# KASSINAO_LOCK_FD_PROOF_BEGIN
for lock_proof in "8:$JOB_LOCK_FILE" "9:$MAINTENANCE_LOCK_FILE"; do
  lock_fd="${lock_proof%%:*}"
  lock_path="${lock_proof#*:}"
  [ "$(stat -Lc '%d:%i:%a:%u:%g:%h' "/proc/$$/fd/$lock_fd" 2>/dev/null || true)" = \
    "$(stat -Lc '%d:%i:%a:%u:%g:%h' "$lock_path" 2>/dev/null || true)" ] && \
    [ "$(stat -Lc '%a:%u:%g:%h' "$lock_path" 2>/dev/null || true)" = 600:0:0:1 ] || \
    die 'lock shared mudou durante abertura'
done
unset lock_proof lock_fd lock_path
# KASSINAO_LOCK_FD_PROOF_END

require_private_env_file() {
  local file="$1" canonical mode
  case "$file" in
    /*) ;;
    *) die 'KASSINAO_ENV_FILE precisa ser um caminho absoluto e canônico' ;;
  esac
  [ -f "$file" ] && [ ! -L "$file" ] || \
    die 'KASSINAO_ENV_FILE precisa ser um arquivo regular, não um link simbólico'
  [ -O "$file" ] || die 'KASSINAO_ENV_FILE precisa pertencer ao usuário atual'
  canonical="$(cd -- "$(dirname -- "$file")" && pwd -P)/$(basename -- "$file")"
  [ "$file" = "$canonical" ] || die 'KASSINAO_ENV_FILE precisa usar o caminho canônico'
  mode="$(portable_mode "$file")"
  [ "$mode" = 600 ] || die 'KASSINAO_ENV_FILE precisa de modo 0600'
}

# Lê somente a chave permitida, sem executar o arquivo nem colocar seu conteúdo
# no ambiente do processo. Duplicatas falham fechado em vez de escolher uma.
env_value() {
  local key="$1" file="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count > 1) exit 2; print value }
  ' "$file" || die "$key aparece mais de uma vez em KASSINAO_ENV_FILE"
}

assert_shared_export_matches() {
  local configured_name="$1" configured_value="$2" sealed_value="$3"
  [ -z "$configured_value" ] || [ "$configured_value" = "$sealed_value" ] ||
    die "$configured_name exportado diverge do .env selado shared"
}

ENV_DATA_ROOT=''
ENV_RECORDINGS_DIR=''
ENV_STATE_DIR=''
ENV_AUTH_DIR=''
ENV_CACHE_DIR=''
ENV_SHARED_APP_ENV=''
ENV_HOST_SCOPE=''
DATA_DIR="${KASSINAO_DATA_ROOT-}"
REC_DIR="${KASSINAO_RECORDINGS_DIR:-${RECORDINGS_DIR-}}"
STATE_DIR="${KASSINAO_STATE_DIR:-${STATE_DIR-}}"
AUTH_DIR="${KASSINAO_AUTH_DIR:-${AUTH_STATE_DIR-}}"
CACHE_DIR="${KASSINAO_MODEL_CACHE_DIR-}"
HOST_SCOPE="${KASSINAO_HOST_SCOPE-}"
NEEDS_ENV=false
for configured_path in "$DATA_DIR" "$REC_DIR" "$STATE_DIR" "$AUTH_DIR" "$CACHE_DIR"; do
  [ -n "$configured_path" ] || NEEDS_ENV=true
done
[ "$HOST_SCOPE" != shared ] || NEEDS_ENV=true

if [ "$NEEDS_ENV" = true ]; then
  # Primeiro prove que o caminho fornecido é canônico/privado. Só depois disso
  # compare com o único .env autorizado da release, preservando a causa real do
  # erro sem abrir o arquivo em execuções dedicated totalmente parametrizadas.
  require_private_env_file "$ENV_FILE"
  [ "$ENV_FILE" = "$DEPLOY_DIR/.env" ] ||
    die 'KASSINAO_ENV_FILE precisa ser exatamente o .env selado da release'
  ENV_DATA_ROOT="$(env_value KASSINAO_DATA_ROOT "$ENV_FILE")"
  ENV_RECORDINGS_DIR="$(env_value KASSINAO_RECORDINGS_DIR "$ENV_FILE")"
  ENV_STATE_DIR="$(env_value KASSINAO_STATE_DIR "$ENV_FILE")"
  ENV_AUTH_DIR="$(env_value KASSINAO_AUTH_DIR "$ENV_FILE")"
  ENV_CACHE_DIR="$(env_value KASSINAO_MODEL_CACHE_DIR "$ENV_FILE")"
  ENV_SHARED_APP_ENV="$(env_value KASSINAO_SHARED_APP_ENV_FILE "$ENV_FILE")"
  ENV_HOST_SCOPE="$(env_value KASSINAO_HOST_SCOPE "$ENV_FILE")"

  if [ -n "$HOST_SCOPE" ] && [ -n "$ENV_HOST_SCOPE" ] && [ "$HOST_SCOPE" != "$ENV_HOST_SCOPE" ]; then
    die 'KASSINAO_HOST_SCOPE exportado diverge do .env selado da release'
  fi
  HOST_SCOPE="${HOST_SCOPE:-${ENV_HOST_SCOPE:-dedicated}}"
  if [ "$HOST_SCOPE" = shared ]; then
    assert_shared_export_matches KASSINAO_DATA_ROOT "$DATA_DIR" "$ENV_DATA_ROOT"
    assert_shared_export_matches KASSINAO_RECORDINGS_DIR "$REC_DIR" "$ENV_RECORDINGS_DIR"
    assert_shared_export_matches KASSINAO_STATE_DIR "$STATE_DIR" "$ENV_STATE_DIR"
    assert_shared_export_matches KASSINAO_AUTH_DIR "$AUTH_DIR" "$ENV_AUTH_DIR"
    assert_shared_export_matches KASSINAO_MODEL_CACHE_DIR "$CACHE_DIR" "$ENV_CACHE_DIR"
    DATA_DIR="$ENV_DATA_ROOT"
    REC_DIR="$ENV_RECORDINGS_DIR"
    STATE_DIR="$ENV_STATE_DIR"
    AUTH_DIR="$ENV_AUTH_DIR"
    CACHE_DIR="$ENV_CACHE_DIR"
  else
    DATA_DIR="${DATA_DIR:-$ENV_DATA_ROOT}"
    REC_DIR="${REC_DIR:-$ENV_RECORDINGS_DIR}"
    STATE_DIR="${STATE_DIR:-$ENV_STATE_DIR}"
    AUTH_DIR="${AUTH_DIR:-$ENV_AUTH_DIR}"
    CACHE_DIR="${CACHE_DIR:-$ENV_CACHE_DIR}"
  fi
else
  HOST_SCOPE="${HOST_SCOPE:-dedicated}"
fi
unset configured_path NEEDS_ENV

case "$HOST_SCOPE" in
  dedicated)
    STORAGE_VERIFIER="$DEPLOY_DIR/scripts/verify-storage-encryption.sh"
    ;;
  shared)
    STORAGE_VERIFIER="$DEPLOY_DIR/scripts/verify-shared-luks-storage.sh"
    ROLLBACK_CHECKER="$DEPLOY_DIR/scripts/check-shared-migration-rollback.sh"
    SHARED_AUDITOR="$DEPLOY_DIR/scripts/audit-shared-vps-security.sh"
    ;;
  *) die 'KASSINAO_HOST_SCOPE aceita somente dedicated ou shared' ;;
esac
[ -x "$STORAGE_VERIFIER" ] && [ ! -L "$STORAGE_VERIFIER" ] || die 'verificador de storage ausente, sem execução ou symlink'
if [ "$HOST_SCOPE" = shared ]; then
  [ -x "$ROLLBACK_CHECKER" ] && [ ! -L "$ROLLBACK_CHECKER" ] || \
    die 'checker de rollback plaintext ausente, sem execução ou symlink'
  command -v findmnt >/dev/null 2>&1 || die 'findmnt não instalado'
  [ -f "$SHARED_AUDITOR" ] && [ -x "$SHARED_AUDITOR" ] && [ ! -L "$SHARED_AUDITOR" ] || \
    die 'auditor estático shared ausente, sem execução ou symlink'
fi

storage_ready() {
  if [ "$HOST_SCOPE" = shared ]; then
    clean_child "KASSINAO_ENV_FILE=$ENV_FILE" \
      "$STORAGE_VERIFIER" >/dev/null
  else
    clean_child "$STORAGE_VERIFIER" \
      "$DATA_REAL" "$REC_REAL" "$STATE_REAL" "$AUTH_REAL" >/dev/null
  fi
}

rollback_ready() {
  [ "$HOST_SCOPE" != shared ] || \
    clean_child "KASSINAO_ENV_FILE=$ENV_FILE" \
      "$ROLLBACK_CHECKER" >/dev/null
}

static_contract_ready() {
  local existing_image="${1:-}"
  [ "$HOST_SCOPE" = shared ] || return 0
  if [ -n "$existing_image" ]; then
    clean_child "KASSINAO_ENV_FILE=$ENV_FILE" \
      "$SHARED_AUDITOR" --preflight --expected-existing-image "$existing_image" >/dev/null
  else
    clean_child "KASSINAO_ENV_FILE=$ENV_FILE" \
      "$SHARED_AUDITOR" --preflight >/dev/null
  fi
}

egress_ready() {
  local -a hardener_scope=()
  [ "$HOST_SCOPE" != shared ] || hardener_scope+=(--shared-host)
  clean_child "$SYSTEMCTL" is-active --quiet "$EGRESS_UNIT" || return 1
  clean_child "$HARDENER" "${hardener_scope[@]}" --check >/dev/null
}

start_and_wait_healthy() {
  if ! rollback_ready; then
    printf 'ERRO: core não será reiniciado com rollback plaintext inválido ou expirado\n' >&2
    return 1
  fi
  if ! storage_ready; then
    printf 'ERRO: core não será reiniciado sem storage dm-crypt/LUKS válido\n' >&2
    return 1
  fi
  if ! egress_ready; then
    printf 'ERRO: core não será reiniciado sem egress active e policy válida\n' >&2
    return 1
  fi
  if ! static_contract_ready "$CONTAINER_IMAGE"; then
    printf 'ERRO: core não será reiniciado porque o contrato estático shared divergiu\n' >&2
    return 1
  fi
  if ! revalidate_container_id; then
    printf 'ERRO: identidade do core mudou; backup não reiniciará nenhum container\n' >&2
    return 1
  fi
  if [ "$(docker_local inspect -f '{{.Config.Image}}' "$CONTAINER_ID" 2>/dev/null || true)" != "$CONTAINER_IMAGE" ]; then
    printf 'ERRO: imagem do core mudou; backup não reiniciará o container\n' >&2
    return 1
  fi
  docker_local start "$CONTAINER_ID" >/dev/null || return 1
  local deadline=$((SECONDS + 120)) state health
  while [ "$SECONDS" -lt "$deadline" ]; do
    IFS='|' read -r state health < <(
      docker_local inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER_ID" 2>/dev/null || true
    )
    [ "$state" = running ] && [ "$health" = healthy ] && return 0
    case "$state:$health" in exited:* | dead:* | *:unhealthy) return 1 ;; esac
    sleep 3
  done
  return 1
}

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$RESTART_CONTAINER" = true ]; then
    if ! start_and_wait_healthy; then
      printf 'ERRO: o backup terminou, mas o core não voltou saudável\n' >&2
      status=1
    fi
  fi
  if [ -n "$TMP" ]; then
    rm -rf -- "$TMP"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

bool_value BACKUP_STOP_CONTAINER "$STOP_CONTAINER"
bool_value BACKUP_ASSUME_QUIESCED "$ASSUME_QUIESCED"
case "$CONTAINER" in
  '' | *[!A-Za-z0-9_.-]*) die 'KASSINAO_CONTAINER possui caracteres inválidos' ;;
esac
command -v rclone >/dev/null 2>&1 || die 'rclone não instalado'
command -v python3 >/dev/null 2>&1 || die 'python3 não instalado'

for definition in \
  "KASSINAO_DATA_ROOT:$DATA_DIR" \
  "RECORDINGS_DIR:$REC_DIR" \
  "STATE_DIR:$STATE_DIR" \
  "AUTH_STATE_DIR:$AUTH_DIR" \
  "KASSINAO_MODEL_CACHE_DIR:$CACHE_DIR"; do
  name="${definition%%:*}"
  value="${definition#*:}"
  case "$value" in
    /*) ;;
    *) die "$name precisa ser um caminho absoluto" ;;
  esac
done

for dir in "$DATA_DIR" "$REC_DIR" "$STATE_DIR" "$AUTH_DIR" "$CACHE_DIR"; do
  [ -d "$dir" ] || die "diretório obrigatório não encontrado: $dir"
  [ ! -L "$dir" ] || die "diretório não pode ser link simbólico: $dir"
done
DATA_REAL="$(cd -- "$DATA_DIR" && pwd -P)"
REC_REAL="$(cd -- "$REC_DIR" && pwd -P)"
STATE_REAL="$(cd -- "$STATE_DIR" && pwd -P)"
AUTH_REAL="$(cd -- "$AUTH_DIR" && pwd -P)"
CACHE_REAL="$(cd -- "$CACHE_DIR" && pwd -P)"

# Um formato fixo torna o arquivo restaurável sem carregar caminhos do host e
# impede prefix bypass (/var/lib/kassinao-old, state/recordings, etc.).
[ "$REC_REAL" = "$DATA_REAL/recordings" ] || \
  die 'RECORDINGS_DIR precisa ser exatamente KASSINAO_DATA_ROOT/recordings'
[ "$STATE_REAL" = "$DATA_REAL/state" ] || \
  die 'STATE_DIR precisa ser exatamente KASSINAO_DATA_ROOT/state'
[ "$AUTH_REAL" = "$DATA_REAL/auth" ] || \
  die 'AUTH_STATE_DIR precisa ser exatamente KASSINAO_DATA_ROOT/auth'
[ "$CACHE_REAL" = "$DATA_REAL/cache" ] || \
  die 'KASSINAO_MODEL_CACHE_DIR precisa ser exatamente KASSINAO_DATA_ROOT/cache'
if [ "$HOST_SCOPE" = shared ]; then
  [ "$ENV_SHARED_APP_ENV" = "$DATA_REAL/config/app.env" ] || \
    die 'KASSINAO_SHARED_APP_ENV_FILE precisa ser DATA_ROOT/config/app.env'
fi
[ "$REC_REAL" != "$STATE_REAL" ] && [ "$REC_REAL" != "$AUTH_REAL" ] && [ "$STATE_REAL" != "$AUTH_REAL" ] || \
  die 'recordings, state e auth precisam ser diretórios distintos'

storage_ready || \
  die 'storage ativo não passou na prova dm-crypt/LUKS; backup cancelado'
rollback_ready || \
  die 'rollback plaintext inválido ou expirado; backup cancelado'
static_contract_ready || \
  die 'contrato estático shared divergiu; backup cancelado antes de parar o writer'

if [ ! -f "$RCLONE_CONFIG_FILE" ] || [ -L "$RCLONE_CONFIG_FILE" ]; then
  die 'RCLONE_CONFIG precisa ser um arquivo regular, não um link simbólico'
fi
case "$RCLONE_CONFIG_FILE" in
  /*) ;;
  *) die 'RCLONE_CONFIG precisa ser um caminho absoluto' ;;
esac
[ -O "$RCLONE_CONFIG_FILE" ] || die 'RCLONE_CONFIG precisa pertencer ao usuário atual'
config_mode="$(portable_mode "$RCLONE_CONFIG_FILE")"
if (( (8#$config_mode & 077) != 0 )); then
  die 'RCLONE_CONFIG permite acesso de grupo/outros; execute chmod 600'
fi
if [ "$HOST_SCOPE" = shared ]; then
  expected_rclone_config="$DATA_REAL/config/backup-upload-rclone.conf"
  [ "$RCLONE_CONFIG_FILE" = "$expected_rclone_config" ] || \
    die 'no adapter shared, RCLONE_CONFIG precisa ser DATA_ROOT/config/backup-upload-rclone.conf'
  [ "$(cd -- "$(dirname -- "$RCLONE_CONFIG_FILE")" && pwd -P)/$(basename -- "$RCLONE_CONFIG_FILE")" = "$RCLONE_CONFIG_FILE" ] || \
    die 'RCLONE_CONFIG shared precisa usar caminho canônico'
  [ "$(portable_link_count "$RCLONE_CONFIG_FILE")" = 1 ] || \
    die 'RCLONE_CONFIG shared não pode possuir hardlinks'
  config_parent="$(dirname -- "$RCLONE_CONFIG_FILE")"
  [ -d "$config_parent" ] && [ ! -L "$config_parent" ] && \
    [ "$(portable_mode "$config_parent"):$(portable_owner_group "$config_parent")" = "700:$(id -u):$(id -g)" ] || \
    die 'DATA_ROOT/config precisa ser diretório privado 0700 do operador'
  config_mount="$(findmnt -n -o TARGET -T "$RCLONE_CONFIG_FILE" 2>/dev/null)" || \
    die 'não foi possível provar o mount cifrado de RCLONE_CONFIG'
  [ "$(cd -- "$config_mount" && pwd -P)" = "$DATA_REAL" ] || \
    die 'RCLONE_CONFIG shared precisa permanecer no mesmo mount dm-crypt/LUKS de DATA_ROOT'
fi
case "$REMOTE" in
  *:*) ;;
  *) die 'RCLONE_REMOTE precisa usar a forma remoto:caminho' ;;
esac
remote_name_without_colon="${REMOTE%%:*}"
remote_path="${REMOTE#*:}"
[[ "$remote_name_without_colon" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || \
  die 'RCLONE_REMOTE usa nome de remoto inseguro'
[[ "$remote_path" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || \
  die 'RCLONE_REMOTE usa path remoto vazio ou inseguro'
case "/$remote_path/" in *'/../'* | *'/./'* | *'//'*) die 'RCLONE_REMOTE não aceita segmentos vazios, . ou ..' ;; esac

# O tar não é um snapshot transacional. Parar o único writer antes de
# enumerar arquivos é o que torna recordings + state coerentes entre si.
container_lookup_status=1
if command -v "$DOCKER" >/dev/null 2>&1; then
  if CONTAINER_ID="$(managed_container_id "$CONTAINER")"; then
    container_lookup_status=0
  else
    container_lookup_status=$?
  fi
fi
if [ "$container_lookup_status" -eq 2 ]; then
  die 'o nome reservado do core pertence a um container com identidade divergente; nenhuma mutação executada'
fi
if [ "$container_lookup_status" -eq 0 ]; then
  CONTAINER_IMAGE="$(docker_local inspect -f '{{.Config.Image}}' "$CONTAINER_ID" 2>/dev/null || true)"
  [[ "$CONTAINER_IMAGE" =~ ^ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] || \
    die 'a imagem existente do core não está presa a digest OCI seguro'
  mounts_json="$(docker_local inspect -f '{{json .Mounts}}' "$CONTAINER_ID" 2>/dev/null)" || \
    die 'não foi possível provar os mounts do core'
  python3 -c '
import json, os, sys
mounts=json.load(sys.stdin)
expected={
    "/app/recordings": (os.path.realpath(sys.argv[1]), True),
    "/app/state": (os.path.realpath(sys.argv[2]), True),
    "/app/auth": (os.path.realpath(sys.argv[3]), True),
    "/home/node/.cache": (os.path.realpath(sys.argv[4]), True),
}
if sys.argv[5] == "shared":
    expected["/run/secrets/kassinao-app.env"] = (os.path.realpath(sys.argv[6]), False)
    expected["/run/kassinao/storage-mounted"] = (os.path.realpath(sys.argv[7]), False)
found={}
for mount in mounts:
    target=mount.get("Destination")
    if target not in expected or target in found: raise SystemExit(1)
    if mount.get("Type") != "bind": raise SystemExit(1)
    found[target]=(os.path.realpath(mount.get("Source") or ""), bool(mount.get("RW")))
if found != expected: raise SystemExit(1)
' "$REC_REAL" "$STATE_REAL" "$AUTH_REAL" "$CACHE_REAL" "$HOST_SCOPE" "$ENV_SHARED_APP_ENV" "$DATA_REAL/.kassinao-mounted" <<<"$mounts_json" || \
    die 'o container indicado não possui exatamente os mounts privados selados'
  container_running="$(docker_local inspect -f '{{.State.Running}}' "$CONTAINER_ID")"
  case "$container_running" in
    true)
      if [ "$STOP_CONTAINER" != true ]; then
        die 'o core está rodando; pare-o ou use BACKUP_STOP_CONTAINER=true numa janela de manutenção'
      fi
      revalidate_container_id || die 'identidade do core mudou antes do stop; backup cancelado'
      [ "$(docker_local inspect -f '{{.Config.Image}}' "$CONTAINER_ID" 2>/dev/null || true)" = "$CONTAINER_IMAGE" ] || \
        die 'imagem do core mudou antes do stop; backup cancelado'
      RESTART_CONTAINER=true
      docker_local stop "$CONTAINER_ID" >/dev/null
      [ "$(docker_local inspect -f '{{.State.Running}}' "$CONTAINER_ID")" = false ] || \
        die 'o Docker não confirmou o core parado; backup cancelado'
      ;;
    false) ;;
    *) die 'o Docker não informou se o core está parado; backup cancelado' ;;
  esac
elif [ "$ASSUME_QUIESCED" != true ]; then
  die 'não foi possível confirmar o core parado; use BACKUP_ASSUME_QUIESCED=true somente com o writer realmente inativo'
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE_NAME="kassinao-$STAMP.tar.gz"
# The plaintext archive exists only while it is uploaded and verified. Keep it
# on the same host-encrypted filesystem as DATA_ROOT; /tmp may be unencrypted.
TMP="$(mktemp -d "$DATA_REAL/.backup.XXXXXX")"
ARCHIVE="$TMP/$ARCHIVE_NAME"
TREE_BEFORE="$TMP/tree.before.json"
TREE_AFTER="$TMP/tree.after.json"
REMOTE_ROOT="${REMOTE%/}"
printf '%s\n' \
  'format=kassinao-backup-v2' \
  "created_at_utc=$STAMP" \
  'contains=recordings,state' \
  'excludes=auth,session-secrets,temporary-files,caches' \
  > "$TMP/BACKUP-MANIFEST.txt"

inventory_backup_tree "$TREE_BEFORE" || \
  die 'recordings/state contêm entrada insegura ou mudaram durante o inventário'

# Nenhuma credencial rclone é aberta antes de provar, com o writer parado, que
# auth não foi hardlinkado/symlinkado para uma árvore incluída no snapshot.
remote_name="${REMOTE%%:*}:"
remote_type="$(
  clean_child rclone --config "$RCLONE_CONFIG_FILE" listremotes --long |
    awk -v wanted="$remote_name" '$1 == wanted { print $2; exit }'
)"
[ "$remote_type" = crypt ] || \
  die "$remote_name precisa ser um remoto do tipo crypt (tipo encontrado: ${remote_type:-nenhum})"

# Os únicos top-levels privados no arquivo são recordings/ e state/. Isso
# exclui auth/ por construção, inclusive quando surgirem novos arquivos nele.
COPYFILE_DISABLE=1 tar \
  --format=ustar \
  --exclude='./recordings/cache' \
  --exclude='./recordings/.cache' \
  --exclude='./state/cache' \
  --exclude='./state/.cache' \
  --exclude='*.tmp' \
  --exclude='*/.cookie-secret' \
  --exclude='*/.instance-id' \
  --exclude='*/.web-sessions.json' \
  --exclude='*/web-sessions.json' \
  --exclude='*/.mcp-sessions.json' \
  --exclude='*/mcp-sessions.json' \
  -czf "$ARCHIVE" \
  -C "$DATA_REAL" ./recordings ./state \
  -C "$TMP" ./BACKUP-MANIFEST.txt

inventory_backup_tree "$TREE_AFTER" || \
  die 'recordings/state contêm entrada insegura ou mudaram depois do tar'
cmp -s -- "$TREE_BEFORE" "$TREE_AFTER" || \
  die 'recordings/state mudaram durante a criação do snapshot'
validate_backup_archive "$ARCHIVE" "$TREE_AFTER" "$TMP/BACKUP-MANIFEST.txt" || \
  die 'arquivo local não corresponde ao inventário seguro do snapshot'

archive_listing="$TMP/archive.list"
tar -tzf "$ARCHIVE" > "$archive_listing"
grep -Fxq './recordings/' "$archive_listing" || die 'arquivo não contém recordings/'
grep -Fxq './state/' "$archive_listing" || die 'arquivo não contém state/'
grep -Fxq './BACKUP-MANIFEST.txt' "$archive_listing" || die 'arquivo não contém manifesto de restauração'
if grep -Eq '^\./auth(/|$)' "$archive_listing"; then
  die 'invariante violado: auth apareceu no arquivo'
fi

# O writer só precisa ficar parado até o tar local estar íntegro. A parte
# lenta (upload + download de verificação) acontece com o serviço novamente
# online e com o watchdog liberado; o lock exclusivo do job continua ativo.
if [ "$RESTART_CONTAINER" = true ]; then
  start_and_wait_healthy || die 'o core não voltou saudável após o snapshot; lock mantido'
  RESTART_CONTAINER=false
fi
flock -u 9
exec 9>&-

# Upload imutável e comparação ponta a ponta dos bytes criptografados.
clean_child rclone --config "$RCLONE_CONFIG_FILE" copyto \
  "$ARCHIVE" "$REMOTE_ROOT/$ARCHIVE_NAME" --immutable
clean_child rclone --config "$RCLONE_CONFIG_FILE" check \
  "$TMP" "$REMOTE_ROOT" \
  --include "/$ARCHIVE_NAME" --one-way --download --checkers 1

size="$(du -h "$ARCHIVE" | cut -f1)"
printf 'backup consistente e verificado: %s (%s)\n' "$ARCHIVE_NAME" "$size"
printf 'retenção: configure lifecycle/object lock no provedor; auth não foi copiado\n'
