#!/usr/bin/env bash
# Deploy image-only, fail-closed. Executa apenas controles verificados do kit,
# sanitiza o ambiente do Compose e nunca compila source na VPS.
set -Eeuo pipefail
umask 077

ROOT_INPUT="${KASSINAO_DEPLOY_DIR:-$(pwd)}"
TEMP_CONFIG=''
STRUCTURE_ENV=''
ROLLBACK_ENV=''
SNAPSHOT_STAGE=''
SNAPSHOT_ARCHIVE_TMP=''
DEPLOY_STARTED=false
DEPLOY_COMPLETE=false
PREVIOUS_IMAGE=''
PREVIOUS_CORE_ID=''
RESTART_PREVIOUS_CORE=false
SNAPSHOT_ARCHIVE=''
DEPLOYED_IMAGE_TMP=''

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

seal_local_docker() {
  local name
  for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
    if declare -p "$name" >/dev/null 2>&1; then
      die "$name não pode vir do ambiente; produção usa somente o daemon local da VPS"
    fi
  done
  export DOCKER_HOST=unix:///var/run/docker.sock
  unset DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
}
seal_local_docker

cleanup() {
  [ -z "$TEMP_CONFIG" ] || rm -f -- "$TEMP_CONFIG"
  [ -z "$STRUCTURE_ENV" ] || rm -f -- "$STRUCTURE_ENV"
  [ -z "$ROLLBACK_ENV" ] || rm -f -- "$ROLLBACK_ENV"
  [ -z "$SNAPSHOT_STAGE" ] || rm -rf -- "$SNAPSHOT_STAGE"
  [ -z "$SNAPSHOT_ARCHIVE_TMP" ] || rm -f -- "$SNAPSHOT_ARCHIVE_TMP"
  [ -z "$DEPLOYED_IMAGE_TMP" ] || rm -f -- "$DEPLOYED_IMAGE_TMP"
}

stop_failed_deploy_containers() {
  local container running containers
  if ! containers="$(docker ps -a --format '{{.Names}}')"; then
    printf 'ERRO CRÍTICO: não foi possível enumerar containers para provar a contenção.\n' >&2
    return 0
  fi
  for container in kassinao kassinao-tunnel kassinao-public; do
    grep -Fqx "$container" <<<"$containers" || continue
    if ! docker stop --time 30 "$container" >/dev/null 2>&1; then
      # O kill interrompe um processo que não respeitou o timeout; um segundo
      # stop marca a parada como administrativa e impede a restart policy de
      # religá-lo imediatamente.
      docker kill "$container" >/dev/null 2>&1 || true
      docker stop --time 10 "$container" >/dev/null 2>&1 || true
    fi
    running="$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)"
    if [ "$running" = false ]; then
      printf 'Container da tentativa falha contido: %s\n' "$container" >&2
    else
      printf 'ERRO CRÍTICO: não foi possível provar o container parado: %s\n' "$container" >&2
    fi
  done
}

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$DEPLOY_STARTED" = true ] && [ "$DEPLOY_COMPLETE" = false ]; then
    stop_failed_deploy_containers
  fi
  if [ "$status" -ne 0 ] && [ "$RESTART_PREVIOUS_CORE" = true ] && [ -n "$PREVIOUS_CORE_ID" ]; then
    if ! egress_ready; then
      printf 'ERRO CRÍTICO: core anterior permaneceu parado porque egress não está active e válido.\n' >&2
    elif docker start "$PREVIOUS_CORE_ID" >/dev/null 2>&1; then
      local deadline=$((SECONDS + 120)) health=''
      while [ "$SECONDS" -lt "$deadline" ]; do
        health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$PREVIOUS_CORE_ID" 2>/dev/null || true)"
        [ "$health" = healthy ] && break
        case "$health" in unhealthy | exited | dead) break ;; esac
        sleep 3
      done
      if [ "$health" = healthy ]; then
        printf 'O core anterior foi reiniciado e voltou saudável porque a troca ainda não havia começado.\n' >&2
      else
        printf 'ERRO CRÍTICO: o core anterior reiniciou, mas não voltou saudável.\n' >&2
      fi
    else
      printf 'ERRO CRÍTICO: não foi possível reiniciar o core anterior; intervenção manual necessária.\n' >&2
    fi
  fi
  cleanup
  if [ "$status" -ne 0 ] && [ "$DEPLOY_STARTED" = true ] && [ "$DEPLOY_COMPLETE" = false ]; then
    printf 'Deploy falhou. Snapshot preservado em %s.\n' "${SNAPSHOT_ARCHIVE:-indisponível}" >&2
    case "$PREVIOUS_IMAGE" in
      ghcr.io/*@sha256:????????????????????????????????????????????????????????????????)
        printf 'A imagem anterior permanece registrada (%s); restaure o snapshot antes de rollback se houve migração.\n' "$PREVIOUS_IMAGE" >&2
        ;;
      *) printf 'Rollback automático não é seguro para a instalação legada; nenhum dado foi apagado pelo gate.\n' >&2 ;;
    esac
  fi
  exit "$status"
}
trap on_exit EXIT

file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

require_private_directory() {
  local directory="$1" mode
  [ -d "$directory" ] && [ ! -L "$directory" ] || die "diretório privado ausente ou symlink: $directory"
  [ -O "$directory" ] || die "diretório privado precisa pertencer ao usuário atual: $directory"
  mode="$(file_mode "$directory")"
  (( (8#$mode & 077) == 0 )) || die "$directory precisa de modo 0700 (atual: $mode)"
}

require_private_file() {
  local file="$1" mode
  [ -f "$file" ] && [ ! -L "$file" ] || die "arquivo privado ausente ou symlink: $file"
  [ -O "$file" ] || die "arquivo privado precisa pertencer ao usuário atual: $file"
  mode="$(file_mode "$file")"
  case "$mode" in 600 | 400) ;; *) die "$file precisa de modo 0600 ou 0400 (atual: $mode)" ;; esac
}

require_control_file() {
  local file="$1" mode
  [ -f "$file" ] && [ ! -L "$file" ] || die "controle ausente ou symlink: $file"
  [ -O "$file" ] || die "controle precisa pertencer ao usuário atual: $file"
  mode="$(file_mode "$file")"
  (( (8#$mode & 022) == 0 )) || die "$file não pode ser gravável por grupo/outros (atual: $mode)"
}

require_private_directory "$ROOT_INPUT"
ROOT="$(cd -- "$ROOT_INPUT" && pwd -P)"
cursor="$ROOT"
while :; do
  [ ! -e "$cursor/.git" ] || die "deploy precisa ficar fora de qualquer Git ($cursor/.git)"
  parent="$(dirname "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done

LOCK_FILE="$ROOT/.deploy.lock"
[ ! -L "$LOCK_FILE" ] || die 'lock de deploy não pode ser symlink'
command -v flock >/dev/null 2>&1 || die 'flock não encontrado'
exec 9>"$LOCK_FILE"
chmod 600 "$LOCK_FILE"
flock -n 9 || die 'já existe outro deploy em andamento'

# O deploy, o backup consistente e o watchdog compartilham um único diretório
# provisionado pelo installer. Não há fallback por usuário: locks diferentes
# permitiriam ao watchdog religar o writer durante um snapshot.
RUNTIME_DIR="${KASSINAO_RUNTIME_DIR:-/run/lock/kassinao}"
[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] || die 'diretório de runtime inválido'
MAINTENANCE_LOCK_FILE="$RUNTIME_DIR/maintenance.lock"
[ -d "$(dirname -- "$MAINTENANCE_LOCK_FILE")" ] || die 'diretório do lock de manutenção não existe'
[ ! -L "$MAINTENANCE_LOCK_FILE" ] || die 'lock de manutenção não pode ser symlink'
exec 8>"$MAINTENANCE_LOCK_FILE"
chmod 600 "$MAINTENANCE_LOCK_FILE"
flock -w 120 8 || die 'outra manutenção não liberou a instância em 120 segundos'

MANIFEST="$ROOT/MANIFEST.sha256"
require_control_file "$MANIFEST"
if command -v sha256sum >/dev/null 2>&1; then
  (cd -- "$ROOT" && sha256sum -c MANIFEST.sha256 --quiet) || die 'kit operacional diverge do MANIFEST.sha256'
else
  (cd -- "$ROOT" && shasum -a 256 -c MANIFEST.sha256 >/dev/null) || die 'kit operacional diverge do MANIFEST.sha256'
fi

ENV_FILE="$ROOT/.env"
COMPOSE_FILE="$ROOT/docker-compose.yml"
COMPOSE_TEMPLATE="$ROOT/compose.env.example"
HARDENER="$ROOT/scripts/harden-docker-egress.sh"
STORAGE_VERIFIER="$ROOT/scripts/verify-storage-encryption.sh"
SYSTEMCTL="${SYSTEMCTL_BIN:-systemctl}"
require_private_file "$ENV_FILE"
require_control_file "$COMPOSE_FILE"
require_control_file "$COMPOSE_TEMPLATE"
require_control_file "$HARDENER"
require_control_file "$STORAGE_VERIFIER"
run_hardener() {
  env -i "PATH=$PATH" "HOME=${HOME:-/root}" "$HARDENER" "$@"
}
egress_ready() {
  command -v "$SYSTEMCTL" >/dev/null 2>&1 || return 1
  "$SYSTEMCTL" is-active --quiet kassinao-docker-egress.service || return 1
  run_hardener --check >/dev/null
}

# O manifesto é uma allowlist dos controles executáveis. Um arquivo antigo que
# sobreviveu a uma cópia por cima não pode continuar disponível em scripts/ ou
# deploy/. Releases oficiais devem ser extraídas em diretórios novos.
manifest_controls="$(awk '{path=$2; sub(/^\.\//, "", path); if (path ~ /^(scripts|deploy)\//) print "./" path}' "$MANIFEST" | sort)"
actual_controls="$(cd -- "$ROOT" && find scripts deploy -type f -print | sed 's|^|./|' | sort)"
[ "$actual_controls" = "$manifest_controls" ] || die 'kit contém controle extra/ausente; extraia a release em diretório vazio'

env_value() {
  local key="$1" file="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count > 1) exit 2; print value }
  ' "$file" || die "$key aparece mais de uma vez em $file"
}

canonical_https_origin() {
  local value="$1" destination="$2" authority host port='' port_number suffix='' port_present=false
  case "$value" in https://*) authority="${value#https://}" ;; *) return 1 ;; esac
  case "$authority" in
    '' | *'/'* | *'\\'* | *'?'* | *'#'* | *'@'*) return 1 ;;
  esac
  [[ ! "$authority" =~ [[:space:]] ]] || return 1

  if [[ "$authority" == \[* ]]; then
    [[ "$authority" =~ ^(\[[0-9A-Fa-f:]+\])(:([0-9]{1,5}))?$ ]] || return 1
    host="$(printf '%s' "${BASH_REMATCH[1]}" | tr 'A-F' 'a-f')"
    port="${BASH_REMATCH[3]-}"
    [ -z "${BASH_REMATCH[2]-}" ] || port_present=true
  else
    host="$authority"
    if [[ "$authority" == *:* ]]; then
      port_present=true
      host="${authority%:*}"
      port="${authority##*:}"
    fi
    if [[ "$host" == *. ]]; then
      host="${host%.}"
    fi
    host="$(printf '%s' "$host" | tr 'A-Z' 'a-z')"
    [[ "$host" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || return 1
  fi

  if [ "$port_present" = true ]; then
    [[ "$port" =~ ^[0-9]{1,5}$ ]] || return 1
    port_number=$((10#$port))
    [ "$port_number" -ge 1 ] && [ "$port_number" -le 65535 ] || return 1
    [ "$port_number" -eq 443 ] || suffix=":$port_number"
  fi
  printf -v "$destination" '%s' "https://$host$suffix"
}

is_public_dns_host() {
  local host
  host="$(printf '%s' "$1" | tr 'A-Z' 'a-z')"
  case "$host" in
    localhost | *.localhost | *.local | *.internal | *.test | *.invalid) return 1 ;;
  esac
  [[ "$host" == *.* ]] || return 1
  [[ ! "$host" =~ ^[0-9.]+$ && ! "$host" =~ ^[0-9a-f:]+$ ]] || return 1
}

validate_public_page_url() {
  local value="$1" remainder authority path origin host
  case "$value" in https://*) ;; *) return 1 ;; esac
  [[ ! "$value" =~ [[:space:]] ]] || return 1
  case "$value" in *'\\'* | *'?'* | *'#'* | *'@'*) return 1 ;; esac
  remainder="${value#https://}"
  [[ "$remainder" == */* ]] || return 1
  authority="${remainder%%/*}"
  path="/${remainder#*/}"
  [ "$path" != / ] || return 1
  canonical_https_origin "https://$authority" origin || return 1
  host="${origin#https://}"
  host="${host%%:*}"
  is_public_dns_host "$host"
}

validate_operator_contact() {
  local value="$1" address domain
  case "$value" in
    mailto:*)
      address="${value#mailto:}"
      case "$address" in '' | *[[:space:],/?#]* | *@*@*) return 1 ;; esac
      [[ "$address" =~ ^[^@]+@[^@]+$ ]] || return 1
      domain="${address##*@}"
      is_public_dns_host "$domain"
      ;;
    *) validate_public_page_url "$value" ;;
  esac
}

validate_public_statement() {
  local value="$1" max_length="${2:-1000}" lower
  [ -n "$value" ] && [ "${#value}" -le "$max_length" ] || return 1
  [[ ! "$value" =~ [[:cntrl:]=] ]] || return 1
  case "$value" in *'://'* | *'@'* | *'#'* | *'$'* | *'`'* | *'\'*) return 1 ;; esac
  [[ ! "$value" =~ (^|[^0-9])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9]|$) ]] || return 1
  [[ ! "$value" =~ ([0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f:]+ ]] || return 1
  [[ ! "$value" =~ (^|[^0-9])[0-9]{15,22}([^0-9]|$) ]] || return 1
  [[ ! "$value" =~ [0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89AaBb][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12} ]] || return 1
  [[ ! "$value" =~ ([A-Za-z0-9-]+\.)+[A-Za-z]{2,63} ]] || return 1
  lower="$(printf '%s' "$value" | tr 'A-Z' 'a-z')"
  case "$lower" in *localhost* | *.local* | *.internal* | *.lan*) return 1 ;; esac
}

load_deploy_origin() {
  local key="$1" fallback="$2" destination="$3" app_raw compose_raw app_canonical compose_canonical
  app_raw="$(env_value "$key" "$APP_ENV")"
  app_raw="${app_raw:-$fallback}"
  canonical_https_origin "$app_raw" app_canonical || die "$key precisa ser uma origem HTTPS sem caminho/credenciais"
  compose_raw="$(env_value "$key" "$ENV_FILE")"
  canonical_https_origin "$compose_raw" compose_canonical || die "$key precisa ser uma origem HTTPS explícita em .env"
  [ "$compose_canonical" = "$app_canonical" ] || die "$key diverge entre .env e app.env"
  printf -v "$destination" '%s' "$app_canonical"
}

image="$(env_value KASSINAO_IMAGE "$ENV_FILE")"
[[ "$image" =~ ^ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] || \
  die 'KASSINAO_IMAGE precisa ser ghcr.io/...@sha256:<64 hex>'
[ "$image" = "$(env_value KASSINAO_IMAGE "$COMPOSE_TEMPLATE")" ] || \
  die 'KASSINAO_IMAGE diverge do digest selado neste kit de release'
digest="${image##*@}"
release_digest="$(env_value KASSINAO_RELEASE_DIGEST "$ENV_FILE")"
[[ "$release_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || \
  die 'KASSINAO_RELEASE_DIGEST precisa ser sha256:<64 hex>'
[ "$release_digest" = "$digest" ] || die 'fingerprint da release diverge de KASSINAO_IMAGE'
[ "$release_digest" = "$(env_value KASSINAO_RELEASE_DIGEST "$COMPOSE_TEMPLATE")" ] || \
  die 'fingerprint da release diverge do digest selado neste kit'
deployment_fingerprint="$(env_value KASSINAO_DEPLOYMENT_FINGERPRINT "$ENV_FILE")"
[[ "$deployment_fingerprint" =~ ^[0-9a-f]{32}$ ]] || \
  die 'KASSINAO_DEPLOYMENT_FINGERPRINT precisa ser gerado pelo injector'

app_env_name="$(env_value KASSINAO_APP_ENV_FILE "$ENV_FILE")"
app_env_name="${app_env_name:-app.env}"
[[ "$app_env_name" =~ ^[A-Za-z0-9._-]+$ ]] || die 'KASSINAO_APP_ENV_FILE precisa ser um arquivo dentro do kit'
APP_ENV="$ROOT/$app_env_name"
require_private_file "$APP_ENV"
[ -z "$(env_value BASE_URL "$APP_ENV")" ] || die 'BASE_URL legado precisa ficar vazio; use apenas APP_URL'
[ -z "$(env_value BASE_URL "$ENV_FILE")" ] || die 'BASE_URL não pode existir no ambiente do Compose'

mode="$(env_value KASSINAO_DEPLOYMENT_MODE "$ENV_FILE")"
[ "$mode" = split ] || die 'o kit operacional verificado aceita somente KASSINAO_DEPLOYMENT_MODE=split'
dedicated_host_ack="$(env_value KASSINAO_DEDICATED_DOCKER_HOST_ACK "$ENV_FILE")"
[ "$dedicated_host_ack" = I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO ] || \
  die 'defina KASSINAO_DEDICATED_DOCKER_HOST_ACK=I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO; os pre-hooks controlam o docker.service inteiro'
profiles="$(env_value COMPOSE_PROFILES "$ENV_FILE")"
tunnel_token="$(env_value TUNNEL_TOKEN "$ENV_FILE")"
has_profile() { case ",$profiles," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
if has_profile tunnel; then [ -n "$tunnel_token" ] || die 'profile tunnel exige TUNNEL_TOKEN';
elif [ -n "$tunnel_token" ]; then die 'TUNNEL_TOKEN definido sem profile tunnel'; fi

for required in DISCORD_TOKEN APPLICATION_ID DISCORD_CLIENT_SECRET APP_URL ALLOWED_GUILD_IDS \
  OPERATOR_NAME OPERATOR_CONTACT_URL PRIVACY_POLICY_URL DATA_DELETION_URL SOURCE_URL \
  PRIVACY_EFFECTIVE_DATE PRIVACY_POLICY_VERSION PRIVACY_AUDIENCE PRIVACY_PURPOSES \
  PRIVACY_LAWFUL_BASIS INFRASTRUCTURE_PROVIDER INFRASTRUCTURE_REGION EDGE_PROVIDER EDGE_REGION \
  OPERATIONAL_LOG_RETENTION BACKUP_STATUS DATA_REQUEST_PROCESS DATA_REQUEST_RESPONSE_DAYS \
  INCIDENT_CONTACT_URL INCIDENT_PROCESS; do
  [ -n "$(env_value "$required" "$APP_ENV")" ] || die "$required precisa ser configurada em $APP_ENV"
done
[ "$(env_value ALLOW_ALL_GUILDS "$APP_ENV")" = false ] || die 'kit privado exige ALLOW_ALL_GUILDS=false'
[ "$(env_value ALLOW_LEGACY_SHARED_STATE "$APP_ENV")" = false ] || die 'kit de produção recusa estado legado compartilhado'
rollback_retention_hours="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS "$ENV_FILE")"
app_rollback_retention_hours="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS "$APP_ENV")"
[[ "$rollback_retention_hours" =~ ^[1-9][0-9]*$ ]] && \
  [ "$rollback_retention_hours" -le 168 ] || \
  die 'KASSINAO_ROLLBACK_RETENTION_HOURS precisa ficar entre 1 e 168'
[ "$app_rollback_retention_hours" = "$rollback_retention_hours" ] || \
  die 'KASSINAO_ROLLBACK_RETENTION_HOURS diverge entre .env e app.env'

load_deploy_origin APP_URL '' app_url
load_deploy_origin MCP_URL "$app_url" mcp_url
load_deploy_origin PUBLIC_URL "$app_url" public_url
load_deploy_origin DOCS_URL "$public_url" docs_url

source_url="$(env_value SOURCE_URL "$APP_ENV")"
compose_source_url="$(env_value SOURCE_URL "$ENV_FILE")"
validate_public_page_url "$source_url" || \
  die 'SOURCE_URL em app.env precisa ser uma página HTTPS pública com caminho'
validate_public_page_url "$compose_source_url" || \
  die 'SOURCE_URL em .env precisa ser uma página HTTPS pública com caminho'
[ "$source_url" = "$compose_source_url" ] || die 'SOURCE_URL diverge entre .env e app.env'

operator_name="$(env_value OPERATOR_NAME "$APP_ENV")"
[ "${#operator_name}" -le 160 ] && [[ ! "$operator_name" =~ [[:cntrl:]=] ]] && \
  [[ "$operator_name" =~ [^[:space:]] ]] || \
  die 'OPERATOR_NAME precisa ter até 160 caracteres, sem controles ou ='
operator_contact_url="$(env_value OPERATOR_CONTACT_URL "$APP_ENV")"
validate_operator_contact "$operator_contact_url" || \
  die 'OPERATOR_CONTACT_URL precisa ser página HTTPS pública com caminho ou mailto simples'
[ "$(env_value PRIVACY_POLICY_URL "$APP_ENV")" = "$app_url/privacy" ] || \
  die 'PRIVACY_POLICY_URL precisa ser exatamente APP_URL + /privacy'
[ "$(env_value DATA_DELETION_URL "$APP_ENV")" = "$app_url/privacy#data-rights" ] || \
  die 'DATA_DELETION_URL precisa ser exatamente APP_URL + /privacy#data-rights'
terms_url="$(env_value TERMS_OF_SERVICE_URL "$APP_ENV")"
[ -z "$terms_url" ] || validate_public_page_url "$terms_url" || \
  die 'TERMS_OF_SERVICE_URL precisa ser página HTTPS pública com caminho, sem query ou fragmento'

privacy_effective_date="$(env_value PRIVACY_EFFECTIVE_DATE "$APP_ENV")"
[[ "$privacy_effective_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || \
  die 'PRIVACY_EFFECTIVE_DATE precisa usar YYYY-MM-DD'
privacy_policy_version="$(env_value PRIVACY_POLICY_VERSION "$APP_ENV")"
[[ "$privacy_policy_version" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$ ]] && \
  [ "$(printf '%s' "$privacy_policy_version" | tr 'A-Z' 'a-z')" != local-draft ] || \
  die 'PRIVACY_POLICY_VERSION é inválida para produção'

for statement_name in PRIVACY_AUDIENCE PRIVACY_PURPOSES PRIVACY_LAWFUL_BASIS OPERATIONAL_LOG_RETENTION \
  DATA_REQUEST_PROCESS INCIDENT_PROCESS; do
  statement_value="$(env_value "$statement_name" "$APP_ENV")"
  validate_public_statement "$statement_value" || \
    die "$statement_name precisa ser descrição pública sem URL, e-mail, IP, hostname privado ou ID"
done
for statement_name in INFRASTRUCTURE_PROVIDER INFRASTRUCTURE_REGION EDGE_PROVIDER EDGE_REGION; do
  statement_value="$(env_value "$statement_name" "$APP_ENV")"
  validate_public_statement "$statement_value" 160 || \
    die "$statement_name precisa ser descrição pública de até 160 caracteres, sem coordenadas privadas"
done

infrastructure_provider="$(env_value INFRASTRUCTURE_PROVIDER "$APP_ENV")"
infrastructure_region="$(env_value INFRASTRUCTURE_REGION "$APP_ENV")"
case "$(printf '%s' "$infrastructure_provider" | tr 'A-Z' 'a-z')" in none | disabled | local)
  die 'INFRASTRUCTURE_PROVIDER precisa identificar o provedor real'
esac
case "$(printf '%s' "$infrastructure_region" | tr 'A-Z' 'a-z')" in none | disabled)
  die 'INFRASTRUCTURE_REGION precisa identificar a região/escopo público real'
esac

edge_provider="$(env_value EDGE_PROVIDER "$APP_ENV")"
edge_region="$(env_value EDGE_REGION "$APP_ENV")"
edge_provider_lower="$(printf '%s' "$edge_provider" | tr 'A-Z' 'a-z')"
edge_region_lower="$(printf '%s' "$edge_region" | tr 'A-Z' 'a-z')"
if { [ "$edge_provider_lower" = none ] && [ "$edge_region_lower" != none ]; } || \
   { [ "$edge_provider_lower" != none ] && [ "$edge_region_lower" = none ]; }; then
  die 'EDGE_PROVIDER e EDGE_REGION precisam ser ambos none ou identificar provider e região'
fi
if [ "$edge_provider_lower" != none ] && \
   { [ "$edge_provider_lower" = disabled ] || [ "$edge_provider_lower" = local ] || \
     [ "$edge_region_lower" = disabled ] || [ "$edge_region_lower" = local ]; }; then
  die 'EDGE_PROVIDER/EDGE_REGION precisam identificar o serviço real ou usar none/none'
fi
if has_profile tunnel && [ "$edge_provider_lower" = none ]; then
  die 'profile tunnel exige declarar EDGE_PROVIDER e EDGE_REGION reais'
fi

backup_status="$(env_value BACKUP_STATUS "$APP_ENV")"
backup_status="$(printf '%s' "$backup_status" | tr 'A-Z' 'a-z')"
backup_provider="$(env_value BACKUP_PROVIDER "$APP_ENV")"
backup_region="$(env_value BACKUP_REGION "$APP_ENV")"
backup_retention_days="$(env_value BACKUP_RETENTION_DAYS "$APP_ENV")"
case "$backup_status" in
  enabled)
    validate_public_statement "$backup_provider" 160 && validate_public_statement "$backup_region" 160 || \
      die 'backup habilitado exige provider/região públicos sem coordenadas privadas'
    case "$(printf '%s' "$backup_provider" | tr 'A-Z' 'a-z')" in none | disabled | local)
      die 'BACKUP_PROVIDER precisa identificar o provedor real'
    esac
    case "$(printf '%s' "$backup_region" | tr 'A-Z' 'a-z')" in none | disabled | local)
      die 'BACKUP_REGION precisa identificar a região/escopo real'
    esac
    [[ "$backup_retention_days" =~ ^[1-9][0-9]*$ ]] && [ "$backup_retention_days" -le 3650 ] || \
      die 'BACKUP_RETENTION_DAYS precisa ficar entre 1 e 3650 quando BACKUP_STATUS=enabled'
    ;;
  disabled)
    { [ -z "$backup_provider" ] || [ "$(printf '%s' "$backup_provider" | tr 'A-Z' 'a-z')" = none ]; } && \
      { [ -z "$backup_region" ] || [ "$(printf '%s' "$backup_region" | tr 'A-Z' 'a-z')" = none ]; } && \
      { [ -z "$backup_retention_days" ] || [ "$backup_retention_days" = 0 ]; } || \
      die 'backup desativado exige BACKUP_PROVIDER/REGION none ou vazios e retenção 0 ou vazia'
    ;;
  *) die 'BACKUP_STATUS aceita somente enabled ou disabled' ;;
esac

data_request_response_days="$(env_value DATA_REQUEST_RESPONSE_DAYS "$APP_ENV")"
[[ "$data_request_response_days" =~ ^[1-9][0-9]*$ ]] && [ "$data_request_response_days" -le 365 ] || \
  die 'DATA_REQUEST_RESPONSE_DAYS precisa ficar entre 1 e 365'
incident_contact_url="$(env_value INCIDENT_CONTACT_URL "$APP_ENV")"
validate_operator_contact "$incident_contact_url" || \
  die 'INCIDENT_CONTACT_URL precisa ser página HTTPS pública com caminho ou mailto simples'

origin_host() {
  local authority="${1#https://}"
  if [[ "$authority" == \[* ]]; then printf '%s' "${authority%%]*}]"; else printf '%s' "${authority%%:*}"; fi
}
has_profile split-public || die 'o kit operacional exige profile split-public'
[ "$(env_value PUBLIC_SURFACES_ENABLED "$APP_ENV")" = false ] || die 'o core privado exige PUBLIC_SURFACES_ENABLED=false'
app_host="$(origin_host "$app_url")"; mcp_host="$(origin_host "$mcp_url")"
public_host="$(origin_host "$public_url")"; docs_host="$(origin_host "$docs_url")"
[ "$public_host" != "$docs_host" ] && [ "$public_host" != "$app_host" ] && [ "$public_host" != "$mcp_host" ] && \
  [ "$docs_host" != "$app_host" ] && [ "$docs_host" != "$mcp_host" ] || \
  die 'o kit operacional exige hosts próprios para landing/docs, separados de app/MCP'

data_root="$(env_value KASSINAO_DATA_ROOT "$ENV_FILE")"
recordings_path="$(env_value KASSINAO_RECORDINGS_DIR "$ENV_FILE")"
state_path="$(env_value KASSINAO_STATE_DIR "$ENV_FILE")"
auth_path="$(env_value KASSINAO_AUTH_DIR "$ENV_FILE")"
cache_path="$(env_value KASSINAO_MODEL_CACHE_DIR "$ENV_FILE")"
[[ "$data_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'KASSINAO_DATA_ROOT precisa ser caminho absoluto simples'
case "$data_root" in *//* | */./* | */../* | */. | */.. | */) die 'KASSINAO_DATA_ROOT precisa ser canônico' ;; esac
case "$data_root" in
  /home | /home/* | /root | /root/* | /run/user | /run/user/* | /tmp | /tmp/* | /var/tmp | /var/tmp/*)
    die 'KASSINAO_DATA_ROOT não pode ficar em área isolada por ProtectHome/PrivateTmp'
    ;;
esac
[ "$recordings_path" = "$data_root/recordings" ] || die 'KASSINAO_RECORDINGS_DIR precisa ser DATA_ROOT/recordings'
[ "$state_path" = "$data_root/state" ] || die 'KASSINAO_STATE_DIR precisa ser DATA_ROOT/state'
[ "$auth_path" = "$data_root/auth" ] || die 'KASSINAO_AUTH_DIR precisa ser DATA_ROOT/auth'
[ "$cache_path" = "$data_root/cache" ] || die 'KASSINAO_MODEL_CACHE_DIR precisa ser DATA_ROOT/cache'
require_private_directory "$data_root"
[ "$(cd -- "$data_root" && pwd -P)" = "$data_root" ] || die 'KASSINAO_DATA_ROOT precisa ser caminho canônico, sem symlink intermediário'
uid="$(env_value KASSINAO_UID "$ENV_FILE")"; gid="$(env_value KASSINAO_GID "$ENV_FILE")"
[[ "$uid" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[1-9][0-9]*$ ]] || die 'KASSINAO_UID/GID precisam ser inteiros não-root'
for path_name in "$recordings_path" "$state_path" "$auth_path" "$cache_path"; do
  [ -d "$path_name" ] && [ ! -L "$path_name" ] || die "volume ausente ou symlink: $path_name"
  real="$(cd -- "$path_name" && pwd -P)"
  case "$real" in "$data_root"/*) ;; *) die "volume escapou do DATA_ROOT: $path_name" ;; esac
  [ "$(file_mode "$path_name")" = 700 ] || die "$path_name precisa de modo 0700"
  owner="$(stat -c '%u:%g' "$path_name" 2>/dev/null || stat -f '%u:%g' "$path_name")"
  [ "$owner" = "$uid:$gid" ] || die "$path_name precisa pertencer a $uid:$gid (atual: $owner)"
done

# Active data, auth state, model/provider caches and every pre-deploy snapshot
# must stay on host storage whose dm-crypt/LUKS chain can be inspected. A plain
# environment assertion is deliberately not accepted as proof.
env -i "PATH=$PATH" "HOME=${HOME:-/root}" "$STORAGE_VERIFIER" \
  "$data_root" "$recordings_path" "$state_path" "$auth_path" "$cache_path" || \
  die 'active instance storage failed the dm-crypt/LUKS verification gate'

command -v docker >/dev/null 2>&1 || die 'Docker não encontrado'
docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 não encontrado'
command -v python3 >/dev/null 2>&1 || die 'python3 é obrigatório para o gate de deploy'
python3 - "$privacy_effective_date" <<'PY' || \
  die 'PRIVACY_EFFECTIVE_DATE precisa ser uma data real e não futura'
import datetime
import sys

try:
    value = datetime.date.fromisoformat(sys.argv[1])
except ValueError:
    raise SystemExit(1)
if value > datetime.datetime.now(datetime.timezone.utc).date():
    raise SystemExit(1)
PY
engine_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
compose_version="$(docker compose version --short 2>/dev/null || true)"
python3 - "$engine_version" "$compose_version" <<'PY' || \
  die 'produção exige Docker Engine >=28.0.0 e Docker Compose >=2.35.0'
import re
import sys

def version(raw):
    match = re.match(r'^v?(\d+)\.(\d+)\.(\d+)', raw)
    if not match:
        raise SystemExit(1)
    return tuple(map(int, match.groups()))

if version(sys.argv[1]) < (28, 0, 0) or version(sys.argv[2]) < (2, 35, 0):
    raise SystemExit(1)
PY
docker_env=(env -i "PATH=$PATH" "HOME=${HOME:-/root}" "DOCKER_HOST=$DOCKER_HOST")
compose=("${docker_env[@]}" docker compose --project-name kassinao --project-directory "$ROOT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
IFS=',' read -r -a profile_list <<< "$profiles"
for profile in "${profile_list[@]}"; do [ -z "$profile" ] || compose+=(--profile "$profile"); done

TEMP_CONFIG="$(mktemp "$ROOT/.compose-config.XXXXXX")"
chmod 600 "$TEMP_CONFIG"
STRUCTURE_ENV="$(mktemp "$ROOT/.compose-env.XXXXXX")"
chmod 600 "$STRUCTURE_ENV"
awk '
  /^TUNNEL_TOKEN=/ { print "TUNNEL_TOKEN=__redacted_by_deploy_gate__"; next }
  { print }
' "$ENV_FILE" > "$STRUCTURE_ENV"
compose_structure=("${docker_env[@]}" docker compose --project-name kassinao --project-directory "$ROOT" --env-file "$STRUCTURE_ENV" -f "$COMPOSE_FILE")
for profile in "${profile_list[@]}"; do [ -z "$profile" ] || compose_structure+=(--profile "$profile"); done

"${compose[@]}" config --quiet
"${compose_structure[@]}" config --no-env-resolution --format json > "$TEMP_CONFIG"
python3 - "$TEMP_CONFIG" "$image" "$release_digest" "$deployment_fingerprint" "$mode" "$recordings_path" "$state_path" "$auth_path" "$cache_path" "$APP_ENV" "$uid" "$gid" "$source_url" <<'PY' || \
  die 'Compose normalizado viola o perfil de segurança do kit'
import json
import os
import sys

config_path, image, release_digest, deployment_fingerprint, mode, recordings, state, auth, cache, app_env, uid, gid, source_url = sys.argv[1:]
with open(config_path, encoding='utf-8') as handle:
    config = json.load(handle)

services = config.get('services') or {}
expected_services = {'kassinao'}
if mode == 'split':
    expected_services.add('kassinao-public')
profiles = os.environ.get('COMPOSE_PROFILES', '')
# O profile já foi aplicado pela CLI; serviço ausente/presente é a fonte de verdade.
if 'cloudflared' in services:
    expected_services.add('cloudflared')
if set(services) != expected_services:
    raise SystemExit(f'serviços inesperados: {sorted(set(services) ^ expected_services)}')

def network_names(service):
    value = service.get('networks') or {}
    return set(value if isinstance(value, dict) else value)

def assert_hardened(name, service, *, require_user=False):
    forbidden = ('build', 'cap_add', 'devices', 'device_cgroup_rules', 'volumes_from', 'gpus')
    if any(service.get(field) for field in forbidden):
        raise SystemExit(f'{name}: superfície privilegiada configurada')
    network_mode = str(service.get('network_mode') or '')
    if service.get('privileged') or network_mode == 'host' or network_mode.startswith('container:'):
        raise SystemExit(f'{name}: privileged/host/container network proibido')
    if service.get('pid') == 'host' or service.get('ipc') == 'host' or service.get('uts'):
        raise SystemExit(f'{name}: namespace compartilhado do host/container proibido')
    if not service.get('read_only'):
        raise SystemExit(f'{name}: root filesystem precisa ser read-only')
    if 'ALL' not in {str(value).upper() for value in service.get('cap_drop') or []}:
        raise SystemExit(f'{name}: cap_drop ALL ausente')
    security = {str(value).replace('=', ':').lower() for value in service.get('security_opt') or []}
    if 'no-new-privileges:true' not in security:
        raise SystemExit(f'{name}: no-new-privileges ausente')
    if any('unconfined' in value for value in security):
        raise SystemExit(f'{name}: perfil de segurança unconfined proibido')
    if require_user and service.get('user') != f'{uid}:{gid}':
        raise SystemExit(f'{name}: usuário não-root divergente')

def env_file_paths(service):
    paths = []
    for entry in service.get('env_file') or []:
        paths.append(entry.get('path') if isinstance(entry, dict) else entry)
    return {os.path.realpath(path) for path in paths if path}

def port_hosts(service):
    return {str(port.get('host_ip') or '') for port in service.get('ports') or [] if isinstance(port, dict)}

core = services['kassinao']
assert_hardened('kassinao', core, require_user=True)
if core.get('image') != image or network_names(core) != {'private'}:
    raise SystemExit('kassinao: imagem/rede divergente')
if env_file_paths(core) != {os.path.realpath(app_env)}:
    raise SystemExit('kassinao: env_file precisa apontar somente para app.env privado')
if port_hosts(core) != {'127.0.0.1'}:
    raise SystemExit('kassinao: porta do host precisa ficar em loopback')
if (core.get('environment') or {}).get('KASSINAO_RELEASE_DIGEST') != release_digest:
    raise SystemExit('kassinao: fingerprint de release divergente')
if (core.get('environment') or {}).get('KASSINAO_DEPLOYMENT_FINGERPRINT') != deployment_fingerprint:
    raise SystemExit('kassinao: fingerprint do deploy divergente')

expected_mounts = {
    '/app/recordings': ('bind', os.path.realpath(recordings)),
    '/app/state': ('bind', os.path.realpath(state)),
    '/app/auth': ('bind', os.path.realpath(auth)),
    '/home/node/.cache': ('bind', os.path.realpath(cache)),
}
actual_mounts = {}
for mount in core.get('volumes') or []:
    if not isinstance(mount, dict):
        raise SystemExit('kassinao: volume não normalizado')
    target = mount.get('target')
    source = mount.get('source')
    actual_mounts[target] = (mount.get('type'), os.path.realpath(source) if mount.get('type') == 'bind' else None)
    if mount.get('read_only'):
        raise SystemExit(f'kassinao: volume de dados read-only em {target}')
if actual_mounts != expected_mounts:
    raise SystemExit('kassinao: fontes/destinos de volumes divergentes')

if mode == 'split':
    public = services['kassinao-public']
    assert_hardened('kassinao-public', public, require_user=True)
    if public.get('image') != image or network_names(public) != {'public'}:
        raise SystemExit('kassinao-public: imagem/rede divergente')
    if public.get('volumes') or public.get('env_file'):
        raise SystemExit('kassinao-public: volumes/env_file são proibidos')
    if port_hosts(public) != {'127.0.0.1'}:
        raise SystemExit('kassinao-public: porta do host precisa ficar em loopback')
    allowed_public_env = {
        'NODE_ENV', 'PORT', 'WEB_BIND_ADDRESS', 'PUBLIC_URL', 'DOCS_URL',
        'SOURCE_URL', 'KASSINAO_RELEASE_DIGEST', 'KASSINAO_DEPLOYMENT_FINGERPRINT',
        'TRUST_PROXY_HOPS', 'REPO_PUBLIC'
    }
    if set(public.get('environment') or {}) - allowed_public_env:
        raise SystemExit('kassinao-public: ambiente fora da allowlist positiva')
    if (public.get('environment') or {}).get('KASSINAO_RELEASE_DIGEST') != release_digest:
        raise SystemExit('kassinao-public: fingerprint de release divergente')
    if (public.get('environment') or {}).get('KASSINAO_DEPLOYMENT_FINGERPRINT') != deployment_fingerprint:
        raise SystemExit('kassinao-public: fingerprint do deploy divergente')
    if (public.get('environment') or {}).get('SOURCE_URL') != source_url:
        raise SystemExit('kassinao-public: SOURCE_URL diverge do app.env privado')

private_network = (config.get('networks') or {}).get('private') or {}
private_driver_opts = private_network.get('driver_opts') or {}
if private_driver_opts.get('com.docker.network.bridge.name') != 'kas-private0':
    raise SystemExit('rede privada precisa usar a bridge estável kas-private0')

public_network = (config.get('networks') or {}).get('public') or {}
if public_network.get('internal') is not True:
    raise SystemExit('rede pública precisa ser internal para negar egress')
driver_opts = public_network.get('driver_opts') or {}
if driver_opts.get('com.docker.network.bridge.name') != 'kas-public0':
    raise SystemExit('rede pública precisa usar a bridge estável kas-public0')
if driver_opts.get('com.docker.network.bridge.gateway_mode_ipv4') != 'isolated':
    raise SystemExit('rede pública precisa remover o gateway IPv4 do host')
if driver_opts.get('com.docker.network.bridge.gateway_mode_ipv6') != 'isolated':
    raise SystemExit('rede pública precisa remover o gateway IPv6 do host')

if 'cloudflared' in services:
    tunnel = services['cloudflared']
    assert_hardened('cloudflared', tunnel)
    if network_names(tunnel) != {'private', 'public'} or tunnel.get('volumes'):
        raise SystemExit('cloudflared: redes/volumes divergentes')
PY

services="$("${compose[@]}" config --services)"
expected=(kassinao)
[ "$mode" = split ] && expected+=(kassinao-public)
has_profile tunnel && expected+=(cloudflared)
for service in $services; do
  case " ${expected[*]} " in *" $service "*) ;; *) die "serviço inesperado: $service" ;; esac
done
for service in "${expected[@]}"; do grep -Fqx "$service" <<< "$services" || die "serviço esperado ausente: $service"; done

app_image_count=0
while IFS= read -r configured_image; do
  case "$configured_image" in
    "$image") app_image_count=$((app_image_count + 1)) ;;
    cloudflare/cloudflared:*@sha256:????????????????????????????????????????????????????????????????) ;;
    *) die "imagem não aprovada no Compose: $configured_image" ;;
  esac
done < <("${compose[@]}" config --images)
expected_app_images=1; [ "$mode" = split ] && expected_app_images=2
[ "$app_image_count" -eq "$expected_app_images" ] || die 'core/público não resolveram exatamente para o digest aprovado'

printf 'Baixando artefato imutável %s...\n' "$image"
"${compose[@]}" pull
repo_digests="$(docker image inspect "$image" --format '{{join .RepoDigests "\n"}}')"
grep -Fq "@$digest" <<< "$repo_digests" || die 'imagem local não corresponde ao digest aprovado'

assert_recordings_idle() {
  python3 - "$recordings_path" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
invalid = 0
active = 0
for child in root.iterdir():
    if not child.is_dir() or child.is_symlink():
        continue
    meta = child / 'meta.json'
    if not meta.exists():
        continue
    try:
        if meta.is_symlink() or not meta.is_file() or meta.stat().st_size > 1024 * 1024:
            raise ValueError('unsafe metadata')
        value = json.loads(meta.read_text(encoding='utf-8'))
        if not isinstance(value, dict):
            raise ValueError('metadata is not an object')
    except Exception:
        invalid += 1
        continue
    if value.get('status') == 'recording':
        active += 1
if invalid:
    print(f'metadados inválidos ou ilegíveis: {invalid}', file=sys.stderr)
    raise SystemExit(43)
if active:
    print(f'gravações ainda ativas: {active}', file=sys.stderr)
    raise SystemExit(42)
PY
}

current_cid="$("${compose[@]}" ps -q kassinao 2>/dev/null || true)"
if [ -n "$current_cid" ]; then
  PREVIOUS_CORE_ID="$current_cid"
  PREVIOUS_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$current_cid" 2>/dev/null || true)"
  assert_recordings_idle || die 'deploy recusado: não foi possível provar que o core está ocioso'
  RESTART_PREVIOUS_CORE=true
  docker stop --time 60 "$current_cid" >/dev/null || die 'não foi possível parar o core anterior com segurança'
  [ "$(docker inspect -f '{{.State.Running}}' "$current_cid" 2>/dev/null || true)" = false ] || \
    die 'o core anterior continuou rodando após o stop'
fi

# A segunda prova ocorre com o writer parado e fecha a janela entre o precheck
# e o shutdown. JSON quebrado ou ilegível também bloqueia o snapshot.
assert_recordings_idle || die 'estado de gravações inconsistente após parar o core'

# As regras são carregadas antes do primeiro start. Como a bridge tem nome
# estável, a policy já vale quando o Compose criar ou recriar a interface.
run_hardener --preload || die 'não foi possível pré-carregar o firewall privado'
egress_ready || die 'serviço/policy de egress não ficaram ativos após o preload; core continuará parado'

rollback_dir="$data_root/rollback"
[ ! -L "$rollback_dir" ] || die 'diretório de rollback não pode ser symlink'
install -d -m 700 "$rollback_dir"
require_private_directory "$rollback_dir"
# Stage e tar parcial ficam dentro do diretório coberto por tmpfiles. Assim um
# SIGKILL ou reboot não deixa cópias órfãs fora da janela de retenção.
SNAPSHOT_STAGE="$(mktemp -d "$rollback_dir/.snapshot.XXXXXX")"
install -d -m 700 "$SNAPSHOT_STAGE/recordings-legacy" "$SNAPSHOT_STAGE/recording-meta" "$SNAPSHOT_STAGE/state"
for name in guildconfig.json autorecord.json .recording-admission.json .discord-surface-inventory.json; do
  [ ! -f "$recordings_path/$name" ] || cp -p -- "$recordings_path/$name" "$SNAPSHOT_STAGE/recordings-legacy/$name"
done
while IFS= read -r -d '' meta; do
  relative="${meta#"$recordings_path"/}"
  case "$relative" in */meta.json) ;; *) die 'caminho de metadata inesperado no snapshot' ;; esac
  [ ! -L "$meta" ] && [ "$(wc -c < "$meta")" -le 1048576 ] || die 'metadata irregular no snapshot'
  install -d -m 700 "$SNAPSHOT_STAGE/recording-meta/$(dirname -- "$relative")"
  cp -p -- "$meta" "$SNAPSHOT_STAGE/recording-meta/$relative"
done < <(find "$recordings_path" -mindepth 2 -maxdepth 2 -type f -name meta.json -print0)
cp -a -- "$state_path/." "$SNAPSHOT_STAGE/state/"
stamp="$(date -u +%Y%m%d-%H%M%S)"
SNAPSHOT_ARCHIVE_TMP="$(mktemp "$rollback_dir/.operational-state-$stamp.XXXXXX")"
snapshot_suffix="${SNAPSHOT_ARCHIVE_TMP##*.}"
[[ "$snapshot_suffix" =~ ^[A-Za-z0-9]{6}$ ]] || die 'mktemp gerou sufixo inesperado para o snapshot'
SNAPSHOT_ARCHIVE="$rollback_dir/operational-state-$stamp-$snapshot_suffix.tar.gz"
tar -czf "$SNAPSHOT_ARCHIVE_TMP" -C "$SNAPSHOT_STAGE" .
rm -rf -- "$SNAPSHOT_STAGE"; SNAPSHOT_STAGE=''
chmod 600 "$SNAPSHOT_ARCHIVE_TMP"
mv -f -- "$SNAPSHOT_ARCHIVE_TMP" "$SNAPSHOT_ARCHIVE"
SNAPSHOT_ARCHIVE_TMP=''
printf 'Snapshot operacional pré-deploy: %s\n' "$SNAPSHOT_ARCHIVE"

# O snapshot pode ser grande. Refaça a prova imediatamente antes da única
# operação que cria/inicia containers, em vez de confiar no precheck antigo.
egress_ready || die 'egress deixou de estar active/válido antes do start; core continuará parado'
DEPLOY_STARTED=true
# A partir deste ponto o Compose pode substituir o container antigo. Um
# rollback automático seria inseguro para migrações de estado; falhamos aberto
# apenas no sentido operacional, preservando snapshot e imagem anterior.
RESTART_PREVIOUS_CORE=false
"${compose[@]}" up -d --no-build --remove-orphans

deadline=$((SECONDS + 240))
while [ "$SECONDS" -lt "$deadline" ]; do
  all_ready=true
  summary=()
  for service in "${expected[@]}"; do
    cid="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
    [ -n "$cid" ] || { all_ready=false; summary+=("$service=ausente"); continue; }
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
    summary+=("$service=${status:-ausente}")
    if [ "$service" = kassinao ] || [ "$service" = kassinao-public ]; then
      [ "$(docker inspect -f '{{.Config.Image}}' "$cid")" = "$image" ] || die "$service executa imagem divergente"
      [ "$status" = healthy ] || all_ready=false
    else
      [ "$status" = running ] || all_ready=false
    fi
    case "$status" in unhealthy | exited | dead) die "$service terminou com estado $status" ;; esac
  done
  [ "$all_ready" = false ] || break
  sleep 3
done
[ "${all_ready:-false}" = true ] || die 'serviços não ficaram prontos em 240 segundos'

# Revalida membership/rede e troca a policy preparada somente depois que a
# topologia final existe. Se isso falhar, o core e o túnel são contidos antes
# de qualquer declaração de sucesso.
if ! run_hardener; then
  die 'firewall final falhou; a tentativa será contida antes de encerrar'
fi

command -v curl >/dev/null 2>&1 || die 'curl é obrigatório para smoke externo'
smoke_body="$(mktemp "$ROOT/.smoke.XXXXXX")"; chmod 600 "$smoke_body"
health_targets=("private|$app_url" "private|$mcp_url")
if [ "$mode" = split ]; then
  health_targets+=("public|$public_url" "public|$docs_url")
else
  health_targets+=("private|$public_url" "private|$docs_url")
fi
for target in "${health_targets[@]}"; do
  expected_surface="${target%%|*}"
  origin="${target#*|}"
  code="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 --retry 4 --retry-all-errors \
    -o "$smoke_body" -w '%{http_code}' "$origin/health")"
  [ "$code" = 200 ] || die "smoke de health falhou em $(origin_host "$origin")"
  python3 - "$smoke_body" "$release_digest" "$deployment_fingerprint" "$expected_surface" <<'PY' || die "fingerprint/roteamento externo diverge em $(origin_host "$origin")"
import json
import sys
with open(sys.argv[1], encoding='utf-8') as handle:
    body = json.load(handle)
if (not isinstance(body, dict) or body.get('ok') is not True or
        body.get('release') != sys.argv[2] or body.get('deployment') != sys.argv[3] or
        body.get('surface') != sys.argv[4]):
    raise SystemExit(1)
if sys.argv[4] == 'private' and body.get('ready') is not True:
    raise SystemExit(1)
if sys.argv[4] == 'public' and 'ready' in body:
    raise SystemExit(1)
PY
done

for privacy_target in 'pt|/privacy' 'en|/en/privacy'; do
  privacy_locale="${privacy_target%%|*}"
  privacy_path="${privacy_target#*|}"
  code="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 --retry 4 --retry-all-errors \
    -o "$smoke_body" -w '%{http_code}' "$app_url$privacy_path")"
  [ "$code" = 200 ] || die "política $privacy_locale não respondeu no host privado"
  python3 - "$smoke_body" "$APP_ENV" "$source_url" "$app_url" "$privacy_locale" \
    "$rollback_retention_hours" <<'PY' || die "conteúdo da política $privacy_locale diverge da configuração privada"
import html
import sys

def escaped(value):
    return html.escape(value, quote=True).replace('&#x27;', '&#039;')

body_path, env_path, source_url, app_url, locale, rollback_hours = sys.argv[1:]
with open(body_path, encoding='utf-8') as handle:
    body = handle.read()

values = {}
with open(env_path, encoding='utf-8') as handle:
    for raw in handle:
        line = raw.rstrip('\n')
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        if key in values:
            raise SystemExit(1)
        values[key] = value

required_values = [
    'OPERATOR_NAME', 'OPERATOR_CONTACT_URL', 'DATA_DELETION_URL', 'PRIVACY_EFFECTIVE_DATE',
    'PRIVACY_POLICY_VERSION', 'PRIVACY_AUDIENCE', 'PRIVACY_PURPOSES',
    'PRIVACY_LAWFUL_BASIS', 'INFRASTRUCTURE_PROVIDER', 'INFRASTRUCTURE_REGION',
    'EDGE_PROVIDER', 'EDGE_REGION', 'OPERATIONAL_LOG_RETENTION',
    'DATA_REQUEST_PROCESS', 'DATA_REQUEST_RESPONSE_DAYS', 'INCIDENT_CONTACT_URL', 'INCIDENT_PROCESS',
]
if any(not values.get(key) for key in required_values):
    raise SystemExit(1)
for key in required_values:
    if escaped(values[key]) not in body:
        raise SystemExit(1)
if escaped(source_url) not in body or 'id="data-rights"' not in body:
    raise SystemExit(1)
if f' {rollback_hours} horas.' not in body and f' {rollback_hours} hours.' not in body:
    raise SystemExit(1)
if values.get('BACKUP_STATUS', '').lower() == 'enabled':
    for key in ('BACKUP_PROVIDER', 'BACKUP_REGION', 'BACKUP_RETENTION_DAYS'):
        if escaped(values.get(key, '')) not in body:
            raise SystemExit(1)
else:
    expected = 'Backup de conteúdo declarado como desativado.' if locale == 'pt' else 'Content backup declared disabled.'
    if expected not in body:
        raise SystemExit(1)
if values.get('TERMS_OF_SERVICE_URL') and escaped(values['TERMS_OF_SERVICE_URL']) not in body:
    raise SystemExit(1)
expected_lang = 'lang="pt-BR"' if locale == 'pt' else 'lang="en"'
canonical = f'{app_url}/privacy' if locale == 'pt' else f'{app_url}/en/privacy'
if expected_lang not in body or f'<link rel="canonical" href="{escaped(canonical)}">' not in body:
    raise SystemExit(1)
if 'Rascunho local.' in body or 'Local draft.' in body:
    raise SystemExit(1)
PY
done

if [ "$mode" = split ]; then
  for origin in "$public_url" "$docs_url"; do
    for private_path in /app /auth/login /api/meetings /mcp /privacy /en/privacy; do
      code="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 -o /dev/null -w '%{http_code}' "$origin$private_path")"
      [ "$code" = 404 ] || die "host público aceitou rota privada $private_path: $(origin_host "$origin")"
    done
  done
fi
rm -f -- "$smoke_body"

# O snapshot existe apenas para recuperar uma troca que falhou. Depois de
# health, firewall e smoke externos aprovados, ele deixa de ter finalidade e
# é removido; em falha, o timer tmpfiles limita a janela configurada.
[ -f "$SNAPSHOT_ARCHIVE" ] && [ ! -L "$SNAPSHOT_ARCHIVE" ] || \
  die 'snapshot operacional sumiu ou ficou irregular antes da limpeza final'
# Prepare o novo marcador antes de apagar o snapshot. Depois da remoção resta
# somente um rename atômico no mesmo filesystem, reduzindo a janela em que uma
# falha local poderia deixar o deploy saudável sem marcador nem snapshot.
DEPLOYED_IMAGE_TMP="$(mktemp "$ROOT/.deployed-image.XXXXXX")"
printf '%s\n' "$image" > "$DEPLOYED_IMAGE_TMP"
chmod 600 "$DEPLOYED_IMAGE_TMP"
rm -f -- "$SNAPSHOT_ARCHIVE"
[ ! -e "$SNAPSHOT_ARCHIVE" ] || die 'snapshot operacional não pôde ser removido após deploy saudável'
SNAPSHOT_ARCHIVE=''
mv -f -- "$DEPLOYED_IMAGE_TMP" "$ROOT/.deployed-image"
DEPLOYED_IMAGE_TMP=''
DEPLOY_COMPLETE=true
printf 'Deploy concluído: %s digest=%s\n' "${summary[*]}" "$digest"
