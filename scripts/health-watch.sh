#!/usr/bin/env bash
# Watchdog host-side. O core é sempre obrigatório; public e tunnel entram no
# conjunto somente quando seus profiles estão ativos. O mesmo lock do backup
# impede que o watchdog religue o core no meio de um snapshot consistente.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
DEPLOY_DIR="${KASSINAO_DEPLOY_DIR:-$PROJECT_DIR}"
ENV_FILE="${KASSINAO_ENV_FILE:-$DEPLOY_DIR/.env}"
DOCKER="${DOCKER_BIN:-docker}"
SYSTEMCTL="${SYSTEMCTL_BIN:-systemctl}"
HARDENER="${KASSINAO_HARDENER:-/usr/local/sbin/kassinao-harden-docker-egress}"
STORAGE_VERIFIER="${KASSINAO_STORAGE_VERIFIER:-/usr/local/sbin/kassinao-verify-storage-encryption}"
EGRESS_UNIT=kassinao-docker-egress.service
CORE_CONTAINER="${KASSINAO_CONTAINER:-kassinao}"
PUBLIC_CONTAINER="${KASSINAO_PUBLIC_CONTAINER:-kassinao-public}"
TUNNEL_CONTAINER="${KASSINAO_TUNNEL_CONTAINER:-kassinao-tunnel}"

die() {
  printf 'ERRO: %s\n' "$*" >&2
  exit 1
}

for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$name" >/dev/null 2>&1; then
    die "$name não pode vir do ambiente; o watchdog exige o daemon local da VPS"
  fi
done
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION

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

# O diretório é provisionado uma vez no host. Não há fallback por usuário:
# deploy, backup e watchdog precisam abrir exatamente o mesmo lock. O watchdog
# obtém o lock antes de ler configuração ou estado que um deploy pode trocar.
RUNTIME_DIR="${KASSINAO_RUNTIME_DIR:-/run/lock/kassinao}"
case "$RUNTIME_DIR" in
  /*) ;;
  *) die 'KASSINAO_RUNTIME_DIR precisa ser um caminho absoluto' ;;
esac
[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] || die 'diretório de runtime inválido'
LOCK_FILE="$RUNTIME_DIR/maintenance.lock"
[ ! -L "$LOCK_FILE" ] || die 'lock não pode ser link simbólico'
exec 9>"$LOCK_FILE"
chmod 600 "$LOCK_FILE"
flock -n 9 || exit 0

require_egress() {
  if ! env -i "PATH=$PATH" "HOME=${HOME:-/root}" "$STORAGE_VERIFIER" >/dev/null; then
    die 'storage ativo não passou na prova dm-crypt/LUKS; watchdog não pode reiniciar containers'
  fi
  if ! "$SYSTEMCTL" is-active --quiet "$EGRESS_UNIT"; then
    die 'firewall de egress não está active; watchdog não pode reiniciar containers'
  fi
  if ! env \
    -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG -u DOCKER_TLS_VERIFY \
    -u DOCKER_CERT_PATH -u DOCKER_API_VERSION \
    "$HARDENER" --check >/dev/null; then
    die 'hardener não confirmou as regras de egress; watchdog não pode reiniciar containers'
  fi
}

# Gate inicial: nem a descoberta de perfis/estado começa se o serviço efetivo
# ou as regras no kernel divergirem. O gate é repetido imediatamente antes de
# cada restart para fechar a janela entre inspeção e mutação.
require_egress

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
  # pelo Compose sem enumerar o host. O caminho serve apenas para ler .env.
  COMPOSE_WORKDIR="$(
    "$DOCKER" inspect \
      --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
      "$CORE_CONTAINER" 2>/dev/null || true
  )"
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
  "$DOCKER" inspect "$PUBLIC_CONTAINER" >/dev/null 2>&1 && PROFILES=split-public
  if "$DOCKER" inspect "$TUNNEL_CONTAINER" >/dev/null 2>&1; then
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
  local role="$1" container="$2" state health started_at timestamp starting_age
  if ! "$DOCKER" inspect "$container" >/dev/null 2>&1; then
    printf 'ERRO: container obrigatório do perfil ausente: %s\n' "$role" >&2
    return 1
  fi
  IFS='|' read -r state health started_at < <(
    "$DOCKER" inspect \
      --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.StartedAt}}' \
      "$container"
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
      timestamp="$(date -Is 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf '%s reiniciando o componente %s: estado inválido\n' "$timestamp" "$role" >&2
      # Sem --timeout: respeita o StopTimeout configurado no container.
      "$DOCKER" restart "$container" >/dev/null
      ;;
    *)
      printf 'ERRO: estado inesperado no componente %s\n' "$role" >&2
      return 1
      ;;
  esac
}

status=0
watch_container core "$CORE_CONTAINER" || status=1
if profile_enabled split-public; then
  watch_container public "$PUBLIC_CONTAINER" || status=1
fi
if profile_enabled tunnel; then
  watch_container tunnel "$TUNNEL_CONTAINER" || status=1
fi
exit "$status"
