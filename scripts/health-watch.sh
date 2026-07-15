#!/bin/bash -p
# Watchdog host-side. O core é sempre obrigatório; public e tunnel entram no
# conjunto somente quando seus profiles estão ativos. O mesmo lock do backup
# impede que o watchdog religue o core no meio de um snapshot consistente.
set -euo pipefail
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
  DOCKER_BIN SYSTEMCTL_BIN KASSINAO_HARDENER KASSINAO_STORAGE_VERIFIER KASSINAO_SHARED_AUDITOR \
  KASSINAO_RUNTIME_DIR KASSINAO_CONTAINER KASSINAO_PUBLIC_CONTAINER KASSINAO_TUNNEL_CONTAINER; do
  if declare -p "$_name" >/dev/null 2>&1; then _forbidden_override="$_name"; break; fi
done
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente do watchdog'
while IFS='=' read -r -d '' _name _value; do unset "$_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset _name _value
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C
[ -z "$_forbidden_override" ] || die "$_forbidden_override não pode vir do ambiente do watchdog"
# KASSINAO_HOST_ENV_SCRUB_END

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do watchdog não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in
  */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;;
  /usr/local/sbin)
    marker=/etc/kassinao/host-controls.env
    [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(stat -c '%a:%u:%g:%h' "$marker" 2>/dev/null || true)" = 600:0:0:1 ] ||
      die 'marker do kit operacional está ausente ou irregular'
    PROJECT_DIR="$(awk -F= '$1 == "KASSINAO_DEPLOY_DIR" { if (seen++) exit 2; print substr($0, index($0,"=")+1) } END { if (seen != 1) exit 2 }' "$marker")" ||
      die 'marker do kit não contém deploy dir único'
    _script_path="$PROJECT_DIR/scripts/health-watch.sh"
    ;;
  *) die 'watchdog precisa executar do kit ou do entrypoint instalado' ;;
esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/health-watch.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do watchdog não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter do watchdog não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

SCRIPT_DIR="$PROJECT_DIR/scripts"
DEPLOY_DIR="$PROJECT_DIR"
ENV_FILE="$DEPLOY_DIR/.env"
DOCKER=docker
SYSTEMCTL=systemctl
HARDENER="$DEPLOY_DIR/scripts/harden-docker-egress.sh"
EGRESS_UNIT=kassinao-docker-egress.service
CORE_CONTAINER=kassinao
PUBLIC_CONTAINER=kassinao-public
TUNNEL_CONTAINER=kassinao-tunnel
env_value() {
  local key="$1"
  awk -v key="$key" 'index($0, key "=") == 1 { count++; value=substr($0,length(key)+2) } END { if (count > 1) exit 2; print value }' "$ENV_FILE" ||
    die "$key não pode aparecer mais de uma vez no .env"
}
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || die '.env selado ausente ou symlink'
FIREWALL_SCOPE="$(env_value KASSINAO_HOST_SCOPE)"
[ -n "$FIREWALL_SCOPE" ] || FIREWALL_SCOPE=dedicated
COMPOSE_PROFILES="$(env_value COMPOSE_PROFILES)"
case "$FIREWALL_SCOPE" in
  dedicated)
    STORAGE_VERIFIER="$DEPLOY_DIR/scripts/verify-storage-encryption.sh"
    SHARED_AUDITOR=''
    SHARED_AUDIT_ENV_FILE=''
    ;;
  shared)
    STORAGE_VERIFIER="$DEPLOY_DIR/scripts/verify-shared-luks-storage.sh"
    SHARED_AUDITOR="$DEPLOY_DIR/scripts/audit-shared-vps-security.sh"
    SHARED_AUDIT_ENV_FILE="$ENV_FILE"
    ;;
  *) die 'KASSINAO_HOST_SCOPE aceita somente dedicated ou shared' ;;
esac
HARDENER_SCOPE_ARGS=()

case "$FIREWALL_SCOPE" in
  dedicated) ;;
  shared)
    HARDENER_SCOPE_ARGS+=(--shared-host)
    case "$SHARED_AUDITOR:$SHARED_AUDIT_ENV_FILE" in
      /*:/*) ;;
      *) die 'shared exige paths absolutos para auditor e .env selados' ;;
    esac
    [ -f "$SHARED_AUDITOR" ] && [ -x "$SHARED_AUDITOR" ] && [ ! -L "$SHARED_AUDITOR" ] ||
      die 'auditor shared selado ausente, sem execução ou symlink'
    [ -f "$SHARED_AUDIT_ENV_FILE" ] && [ ! -L "$SHARED_AUDIT_ENV_FILE" ] ||
      die '.env selado do auditor shared ausente ou symlink'
    ;;
  *) die 'KASSINAO_FIREWALL_SCOPE aceita somente dedicated ou shared' ;;
esac

export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
DOCKER_CONFIG="$DEPLOY_DIR/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && \
  [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] ||
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] ||
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG

for container in "$CORE_CONTAINER" "$PUBLIC_CONTAINER" "$TUNNEL_CONTAINER"; do
  case "$container" in
    '' | *[!A-Za-z0-9_.-]*) die 'nome de container inválido' ;;
  esac
done
command -v flock >/dev/null 2>&1 || die 'flock não instalado'
command -v "$DOCKER" >/dev/null 2>&1 || die 'docker não encontrado'
command -v "$SYSTEMCTL" >/dev/null 2>&1 || die 'systemctl não encontrado'
command -v env >/dev/null 2>&1 || die 'env não encontrado'
command -v python3 >/dev/null 2>&1 || die 'python3 não encontrado'
[ -x "$HARDENER" ] && [ ! -L "$HARDENER" ] || die 'hardener de egress ausente, sem execução ou symlink'
[ -x "$STORAGE_VERIFIER" ] && [ ! -L "$STORAGE_VERIFIER" ] || die 'verificador de storage ausente, sem execução ou symlink'
STARTING_MAX_SECONDS="${HEALTH_STARTING_MAX_SECONDS:-300}"
[[ "$STARTING_MAX_SECONDS" =~ ^[1-9][0-9]*$ ]] || die 'HEALTH_STARTING_MAX_SECONDS precisa ser inteiro positivo'

# Resolva o nome apenas para descobrir o ID completo. Toda leitura de estado e
# toda mutação posterior usa esse ID e repete a prova de nome + labels Compose.
# Um container alheio que ocupe um nome reservado nunca é reiniciado.
managed_container_id() {
  local reference="$1" container="$2" expected_service="$3" candidate identity
  local actual_id actual_name actual_project actual_service extra
  candidate="$("$DOCKER" inspect --format '{{.Id}}' "$reference" 2>/dev/null)" || return 1
  [[ "$candidate" =~ ^[0-9a-f]{64}$ ]] || return 2
  identity="$(
    "$DOCKER" inspect \
      --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
      "$candidate" 2>/dev/null
  )" || return 2
  IFS='|' read -r actual_id actual_name actual_project actual_service extra <<<"$identity"
  [ -z "$extra" ] && [ "$actual_id" = "$candidate" ] && [ "$actual_name" = "/$container" ] && \
    [ "$actual_project" = kassinao ] && [ "$actual_service" = "$expected_service" ] || return 2
  printf '%s\n' "$candidate"
}

# O diretório é provisionado uma vez no host. Não há fallback por usuário:
# deploy, backup e watchdog precisam abrir exatamente o mesmo lock. O watchdog
# obtém o lock antes de ler configuração ou estado que um deploy pode trocar.
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
flock -n 9 || exit 0

require_egress() {
  local -a storage_environment=(env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" \
    "LD_PRELOAD=${LD_PRELOAD-}" "KASSINAO_ENV_FILE=$ENV_FILE")
  if ! "${storage_environment[@]}" "$STORAGE_VERIFIER" >/dev/null; then
    die 'storage ativo não passou na prova dm-crypt/LUKS; watchdog não pode reiniciar containers'
  fi
  if ! "$SYSTEMCTL" is-active --quiet "$EGRESS_UNIT"; then
    die 'firewall de egress não está active; watchdog não pode reiniciar containers'
  fi
  if ! env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" \
    "$HARDENER" "${HARDENER_SCOPE_ARGS[@]}" --check >/dev/null; then
    die 'hardener não confirmou as regras de egress; watchdog não pode reiniciar containers'
  fi
}

require_static_container_contract() {
  local existing_image="${1:-}"
  local existing_service="${2:-}"
  [ "$FIREWALL_SCOPE" = shared ] || return 0
  local -a contract_args=(--preflight)
  if [ "$existing_service" = cloudflared ]; then
    contract_args+=(--require-current-images)
  elif [ -n "$existing_image" ]; then
    contract_args+=(--expected-existing-image "$existing_image")
  fi
  if ! env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" \
    "KASSINAO_ENV_FILE=$SHARED_AUDIT_ENV_FILE" \
    "$SHARED_AUDITOR" "${contract_args[@]}" >/dev/null; then
    die 'contrato estático shared divergiu; watchdog não pode reiniciar containers'
  fi
}

# Gate inicial: nem a descoberta de perfis/estado começa se o serviço efetivo
# ou as regras no kernel divergirem. O gate é repetido imediatamente antes de
# cada restart para fechar a janela entre inspeção e mutação.
require_egress
require_static_container_contract

env_value() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  awk -F= -v wanted="$key" '
    $0 !~ /^[[:space:]]*#/ && $1 == wanted {
      sub(/^[^=]*=/, "")
      sub(/\r$/, "")
      value=$0
    }
    END { print value }
  ' "$file"
}

PROFILES_KNOWN=false
if [ "${COMPOSE_PROFILES+x}" = x ]; then
  PROFILES="$COMPOSE_PROFILES"
  PROFILES_KNOWN=true
elif [ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ]; then
  PROFILES="$(env_value COMPOSE_PROFILES "$ENV_FILE")"
  PROFILES_KNOWN=true
else
  PROFILES=''
fi
if [ "$PROFILES_KNOWN" != true ]; then
  # Quando o script foi instalado em /usr/local, descobre a raiz registrada
  # pelo Compose sem enumerar o host. O caminho serve apenas para ler .env e
  # só é aceito depois de provar a identidade do core pelo ID imutável.
  DISCOVERY_CORE_ID=''
  DISCOVERY_CORE_ID="$(managed_container_id "$CORE_CONTAINER" "$CORE_CONTAINER" kassinao 2>/dev/null || true)"
  COMPOSE_WORKDIR=''
  if [ -n "$DISCOVERY_CORE_ID" ]; then
    COMPOSE_WORKDIR="$(
      "$DOCKER" inspect \
        --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
        "$DISCOVERY_CORE_ID" 2>/dev/null || true
    )"
  fi
  case "$COMPOSE_WORKDIR" in
    /*)
      discovered_env="$COMPOSE_WORKDIR/.env"
      if [ -f "$discovered_env" ] && [ ! -L "$discovered_env" ]; then
        PROFILES="$(env_value COMPOSE_PROFILES "$discovered_env")"
        PROFILES_KNOWN=true
      fi
      ;;
  esac
fi
if [ "$PROFILES_KNOWN" != true ]; then
  # Compatibilidade com containers antigos sem o label acima: componentes
  # opcionais que ainda existem são tratados como ativos, nunca ignorados.
  managed_container_id "$PUBLIC_CONTAINER" "$PUBLIC_CONTAINER" kassinao-public >/dev/null 2>&1 && \
    PROFILES=split-public
  if managed_container_id "$TUNNEL_CONTAINER" "$TUNNEL_CONTAINER" cloudflared >/dev/null 2>&1; then
    PROFILES="${PROFILES:+$PROFILES,}tunnel"
  fi
fi
profile_enabled() {
  local wanted="$1" profile
  IFS=',' read -r -a configured_profiles <<<"$PROFILES"
  for profile in "${configured_profiles[@]}"; do
    profile="${profile#${profile%%[![:space:]]*}}"
    profile="${profile%${profile##*[![:space:]]}}"
    [ "$profile" = "$wanted" ] && return 0
  done
  return 1
}

watch_container() {
  local role="$1" container="$2" expected_service="$3" cid confirmed_cid state health started_at timestamp starting_age existing_image
  if ! cid="$(managed_container_id "$container" "$container" "$expected_service")"; then
    printf 'ERRO: container obrigatório do perfil ausente ou com identidade divergente: %s\n' "$role" >&2
    return 1
  fi
  IFS='|' read -r state health started_at < <(
    "$DOCKER" inspect \
      --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.StartedAt}}' \
      "$cid"
  )
  case "$state:$health" in
    running:healthy)
      return 0
      ;;
    running:none)
      if [ "$role" = tunnel ]; then return 0; fi
      printf 'ERRO: componente %s está sem healthcheck obrigatório\n' "$role" >&2
      return 1
      ;;
    running:starting)
      starting_age="$(python3 - "$started_at" <<'PY'
from datetime import datetime, timezone
import sys
try:
    started = datetime.fromisoformat(sys.argv[1].replace('Z', '+00:00'))
    print(max(0, int((datetime.now(timezone.utc) - started).total_seconds())))
except Exception:
    raise SystemExit(1)
PY
      )" || {
        printf 'ERRO: não foi possível medir há quanto tempo %s está starting\n' "$role" >&2
        return 1
      }
      if [ "$starting_age" -le "$STARTING_MAX_SECONDS" ]; then return 0; fi
      printf 'ERRO: componente %s permaneceu starting além da janela segura\n' "$role" >&2
      return 1
      ;;
    restarting:*)
      printf 'ERRO: componente %s está em crash-loop/restarting\n' "$role" >&2
      return 1
      ;;
    running:unhealthy | exited:* | dead:* | created:*)
      require_egress
      existing_image="$("$DOCKER" inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
      [[ "$existing_image" =~ ^[a-z0-9][a-z0-9._/-]*(:[0-9A-Za-z._-]+)?@sha256:[0-9a-f]{64}$ ]] || {
        printf 'ERRO: imagem existente do componente %s não está presa a digest seguro\n' "$role" >&2
        return 1
      }
      require_static_container_contract "$existing_image" "$expected_service"
      confirmed_cid="$(managed_container_id "$cid" "$container" "$expected_service")" || {
        printf 'ERRO: identidade do componente %s mudou antes do restart\n' "$role" >&2
        return 1
      }
      [ "$confirmed_cid" = "$cid" ] || {
        printf 'ERRO: ID do componente %s mudou antes do restart\n' "$role" >&2
        return 1
      }
      [ "$("$DOCKER" inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)" = "$existing_image" ] || {
        printf 'ERRO: imagem do componente %s mudou antes do restart\n' "$role" >&2
        return 1
      }
      timestamp="$(date -Is 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf '%s reiniciando o componente %s: estado inválido\n' "$timestamp" "$role" >&2
      # Sem --timeout: respeita o StopTimeout configurado no container.
      "$DOCKER" restart "$cid" >/dev/null
      ;;
    *)
      printf 'ERRO: estado inesperado no componente %s\n' "$role" >&2
      return 1
      ;;
  esac
}

status=0
watch_container core "$CORE_CONTAINER" kassinao || status=1
if profile_enabled split-public; then
  watch_container public "$PUBLIC_CONTAINER" kassinao-public || status=1
fi
if profile_enabled tunnel; then
  watch_container tunnel "$TUNNEL_CONTAINER" cloudflared || status=1
fi
exit "$status"
