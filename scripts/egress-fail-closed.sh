#!/bin/bash -p
# Contém os componentes privados quando o hardening não pode ser aplicado.
# Stop failures não são ignorados: kill é o fallback e o estado final é provado.
set -Eeuo pipefail
umask 077

die() {
  printf 'ERRO: %s\n' "$*" >&2
  exit 1
}

# KASSINAO_HOST_ENV_SCRUB_BEGIN
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
_forbidden_override=''
for _name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION \
  KASSINAO_CONTAINER KASSINAO_TUNNEL_CONTAINER KASSINAO_RUNTIME_DIR; do
  if declare -p "$_name" >/dev/null 2>&1; then _forbidden_override="$_name"; break; fi
done
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente do fail-closed'
while IFS='=' read -r -d '' _name _value; do unset "$_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset _name _value
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C
[ -z "$_forbidden_override" ] || die "$_forbidden_override não pode vir do ambiente do fail-closed"
# KASSINAO_HOST_ENV_SCRUB_END

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do fail-closed não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in
  */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;;
  /usr/local/sbin)
    marker=/etc/kassinao/host-controls.env
    [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(stat -c '%a:%u:%g:%h' "$marker" 2>/dev/null || true)" = 600:0:0:1 ] ||
      die 'marker do kit operacional está ausente ou irregular'
    PROJECT_DIR="$(awk -F= '$1 == "KASSINAO_DEPLOY_DIR" { if (seen++) exit 2; print substr($0, index($0,"=")+1) } END { if (seen != 1) exit 2 }' "$marker")" ||
      die 'marker do kit não contém deploy dir único'
    _script_path="$PROJECT_DIR/scripts/egress-fail-closed.sh"
    ;;
  *) die 'fail-closed precisa executar do kit ou do entrypoint instalado' ;;
esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/egress-fail-closed.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do fail-closed não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[ "$_no_dump_filter" = 0 ] || die 'coredump_filter do fail-closed não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$(id -u)" -eq 0 ] || { echo 'ERRO: execute como root' >&2; exit 1; }
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
DOCKER_CONFIG="$PROJECT_DIR/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] ||
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] ||
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG
command -v docker >/dev/null 2>&1 || { echo 'ERRO: docker não encontrado' >&2; exit 1; }
command -v flock >/dev/null 2>&1 || die 'flock não encontrado'

RUNTIME_DIR=/run/lock/kassinao
[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] &&
  [ "$(readlink -f -- "$RUNTIME_DIR" 2>/dev/null || true)" = "$RUNTIME_DIR" ] &&
  [ "$(stat -c '%a:%u:%g' "$RUNTIME_DIR" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'diretório de runtime precisa preexistir como 0700 root:root canônico'
LOCK_FILE="$RUNTIME_DIR/maintenance.lock"
[ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] &&
  [ "$(readlink -f -- "$LOCK_FILE" 2>/dev/null || true)" = "$LOCK_FILE" ] &&
  [ "$(stat -c '%a:%u:%g:%h' "$LOCK_FILE" 2>/dev/null || true)" = 600:0:0:1 ] ||
  die 'maintenance.lock precisa preexistir como regular 0600 root:root sem hardlink'
exec 9<>"$LOCK_FILE"
# KASSINAO_LOCK_FD_PROOF_BEGIN
[ "$(stat -Lc '%a:%u:%g:%h' "/proc/$$/fd/9" 2>/dev/null || true)" = 600:0:0:1 ] &&
  [ "$(readlink -f -- "/proc/$$/fd/9" 2>/dev/null || true)" = "$LOCK_FILE" ] &&
  [ "$(stat -c '%d:%i' "$LOCK_FILE" 2>/dev/null || true)" = "$(stat -Lc '%d:%i' "/proc/$$/fd/9" 2>/dev/null || true)" ] ||
  die 'maintenance.lock mudou durante a abertura'
# KASSINAO_LOCK_FD_PROOF_END
flock -w 30 9 || die 'outra manutenção do Kassinão está em andamento'

status=0
for pair in kassinao:kassinao kassinao-tunnel:cloudflared; do
  container="${pair%%:*}"
  expected_service="${pair#*:}"
  cid="$(docker inspect --format '{{.Id}}' "$container" 2>/dev/null)" || continue
  if [[ ! "$cid" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERRO: identidade inválida para $container; nenhuma mutação executada" >&2
    status=1
    continue
  fi
  identity="$(docker inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$cid" 2>/dev/null || true)"
  IFS='|' read -r actual_id actual_name actual_project actual_service extra <<<"$identity"
  if [ -n "$extra" ] || [ "$actual_id" != "$cid" ] || [ "$actual_name" != "/$container" ] || \
    [ "$actual_project" != kassinao ] || [ "$actual_service" != "$expected_service" ]; then
    echo "ERRO: $container não pertence ao projeto/serviço esperado; nenhuma mutação executada" >&2
    status=1
    continue
  fi
  if ! docker stop --time 30 "$cid" >/dev/null 2>&1; then
    docker kill "$cid" >/dev/null 2>&1 || status=1
    # docker kill pode acionar a restart policy. Um segundo stop registra uma
    # parada administrativa e mantém o container desligado até ação explícita.
    docker stop --time 10 "$cid" >/dev/null 2>&1 || true
  fi
  running="$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || true)"
  if [ "$running" = true ] || [ -z "$running" ]; then
    echo "ERRO: não foi possível provar $container parado" >&2
    status=1
  fi
done

[ "$status" -eq 0 ] || exit 1
echo 'Componentes privados confirmados como parados após falha de egress.'
