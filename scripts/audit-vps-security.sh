#!/bin/bash -p
# Gate de segurança da instância. O relatório fica em DEPLOY_DIR/audit com
# modo 0600 e registra somente invariantes/pass-fail: não enumera outros apps,
# containers, arquivos, regras completas, IPs ou valores de ambiente do host.
set -uo pipefail
umask 077

fatal() { printf 'ERRO: %s\n' "$*" >&2; exit 2; }

_saved_deploy_dir="${KASSINAO_DEPLOY_DIR-}"
_saved_report_name="${KASSINAO_AUDIT_REPORT_NAME-}"
_saved_allowed_tcp="${KASSINAO_ALLOWED_PUBLIC_TCP_PORTS-}"
_saved_allowed_udp="${KASSINAO_ALLOWED_PUBLIC_UDP_PORTS-}"
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
_inherited_docker_environment_name=''
for _inherited_name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$_inherited_name" >/dev/null 2>&1; then
    _inherited_docker_environment_name="$_inherited_name"
    break
  fi
done
[ -r "/proc/$$/environ" ] || fatal '/proc é obrigatório para limpar o ambiente do audit dedicado'
while IFS='=' read -r -d '' _inherited_name _inherited_value; do
  unset "$_inherited_name" 2>/dev/null || true
done < "/proc/$$/environ"
unset _inherited_name _inherited_value
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C
[ -z "$_inherited_docker_environment_name" ] || \
  fatal "$_inherited_docker_environment_name não pode vir do ambiente; o audit exige o daemon local da VPS"
if [ -n "$_saved_deploy_dir" ]; then KASSINAO_DEPLOY_DIR="$_saved_deploy_dir"; export KASSINAO_DEPLOY_DIR; fi
if [ -n "$_saved_report_name" ]; then KASSINAO_AUDIT_REPORT_NAME="$_saved_report_name"; export KASSINAO_AUDIT_REPORT_NAME; fi
if [ -n "$_saved_allowed_tcp" ]; then KASSINAO_ALLOWED_PUBLIC_TCP_PORTS="$_saved_allowed_tcp"; export KASSINAO_ALLOWED_PUBLIC_TCP_PORTS; fi
if [ -n "$_saved_allowed_udp" ]; then KASSINAO_ALLOWED_PUBLIC_UDP_PORTS="$_saved_allowed_udp"; export KASSINAO_ALLOWED_PUBLIC_UDP_PORTS; fi

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) fatal 'caminho do audit dedicado não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) fatal 'audit dedicado precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) fatal 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/audit-vps-security.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || fatal 'core limit do audit dedicado não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[ "$_no_dump_filter" = 0 ] || fatal 'coredump_filter do audit dedicado não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir
[ "$EUID" -eq 0 ] || fatal 'execute o audit como root'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_DIR="${_saved_deploy_dir:-$(cd -- "$SCRIPT_DIR/.." && pwd -P)}"
case "$DEPLOY_DIR" in
  /*) ;;
  *) printf 'ERRO: KASSINAO_DEPLOY_DIR precisa ser absoluto\n' >&2; exit 2 ;;
esac
if [ ! -d "$DEPLOY_DIR" ] || [ -L "$DEPLOY_DIR" ]; then
  printf 'ERRO: diretório operacional ausente ou symlink\n' >&2
  exit 2
fi
DEPLOY_REAL="$(cd -- "$DEPLOY_DIR" && pwd -P)"
if [ "$DEPLOY_REAL" != "$DEPLOY_DIR" ]; then
  printf 'ERRO: KASSINAO_DEPLOY_DIR precisa ser o caminho canônico\n' >&2
  exit 2
fi
[ "$DEPLOY_REAL" = "$PROJECT_DIR" ] || fatal 'KASSINAO_DEPLOY_DIR precisa apontar exatamente para o kit selado'
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
DOCKER_CONFIG="$DEPLOY_REAL/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && \
  [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] || \
  fatal 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] || \
  fatal 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG
cursor="$DEPLOY_REAL"
while :; do
  if [ -e "$cursor/.git" ]; then
    printf 'ERRO: o diretório operacional não pode ficar dentro de Git\n' >&2
    exit 2
  fi
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done

REPORT_DIR="$DEPLOY_REAL/audit"
if [ -L "$REPORT_DIR" ]; then
  printf 'ERRO: o diretório de relatório não pode ser symlink\n' >&2
  exit 2
fi
install -d -m 0700 "$REPORT_DIR"
chmod 0700 "$REPORT_DIR"
[ -O "$REPORT_DIR" ] || {
  printf 'ERRO: o diretório de relatório precisa pertencer ao usuário atual\n' >&2
  exit 2
}
REPORT_NAME="${_saved_report_name:-security-$(date -u +%Y%m%d-%H%M%S)-$$.log}"
case "$REPORT_NAME" in
  '' | *[!A-Za-z0-9._-]*) printf 'ERRO: nome de relatório inválido\n' >&2; exit 2 ;;
esac
REPORT_FILE="$REPORT_DIR/$REPORT_NAME"
if ! (set -o noclobber; : > "$REPORT_FILE") 2>/dev/null; then
  printf 'ERRO: o arquivo de relatório já existe ou não é seguro\n' >&2
  exit 2
fi
chmod 0600 "$REPORT_FILE"
exec 3>&1
exec >> "$REPORT_FILE" 2>&1
publish_report() {
  local status=$?
  trap - EXIT
  chmod 0600 "$REPORT_FILE"
  cat "$REPORT_FILE" >&3
  exit "$status"
}
trap publish_report EXIT

FAILURES=0
WARNINGS=0
ALLOWED_PUBLIC_TCP_PORTS="${_saved_allowed_tcp:-22}"
ALLOWED_PUBLIC_UDP_PORTS="${_saved_allowed_udp:-}"
ENV_FILE="$DEPLOY_REAL/.env"
CORE_CONTAINER=kassinao
PUBLIC_CONTAINER=kassinao-public
TUNNEL_CONTAINER=kassinao-tunnel
CORE_NETWORKS=''
PUBLIC_NETWORKS=''

for container_name in "$CORE_CONTAINER" "$PUBLIC_CONTAINER" "$TUNNEL_CONTAINER"; do
  case "$container_name" in
    '' | *[!A-Za-z0-9_.-]*) fatal 'nome de container configurado é inválido' ;;
  esac
done
[ "$CORE_CONTAINER" != "$PUBLIC_CONTAINER" ] && [ "$CORE_CONTAINER" != "$TUNNEL_CONTAINER" ] && \
  [ "$PUBLIC_CONTAINER" != "$TUNNEL_CONTAINER" ] || fatal 'nomes dos containers precisam ser distintos'

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
warn() { printf 'WARN  %s\n' "$1"; WARNINGS=$((WARNINGS + 1)); }
section() { printf '\n=== %s ===\n' "$1"; }
portable_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
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
container_env_value() {
  local container="$1" key="$2"
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null |
    awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }'
}
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
allowed_port() {
  local wanted="$1" configured="${2// /,}"
  case ",$configured," in
    *",$wanted,"*) return 0 ;;
    *) return 1 ;;
  esac
}

section REPORT
pass 'relatório privado criado com modo 0600'
printf 'timestamp_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

section DEPLOYMENT_FILES
MANIFEST_FILE="$DEPLOY_REAL/MANIFEST.sha256"
if [ -f "$MANIFEST_FILE" ] && [ ! -L "$MANIFEST_FILE" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    (cd -- "$DEPLOY_REAL" && sha256sum -c MANIFEST.sha256 --quiet) \
      && pass 'kit operacional corresponde ao manifesto selado' \
      || fail 'kit operacional diverge do manifesto selado'
  else
    (cd -- "$DEPLOY_REAL" && shasum -a 256 -c MANIFEST.sha256 >/dev/null) \
      && pass 'kit operacional corresponde ao manifesto selado' \
      || fail 'kit operacional diverge do manifesto selado'
  fi
else
  fail 'MANIFEST.sha256 do kit está ausente ou irregular'
fi
DEPLOY_MODE="$(portable_mode "$DEPLOY_REAL" 2>/dev/null || true)"
if [ -n "$DEPLOY_MODE" ] && (( (8#$DEPLOY_MODE & 077) == 0 )); then
  pass 'diretório operacional nega grupo/outros'
else
  fail 'diretório operacional precisa negar grupo/outros'
fi
if [ "$(stat -c '%u:%g' "$DEPLOY_REAL" 2>/dev/null || true)" = '0:0' ]; then
  pass 'diretório operacional pertence a root:root'
else
  fail 'diretório operacional precisa pertencer a root:root'
fi
if [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
  fail '.env operacional ausente, irregular ou symlink'
else
  ENV_REAL="$(cd -- "$(dirname -- "$ENV_FILE")" && pwd -P)/$(basename -- "$ENV_FILE")"
  [ "$ENV_REAL" = "$DEPLOY_REAL/.env" ] || fail '.env precisa ser exatamente DEPLOY_DIR/.env'
  ENV_MODE="$(portable_mode "$ENV_FILE" 2>/dev/null || true)"
  case "$ENV_MODE" in
    600 | 400) pass '.env operacional está privado' ;;
    *) fail '.env operacional precisa usar modo 0600 ou 0400' ;;
  esac
fi

APP_ENV_NAME="$(env_value KASSINAO_APP_ENV_FILE "$ENV_FILE")"
APP_ENV_NAME="${APP_ENV_NAME:-app.env}"
case "$APP_ENV_NAME" in
  '' | */* | .* | *[!A-Za-z0-9._-]*) fail 'KASSINAO_APP_ENV_FILE precisa ser um nome local simples'; APP_ENV_FILE='' ;;
  *) APP_ENV_FILE="$DEPLOY_REAL/$APP_ENV_NAME" ;;
esac
if [ -n "$APP_ENV_FILE" ]; then
  if [ ! -f "$APP_ENV_FILE" ] || [ -L "$APP_ENV_FILE" ]; then
    fail 'arquivo privado do core ausente, irregular ou symlink'
  else
    APP_ENV_MODE="$(portable_mode "$APP_ENV_FILE" 2>/dev/null || true)"
    case "$APP_ENV_MODE" in
      600 | 400) pass 'arquivo privado do core está restrito' ;;
      *) fail 'arquivo privado do core precisa usar modo 0600 ou 0400' ;;
    esac
  fi
fi

EXPECTED_IMAGE="$(env_value KASSINAO_IMAGE "$ENV_FILE")"
EXPECTED_RELEASE="$(env_value KASSINAO_RELEASE_DIGEST "$ENV_FILE")"
EXPECTED_DEPLOYMENT="$(env_value KASSINAO_DEPLOYMENT_FINGERPRINT "$ENV_FILE")"
HOST_SCOPE="$(env_value KASSINAO_HOST_SCOPE "$ENV_FILE")"
DEDICATED_HOST_ACK="$(env_value KASSINAO_DEDICATED_DOCKER_HOST_ACK "$ENV_FILE")"
ROLLBACK_RETENTION_HOURS="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS "$ENV_FILE")"
if [[ "$EXPECTED_IMAGE" =~ ^ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] && \
   [[ "$EXPECTED_RELEASE" =~ ^sha256:[0-9a-f]{64}$ ]] && \
   [ "${EXPECTED_IMAGE##*@}" = "$EXPECTED_RELEASE" ] && \
   [[ "$EXPECTED_DEPLOYMENT" =~ ^[0-9a-f]{32}$ ]]; then
  pass 'imagem, release e fingerprint do deploy estão selados no ambiente privado'
else
  fail 'imagem, release ou fingerprint do deploy são inválidos/divergentes'
fi
if [ "$HOST_SCOPE" = dedicated ]; then
  pass 'auditoria dedicada recebeu KASSINAO_HOST_SCOPE=dedicated'
else
  fail 'audit-vps-security.sh pertence somente ao adapter dedicated'
fi
if [ "$DEDICATED_HOST_ACK" = I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO ]; then
  pass 'operador reconheceu que os pre-hooks controlam o Docker inteiro em VPS dedicada'
else
  fail 'aceite explícito de VPS dedicada para o Docker está ausente'
fi
if [[ "$ROLLBACK_RETENTION_HOURS" =~ ^[1-9][0-9]*$ ]] && [ "$ROLLBACK_RETENTION_HOURS" -le 168 ] && \
   [ -n "$APP_ENV_FILE" ] && \
   [ "$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS "$APP_ENV_FILE")" = "$ROLLBACK_RETENTION_HOURS" ]; then
  pass 'janela de rollback 1..168h coincide entre Compose e core privado'
else
  fail 'janela de rollback precisa ser 1..168h e coincidir entre .env e app.env'
fi
DEPLOYED_IMAGE_FILE="$DEPLOY_REAL/.deployed-image"
if [ -f "$DEPLOYED_IMAGE_FILE" ] && [ ! -L "$DEPLOYED_IMAGE_FILE" ] && \
   [ "$(tr -d '\r\n' < "$DEPLOYED_IMAGE_FILE")" = "$EXPECTED_IMAGE" ]; then
  pass 'registro local do último deploy corresponde ao digest configurado'
else
  fail 'registro .deployed-image ausente ou divergente'
fi

DATA_ROOT="$(env_value KASSINAO_DATA_ROOT "$ENV_FILE")"
RECORDINGS_DIR="$(env_value KASSINAO_RECORDINGS_DIR "$ENV_FILE")"
STATE_DIR="$(env_value KASSINAO_STATE_DIR "$ENV_FILE")"
AUTH_DIR="$(env_value KASSINAO_AUTH_DIR "$ENV_FILE")"
CACHE_DIR="$(env_value KASSINAO_MODEL_CACHE_DIR "$ENV_FILE")"
EXPECTED_UID="$(env_value KASSINAO_UID "$ENV_FILE")"
EXPECTED_GID="$(env_value KASSINAO_GID "$ENV_FILE")"
if ! [[ "$EXPECTED_UID" =~ ^[1-9][0-9]*$ ]] || ! [[ "$EXPECTED_GID" =~ ^[1-9][0-9]*$ ]]; then
  fail 'KASSINAO_UID e KASSINAO_GID precisam identificar usuário/grupo não-root'
elif [ "$(stat -c '%u:%g' "$ENV_FILE" 2>/dev/null || true)" = '0:0' ] && \
     [ -n "$APP_ENV_FILE" ] && [ "$(stat -c '%u:%g' "$APP_ENV_FILE" 2>/dev/null || true)" = '0:0' ]; then
  pass 'arquivos de ambiente pertencem somente a root:root'
else
  fail 'arquivos de ambiente precisam pertencer a root:root; o UID/GID configurado pertence apenas ao runtime'
fi
if [ -z "$DATA_ROOT" ] || [ -z "$RECORDINGS_DIR" ] || [ -z "$STATE_DIR" ] || [ -z "$AUTH_DIR" ] || [ -z "$CACHE_DIR" ]; then
  fail 'DATA_ROOT e os quatro diretórios privados precisam estar explícitos no .env'
  DATA_ROOT=''
elif [ "$RECORDINGS_DIR" != "$DATA_ROOT/recordings" ] || \
     [ "$STATE_DIR" != "$DATA_ROOT/state" ] || \
     [ "$AUTH_DIR" != "$DATA_ROOT/auth" ] || \
     [ "$CACHE_DIR" != "$DATA_ROOT/cache" ]; then
  fail 'mounts privados precisam ser filhos exatos DATA_ROOT/{recordings,state,auth,cache}'
else
  case "$DATA_ROOT" in
    / | /app | /etc | /home | /opt | /root | /run | /srv | /tmp | /usr | /var | /var/lib)
      fail 'KASSINAO_DATA_ROOT aponta para diretório de sistema genérico'
      ;;
    /home/* | /root/* | /run/user | /run/user/* | /tmp/* | /var/tmp | /var/tmp/*)
      fail 'KASSINAO_DATA_ROOT fica em área isolada por ProtectHome/PrivateTmp'
      ;;
    /*)
      if [ -d "$DATA_ROOT" ] && [ ! -L "$DATA_ROOT" ] && [ "$(cd -- "$DATA_ROOT" && pwd -P)" = "$DATA_ROOT" ]; then
        pass 'DATA_ROOT existe, é dedicado e canônico'
        DATA_ROOT_MODE="$(portable_mode "$DATA_ROOT" 2>/dev/null || true)"
        DATA_ROOT_OWNER="$(stat -c '%u:%g' "$DATA_ROOT" 2>/dev/null || true)"
        [ "$DATA_ROOT_MODE" = 700 ] \
          && pass 'DATA_ROOT usa modo exato 0700' \
          || fail 'DATA_ROOT precisa usar modo exato 0700'
        [ "$DATA_ROOT_OWNER" = '0:0' ] \
          && pass 'DATA_ROOT pertence a root:root' \
          || fail 'DATA_ROOT precisa pertencer a root:root; somente seus quatro volumes pertencem ao runtime'
      else
        fail 'DATA_ROOT precisa existir como diretório canônico, sem symlink'
      fi
      ;;
    *) fail 'KASSINAO_DATA_ROOT precisa ser absoluto' ;;
  esac
  for pair in "recordings:$RECORDINGS_DIR" "state:$STATE_DIR" "auth:$AUTH_DIR" "cache:$CACHE_DIR"; do
    label="${pair%%:*}"
    dir="${pair#*:}"
    if [ ! -d "$dir" ] || [ -L "$dir" ] || [ "$(cd -- "$dir" 2>/dev/null && pwd -P)" != "$dir" ]; then
      fail "$label precisa ser diretório canônico, sem symlink"
      continue
    fi
    mode="$(portable_mode "$dir" 2>/dev/null || true)"
    if [ "$mode" = 700 ]; then
      pass "$label usa modo exato 0700"
    else
      fail "$label precisa usar modo exato 0700"
    fi
    if [ -n "$EXPECTED_UID" ] && [ -n "$EXPECTED_GID" ]; then
      actual_owner="$(stat -c '%u:%g' "$dir" 2>/dev/null || true)"
      [ "$actual_owner" = "$EXPECTED_UID:$EXPECTED_GID" ] \
        && pass "$label pertence ao UID/GID configurado" \
        || fail "$label não pertence ao UID/GID configurado"
    else
      fail 'KASSINAO_UID e KASSINAO_GID precisam estar explícitos no .env'
    fi
  done
fi

PROFILES="$(env_value COMPOSE_PROFILES "$ENV_FILE")"
DEPLOYMENT_MODE="$(env_value KASSINAO_DEPLOYMENT_MODE "$ENV_FILE")"
if [ "$DEPLOYMENT_MODE" = split ] && profile_enabled split-public && \
   [ -n "$APP_ENV_FILE" ] && [ -f "$APP_ENV_FILE" ] && [ ! -L "$APP_ENV_FILE" ] && \
   python3 - "$ENV_FILE" "$APP_ENV_FILE" >/dev/null 2>&1 <<'PY'
import re
import sys
from urllib.parse import urlsplit

def read_env(path):
    values = {}
    with open(path, encoding='utf-8') as handle:
        for raw in handle:
            raw = raw.rstrip('\r\n')
            if not raw or raw.lstrip().startswith('#') or '=' not in raw:
                continue
            key, value = raw.split('=', 1)
            if not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or key in values:
                raise ValueError('invalid or duplicate key')
            values[key] = value
    return values

def origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or
            parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('invalid origin')
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError('invalid port')
    return parsed.hostname.lower()

compose = read_env(sys.argv[1])
app = read_env(sys.argv[2])
profiles = [item.strip() for item in compose.get('COMPOSE_PROFILES', '').split(',') if item.strip()]
if (len(profiles) != len(set(profiles)) or not set(profiles) <= {'split-public', 'tunnel'} or
        'split-public' not in profiles or (('tunnel' in profiles) != bool(compose.get('TUNNEL_TOKEN')))):
    raise SystemExit(1)
if (app.get('PUBLIC_SURFACES_ENABLED') != 'false' or app.get('ALLOW_ALL_GUILDS') != 'false' or
        app.get('ALLOW_LOCAL_APP_URL', 'false') != 'false' or
        app.get('ALLOW_LEGACY_SHARED_STATE') != 'false' or app.get('BASE_URL', '') != ''):
    raise SystemExit(1)
guilds = [item.strip() for item in app.get('ALLOWED_GUILD_IDS', '').split(',')]
if not guilds or any(not re.fullmatch(r'[0-9]{17,20}', item) for item in guilds) or len(guilds) != len(set(guilds)):
    raise SystemExit(1)
if app.get('GUILD_ID', '') and app['GUILD_ID'] not in guilds:
    raise SystemExit(1)
if (not app.get('DISCORD_TOKEN') or not app.get('DISCORD_CLIENT_SECRET') or
        not re.fullmatch(r'[0-9]{17,20}', app.get('APPLICATION_ID', ''))):
    raise SystemExit(1)
names = ('APP_URL', 'PUBLIC_URL', 'DOCS_URL', 'MCP_URL')
hosts = {name: origin(app.get(name, '')) for name in names}
if app.get('BASE_URL', '') not in ('', app['APP_URL']):
    raise SystemExit(1)
if any(compose.get(name) != app.get(name) for name in names):
    raise SystemExit(1)
if (hosts['PUBLIC_URL'] == hosts['DOCS_URL'] or
        hosts['PUBLIC_URL'] in (hosts['APP_URL'], hosts['MCP_URL']) or
        hosts['DOCS_URL'] in (hosts['APP_URL'], hosts['MCP_URL'])):
    raise SystemExit(1)
PY
then
  pass 'topologia split, guild allowlist e origens HTTPS privadas foram revalidadas'
else
  fail 'produção exige topologia split coerente, allowlist privada e origens HTTPS próprias'
fi

section HOST_GATE
CORE_PATTERN_FILE=/proc/sys/kernel/core_pattern
if [ ! -r "$CORE_PATTERN_FILE" ]; then
  fail 'kernel.core_pattern não pôde ser lido'
else
  IFS= read -r core_pattern < "$CORE_PATTERN_FILE" || core_pattern=''
  if [ -z "$core_pattern" ]; then
    fail 'kernel.core_pattern está vazio ou inválido'
  elif [[ "$core_pattern" = '|'* ]]; then
    fail 'kernel.core_pattern em pipe é incompatível com o isolamento process-scoped do host'
  else
    pass 'kernel.core_pattern grava somente em arquivo e não delega dumps a handler global'
  fi
fi
SSHD_CONTEXT_USERS=()
while IFS=: read -r context_user _ _ _ _ _ login_shell; do
  [ -n "$context_user" ] || continue
  grep -Fqx "$login_shell" /etc/shells 2>/dev/null || continue
  case "$login_shell" in *nologin | */false) continue ;; esac
  SSHD_CONTEXT_USERS+=("$context_user")
done < /etc/passwd
[ "${#SSHD_CONTEXT_USERS[@]}" -gt 0 ] || fail 'nenhum usuário de login pôde ser enumerado para o sshd'
SSHD_CONTEXT_ADDRESSES=(203.0.113.10 127.0.0.1 2001:db8::10)
for context_user in "${SSHD_CONTEXT_USERS[@]}"; do
  for context_address in "${SSHD_CONTEXT_ADDRESSES[@]}"; do
    SSHD_EFFECTIVE="$(sshd -T -C "user=$context_user,host=localhost,addr=$context_address" 2>/dev/null || true)"
    if [ -z "$SSHD_EFFECTIVE" ]; then
      fail 'não foi possível ler um contexto efetivo do sshd'
      continue
    fi
    context_ok=true
    for pair in \
      'permitrootlogin:no' \
      'passwordauthentication:no' \
      'kbdinteractiveauthentication:no' \
      'pubkeyauthentication:yes' \
      'hostbasedauthentication:no' \
      'gssapiauthentication:no' \
      'permitemptypasswords:no'; do
      key="${pair%%:*}"; expected="${pair#*:}"
      actual="$(awk -v key="$key" '$1 == key { print $2; exit }' <<<"$SSHD_EFFECTIVE")"
      [ "$actual" = "$expected" ] || context_ok=false
    done
    AUTHENTICATION_METHODS="$(awk '$1 == "authenticationmethods" { $1=""; sub(/^ /, ""); print; exit }' <<<"$SSHD_EFFECTIVE")"
    if [ "$AUTHENTICATION_METHODS" != any ] && \
       ! [[ "$AUTHENTICATION_METHODS" =~ ^publickey(,publickey)*(\ publickey(,publickey)*)*$ ]]; then
      context_ok=false
    fi
    MAX_AUTH_TRIES="$(awk '$1 == "maxauthtries" { print $2; exit }' <<<"$SSHD_EFFECTIVE")"
    [ -n "$MAX_AUTH_TRIES" ] && [ "$MAX_AUTH_TRIES" -le 4 ] 2>/dev/null || context_ok=false
    [ "$context_ok" = true ] \
      && pass 'contexto efetivo do sshd nega root/senha e exige chave' \
      || fail 'Match efetivo do sshd diverge da política segura'
  done
done

if command -v python3 >/dev/null 2>&1 && python3 - /etc/ssh/sshd_config >/dev/null 2>&1 <<'PY'
import glob
import os
import shlex
import sys

def expanded(path, stack=()):
    real = os.path.realpath(path)
    if real in stack:
        raise RuntimeError('recursive Include')
    with open(real, encoding='utf-8') as handle:
        for raw in handle:
            tokens = shlex.split(raw, comments=True, posix=True)
            if not tokens:
                continue
            if tokens[0].lower() != 'include':
                yield tokens
                continue
            for pattern in tokens[1:]:
                if not os.path.isabs(pattern):
                    pattern = os.path.join('/etc/ssh', pattern)
                for included in sorted(glob.glob(pattern)):
                    yield from expanded(included, stack + (real,))

dangerous_yes = {
    'passwordauthentication', 'kbdinteractiveauthentication',
    'challengeresponseauthentication', 'permitemptypasswords',
    'hostbasedauthentication', 'gssapiauthentication',
}
in_match = False
for tokens in expanded(sys.argv[1]):
    key = tokens[0].lower()
    if key == 'match':
        in_match = True
        continue
    if not in_match or len(tokens) < 2:
        continue
    value = tokens[1].lower()
    if key in dangerous_yes and value == 'yes':
        raise SystemExit(1)
    if key == 'pubkeyauthentication' and value != 'yes':
        raise SystemExit(1)
    if key == 'permitrootlogin' and value != 'no':
        raise SystemExit(1)
    if key == 'authenticationmethods':
        alternatives = [item.lower() for item in tokens[1:]]
        if not alternatives or any(
            not chain or any(step != 'publickey' for step in chain.split(','))
            for chain in alternatives
        ):
            raise SystemExit(1)
PY
then
  pass 'nenhum Match/Include do sshd reabre root ou método diferente de chave pública'
else
  fail 'Match/Include do sshd contém override permissivo ou não pôde ser auditado'
fi

if ! command -v ss >/dev/null 2>&1; then
  fail 'ss é obrigatório para provar os listeners do host'
  TCP_LISTENERS=''; UDP_LISTENERS=''
else
  TCP_LISTENERS="$(ss -H -lnt 2>/dev/null)" || { fail 'scan TCP do host falhou'; TCP_LISTENERS=''; }
  UDP_LISTENERS="$(ss -H -lnu 2>/dev/null)" || { fail 'scan UDP do host falhou'; UDP_LISTENERS=''; }
fi

PUBLIC_TCP_LISTENERS=0
while IFS= read -r local_address; do
  [ -n "$local_address" ] || continue
  case "$local_address" in 127.*:* | \[::1\]:* | ::1:*) continue ;; esac
  PUBLIC_TCP_LISTENERS=$((PUBLIC_TCP_LISTENERS + 1))
  port="${local_address##*:}"
  allowed_port "$port" "$ALLOWED_PUBLIC_TCP_PORTS" \
    && pass 'listener TCP externo pertence à allowlist' \
    || fail 'listener TCP externo não autorizado'
done <<<"$(awk '{print $4}' <<<"$TCP_LISTENERS" | sort -u)"
[ "$PUBLIC_TCP_LISTENERS" -gt 0 ] || warn 'nenhum listener TCP não-loopback foi confirmado'

PUBLIC_UDP_LISTENERS=0
while IFS= read -r local_address; do
  [ -n "$local_address" ] || continue
  case "$local_address" in 127.*:* | \[::1\]:* | ::1:*) continue ;; esac
  PUBLIC_UDP_LISTENERS=$((PUBLIC_UDP_LISTENERS + 1))
  port="${local_address##*:}"
  allowed_port "$port" "$ALLOWED_PUBLIC_UDP_PORTS" \
    && pass 'listener UDP externo pertence à allowlist' \
    || fail 'listener UDP externo não autorizado'
done <<<"$(awk '{print $4}' <<<"$UDP_LISTENERS" | sort -u)"
[ "$PUBLIC_UDP_LISTENERS" -gt 0 ] || pass 'nenhum listener UDP não-loopback encontrado'

UFW_STATUS="$(ufw status verbose 2>&1 || true)"
NFT_RULESET="$(nft list ruleset 2>&1 || true)"
if grep -qi '^Status: active' <<<"$UFW_STATUS" && grep -Eqi '^Default: (deny|reject) \(incoming\)' <<<"$UFW_STATUS"; then
  pass 'firewall UFW tem política padrão de entrada deny/reject'
elif tr '\n' ' ' <<<"$NFT_RULESET" | grep -Eqi 'hook input[^}]*policy (drop|reject)'; then
  pass 'nftables tem política de entrada drop/reject'
else
  fail 'firewall de entrada deny/reject não foi confirmado'
fi
for service in ssh fail2ban unattended-upgrades docker; do
  state="$(systemctl is-active "$service" 2>/dev/null || true)"
  [ "$state" = active ] && pass "$service ativo" || fail "$service não está ativo"
done
systemd_version="$(systemctl --version 2>/dev/null | awk 'NR == 1 && $1 == "systemd" { print $2 }')"
if [[ "$systemd_version" =~ ^[0-9]+$ ]] && [ "$systemd_version" -ge 249 ]; then
  pass 'systemd suporta age-by do tmpfiles usado na retenção'
else
  fail 'retenção exige systemd >= 249'
fi
if APT_SIMULATION="$(apt-get -s upgrade 2>/dev/null)"; then
  PENDING_UPDATES="$(awk '/^Inst /{count++} END{print count+0}' <<<"$APT_SIMULATION")"
  [ "$PENDING_UPDATES" -eq 0 ] && pass 'nenhuma atualização pendente detectada' || warn 'existem atualizações pendentes'
else
  fail 'não foi possível simular atualizações do sistema'
fi

FAIL2BAN_STATUS="$(fail2ban-client status 2>&1 || true)"
if grep -Eq 'Jail list:.*(^|[,[:space:]])sshd([,[:space:]]|$)' <<<"$FAIL2BAN_STATUS" && \
   fail2ban-client status sshd 2>/dev/null | grep -q 'Status for the jail: sshd'; then
  pass 'jail sshd do fail2ban está ativo'
else
  fail 'jail sshd do fail2ban não está ativo'
fi

section HOST_CONTROLS
controls_match=true
for pair in \
  "scripts/health-watch.sh:/usr/local/sbin/kassinao-health-watch:755" \
  "scripts/verify-storage-encryption.sh:/usr/local/sbin/kassinao-verify-storage-encryption:755" \
  "scripts/harden-docker-egress.sh:/usr/local/sbin/kassinao-harden-docker-egress:755" \
  "scripts/egress-fail-closed.sh:/usr/local/sbin/kassinao-egress-fail-closed:755" \
  "deploy/systemd/kassinao-health-watch.service:/etc/systemd/system/kassinao-health-watch.service:644" \
  "deploy/systemd/kassinao-health-watch.timer:/etc/systemd/system/kassinao-health-watch.timer:644" \
  "deploy/systemd/kassinao-docker-egress.service:/etc/systemd/system/kassinao-docker-egress.service:644" \
  "deploy/systemd/kassinao-egress-fail-closed.service:/etc/systemd/system/kassinao-egress-fail-closed.service:644" \
  "deploy/systemd/kassinao-rollback-clean.timer:/etc/systemd/system/kassinao-rollback-clean.timer:644" \
  "deploy/systemd/docker.service.d/kassinao-egress.conf:/etc/systemd/system/docker.service.d/kassinao-egress.conf:644" \
  "deploy/tmpfiles.d/kassinao.conf:/etc/tmpfiles.d/kassinao.conf:644"; do
  source_relative="${pair%%:*}"
  remainder="${pair#*:}"
  installed="${remainder%%:*}"
  expected_mode="${remainder##*:}"
  source_file="$DEPLOY_REAL/$source_relative"
  if [ ! -f "$source_file" ] || [ -L "$source_file" ] || \
     [ ! -f "$installed" ] || [ -L "$installed" ] || \
     ! cmp -s "$source_file" "$installed" || \
     [ "$(portable_mode "$installed" 2>/dev/null || true)" != "$expected_mode" ] || \
     [ "$(stat -c '%u:%g' "$installed" 2>/dev/null || true)" != '0:0' ]; then
    controls_match=false
  fi
done
[ "$controls_match" = true ] \
  && pass 'scripts e units root correspondem exatamente ao kit atual' \
  || fail 'scripts/units root estão ausentes, antigos ou com ownership/modo incorreto'

storage_paths_file=/etc/kassinao/storage-paths
expected_storage_paths="$(printf '%s\n' "$DATA_ROOT" "$RECORDINGS_DIR" "$STATE_DIR" "$AUTH_DIR" "$CACHE_DIR")"
if [ -f "$storage_paths_file" ] && [ ! -L "$storage_paths_file" ] && \
   [ "$(stat -c '%a:%u:%g' "$storage_paths_file" 2>/dev/null || true)" = '600:0:0' ] && \
   [ "$(cat "$storage_paths_file" 2>/dev/null)" = "$expected_storage_paths" ]; then
  pass 'allowlist root-owned do storage corresponde aos mounts da instância'
else
  fail 'allowlist de storage ausente, insegura ou divergente dos mounts'
fi
host_controls_file=/etc/kassinao/host-controls.env
expected_host_controls="$(printf 'KASSINAO_DEPLOY_DIR=%s\nKASSINAO_DATA_ROOT=%s\nKASSINAO_ROLLBACK_RETENTION_HOURS=%s' "$DEPLOY_REAL" "$DATA_ROOT" "$ROLLBACK_RETENTION_HOURS")"
if [ -f "$host_controls_file" ] && [ ! -L "$host_controls_file" ] && \
   [ "$(stat -c '%a:%u:%g' "$host_controls_file" 2>/dev/null || true)" = '600:0:0' ] && \
   [ "$(cat "$host_controls_file" 2>/dev/null)" = "$expected_host_controls" ]; then
  pass 'registro root-owned dos controles de host coincide com release, DATA_ROOT e retenção'
else
  fail 'registro dos controles de host está ausente, inseguro ou divergente'
fi
rollback_tmpfiles=/etc/tmpfiles.d/kassinao-rollback.conf
rollback_template="$DEPLOY_REAL/deploy/tmpfiles.d/kassinao-rollback.conf.in"
if [[ "$ROLLBACK_RETENTION_HOURS" =~ ^[1-9][0-9]*$ ]] && [ "$ROLLBACK_RETENTION_HOURS" -le 168 ]; then
  rollback_cleanup_age="$((ROLLBACK_RETENTION_HOURS * 60 - 31))min"
else
  rollback_cleanup_age=invalid
fi
expected_rollback_tmpfiles="$(sed -e "s|@ROLLBACK_DIR@|$DATA_ROOT/rollback|g" \
  -e "s|@CLEANUP_AGE@|$rollback_cleanup_age|g" "$rollback_template" 2>/dev/null || true)"
if [ -n "$DATA_ROOT" ] && [ -n "$ROLLBACK_RETENTION_HOURS" ] && \
   [ -f "$rollback_tmpfiles" ] && [ ! -L "$rollback_tmpfiles" ] && \
   [ "$(stat -c '%a:%u:%g' "$rollback_tmpfiles" 2>/dev/null || true)" = '644:0:0' ] && \
   [ "$(cat "$rollback_tmpfiles" 2>/dev/null)" = "$expected_rollback_tmpfiles" ]; then
  pass 'tmpfiles limita snapshots de rollback à janela declarada no DATA_ROOT'
else
  fail 'regra tmpfiles de rollback está ausente, insegura ou divergente'
fi
rollback_service=/etc/systemd/system/kassinao-rollback-clean.service
rollback_service_template="$DEPLOY_REAL/deploy/systemd/kassinao-rollback-clean.service.in"
expected_rollback_service="$(sed -e "s|@ROLLBACK_DIR@|$DATA_ROOT/rollback|g" \
  -e "s|@RETENTION_HOURS@|$ROLLBACK_RETENTION_HOURS|g" \
  -e "s|@CLEANUP_AGE@|$rollback_cleanup_age|g" \
  "$rollback_service_template" 2>/dev/null || true)"
if [ -n "$DATA_ROOT" ] && [ -f "$rollback_service_template" ] && [ ! -L "$rollback_service_template" ] && \
   [ -f "$rollback_service" ] && [ ! -L "$rollback_service" ] && \
   [ "$(stat -c '%a:%u:%g' "$rollback_service" 2>/dev/null || true)" = '644:0:0' ] && \
   [ "$(cat "$rollback_service" 2>/dev/null)" = "$expected_rollback_service" ]; then
  pass 'unit de limpeza escreve somente no rollback do DATA_ROOT declarado'
else
  fail 'unit de limpeza de rollback está ausente, insegura ou divergente'
fi
rollback_dir="$DATA_ROOT/rollback"
rollback_safe=true
if [ ! -d "$rollback_dir" ] || [ -L "$rollback_dir" ] || \
   [ "$(stat -c '%a:%u:%g' "$rollback_dir" 2>/dev/null || true)" != '700:0:0' ]; then
  rollback_safe=false
else
  while IFS= read -r -d '' snapshot; do
    name="${snapshot##*/}"
    if [[ ! "$name" =~ ^operational-state-[0-9]{8}-[0-9]{6}-[A-Za-z0-9]{6}\.tar\.gz$ ]] || \
       [ ! -f "$snapshot" ] || [ -L "$snapshot" ] || \
       [ "$(stat -c '%a:%u:%g' "$snapshot" 2>/dev/null || true)" != '600:0:0' ]; then
      rollback_safe=false
    fi
  done < <(find "$rollback_dir" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
  if [[ "$ROLLBACK_RETENTION_HOURS" =~ ^[1-9][0-9]*$ ]] && \
     find "$rollback_dir" -mindepth 1 -maxdepth 1 -mmin "+$((ROLLBACK_RETENTION_HOURS * 60))" -print -quit 2>/dev/null | grep -q .; then
    rollback_safe=false
  fi
fi
[ "$rollback_safe" = true ] \
  && pass 'rollback contém somente snapshots privados dentro da janela declarada' \
  || fail 'diretório de rollback está inseguro, contém conteúdo inesperado ou snapshot vencido'
if [ -x /usr/local/sbin/kassinao-verify-storage-encryption ] && \
   env -i "PATH=$PATH" "HOME=${HOME:-/root}" \
     /usr/local/sbin/kassinao-verify-storage-encryption >/dev/null 2>&1; then
  pass 'dados ativos e swap passam na prova dm-crypt/LUKS'
else
  fail 'dados ativos ou swap não têm prova dm-crypt/LUKS'
fi
if [ -d /run/lock/kassinao ] && [ ! -L /run/lock/kassinao ] && \
   [ "$(stat -c '%a:%u:%g' /run/lock/kassinao 2>/dev/null || true)" = '700:0:0' ]; then
  pass 'tmpfiles materializou o diretório de locks privado 0700 root:root'
else
  fail 'diretório /run/lock/kassinao precisa ser real, 0700 e root:root'
fi
locks_converge=true
for script in scripts/health-watch.sh scripts/backup.sh scripts/deploy-release.sh; do
  source_file="$DEPLOY_REAL/$script"
  [ "$(grep -Fxc 'RUNTIME_DIR=/run/lock/kassinao' "$source_file" 2>/dev/null || true)" -eq 1 ] || locks_converge=false
  ! grep -Eq 'KASSINAO_RUNTIME_DIR:-|RUNTIME_DIR=.*KASSINAO_RUNTIME_DIR' "$source_file" 2>/dev/null || locks_converge=false
  grep -Fq '$RUNTIME_DIR/maintenance.lock' "$source_file" 2>/dev/null || locks_converge=false
done
[ "$locks_converge" = true ] \
  && pass 'deploy, backup e watchdog convergem no mesmo maintenance.lock privado' \
  || fail 'scripts operacionais divergem no diretório ou lock de manutenção'

unit_property_is() {
  local unit="$1" property="$2" expected="$3" actual
  actual="$(systemctl show "$unit" -p "$property" --value 2>/dev/null || true)"
  [ "$actual" = "$expected" ]
}
unit_words_are() {
  local unit="$1" property="$2" expected="$3" actual
  actual="$(systemctl show "$unit" -p "$property" --value 2>/dev/null | tr ' ' '\n' | grep -ve '^$' | sort -u | tr '\n' ' ' | sed 's/ $//' || true)"
  expected="$(tr ' ' '\n' <<<"$expected" | grep -ve '^$' | sort -u | tr '\n' ' ' | sed 's/ $//')"
  [ "$actual" = "$expected" ]
}
unit_exec_is() {
  local unit="$1" expected="$2" actual
  actual="$(systemctl show "$unit" -p ExecStart --value 2>/dev/null || true)"
  grep -Fq "path=$expected ;" <<<"$actual" && grep -Fq "argv[]=$expected ;" <<<"$actual"
}
unit_words_contain() {
  local unit="$1" property="$2" expected="$3"
  systemctl show "$unit" -p "$property" --value 2>/dev/null | tr ' ' '\n' | grep -Fqx -- "$expected"
}
unit_exec_property_contains() {
  local unit="$1" property="$2" executable="$3" argument="$4" actual
  actual="$(systemctl show "$unit" -p "$property" --value 2>/dev/null || true)"
  grep -Fq "path=$executable ;" <<<"$actual" && \
    grep -Fq "argv[]=$executable $argument ;" <<<"$actual"
}
unit_exec_property_contains_noarg() {
  local unit="$1" property="$2" executable="$3" actual
  actual="$(systemctl show "$unit" -p "$property" --value 2>/dev/null || true)"
  grep -Fq "path=$executable ;" <<<"$actual" && grep -Fq "argv[]=$executable ;" <<<"$actual"
}

units_effective_ok=true
for unit in kassinao-health-watch.service kassinao-health-watch.timer kassinao-docker-egress.service kassinao-egress-fail-closed.service kassinao-rollback-clean.service kassinao-rollback-clean.timer; do
  unit_property_is "$unit" FragmentPath "/etc/systemd/system/$unit" || units_effective_ok=false
  unit_property_is "$unit" DropInPaths '' || units_effective_ok=false
  unit_property_is "$unit" LoadState loaded || units_effective_ok=false
  unit_property_is "$unit" NeedDaemonReload no || units_effective_ok=false
done
unit_exec_property_contains kassinao-rollback-clean.service ExecStart /usr/bin/systemd-tmpfiles '--clean /etc/tmpfiles.d/kassinao-rollback.conf' || units_effective_ok=false
unit_property_is kassinao-rollback-clean.service ProtectSystem strict || units_effective_ok=false
unit_property_is kassinao-rollback-clean.service NoNewPrivileges yes || units_effective_ok=false
unit_property_is kassinao-rollback-clean.service PrivateTmp yes || units_effective_ok=false
unit_property_is kassinao-rollback-clean.service ProtectHome yes || units_effective_ok=false
unit_property_is kassinao-rollback-clean.service LockPersonality yes || units_effective_ok=false
unit_property_is kassinao-rollback-clean.service MemoryDenyWriteExecute yes || units_effective_ok=false
unit_words_are kassinao-rollback-clean.service CapabilityBoundingSet '' || units_effective_ok=false
unit_words_are kassinao-rollback-clean.service RestrictAddressFamilies 'AF_UNIX' || units_effective_ok=false
unit_words_are kassinao-rollback-clean.service ReadWritePaths "$DATA_ROOT/rollback" || units_effective_ok=false
unit_words_are kassinao-rollback-clean.service Environment \
  "KASSINAO_ROLLBACK_RETENTION_HOURS=$ROLLBACK_RETENTION_HOURS KASSINAO_ROLLBACK_CLEANUP_AGE=$rollback_cleanup_age" || units_effective_ok=false
unit_property_is kassinao-rollback-clean.timer Unit kassinao-rollback-clean.service || units_effective_ok=false
unit_property_is kassinao-rollback-clean.timer Persistent yes || units_effective_ok=false
for unit in kassinao-health-watch.service kassinao-docker-egress.service kassinao-egress-fail-closed.service; do
  unit_property_is "$unit" User root || units_effective_ok=false
  unit_property_is "$unit" Group root || units_effective_ok=false
  unit_property_is "$unit" Type oneshot || units_effective_ok=false
  unit_property_is "$unit" NoNewPrivileges yes || units_effective_ok=false
  unit_property_is "$unit" PrivateTmp yes || units_effective_ok=false
  unit_property_is "$unit" ProtectHome yes || units_effective_ok=false
  unit_property_is "$unit" ProtectSystem strict || units_effective_ok=false
  unit_property_is "$unit" LockPersonality yes || units_effective_ok=false
  unit_property_is "$unit" MemoryDenyWriteExecute yes || units_effective_ok=false
done
unit_exec_is kassinao-health-watch.service /usr/local/sbin/kassinao-health-watch || units_effective_ok=false
unit_words_are kassinao-health-watch.service RestrictAddressFamilies 'AF_UNIX AF_NETLINK' || units_effective_ok=false
unit_words_are kassinao-health-watch.service CapabilityBoundingSet 'CAP_NET_ADMIN CAP_NET_RAW' || units_effective_ok=false
unit_words_are kassinao-health-watch.service Requires 'docker.service kassinao-docker-egress.service' || units_effective_ok=false
unit_words_are kassinao-health-watch.service ReadWritePaths '/run/lock/kassinao' || units_effective_ok=false
unit_property_is kassinao-health-watch.timer Unit kassinao-health-watch.service || units_effective_ok=false
unit_property_is kassinao-health-watch.timer Persistent yes || units_effective_ok=false
unit_exec_is kassinao-docker-egress.service /usr/local/sbin/kassinao-harden-docker-egress || units_effective_ok=false
unit_words_are kassinao-docker-egress.service BindsTo 'docker.service' || units_effective_ok=false
unit_property_is kassinao-docker-egress.service RemainAfterExit yes || units_effective_ok=false
unit_property_is kassinao-docker-egress.service PrivateDevices yes || units_effective_ok=false
unit_property_is kassinao-docker-egress.service ProtectControlGroups yes || units_effective_ok=false
unit_property_is kassinao-docker-egress.service ProtectKernelTunables yes || units_effective_ok=false
unit_property_is kassinao-docker-egress.service RestrictNamespaces yes || units_effective_ok=false
unit_words_are kassinao-docker-egress.service RestrictAddressFamilies 'AF_UNIX AF_NETLINK' || units_effective_ok=false
unit_words_are kassinao-docker-egress.service CapabilityBoundingSet 'CAP_NET_ADMIN CAP_NET_RAW' || units_effective_ok=false
unit_words_are kassinao-docker-egress.service ReadWritePaths '/run/lock/kassinao' || units_effective_ok=false
unit_words_are kassinao-docker-egress.service OnFailure 'kassinao-egress-fail-closed.service' || units_effective_ok=false
unit_property_is kassinao-docker-egress.service OnFailureJobMode replace-irreversibly || units_effective_ok=false
unit_property_is kassinao-docker-egress.service Restart on-failure || units_effective_ok=false
unit_property_is kassinao-egress-fail-closed.service PrivateDevices yes || units_effective_ok=false
unit_exec_is kassinao-egress-fail-closed.service /usr/local/sbin/kassinao-egress-fail-closed || units_effective_ok=false
unit_property_is kassinao-egress-fail-closed.service ProtectControlGroups yes || units_effective_ok=false
unit_property_is kassinao-egress-fail-closed.service ProtectKernelTunables yes || units_effective_ok=false
unit_property_is kassinao-egress-fail-closed.service RestrictNamespaces yes || units_effective_ok=false
unit_words_are kassinao-egress-fail-closed.service RestrictAddressFamilies 'AF_UNIX' || units_effective_ok=false
unit_words_are kassinao-egress-fail-closed.service CapabilityBoundingSet '' || units_effective_ok=false
unit_words_contain docker.service Wants kassinao-docker-egress.service || units_effective_ok=false
unit_words_contain docker.service Requires systemd-tmpfiles-setup.service || units_effective_ok=false
unit_exec_property_contains docker.service ExecStartPre /usr/local/sbin/kassinao-harden-docker-egress --offline-preload || units_effective_ok=false
unit_exec_property_contains_noarg docker.service ExecStartPre /usr/local/sbin/kassinao-verify-storage-encryption || units_effective_ok=false
unit_words_contain docker.service DropInPaths /etc/systemd/system/docker.service.d/kassinao-egress.conf || units_effective_ok=false
unit_property_is docker.service LoadState loaded || units_effective_ok=false
unit_property_is docker.service NeedDaemonReload no || units_effective_ok=false
[ "$units_effective_ok" = true ] \
  && pass 'units efetivas usam fragments exatos, sem drop-ins e com sandbox esperado' \
  || fail 'unit efetiva diverge, tem drop-in, fragment irregular ou daemon-reload pendente'
if systemctl is-enabled --quiet kassinao-health-watch.timer && \
   systemctl is-active --quiet kassinao-health-watch.timer; then
  pass 'timer do watchdog está habilitado e ativo'
else
  fail 'timer do watchdog precisa estar habilitado e ativo'
fi
if systemctl is-enabled --quiet kassinao-docker-egress.service && \
   systemctl is-active --quiet kassinao-docker-egress.service; then
  pass 'firewall Docker está habilitado e ativo para sobreviver ao reboot'
else
  fail 'firewall Docker precisa estar habilitado e ativo'
fi
if systemctl is-enabled --quiet kassinao-rollback-clean.timer && \
   systemctl is-active --quiet kassinao-rollback-clean.timer; then
  pass 'timer persistente de retenção de rollback está habilitado e ativo'
else
  fail 'timer de retenção de rollback precisa estar habilitado e ativo'
fi

section DOCKER_PERIMETER
if ! command -v python3 >/dev/null 2>&1; then
  fail 'python3 é obrigatório para auditar o perímetro Docker'
fi
ENGINE_VERSION="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || true)"
if python3 - "$ENGINE_VERSION" "$COMPOSE_VERSION" >/dev/null 2>&1 <<'PY'
import re
import sys
def parse(raw):
    match = re.match(r'^v?(\d+)\.(\d+)\.(\d+)', raw)
    if not match:
        raise SystemExit(1)
    return tuple(map(int, match.groups()))
if parse(sys.argv[1]) < (28, 0, 0) or parse(sys.argv[2]) < (2, 35, 0):
    raise SystemExit(1)
PY
then
  pass 'Docker Engine e Compose atendem às versões mínimas seguras'
else
  fail 'produção exige Docker Engine >=28.0.0 e Compose >=2.35.0'
fi

DOCKER_MAIN_PID="$(systemctl show docker -p MainPID --value 2>/dev/null || true)"
if [[ "$DOCKER_MAIN_PID" =~ ^[1-9][0-9]*$ ]] && [ -r "/proc/$DOCKER_MAIN_PID/cmdline" ] && \
   DOCKER_CONFIG_FILE="$(python3 - "/proc/$DOCKER_MAIN_PID/cmdline" 2>/dev/null <<'PY'
import os
import sys

argv = [item.decode('utf-8', 'strict') for item in open(sys.argv[1], 'rb').read().split(b'\0') if item]
if not argv or os.path.basename(argv[0]) not in ('dockerd', 'dockerd-rootless.sh'):
    raise SystemExit(1)

def boolean(raw):
    value = raw.lower()
    if value in ('true', '1'):
        return True
    if value in ('false', '0'):
        return False
    raise ValueError('invalid boolean')

config_file = '/etc/docker/daemon.json'
config_seen = False
seen = set()
index = 1
while index < len(argv):
    arg = argv[index]
    if arg == '--config-file':
        if config_seen or index + 1 >= len(argv):
            raise SystemExit(1)
        config_file = argv[index + 1]
        config_seen = True
        index += 2
        continue
    if arg.startswith('--config-file='):
        if config_seen:
            raise SystemExit(1)
        config_file = arg.split('=', 1)[1]
        config_seen = True
        index += 1
        continue
    matched = False
    for name in ('iptables', 'ip6tables', 'allow-direct-routing', 'live-restore'):
        prefix = f'--{name}'
        if arg == prefix or arg.startswith(prefix + '='):
            if name in seen:
                raise SystemExit(1)
            seen.add(name)
            if '=' in arg:
                raw = arg.split('=', 1)[1]
            elif index + 1 < len(argv) and argv[index + 1].lower() in ('true', 'false', '1', '0'):
                raw = argv[index + 1]
                index += 1
            else:
                raw = 'true'
            enabled = boolean(raw)
            if name in ('iptables', 'ip6tables') and not enabled:
                raise SystemExit(1)
            if name == 'allow-direct-routing' and enabled:
                raise SystemExit(1)
            if name == 'live-restore' and enabled:
                raise SystemExit(1)
            matched = True
            break
    if not matched and (arg == '--firewall-backend' or arg.startswith('--firewall-backend=')):
        if 'firewall-backend' in seen:
            raise SystemExit(1)
        seen.add('firewall-backend')
        if '=' in arg:
            backend = arg.split('=', 1)[1]
        elif index + 1 < len(argv):
            backend = argv[index + 1]
            index += 1
        else:
            raise SystemExit(1)
        if backend != 'iptables':
            raise SystemExit(1)
    index += 1

if not os.path.isabs(config_file):
    raise SystemExit(1)
print(os.path.normpath(config_file))
PY
   )"
then
  pass 'flags efetivas do dockerd preservam firewall e negam direct routing'
else
  fail 'não foi possível provar flags seguras no processo dockerd efetivo'
  DOCKER_CONFIG_FILE=''
fi

if [ -n "$DOCKER_CONFIG_FILE" ]; then
  if [ -e "$DOCKER_CONFIG_FILE" ]; then
    if [ ! -f "$DOCKER_CONFIG_FILE" ] || [ -L "$DOCKER_CONFIG_FILE" ] || \
       [ "$(stat -c '%u' "$DOCKER_CONFIG_FILE" 2>/dev/null || true)" != 0 ] || \
       (( (8#$(portable_mode "$DOCKER_CONFIG_FILE" 2>/dev/null || printf 777) & 022) != 0 )); then
      fail 'config efetiva do dockerd precisa ser arquivo regular root-owned e não gravável por terceiros'
    elif python3 - "$DOCKER_CONFIG_FILE" >/dev/null 2>&1 <<'PY'
import json
import sys

def boolean(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value.lower() in ('true', 'false', '1', '0'):
        return value.lower() in ('true', '1')
    raise ValueError('invalid boolean')

with open(sys.argv[1], encoding='utf-8') as handle:
    config = json.load(handle)
if not isinstance(config, dict):
    raise SystemExit(1)
for name in ('iptables', 'ip6tables'):
    if name in config and not boolean(config[name]):
        raise SystemExit(1)
if 'allow-direct-routing' in config and boolean(config['allow-direct-routing']):
    raise SystemExit(1)
if 'live-restore' in config and boolean(config['live-restore']):
    raise SystemExit(1)
if config.get('firewall-backend', 'iptables') != 'iptables':
    raise SystemExit(1)
PY
    then
      pass 'config-file efetivo do dockerd mantém política segura'
    else
      fail 'config-file efetivo do dockerd desativa firewall ou habilita direct routing'
    fi
  elif [ "$DOCKER_CONFIG_FILE" = /etc/docker/daemon.json ]; then
    pass 'dockerd usa defaults seguros sem daemon.json local'
  else
    fail 'config-file explícito do dockerd está ausente'
  fi
fi

LIVE_RESTORE="$(docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null || true)"
if [ "$LIVE_RESTORE" = false ]; then
  pass 'Docker live-restore está desativado para respeitar o lifecycle systemd'
else
  fail 'Docker live-restore precisa ficar desativado nesta VPS'
fi

if iptables -S DOCKER-USER >/dev/null 2>&1 && iptables -S FORWARD >/dev/null 2>&1; then
  pass 'pipeline de forwarding Docker passa por DOCKER-USER'
elif tr '\n' ' ' <<<"$NFT_RULESET" | grep -Eqi 'table (ip|inet) docker[^}]*hook forward'; then
  pass 'pipeline nftables de forwarding Docker foi confirmado'
else
  fail 'não foi possível provar o firewall de forwarding do Docker'
fi
SWARM_STATE="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
[ "$SWARM_STATE" = inactive ] && pass 'Docker Swarm está inativo' || fail 'Docker Swarm precisa ficar inativo nesta VPS'

ALL_CONTAINER_IDS_RAW="$(docker ps -aq --no-trunc 2>/dev/null)" || { fail 'não foi possível enumerar todos os containers'; ALL_CONTAINER_IDS_RAW=''; }
if [ -z "$ALL_CONTAINER_IDS_RAW" ]; then
  fail 'nenhum container foi encontrado para auditoria do host dedicado'
else
  mapfile -t ALL_CONTAINER_ID_LIST <<<"$ALL_CONTAINER_IDS_RAW"
  valid_container_ids=true
  for container_id in "${ALL_CONTAINER_ID_LIST[@]}"; do
    [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || valid_container_ids=false
  done
  if [ "$valid_container_ids" != true ]; then
    fail 'inventário de IDs Docker contém valor inválido'
    ATTACHED_NETWORKS=''
  else
    EXPECTED_CONTAINER_NAMES=("$CORE_CONTAINER")
    profile_enabled split-public && EXPECTED_CONTAINER_NAMES+=("$PUBLIC_CONTAINER")
    profile_enabled tunnel && EXPECTED_CONTAINER_NAMES+=("$TUNNEL_CONTAINER")
    dedicated_projection='{"Id":{{json .Id}},"Name":{{json .Name}},"HostConfig":{"Privileged":{{json .HostConfig.Privileged}},"CapAdd":{{json .HostConfig.CapAdd}},"HasDevices":{{if .HostConfig.Devices}}true{{else}}false{{end}},"HasDeviceCgroupRules":{{if .HostConfig.DeviceCgroupRules}}true{{else}}false{{end}},"HasDeviceRequests":{{if .HostConfig.DeviceRequests}}true{{else}}false{{end}},"NetworkMode":{{json .HostConfig.NetworkMode}},"PortBindings":{{json .HostConfig.PortBindings}}},"Mounts":[{{range $index, $mount := .Mounts}}{{if $index}},{{end}}{"Type":{{json $mount.Type}},"Source":{{json $mount.Source}},"Destination":{{json $mount.Destination}},"RW":{{json $mount.RW}}}{{end}}],"NetworkNames":[{{$first := true}}{{range $name, $_ := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{$first = false}}{{json $name}}{{end}}]}'
    if ATTACHED_NETWORKS="$({
      docker inspect --format "$dedicated_projection" "${ALL_CONTAINER_ID_LIST[@]}"
    } | python3 /dev/fd/3 "$RECORDINGS_DIR" "$STATE_DIR" "$AUTH_DIR" "$CACHE_DIR" -- "${EXPECTED_CONTAINER_NAMES[@]}" 3<<'PY'
import json
import os
import re
import sys

separator = sys.argv.index("--")
allowed_data = {os.path.realpath(value) for value in sys.argv[1:separator]}
expected = set(sys.argv[separator + 1:])
sensitive_roots = (
    "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64",
    "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var",
)
actual = set()
network_names = set()
for line in sys.stdin:
    try:
        item = json.loads(line)
    except Exception:
        raise SystemExit(1)
    if not isinstance(item, dict):
        raise SystemExit(1)
    actual.add(str(item.get("Name") or "").lstrip("/"))
    host = item.get("HostConfig") or {}
    if host.get("Privileged") or host.get("CapAdd") or host.get("HasDevices") or \
            host.get("HasDeviceCgroupRules") or host.get("HasDeviceRequests"):
        raise SystemExit(1)
    if host.get("NetworkMode") == "host":
        raise SystemExit(1)
    for bindings in (host.get("PortBindings") or {}).values():
        for binding in bindings or []:
            if (binding or {}).get("HostIp") not in ("127.0.0.1", "::1"):
                raise SystemExit(1)
    for mount in item.get("Mounts") or []:
        if mount.get("Type") != "bind":
            continue
        source = os.path.normpath(str(mount.get("Source") or ""))
        destination = os.path.normpath(str(mount.get("Destination") or ""))
        if source == "/" or source.endswith("/docker.sock") or destination.endswith("/docker.sock"):
            raise SystemExit(1)
        if os.path.realpath(source) in allowed_data:
            continue
        if any(source == root or source.startswith(root + "/") for root in sensitive_roots):
            raise SystemExit(1)
    for network_name in item.get("NetworkNames") or []:
        if not isinstance(network_name, str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', network_name) is None:
            raise SystemExit(1)
        network_names.add(network_name)
if actual != expected:
    raise SystemExit(1)
print("\n".join(sorted(network_names)))
PY
)"; then
      pass 'host dedicado contém somente containers esperados, sem privilégios ou binds sensíveis'
    else
      fail 'container alheio, privilégio global, device, docker.sock ou bind sensível detectado'
      ATTACHED_NETWORKS=''
    fi
    bad_network_driver=0
    while IFS= read -r network_name; do
      [ -n "$network_name" ] || continue
      [ "$(docker network inspect -f '{{.Driver}}' "$network_name" 2>/dev/null || true)" = bridge ] || \
        bad_network_driver=$((bad_network_driver + 1))
    done <<<"$ATTACHED_NETWORKS"
    [ "$bad_network_driver" -eq 0 ] \
      && pass 'todas as redes anexadas usam o driver bridge permitido' \
      || fail 'existe rede anexada com driver não permitido'
  fi
fi
unset ALL_CONTAINER_IDS_RAW ALL_CONTAINER_ID_LIST

section CORE_CONTAINER
CONFIGURED_IMAGE=''
if ! docker inspect --format '{{.Id}}' "$CORE_CONTAINER" >/dev/null 2>&1; then
  fail 'container core não encontrado'
else
  CONTAINER_USER="$(docker inspect -f '{{.Config.User}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  PRIVILEGED="$(docker inspect -f '{{.HostConfig.Privileged}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  READONLY_ROOTFS="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  CAP_DROP="$(docker inspect -f '{{json .HostConfig.CapDrop}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  CAP_ADD="$(docker inspect -f '{{json .HostConfig.CapAdd}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  DEVICES="$(docker inspect -f '{{json .HostConfig.Devices}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  DEVICE_RULES="$(docker inspect -f '{{json .HostConfig.DeviceCgroupRules}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  SECURITY_OPT="$(docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  NETWORK_MODE="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  PID_MODE="$(docker inspect -f '{{.HostConfig.PidMode}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  IPC_MODE="$(docker inspect -f '{{.HostConfig.IpcMode}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  UTS_MODE="$(docker inspect -f '{{.HostConfig.UtsMode}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  CONFIGURED_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  CORE_STATE_HEALTH="$(docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  CORE_RESTART_POLICY="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CORE_CONTAINER" 2>/dev/null || true)"

  case "$CONTAINER_USER" in '' | 0 | root | 0:0 | root:root) fail 'core roda como root' ;; *) pass 'core roda como usuário não-root' ;; esac
  [ "$CORE_STATE_HEALTH" = 'running|healthy' ] \
    && pass 'core está running e healthy' \
    || fail 'core precisa estar running e healthy antes da aprovação'
  [ "$CORE_RESTART_POLICY" = unless-stopped ] \
    && pass 'core usa restart policy unless-stopped' \
    || fail 'core precisa usar restart policy unless-stopped'
  [ "$PRIVILEGED" = false ] && pass 'core não é privilegiado' || fail 'core está privilegiado'
  [ "$READONLY_ROOTFS" = true ] && pass 'root filesystem do core é read-only' || fail 'root filesystem do core permite escrita'
  grep -q 'ALL' <<<"$CAP_DROP" && pass 'core remove todas as capabilities' || fail 'core não remove todas as capabilities'
  { [ "$CAP_ADD" = null ] || [ "$CAP_ADD" = '[]' ]; } && pass 'core não readiciona capabilities' || fail 'core readiciona capabilities'
  { [ "$DEVICES" = null ] || [ "$DEVICES" = '[]' ]; } && \
    { [ "$DEVICE_RULES" = null ] || [ "$DEVICE_RULES" = '[]' ]; } \
    && pass 'core não recebe devices do host' || fail 'core recebe device ou regra de device'
  grep -q 'no-new-privileges' <<<"$SECURITY_OPT" && pass 'core usa no-new-privileges' || fail 'core sem no-new-privileges'
  grep -Eqi '(apparmor|seccomp)[=:]unconfined' <<<"$SECURITY_OPT" \
    && fail 'core usa perfil unconfined' || pass 'core não desativa AppArmor/seccomp'
  [[ "$NETWORK_MODE" != host && "$NETWORK_MODE" != container:* ]] && pass 'core não compartilha namespace de rede' || fail 'core compartilha namespace de rede'
  [ -z "$PID_MODE" ] && pass 'core tem namespace de processos isolado' || fail 'core compartilha namespace de processos'
  { [ -z "$IPC_MODE" ] || [ "$IPC_MODE" = private ]; } && pass 'core tem IPC isolado' || fail 'core compartilha IPC'
  [ -z "$UTS_MODE" ] && pass 'core tem namespace UTS isolado' || fail 'core compartilha namespace UTS'
  [[ "$CONFIGURED_IMAGE" =~ ^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] && \
    [ "$CONFIGURED_IMAGE" = "$EXPECTED_IMAGE" ] \
    && pass 'core usa o digest exato configurado' \
    || fail 'core não usa o digest exato configurado'
  CORE_RELEASE="$(container_env_value "$CORE_CONTAINER" KASSINAO_RELEASE_DIGEST)"
  CORE_DEPLOYMENT="$(container_env_value "$CORE_CONTAINER" KASSINAO_DEPLOYMENT_FINGERPRINT)"
  [ "$CORE_RELEASE" = "$EXPECTED_RELEASE" ] && [ "$CORE_DEPLOYMENT" = "$EXPECTED_DEPLOYMENT" ] \
    && pass 'core recebeu os fingerprints exatos da release e do deploy' \
    || fail 'core recebeu fingerprint divergente'
  [ -z "$(container_env_value "$CORE_CONTAINER" TUNNEL_TOKEN)" ] \
    && pass 'core não recebeu credencial do túnel' || fail 'core recebeu credencial do túnel'
  if [ -n "$APP_ENV_FILE" ] && [ -f "$APP_ENV_FILE" ] && \
     docker inspect -f '{{json .Config.Env}}' "$CORE_CONTAINER" 2>/dev/null | python3 -c '
import json
import re
import sys

def read_env(path):
    values = {}
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            raw = raw.rstrip("\r\n")
            if not raw or raw.lstrip().startswith("#") or "=" not in raw:
                continue
            key, value = raw.split("=", 1)
            if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in values:
                raise ValueError("invalid or duplicate key")
            values[key] = value
    return values

entries = json.load(sys.stdin)
if not isinstance(entries, list):
    raise SystemExit(1)
effective = {}
for entry in entries:
    key, separator, value = entry.partition("=")
    if not separator or key in effective:
        raise SystemExit(1)
    effective[key] = value
configured = read_env(sys.argv[1])
required = (
    "APP_URL", "BASE_URL", "PUBLIC_URL", "DOCS_URL", "MCP_URL",
    "PUBLIC_SURFACES_ENABLED", "ALLOW_ALL_GUILDS", "ALLOWED_GUILD_IDS",
    "ALLOW_LOCAL_APP_URL", "ALLOW_LEGACY_SHARED_STATE",
    "DISCORD_TOKEN", "APPLICATION_ID", "DISCORD_CLIENT_SECRET",
)
if any(effective.get(key) != configured.get(key) for key in required):
    raise SystemExit(1)
if effective.get("NODE_ENV") != "production":
    raise SystemExit(1)
' "$APP_ENV_FILE" >/dev/null 2>&1; then
    pass 'ambiente efetivo do core corresponde às invariantes privadas do app.env'
  else
    fail 'ambiente efetivo do core diverge do app.env privado ou contém duplicatas'
  fi
  BAD_PORTS="$(docker port "$CORE_CONTAINER" 2>/dev/null | awk '$3 !~ /^127\.0\.0\.1:/ && $3 !~ /^\[::1\]:/ {count++} END {print count+0}')"
  [ "$BAD_PORTS" -eq 0 ] && pass 'portas do core estão presas a loopback' || fail 'core publica porta fora de loopback'

  MOUNTS="$(docker inspect -f '{{range .Mounts}}{{println .Type "|" .Source "|" .Destination}}{{end}}' "$CORE_CONTAINER" 2>/dev/null || true)"
  rec_count=0 state_count=0 auth_count=0 cache_count=0
  while IFS='|' read -r mount_type source destination; do
    mount_type="$(xargs <<<"$mount_type")"
    source="$(xargs <<<"$source")"
    destination="$(xargs <<<"$destination")"
    [ -n "$destination" ] || continue
    case "$destination" in
      /app/recordings)
        rec_count=$((rec_count + 1))
        [ "$mount_type" = bind ] && [ "$source" = "$RECORDINGS_DIR" ] || fail 'mount de recordings não usa o caminho exato configurado'
        ;;
      /app/state)
        state_count=$((state_count + 1))
        [ "$mount_type" = bind ] && [ "$source" = "$STATE_DIR" ] || fail 'mount de state não usa o caminho exato configurado'
        ;;
      /app/auth)
        auth_count=$((auth_count + 1))
        [ "$mount_type" = bind ] && [ "$source" = "$AUTH_DIR" ] || fail 'mount de auth não usa o caminho exato configurado'
        ;;
      /home/node/.cache)
        cache_count=$((cache_count + 1))
        [ "$mount_type" = bind ] && [ "$source" = "$CACHE_DIR" ] || fail 'cache de modelo não usa o caminho exato configurado'
        ;;
      *) fail 'core possui mount inesperado' ;;
    esac
  done <<<"$MOUNTS"
  [ "$rec_count" -eq 1 ] && [ "$state_count" -eq 1 ] && [ "$auth_count" -eq 1 ] && [ "$cache_count" -eq 1 ] \
    && pass 'core usa exatamente os quatro mounts esperados' \
    || fail 'core precisa de um único mount para recordings, state, auth e cache'
  CORE_NETWORKS="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$CORE_CONTAINER" 2>/dev/null | sort -u)"
  [ "$(grep -cve '^$' <<<"$CORE_NETWORKS")" -eq 1 ] \
    && pass 'core usa exatamente uma rede privada' \
    || fail 'core possui rede adicional ou rede privada ausente'
  if [ "$(grep -cve '^$' <<<"$CORE_NETWORKS")" -eq 1 ]; then
    CORE_NETWORK_NAME="$(grep -ve '^$' <<<"$CORE_NETWORKS")"
    PRIVATE_MEMBERS="$(docker network inspect -f '{{range .Containers}}{{println .Name}}{{end}}' "$CORE_NETWORK_NAME" 2>/dev/null | grep -ve '^$' | sort -u)"
    EXPECTED_PRIVATE_MEMBERS="$CORE_CONTAINER"
    if profile_enabled tunnel; then
      EXPECTED_PRIVATE_MEMBERS="$(printf '%s\n%s\n' "$CORE_CONTAINER" "$TUNNEL_CONTAINER" | sort -u)"
    fi
    [ "$PRIVATE_MEMBERS" = "$EXPECTED_PRIVATE_MEMBERS" ] \
      && pass 'rede privada contém somente core e túnel esperado' \
      || fail 'rede privada contém endpoint inesperado ou endpoint esperado ausente'
    read -r CORE_NETWORK_ID CORE_NETWORK_DRIVER CORE_BRIDGE < <(
      docker network inspect -f '{{.Id}} {{.Driver}} {{index .Options "com.docker.network.bridge.name"}}' "$CORE_NETWORK_NAME" 2>/dev/null || true
    )
    CORE_BRIDGE="${CORE_BRIDGE:-br-${CORE_NETWORK_ID:0:12}}"
    firewall_family_ok() {
      local tool="$1" destination first_forward first_docker first_input expected_forward expected_docker expected_input index
      local egress_anchor host_anchor egress_chain host_chain egress_inactive host_inactive
      shift
      local -a egress_rules host_rules anchor_rules
      expected_forward='-A FORWARD -j DOCKER-USER'
      expected_docker="-A DOCKER-USER -i $CORE_BRIDGE -j KASSINAO-EGRESS"
      expected_input="-A INPUT -i $CORE_BRIDGE -j KASSINAO-HOST"
      first_forward="$("$tool" -S FORWARD 2>/dev/null | awk '$1 == "-A" {print; exit}')"
      first_docker="$("$tool" -S DOCKER-USER 2>/dev/null | awk '$1 == "-A" {print; exit}')"
      first_input="$("$tool" -S INPUT 2>/dev/null | awk '$1 == "-A" {print; exit}')"
      [ "$first_forward" = "$expected_forward" ] || return 1
      [ "$first_docker" = "$expected_docker" ] || return 1
      [ "$first_input" = "$expected_input" ] || return 1
      [ "$("$tool" -S FORWARD 2>/dev/null | grep -Fxc -- "$expected_forward")" -eq 1 ] || return 1
      [ "$("$tool" -S DOCKER-USER 2>/dev/null | grep -Fxc -- "$expected_docker")" -eq 1 ] || return 1
      [ "$("$tool" -S INPUT 2>/dev/null | grep -Fxc -- "$expected_input")" -eq 1 ] || return 1

      mapfile -t anchor_rules < <("$tool" -S KASSINAO-EGRESS 2>/dev/null | awk '$1 == "-A" {print}')
      [ "${#anchor_rules[@]}" -eq 1 ] || return 1
      egress_anchor="${anchor_rules[0]}"
      case "$egress_anchor" in
        '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-A') egress_chain=KASSINAO-EGRESS-A; egress_inactive=KASSINAO-EGRESS-B ;;
        '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-B') egress_chain=KASSINAO-EGRESS-B; egress_inactive=KASSINAO-EGRESS-A ;;
        *) return 1 ;;
      esac
      mapfile -t anchor_rules < <("$tool" -S KASSINAO-HOST 2>/dev/null | awk '$1 == "-A" {print}')
      [ "${#anchor_rules[@]}" -eq 1 ] || return 1
      host_anchor="${anchor_rules[0]}"
      case "$host_anchor" in
        '-A KASSINAO-HOST -j KASSINAO-HOST-A') host_chain=KASSINAO-HOST-A; host_inactive=KASSINAO-HOST-B ;;
        '-A KASSINAO-HOST -j KASSINAO-HOST-B') host_chain=KASSINAO-HOST-B; host_inactive=KASSINAO-HOST-A ;;
        *) return 1 ;;
      esac
      [ "$("$tool" -S 2>/dev/null | awk -v target="$egress_chain" '$1 == "-A" {for (i=1; i<NF; i++) if ($i == "-j" && $(i+1) == target) count++} END {print count+0}')" -eq 1 ] || return 1
      [ "$("$tool" -S 2>/dev/null | awk -v target="$host_chain" '$1 == "-A" {for (i=1; i<NF; i++) if ($i == "-j" && $(i+1) == target) count++} END {print count+0}')" -eq 1 ] || return 1
      [ "$("$tool" -S 2>/dev/null | awk -v a="$egress_inactive" -v b="$host_inactive" '$1 == "-A" {for (i=1; i<NF; i++) if ($i == "-j" && ($(i+1) == a || $(i+1) == b)) count++} END {print count+0}')" -eq 0 ] || return 1

      mapfile -t egress_rules < <("$tool" -S "$egress_chain" 2>/dev/null | awk '$1 == "-A" {print}')
      [ "${#egress_rules[@]}" -eq "$(( $# + 2 ))" ] || return 1
      [ "${egress_rules[0]}" = "-A $egress_chain -o $CORE_BRIDGE -j RETURN" ] || return 1
      index=1
      for destination in "$@"; do
        [ "${egress_rules[$index]}" = "-A $egress_chain -d $destination -j REJECT" ] || return 1
        index=$((index + 1))
      done
      [ "${egress_rules[$index]}" = "-A $egress_chain -j RETURN" ] || return 1

      mapfile -t host_rules < <("$tool" -S "$host_chain" 2>/dev/null | awk '$1 == "-A" {print}')
      [ "${#host_rules[@]}" -eq 3 ] || return 1
      [[ "${host_rules[0]}" == "-A $host_chain -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN" || \
         "${host_rules[0]}" == "-A $host_chain -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN" ]] || return 1
      [ "${host_rules[1]}" = "-A $host_chain -m addrtype --dst-type LOCAL -j REJECT" ] || return 1
      [ "${host_rules[2]}" = "-A $host_chain -j RETURN" ] || return 1
    }
    if [ "$CORE_NETWORK_DRIVER" = bridge ] && [ "$CORE_BRIDGE" = kas-private0 ] && \
       firewall_family_ok iptables 127.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 && \
       firewall_family_ok ip6tables ::1/128 fc00::/7 fe80::/10; then
      pass 'core/túnel têm egress lateral e acesso ao host negados em IPv4/IPv6'
    else
      fail 'política KASSINAO-EGRESS/HOST está ausente ou incompleta'
    fi
  fi
fi

section PUBLIC_CONTAINER
public_exists=false
docker inspect --format '{{.Id}}' "$PUBLIC_CONTAINER" >/dev/null 2>&1 && public_exists=true
if profile_enabled split-public; then
  if [ "$public_exists" != true ]; then
    fail 'profile split-public ativo sem container público'
  else
    PUBLIC_USER="$(docker inspect -f '{{.Config.User}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_PRIVILEGED="$(docker inspect -f '{{.HostConfig.Privileged}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_READONLY="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_CAP_DROP="$(docker inspect -f '{{json .HostConfig.CapDrop}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_CAP_ADD="$(docker inspect -f '{{json .HostConfig.CapAdd}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_DEVICES="$(docker inspect -f '{{json .HostConfig.Devices}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_DEVICE_RULES="$(docker inspect -f '{{json .HostConfig.DeviceCgroupRules}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_SECURITY_OPT="$(docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_NETWORK_MODE="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_PID_MODE="$(docker inspect -f '{{.HostConfig.PidMode}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_IPC_MODE="$(docker inspect -f '{{.HostConfig.IpcMode}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_UTS_MODE="$(docker inspect -f '{{.HostConfig.UtsMode}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_MOUNTS="$(docker inspect -f '{{json .Mounts}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_STATE_HEALTH="$(docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    PUBLIC_RESTART_POLICY="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)"
    case "$PUBLIC_USER" in '' | 0 | root | 0:0 | root:root) fail 'processo público roda como root' ;; *) pass 'processo público roda como não-root' ;; esac
    [ "$PUBLIC_STATE_HEALTH" = 'running|healthy' ] \
      && pass 'processo público está running e healthy' \
      || fail 'processo público precisa estar running e healthy antes da aprovação'
    [ "$PUBLIC_RESTART_POLICY" = unless-stopped ] \
      && pass 'processo público usa restart policy unless-stopped' \
      || fail 'processo público precisa usar restart policy unless-stopped'
    [ "$PUBLIC_PRIVILEGED" = false ] && pass 'processo público não é privilegiado' || fail 'processo público está privilegiado'
    [ "$PUBLIC_READONLY" = true ] && pass 'root filesystem público é read-only' || fail 'root filesystem público permite escrita'
    grep -q 'ALL' <<<"$PUBLIC_CAP_DROP" && pass 'processo público remove capabilities' || fail 'processo público mantém capabilities'
    { [ "$PUBLIC_CAP_ADD" = null ] || [ "$PUBLIC_CAP_ADD" = '[]' ]; } && pass 'processo público não readiciona capabilities' || fail 'processo público readiciona capabilities'
    { [ "$PUBLIC_DEVICES" = null ] || [ "$PUBLIC_DEVICES" = '[]' ]; } && \
      { [ "$PUBLIC_DEVICE_RULES" = null ] || [ "$PUBLIC_DEVICE_RULES" = '[]' ]; } \
      && pass 'processo público não recebe devices' || fail 'processo público recebe device ou regra de device'
    grep -q 'no-new-privileges' <<<"$PUBLIC_SECURITY_OPT" && pass 'processo público usa no-new-privileges' || fail 'processo público sem no-new-privileges'
    grep -Eqi '(apparmor|seccomp)[=:]unconfined' <<<"$PUBLIC_SECURITY_OPT" \
      && fail 'processo público usa perfil unconfined' || pass 'processo público não desativa AppArmor/seccomp'
    [[ "$PUBLIC_NETWORK_MODE" != host && "$PUBLIC_NETWORK_MODE" != container:* ]] && pass 'processo público não compartilha namespace de rede' || fail 'processo público compartilha namespace de rede'
    [ -z "$PUBLIC_PID_MODE" ] && pass 'processo público tem namespace de processos isolado' || fail 'processo público compartilha namespace de processos'
    { [ -z "$PUBLIC_IPC_MODE" ] || [ "$PUBLIC_IPC_MODE" = private ]; } && pass 'processo público tem IPC isolado' || fail 'processo público compartilha IPC'
    [ -z "$PUBLIC_UTS_MODE" ] && pass 'processo público tem UTS isolado' || fail 'processo público compartilha UTS'
    [ "$PUBLIC_MOUNTS" = '[]' ] && pass 'processo público não possui mounts' || fail 'processo público possui mounts'
    BAD_PUBLIC_PORTS="$(docker port "$PUBLIC_CONTAINER" 2>/dev/null | awk '$3 !~ /^127\.0\.0\.1:/ && $3 !~ /^\[::1\]:/ {count++} END {print count+0}')"
    [ "$BAD_PUBLIC_PORTS" -eq 0 ] && pass 'portas públicas do container estão presas a loopback' || fail 'processo público publica porta fora de loopback'
    [ "$PUBLIC_IMAGE" = "$CONFIGURED_IMAGE" ] && pass 'core e público usam o mesmo digest' || fail 'core e público usam imagens diferentes'
    PUBLIC_RELEASE="$(container_env_value "$PUBLIC_CONTAINER" KASSINAO_RELEASE_DIGEST)"
    PUBLIC_DEPLOYMENT="$(container_env_value "$PUBLIC_CONTAINER" KASSINAO_DEPLOYMENT_FINGERPRINT)"
    [ "$PUBLIC_RELEASE" = "$EXPECTED_RELEASE" ] && [ "$PUBLIC_DEPLOYMENT" = "$EXPECTED_DEPLOYMENT" ] \
      && pass 'processo público recebeu os fingerprints exatos' \
      || fail 'processo público recebeu fingerprint divergente'
    PUBLIC_NETWORKS="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$PUBLIC_CONTAINER" 2>/dev/null | sort -u)"
    SHARED_NETWORKS="$(comm -12 <(printf '%s\n' "$CORE_NETWORKS") <(printf '%s\n' "$PUBLIC_NETWORKS"))"
    [ -z "$SHARED_NETWORKS" ] && pass 'core e público não compartilham rede' || fail 'core e público compartilham rede'
    PUBLIC_NETWORK_COUNT="$(grep -cve '^$' <<<"$PUBLIC_NETWORKS")"
    if [ "$PUBLIC_NETWORK_COUNT" -eq 1 ]; then
      PUBLIC_NETWORK_NAME="$(grep -ve '^$' <<<"$PUBLIC_NETWORKS")"
      PUBLIC_MEMBERS="$(docker network inspect -f '{{range .Containers}}{{println .Name}}{{end}}' "$PUBLIC_NETWORK_NAME" 2>/dev/null | grep -ve '^$' | sort -u)"
      EXPECTED_PUBLIC_MEMBERS="$PUBLIC_CONTAINER"
      if profile_enabled tunnel; then
        EXPECTED_PUBLIC_MEMBERS="$(printf '%s\n%s\n' "$PUBLIC_CONTAINER" "$TUNNEL_CONTAINER" | sort -u)"
      fi
      [ "$PUBLIC_MEMBERS" = "$EXPECTED_PUBLIC_MEMBERS" ] \
        && pass 'rede pública contém somente landing/docs e túnel esperado' \
        || fail 'rede pública contém endpoint inesperado ou endpoint esperado ausente'
      PUBLIC_NETWORK_POLICY="$(docker network inspect -f '{{.Internal}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv6"}}' "$PUBLIC_NETWORK_NAME" 2>/dev/null || true)"
      [ "$PUBLIC_NETWORK_POLICY" = 'true|isolated|isolated' ] \
        && pass 'rede pública nega egress e gateway IPv4/IPv6 do host' \
        || fail 'rede pública não está internal+isolated em IPv4/IPv6'
    else
      fail 'processo público precisa usar exatamente uma rede isolada'
    fi

    PUBLIC_ALLOWED_ENV='NODE_ENV NODE_VERSION YARN_VERSION PYTHONDONTWRITEBYTECODE PATH HOME HOSTNAME PORT WEB_BIND_ADDRESS PUBLIC_URL DOCS_URL SOURCE_URL KASSINAO_RELEASE_DIGEST KASSINAO_DEPLOYMENT_FINGERPRINT TRUST_PROXY_HOPS REPO_PUBLIC TZ LANG LC_ALL TERM NO_COLOR FORCE_COLOR'
    bad_public_env=''
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      name="${entry%%=*}"
      value="${entry#*=}"
      [ "$entry" != "$name" ] || continue
      [ -n "$value" ] || continue
      case " $PUBLIC_ALLOWED_ENV " in
        *" $name "*) ;;
        *) bad_public_env="${bad_public_env}${bad_public_env:+,}$name" ;;
      esac
    done < <(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$PUBLIC_CONTAINER" 2>/dev/null)
    [ -z "$bad_public_env" ] && pass 'env público obedece à allowlist positiva' || fail "env público fora da allowlist: $bad_public_env"
  fi
elif [ "$public_exists" = true ] && [ "$(docker inspect -f '{{.State.Running}}' "$PUBLIC_CONTAINER" 2>/dev/null || true)" = true ]; then
  fail 'container público está rodando sem profile split-public'
else
  pass 'profile split-public inativo não expõe processo público'
fi

section TUNNEL_CONTAINER
tunnel_exists=false
docker inspect --format '{{.Id}}' "$TUNNEL_CONTAINER" >/dev/null 2>&1 && tunnel_exists=true
if profile_enabled tunnel; then
  COMPOSE_FILE="$DEPLOY_REAL/docker-compose.yml"
  EXPECTED_TUNNEL_IMAGE=''
  if [ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ]; then
    COMPOSE_IMAGES="$(
      env -i "PATH=$PATH" "HOME=${HOME:-/root}" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" \
        "DOCKER_HOST=$DOCKER_HOST" "DOCKER_CONFIG=$DOCKER_CONFIG" docker compose \
        --project-name kassinao \
        --project-directory "$DEPLOY_REAL" \
        --env-file "$ENV_FILE" \
        -f "$COMPOSE_FILE" \
        --profile tunnel \
        config --images 2>/dev/null
    )" || COMPOSE_IMAGES=''
    MATCHING_TUNNEL_IMAGES="$(grep -E '^cloudflare/cloudflared:' <<<"$COMPOSE_IMAGES" || true)"
    if [ "$(grep -cve '^$' <<<"$MATCHING_TUNNEL_IMAGES")" -eq 1 ]; then
      EXPECTED_TUNNEL_IMAGE="$(grep -ve '^$' <<<"$MATCHING_TUNNEL_IMAGES")"
      pass 'imagem esperada do túnel foi derivada do Compose selado'
    else
      fail 'Compose não resolveu exatamente uma imagem cloudflared'
    fi
  else
    fail 'Compose selado está ausente para validar o túnel'
  fi
  if [ "$tunnel_exists" != true ]; then
    fail 'profile tunnel ativo sem cloudflared'
  else
    TUNNEL_USER="$(docker inspect -f '{{.Config.User}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_PRIVILEGED="$(docker inspect -f '{{.HostConfig.Privileged}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_READONLY="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_CAP_DROP="$(docker inspect -f '{{json .HostConfig.CapDrop}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_CAP_ADD="$(docker inspect -f '{{json .HostConfig.CapAdd}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_DEVICES="$(docker inspect -f '{{json .HostConfig.Devices}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_DEVICE_RULES="$(docker inspect -f '{{json .HostConfig.DeviceCgroupRules}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_SECURITY_OPT="$(docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_NETWORK_MODE="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_PID_MODE="$(docker inspect -f '{{.HostConfig.PidMode}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_IPC_MODE="$(docker inspect -f '{{.HostConfig.IpcMode}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_UTS_MODE="$(docker inspect -f '{{.HostConfig.UtsMode}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_MOUNTS="$(docker inspect -f '{{json .Mounts}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_PORTS="$(docker port "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_STATE="$(docker inspect -f '{{.State.Status}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_RESTART_POLICY="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    case "$TUNNEL_USER" in '' | 0 | root | 0:0 | root:root) fail 'cloudflared roda como root' ;; *) pass 'cloudflared roda como não-root' ;; esac
    [ "$TUNNEL_STATE" = running ] \
      && pass 'cloudflared está running' \
      || fail 'cloudflared precisa estar running antes da aprovação'
    [ "$TUNNEL_RESTART_POLICY" = unless-stopped ] \
      && pass 'cloudflared usa restart policy unless-stopped' \
      || fail 'cloudflared precisa usar restart policy unless-stopped'
    [ "$TUNNEL_PRIVILEGED" = false ] && pass 'cloudflared não é privilegiado' || fail 'cloudflared está privilegiado'
    [ "$TUNNEL_READONLY" = true ] && pass 'root filesystem do cloudflared é read-only' || fail 'root filesystem do cloudflared permite escrita'
    grep -q 'ALL' <<<"$TUNNEL_CAP_DROP" && pass 'cloudflared remove capabilities' || fail 'cloudflared mantém capabilities'
    { [ "$TUNNEL_CAP_ADD" = null ] || [ "$TUNNEL_CAP_ADD" = '[]' ]; } && pass 'cloudflared não readiciona capabilities' || fail 'cloudflared readiciona capabilities'
    { [ "$TUNNEL_DEVICES" = null ] || [ "$TUNNEL_DEVICES" = '[]' ]; } && \
      { [ "$TUNNEL_DEVICE_RULES" = null ] || [ "$TUNNEL_DEVICE_RULES" = '[]' ]; } \
      && pass 'cloudflared não recebe devices' || fail 'cloudflared recebe device ou regra de device'
    grep -q 'no-new-privileges' <<<"$TUNNEL_SECURITY_OPT" && pass 'cloudflared usa no-new-privileges' || fail 'cloudflared sem no-new-privileges'
    grep -Eqi '(apparmor|seccomp)[=:]unconfined' <<<"$TUNNEL_SECURITY_OPT" \
      && fail 'cloudflared usa perfil unconfined' || pass 'cloudflared não desativa AppArmor/seccomp'
    [[ "$TUNNEL_NETWORK_MODE" != host && "$TUNNEL_NETWORK_MODE" != container:* ]] && pass 'cloudflared não compartilha namespace de rede' || fail 'cloudflared compartilha namespace de rede'
    [ -z "$TUNNEL_PID_MODE" ] && pass 'cloudflared tem namespace de processos isolado' || fail 'cloudflared compartilha namespace de processos'
    { [ -z "$TUNNEL_IPC_MODE" ] || [ "$TUNNEL_IPC_MODE" = private ]; } && pass 'cloudflared tem IPC isolado' || fail 'cloudflared compartilha IPC'
    [ -z "$TUNNEL_UTS_MODE" ] && pass 'cloudflared tem UTS isolado' || fail 'cloudflared compartilha UTS'
    [ "$TUNNEL_MOUNTS" = '[]' ] && pass 'cloudflared não possui mounts' || fail 'cloudflared possui mounts'
    [ -z "$TUNNEL_PORTS" ] && pass 'cloudflared não publica portas' || fail 'cloudflared publica portas'
    [[ "$EXPECTED_TUNNEL_IMAGE" =~ ^cloudflare/cloudflared:[0-9][0-9A-Za-z._-]*@sha256:[0-9a-f]{64}$ ]] && \
      [ "$TUNNEL_IMAGE" = "$EXPECTED_TUNNEL_IMAGE" ] \
      && pass 'cloudflared usa a versão e o digest exatos do Compose selado' \
      || fail 'cloudflared diverge da imagem imutável do Compose selado'
    TUNNEL_RUNTIME_ENTRYPOINT="$(docker inspect -f '{{json .Config.Entrypoint}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    TUNNEL_IMAGE_ENTRYPOINT="$(docker image inspect -f '{{json .Config.Entrypoint}}' "$EXPECTED_TUNNEL_IMAGE" 2>/dev/null || true)"
    TUNNEL_RUNTIME_CMD="$(docker inspect -f '{{json .Config.Cmd}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
    [ -n "$TUNNEL_IMAGE_ENTRYPOINT" ] && [ "$TUNNEL_RUNTIME_ENTRYPOINT" = "$TUNNEL_IMAGE_ENTRYPOINT" ] && \
      [ "$TUNNEL_RUNTIME_CMD" = '["tunnel","--no-autoupdate","run"]' ] \
      && pass 'cloudflared preserva Entrypoint e usa Cmd fixo de tunnel sem autoupdate' \
      || fail 'cloudflared altera Entrypoint ou usa Cmd diferente do túnel aprovado'
    EXPECTED_TUNNEL_TOKEN="$(env_value TUNNEL_TOKEN "$ENV_FILE")"
    RUNTIME_TUNNEL_TOKEN="$(container_env_value "$TUNNEL_CONTAINER" TUNNEL_TOKEN)"
    [ -n "$EXPECTED_TUNNEL_TOKEN" ] && [ "$RUNTIME_TUNNEL_TOKEN" = "$EXPECTED_TUNNEL_TOKEN" ] \
      && pass 'credencial efetiva do túnel corresponde silenciosamente ao .env privado' \
      || fail 'credencial efetiva do túnel está ausente ou diverge do .env privado'
    unset EXPECTED_TUNNEL_TOKEN RUNTIME_TUNNEL_TOKEN
    if docker inspect -f '{{json .Config.Labels}}' "$TUNNEL_CONTAINER" 2>/dev/null | python3 -c '
import json
import sys

labels = json.load(sys.stdin)
if not isinstance(labels, dict):
    raise SystemExit(1)
expected = {
    "com.docker.compose.project": "kassinao",
    "com.docker.compose.service": "cloudflared",
    "com.docker.compose.oneoff": "False",
    "com.docker.compose.project.working_dir": sys.argv[1],
    "com.docker.compose.project.config_files": sys.argv[1] + "/docker-compose.yml",
}
if any(labels.get(key) != value for key, value in expected.items()):
    raise SystemExit(1)
' "$DEPLOY_REAL" >/dev/null 2>&1; then
      pass 'labels efetivos do cloudflared pertencem ao projeto/serviço Compose selado'
    else
      fail 'labels do cloudflared divergem do projeto, serviço ou Compose operacional'
    fi
    TUNNEL_NETWORKS="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$TUNNEL_CONTAINER" 2>/dev/null | sort -u)"
    EXPECTED_TUNNEL_NETWORKS="$CORE_NETWORKS"
    if profile_enabled split-public; then
      EXPECTED_TUNNEL_NETWORKS="$(printf '%s\n%s\n' "$CORE_NETWORKS" "$PUBLIC_NETWORKS" | grep -ve '^$' | sort -u)"
    fi
    [ "$TUNNEL_NETWORKS" = "$EXPECTED_TUNNEL_NETWORKS" ] \
      && pass 'cloudflared usa somente a união das redes esperadas' \
      || fail 'cloudflared possui rede extra ou rede esperada ausente'
  fi
elif [ "$tunnel_exists" = true ] && [ "$(docker inspect -f '{{.State.Running}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)" = true ]; then
  fail 'cloudflared está rodando sem profile tunnel'
else
  pass 'profile tunnel inativo não mantém cloudflared'
fi

section WATCHDOG_EXECUTION
if systemctl start kassinao-health-watch.service >/dev/null 2>&1 && \
   unit_property_is kassinao-health-watch.service Result success && \
   unit_property_is kassinao-health-watch.service ExecMainStatus 0; then
  pass 'watchdog oneshot foi executado agora e terminou com sucesso'
else
  fail 'watchdog oneshot não executou ou retornou resultado diferente de sucesso'
fi

section SUMMARY
printf 'failures=%d warnings=%d\n' "$FAILURES" "$WARNINGS"
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
pass 'VPS atende aos invariantes automatizados'
