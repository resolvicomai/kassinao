#!/usr/bin/env bash
# Configura a identidade da instância sem colocar segredos em argumentos,
# histórico do shell ou no processo público.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

CALLER_UID="$(id -u)"
CALLER_GID="$(id -g)"
if [ "$CALLER_UID" -eq 0 ]; then
  # A operação oficial mantém kit e env root-owned, mas o container continua
  # no usuário `node` não-root da imagem publicada.
  RUN_UID="${KASSINAO_RUNTIME_UID:-1000}"
  RUN_GID="${KASSINAO_RUNTIME_GID:-1000}"
else
  RUN_UID="${KASSINAO_RUNTIME_UID:-$CALLER_UID}"
  RUN_GID="${KASSINAO_RUNTIME_GID:-$CALLER_GID}"
fi
[[ "$RUN_UID" =~ ^[1-9][0-9]*$ && "$RUN_GID" =~ ^[1-9][0-9]*$ ]] || {
  echo 'ERRO: UID/GID de runtime precisam ser inteiros não-root.' >&2
  exit 1
}

if [ -n "${KASSINAO_APP_ENV_FILE:-}" ]; then
  APP_ENV_FILE="$KASSINAO_APP_ENV_FILE"
elif [ -f app.env ] && [ -f .env ]; then
  APP_ENV_FILE=app.env
else
  APP_ENV_FILE=.env
fi
COMPOSE_ENV_FILE="${KASSINAO_COMPOSE_ENV_FILE:-.env}"
TMP_FILE=""

cleanup() {
  [ -z "$TMP_FILE" ] || rm -f -- "$TMP_FILE"
  unset DTOKEN APP_ID DSECRET APP_ORIGIN PUBLIC_ORIGIN DOCS_ORIGIN MCP_ORIGIN GUILDS TTOKEN DEPLOY_MODE
  unset OPERATOR_NAME OPERATOR_CONTACT_URL PRIVACY_POLICY_URL DATA_DELETION_URL TERMS_OF_SERVICE_URL
  unset PRIVACY_EFFECTIVE_DATE PRIVACY_POLICY_VERSION PRIVACY_AUDIENCE PRIVACY_PURPOSES PRIVACY_LAWFUL_BASIS
  unset INFRASTRUCTURE_PROVIDER INFRASTRUCTURE_REGION EDGE_PROVIDER EDGE_REGION OPERATIONAL_LOG_RETENTION
  unset BACKUP_STATUS BACKUP_PROVIDER BACKUP_REGION BACKUP_RETENTION_DAYS
  unset DATA_REQUEST_PROCESS DATA_REQUEST_RESPONSE_DAYS INCIDENT_CONTACT_URL INCIDENT_PROCESS
  unset SOURCE_URL ROLLBACK_RETENTION_HOURS
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for file in "$APP_ENV_FILE" "$COMPOSE_ENV_FILE"; do
  if [ ! -f "$file" ] || [ -L "$file" ]; then
    echo "ERRO: arquivo de ambiente ausente ou symlink: $file" >&2
    exit 1
  fi
  if [ ! -O "$file" ]; then
    echo "ERRO: $file precisa pertencer ao usuário atual." >&2
    exit 1
  fi
  chmod 600 "$file"
done

env_value() {
  local key="$1" file="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count > 1) exit 2; print value }
  ' "$file" || { echo "ERRO: $key aparece mais de uma vez em $file" >&2; exit 1; }
}

read_secret() {
  local prompt="$1" destination="$2" value
  IFS= read -r -s -p "$prompt" value
  printf '\n'
  [ -n "$value" ] || { echo 'ERRO: o segredo não pode ficar vazio.' >&2; exit 1; }
  printf -v "$destination" '%s' "$value"
}

read_optional_secret() {
  local prompt="$1" destination="$2" value
  IFS= read -r -s -p "$prompt" value
  printf '\n'
  printf -v "$destination" '%s' "$value"
}

read_value() {
  local prompt="$1" destination="$2" input
  IFS= read -r -p "$prompt" input
  [ -n "$input" ] || { echo 'ERRO: o valor não pode ficar vazio.' >&2; exit 1; }
  printf -v "$destination" '%s' "$input"
}

read_value_default() {
  local prompt="$1" fallback="$2" destination="$3" input
  IFS= read -r -p "$prompt" input
  printf -v "$destination" '%s' "${input:-$fallback}"
}

canonical_origin() {
  local value="$1" destination="$2" scheme authority host port='' port_number suffix='' port_present=false
  case "$value" in
    https://*) scheme=https; authority="${value#https://}" ;;
    http://*) scheme=http; authority="${value#http://}" ;;
    *) return 1 ;;
  esac
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
    if ! { [ "$scheme" = https ] && [ "$port_number" -eq 443 ]; } && \
       ! { [ "$scheme" = http ] && [ "$port_number" -eq 80 ]; }; then
      suffix=":$port_number"
    fi
  fi

  if [ "$scheme" = http ]; then
    [ "$host" = localhost ] || [ "$host" = 127.0.0.1 ] || return 1
  fi
  printf -v "$destination" '%s' "$scheme://$host$suffix"
}

origin_host() {
  local authority="${1#*://}"
  if [[ "$authority" == \[* ]]; then
    printf '%s' "${authority%%]*}]"
  else
    printf '%s' "${authority%%:*}"
  fi
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

canonical_public_page_url() {
  local value="$1" destination="$2" remainder authority path origin host
  case "$value" in
    https://*) ;;
    *) return 1 ;;
  esac
  [[ ! "$value" =~ [[:space:]] ]] || return 1
  case "$value" in *'\\'* | *'?'* | *'#'* | *'@'*) return 1 ;; esac
  remainder="${value#https://}"
  [[ "$remainder" == */* ]] || return 1
  authority="${remainder%%/*}"
  path="/${remainder#*/}"
  [ "$path" != / ] || return 1
  canonical_origin "https://$authority" origin || return 1
  host="$(origin_host "$origin")"
  is_public_dns_host "$host" || return 1
  printf -v "$destination" '%s' "$origin$path"
}

canonical_operator_contact() {
  local value="$1" destination="$2" address domain
  case "$value" in
    mailto:*)
      address="${value#mailto:}"
      case "$address" in '' | *[[:space:],/?#]* | *@*@*) return 1 ;; esac
      [[ "$address" =~ ^[^@]+@[^@]+$ ]] || return 1
      domain="${address##*@}"
      is_public_dns_host "$domain" || return 1
      printf -v "$destination" '%s' "mailto:$address"
      ;;
    *) canonical_public_page_url "$value" "$destination" || return 1 ;;
  esac
}

public_statement() {
  local value="$1" destination="$2" max_length="${3:-1000}" lower
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
  printf -v "$destination" '%s' "$value"
}

read_public_statement() {
  local prompt="$1" destination="$2" max_length="${3:-1000}" statement
  read_value "$prompt" statement
  public_statement "$statement" "$destination" "$max_length" || {
    echo 'ERRO: use uma descrição pública sem URL, e-mail, IP, hostname interno, ID, controle ou metacaractere de env.' >&2
    exit 1
  }
}

rewrite_app_env() {
  TMP_FILE="$(mktemp "${APP_ENV_FILE}.tmp.XXXXXX")"
  awk '
    !/^DISCORD_TOKEN=/ && !/^APPLICATION_ID=/ && !/^DISCORD_CLIENT_SECRET=/ &&
    !/^APP_URL=/ && !/^BASE_URL=/ && !/^PUBLIC_URL=/ && !/^DOCS_URL=/ && !/^MCP_URL=/ &&
    !/^OPERATOR_NAME=/ && !/^OPERATOR_CONTACT_URL=/ && !/^PRIVACY_POLICY_URL=/ &&
    !/^DATA_DELETION_URL=/ && !/^TERMS_OF_SERVICE_URL=/ &&
    !/^PRIVACY_EFFECTIVE_DATE=/ && !/^PRIVACY_POLICY_VERSION=/ &&
    !/^PRIVACY_AUDIENCE=/ && !/^PRIVACY_PURPOSES=/ && !/^PRIVACY_LAWFUL_BASIS=/ &&
    !/^INFRASTRUCTURE_PROVIDER=/ && !/^INFRASTRUCTURE_REGION=/ &&
    !/^EDGE_PROVIDER=/ && !/^EDGE_REGION=/ && !/^OPERATIONAL_LOG_RETENTION=/ &&
    !/^BACKUP_STATUS=/ && !/^BACKUP_PROVIDER=/ && !/^BACKUP_REGION=/ && !/^BACKUP_RETENTION_DAYS=/ &&
    !/^DATA_REQUEST_PROCESS=/ && !/^DATA_REQUEST_RESPONSE_DAYS=/ &&
    !/^INCIDENT_CONTACT_URL=/ && !/^INCIDENT_PROCESS=/ && !/^SOURCE_URL=/ &&
    !/^KASSINAO_ROLLBACK_RETENTION_HOURS=/ &&
    !/^ALLOW_LOCAL_APP_URL=/ && !/^ALLOW_LEGACY_SHARED_STATE=/ &&
    !/^PUBLIC_SURFACES_ENABLED=/ && !/^ALLOWED_GUILD_IDS=/ && !/^ALLOW_ALL_GUILDS=/
  ' "$APP_ENV_FILE" > "$TMP_FILE"
  printf '%s=%s\n' DISCORD_TOKEN "$DTOKEN" >> "$TMP_FILE"
  printf '%s=%s\n' APPLICATION_ID "$APP_ID" >> "$TMP_FILE"
  printf '%s=%s\n' DISCORD_CLIENT_SECRET "$DSECRET" >> "$TMP_FILE"
  printf '%s=%s\n' APP_URL "$APP_ORIGIN" >> "$TMP_FILE"
  # Instalações novas usam uma única origem canônica. Limpar o alias impede
  # uma configuração antiga de divergir silenciosamente do APP_URL novo.
  printf '%s=\n' BASE_URL >> "$TMP_FILE"
  printf '%s=%s\n' PUBLIC_URL "$PUBLIC_ORIGIN" >> "$TMP_FILE"
  printf '%s=%s\n' DOCS_URL "$DOCS_ORIGIN" >> "$TMP_FILE"
  printf '%s=%s\n' MCP_URL "$MCP_ORIGIN" >> "$TMP_FILE"
  printf '%s=%s\n' SOURCE_URL "$SOURCE_URL" >> "$TMP_FILE"
  printf '%s=%s\n' OPERATOR_NAME "$OPERATOR_NAME" >> "$TMP_FILE"
  printf '%s=%s\n' OPERATOR_CONTACT_URL "$OPERATOR_CONTACT_URL" >> "$TMP_FILE"
  printf '%s=%s\n' PRIVACY_POLICY_URL "$PRIVACY_POLICY_URL" >> "$TMP_FILE"
  printf '%s=%s\n' DATA_DELETION_URL "$DATA_DELETION_URL" >> "$TMP_FILE"
  printf '%s=%s\n' TERMS_OF_SERVICE_URL "$TERMS_OF_SERVICE_URL" >> "$TMP_FILE"
  printf '%s=%s\n' PRIVACY_EFFECTIVE_DATE "$PRIVACY_EFFECTIVE_DATE" >> "$TMP_FILE"
  printf '%s=%s\n' PRIVACY_POLICY_VERSION "$PRIVACY_POLICY_VERSION" >> "$TMP_FILE"
  printf '%s=%s\n' PRIVACY_AUDIENCE "$PRIVACY_AUDIENCE" >> "$TMP_FILE"
  printf '%s=%s\n' PRIVACY_PURPOSES "$PRIVACY_PURPOSES" >> "$TMP_FILE"
  printf '%s=%s\n' PRIVACY_LAWFUL_BASIS "$PRIVACY_LAWFUL_BASIS" >> "$TMP_FILE"
  printf '%s=%s\n' INFRASTRUCTURE_PROVIDER "$INFRASTRUCTURE_PROVIDER" >> "$TMP_FILE"
  printf '%s=%s\n' INFRASTRUCTURE_REGION "$INFRASTRUCTURE_REGION" >> "$TMP_FILE"
  printf '%s=%s\n' EDGE_PROVIDER "$EDGE_PROVIDER" >> "$TMP_FILE"
  printf '%s=%s\n' EDGE_REGION "$EDGE_REGION" >> "$TMP_FILE"
  printf '%s=%s\n' OPERATIONAL_LOG_RETENTION "$OPERATIONAL_LOG_RETENTION" >> "$TMP_FILE"
  printf '%s=%s\n' BACKUP_STATUS "$BACKUP_STATUS" >> "$TMP_FILE"
  printf '%s=%s\n' BACKUP_PROVIDER "$BACKUP_PROVIDER" >> "$TMP_FILE"
  printf '%s=%s\n' BACKUP_REGION "$BACKUP_REGION" >> "$TMP_FILE"
  printf '%s=%s\n' BACKUP_RETENTION_DAYS "$BACKUP_RETENTION_DAYS" >> "$TMP_FILE"
  printf '%s=%s\n' DATA_REQUEST_PROCESS "$DATA_REQUEST_PROCESS" >> "$TMP_FILE"
  printf '%s=%s\n' DATA_REQUEST_RESPONSE_DAYS "$DATA_REQUEST_RESPONSE_DAYS" >> "$TMP_FILE"
  printf '%s=%s\n' INCIDENT_CONTACT_URL "$INCIDENT_CONTACT_URL" >> "$TMP_FILE"
  printf '%s=%s\n' INCIDENT_PROCESS "$INCIDENT_PROCESS" >> "$TMP_FILE"
  printf '%s=%s\n' KASSINAO_ROLLBACK_RETENTION_HOURS "$ROLLBACK_RETENTION_HOURS" >> "$TMP_FILE"
  printf '%s=%s\n' ALLOW_LOCAL_APP_URL "$([[ "$APP_ORIGIN" == http://* ]] && printf true || printf false)" >> "$TMP_FILE"
  printf '%s=%s\n' ALLOW_LEGACY_SHARED_STATE false >> "$TMP_FILE"
  printf '%s=%s\n' PUBLIC_SURFACES_ENABLED false >> "$TMP_FILE"
  printf '%s=%s\n' ALLOWED_GUILD_IDS "$GUILDS" >> "$TMP_FILE"
  printf '%s=%s\n' ALLOW_ALL_GUILDS false >> "$TMP_FILE"
  chmod 600 "$TMP_FILE"
  mv -f -- "$TMP_FILE" "$APP_ENV_FILE"
  TMP_FILE=""
}

rewrite_compose_env() {
  local profiles=''
  [ -z "$TTOKEN" ] || profiles=tunnel
  [ -z "$profiles" ] && profiles=split-public || profiles="$profiles,split-public"
  TMP_FILE="$(mktemp "${COMPOSE_ENV_FILE}.tmp.XXXXXX")"
  awk '
    !/^KASSINAO_DEPLOYMENT_MODE=/ && !/^KASSINAO_DEPLOYMENT_FINGERPRINT=/ &&
    !/^KASSINAO_UID=/ && !/^KASSINAO_GID=/ && !/^COMPOSE_PROFILES=/ &&
    !/^KASSINAO_ROLLBACK_RETENTION_HOURS=/ &&
    !/^APP_URL=/ && !/^PUBLIC_URL=/ && !/^DOCS_URL=/ && !/^MCP_URL=/ && !/^SOURCE_URL=/ && !/^TUNNEL_TOKEN=/
  ' "$COMPOSE_ENV_FILE" > "$TMP_FILE"
  printf '%s=%s\n' KASSINAO_DEPLOYMENT_MODE "$DEPLOY_MODE" >> "$TMP_FILE"
  printf '%s=%s\n' KASSINAO_DEPLOYMENT_FINGERPRINT "$DEPLOYMENT_FINGERPRINT" >> "$TMP_FILE"
  printf '%s=%s\n' KASSINAO_UID "$RUN_UID" >> "$TMP_FILE"
  printf '%s=%s\n' KASSINAO_GID "$RUN_GID" >> "$TMP_FILE"
  printf '%s=%s\n' COMPOSE_PROFILES "$profiles" >> "$TMP_FILE"
  printf '%s=%s\n' KASSINAO_ROLLBACK_RETENTION_HOURS "$ROLLBACK_RETENTION_HOURS" >> "$TMP_FILE"
  printf '%s=%s\n' APP_URL "$APP_ORIGIN" >> "$TMP_FILE"
  printf '%s=%s\n' PUBLIC_URL "$PUBLIC_ORIGIN" >> "$TMP_FILE"
  printf '%s=%s\n' DOCS_URL "$DOCS_ORIGIN" >> "$TMP_FILE"
  printf '%s=%s\n' MCP_URL "$MCP_ORIGIN" >> "$TMP_FILE"
  printf '%s=%s\n' SOURCE_URL "$SOURCE_URL" >> "$TMP_FILE"
  printf '%s=%s\n' TUNNEL_TOKEN "$TTOKEN" >> "$TMP_FILE"
  chmod 600 "$TMP_FILE"
  mv -f -- "$TMP_FILE" "$COMPOSE_ENV_FILE"
  TMP_FILE=""
}

echo '== Identidade privada da sua instância Kassinão =='
echo 'Segredos não vão para Git, imagem, processo público ou histórico do shell.'
echo 'Origens, SOURCE_URL e identidade/política do operador são metadados públicos da instância.'
echo

default_mode="$(env_value KASSINAO_DEPLOYMENT_MODE "$COMPOSE_ENV_FILE")"
[ -z "$default_mode" ] || [ "$default_mode" = split ] || {
  echo 'ERRO: o kit operacional verificado aceita somente a topologia split.' >&2
  exit 1
}
DEPLOY_MODE=split
ROLLBACK_RETENTION_HOURS="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS "$COMPOSE_ENV_FILE")"
ROLLBACK_RETENTION_HOURS="${ROLLBACK_RETENTION_HOURS:-72}"
[[ "$ROLLBACK_RETENTION_HOURS" =~ ^[1-9][0-9]*$ ]] && \
  [ "$ROLLBACK_RETENTION_HOURS" -le 168 ] || {
  echo 'ERRO: KASSINAO_ROLLBACK_RETENTION_HOURS precisa ficar entre 1 e 168.' >&2
  exit 1
}
DEPLOYMENT_FINGERPRINT="$(env_value KASSINAO_DEPLOYMENT_FINGERPRINT "$COMPOSE_ENV_FILE")"
if [ -z "$DEPLOYMENT_FINGERPRINT" ]; then
  DEPLOYMENT_FINGERPRINT="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
fi
[[ "$DEPLOYMENT_FINGERPRINT" =~ ^[0-9a-f]{32}$ ]] || {
  echo 'ERRO: KASSINAO_DEPLOYMENT_FINGERPRINT existente é inválido.' >&2
  exit 1
}
read_secret '1) DISCORD_TOKEN (Bot > Token): ' DTOKEN
read_value '2) APPLICATION_ID (General Information): ' APP_ID
[[ "$APP_ID" =~ ^[0-9]{17,20}$ ]] || { echo 'ERRO: APPLICATION_ID inválido.' >&2; exit 1; }
read_secret '3) DISCORD_CLIENT_SECRET (OAuth2 > Client Secret): ' DSECRET
read_value '4) APP_URL própria (origem HTTPS): ' APP_ORIGIN
canonical_origin "$APP_ORIGIN" APP_ORIGIN || { echo 'ERRO: APP_URL precisa ser uma origem HTTPS sem caminho.' >&2; exit 1; }

[[ "$APP_ORIGIN" == https://* ]] || {
  echo 'ERRO: o kit operacional é exclusivo para produção HTTPS; use o checkout de código para localhost.' >&2
  exit 1
}

read_value '5) PUBLIC_URL (origem HTTPS exclusiva da landing): ' PUBLIC_ORIGIN
read_value '6) DOCS_URL (origem HTTPS exclusiva da documentação): ' DOCS_ORIGIN
read_value_default '7) MCP_URL (Enter = APP_URL): ' "$APP_ORIGIN" MCP_ORIGIN

for origin_name in PUBLIC_ORIGIN DOCS_ORIGIN MCP_ORIGIN; do
  canonical_origin "${!origin_name}" "$origin_name" || { echo 'ERRO: todas as URLs precisam ser origens HTTPS (ou localhost local).' >&2; exit 1; }
done

[[ "$PUBLIC_ORIGIN" == https://* && "$DOCS_ORIGIN" == https://* && "$MCP_ORIGIN" == https://* ]] || {
  echo 'ERRO: o kit operacional exige HTTPS nas quatro origens.' >&2
  exit 1
}
app_host="$(origin_host "$APP_ORIGIN")"
mcp_host="$(origin_host "$MCP_ORIGIN")"
public_host="$(origin_host "$PUBLIC_ORIGIN")"
docs_host="$(origin_host "$DOCS_ORIGIN")"
[ "$public_host" != "$docs_host" ] && [ "$public_host" != "$app_host" ] && [ "$public_host" != "$mcp_host" ] && \
  [ "$docs_host" != "$app_host" ] && [ "$docs_host" != "$mcp_host" ] || {
    echo 'ERRO: landing e docs precisam de hosts próprios, separados de app/MCP.' >&2
    exit 1
  }

read_value '8) SOURCE_URL (repositório público do source desta instalação): ' SOURCE_URL
canonical_public_page_url "$SOURCE_URL" SOURCE_URL || {
  echo 'ERRO: SOURCE_URL precisa ser uma página HTTPS pública com caminho, sem query ou fragmento.' >&2
  exit 1
}
read_value '9) OPERATOR_NAME (nome/empresa responsável por esta instância): ' OPERATOR_NAME
[ "${#OPERATOR_NAME}" -le 160 ] && [[ ! "$OPERATOR_NAME" =~ [[:cntrl:]=] ]] && \
  [[ "$OPERATOR_NAME" =~ [^[:space:]] ]] || {
  echo 'ERRO: OPERATOR_NAME precisa ter até 160 caracteres, sem controles ou =.' >&2
  exit 1
}
read_value '10) OPERATOR_CONTACT_URL (HTTPS com caminho ou mailto simples): ' OPERATOR_CONTACT_URL
canonical_operator_contact "$OPERATOR_CONTACT_URL" OPERATOR_CONTACT_URL || {
  echo 'ERRO: contato precisa ser uma página HTTPS pública com caminho ou mailto para um único e-mail.' >&2
  exit 1
}
read_value_default '11) TERMS_OF_SERVICE_URL (HTTPS opcional; Enter = nenhuma): ' '' TERMS_OF_SERVICE_URL
if [ -n "$TERMS_OF_SERVICE_URL" ]; then
  canonical_public_page_url "$TERMS_OF_SERVICE_URL" TERMS_OF_SERVICE_URL || {
    echo 'ERRO: termos precisam ser uma página HTTPS pública com caminho, sem query ou fragmento.' >&2
    exit 1
  }
fi
PRIVACY_POLICY_URL="$APP_ORIGIN/privacy"
DATA_DELETION_URL="$APP_ORIGIN/privacy#data-rights"

read_value '12) ALLOWED_GUILD_IDS (IDs separados por vírgula): ' GUILDS
IFS=',' read -r -a guild_list <<< "$GUILDS"
for guild in "${guild_list[@]}"; do
  guild="${guild//[[:space:]]/}"
  [[ "$guild" =~ ^[0-9]{17,20}$ ]] || { echo 'ERRO: guild ID inválido.' >&2; exit 1; }
done
read_optional_secret '13) TUNNEL_TOKEN (Enter = proxy HTTPS próprio, sem cloudflared): ' TTOKEN
if [[ "$APP_ORIGIN" == http://* && -n "$TTOKEN" ]]; then
  echo 'ERRO: um túnel público não pode apontar para uma topologia localhost.' >&2
  exit 1
fi

echo
echo '== Contrato público da política desta instância =='
echo 'Use somente descrições públicas; nunca informe IP, hostname privado, IDs ou segredos.'
read_value '14) PRIVACY_EFFECTIVE_DATE (YYYY-MM-DD): ' PRIVACY_EFFECTIVE_DATE
[[ "$PRIVACY_EFFECTIVE_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || {
  echo 'ERRO: PRIVACY_EFFECTIVE_DATE precisa usar YYYY-MM-DD.' >&2
  exit 1
}
read_value '15) PRIVACY_POLICY_VERSION (ex.: 1.0): ' PRIVACY_POLICY_VERSION
[[ "$PRIVACY_POLICY_VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$ ]] || {
  echo 'ERRO: versão aceita 1 a 32 caracteres: letras, números, ponto, hífen e underscore.' >&2
  exit 1
}
read_public_statement '16) PRIVACY_AUDIENCE (quem é abrangido): ' PRIVACY_AUDIENCE
read_public_statement '17) PRIVACY_PURPOSES (finalidades desta operação): ' PRIVACY_PURPOSES
read_public_statement '18) PRIVACY_LAWFUL_BASIS (base/justificativa definida pelo operador): ' PRIVACY_LAWFUL_BASIS
read_public_statement '19) INFRASTRUCTURE_PROVIDER (somente nome público): ' INFRASTRUCTURE_PROVIDER 160
read_public_statement '20) INFRASTRUCTURE_REGION (região pública, sem datacenter/host): ' INFRASTRUCTURE_REGION 160
case "$(printf '%s' "$INFRASTRUCTURE_PROVIDER" | tr 'A-Z' 'a-z')" in none | disabled | local)
  echo 'ERRO: INFRASTRUCTURE_PROVIDER precisa identificar o provedor real.' >&2
  exit 1
esac
case "$(printf '%s' "$INFRASTRUCTURE_REGION" | tr 'A-Z' 'a-z')" in none | disabled)
  echo 'ERRO: INFRASTRUCTURE_REGION precisa identificar a região/escopo público real.' >&2
  exit 1
esac

if [ -n "$TTOKEN" ]; then
  edge_provider_default='Cloudflare Tunnel'
  edge_region_default='global'
else
  edge_provider_default='none'
  edge_region_default='none'
fi
read_value_default "21) EDGE_PROVIDER (Enter = $edge_provider_default): " "$edge_provider_default" EDGE_PROVIDER
read_value_default "22) EDGE_REGION (Enter = $edge_region_default): " "$edge_region_default" EDGE_REGION
public_statement "$EDGE_PROVIDER" EDGE_PROVIDER 160 && public_statement "$EDGE_REGION" EDGE_REGION 160 || {
  echo 'ERRO: provider/região de borda precisam ser descrições públicas sem coordenadas privadas.' >&2
  exit 1
}
edge_provider_lower="$(printf '%s' "$EDGE_PROVIDER" | tr 'A-Z' 'a-z')"
edge_region_lower="$(printf '%s' "$EDGE_REGION" | tr 'A-Z' 'a-z')"
if { [ "$edge_provider_lower" = none ] && [ "$edge_region_lower" != none ]; } || \
   { [ "$edge_provider_lower" != none ] && [ "$edge_region_lower" = none ]; }; then
  echo 'ERRO: EDGE_PROVIDER e EDGE_REGION precisam ser ambos none ou identificar provider e região.' >&2
  exit 1
fi
if [ "$edge_provider_lower" != none ] && { [ "$edge_provider_lower" = disabled ] || [ "$edge_provider_lower" = local ] || [ "$edge_region_lower" = disabled ] || [ "$edge_region_lower" = local ]; }; then
  echo 'ERRO: provider/região de borda precisam identificar o serviço real ou usar none/none.' >&2
  exit 1
fi
[ -z "$TTOKEN" ] || [ "$edge_provider_lower" != none ] || {
  echo 'ERRO: TUNNEL_TOKEN configurado exige declarar o provider de túnel/borda.' >&2
  exit 1
}

read_public_statement '23) OPERATIONAL_LOG_RETENTION (rotação/expurgo de container, host e provider): ' OPERATIONAL_LOG_RETENTION
read_value_default '24) BACKUP_STATUS (enabled/disabled; Enter = disabled): ' disabled BACKUP_STATUS
BACKUP_STATUS="$(printf '%s' "$BACKUP_STATUS" | tr 'A-Z' 'a-z')"
case "$BACKUP_STATUS" in
  enabled)
    read_public_statement '25) BACKUP_PROVIDER: ' BACKUP_PROVIDER 160
    read_public_statement '26) BACKUP_REGION: ' BACKUP_REGION 160
    case "$(printf '%s' "$BACKUP_PROVIDER" | tr 'A-Z' 'a-z')" in none | disabled | local)
      echo 'ERRO: BACKUP_PROVIDER precisa identificar o provedor real.' >&2
      exit 1
    esac
    case "$(printf '%s' "$BACKUP_REGION" | tr 'A-Z' 'a-z')" in none | disabled | local)
      echo 'ERRO: BACKUP_REGION precisa identificar a região/escopo real.' >&2
      exit 1
    esac
    read_value '27) BACKUP_RETENTION_DAYS (1..3650): ' BACKUP_RETENTION_DAYS
    [[ "$BACKUP_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]] && [ "$BACKUP_RETENTION_DAYS" -le 3650 ] || {
      echo 'ERRO: BACKUP_RETENTION_DAYS precisa ficar entre 1 e 3650.' >&2
      exit 1
    }
    ;;
  disabled)
    BACKUP_PROVIDER=none
    BACKUP_REGION=none
    BACKUP_RETENTION_DAYS=0
    ;;
  *)
    echo 'ERRO: BACKUP_STATUS aceita somente enabled ou disabled.' >&2
    exit 1
    ;;
esac

read_public_statement '28) DATA_REQUEST_PROCESS (verificação e entrega pelo contato acima): ' DATA_REQUEST_PROCESS
read_value_default '29) DATA_REQUEST_RESPONSE_DAYS (1..365; Enter = 30): ' 30 DATA_REQUEST_RESPONSE_DAYS
[[ "$DATA_REQUEST_RESPONSE_DAYS" =~ ^[1-9][0-9]*$ ]] && [ "$DATA_REQUEST_RESPONSE_DAYS" -le 365 ] || {
  echo 'ERRO: DATA_REQUEST_RESPONSE_DAYS precisa ficar entre 1 e 365.' >&2
  exit 1
}
read_value_default '30) INCIDENT_CONTACT_URL (Enter = contato do operador): ' "$OPERATOR_CONTACT_URL" INCIDENT_CONTACT_URL
canonical_operator_contact "$INCIDENT_CONTACT_URL" INCIDENT_CONTACT_URL || {
  echo 'ERRO: contato de incidente precisa ser página HTTPS pública ou mailto simples.' >&2
  exit 1
}
read_public_statement '31) INCIDENT_PROCESS (triagem, contenção e notificação): ' INCIDENT_PROCESS

rewrite_app_env
rewrite_compose_env

echo
echo "Configuração privada gravada em $APP_ENV_FILE; topologia em $COMPOSE_ENV_FILE (0600)."
echo "Cadastre no Discord OAuth2 Redirects: $APP_ORIGIN/auth/callback"
if [ -z "$TTOKEN" ]; then
  echo 'Cloudflared ficou desativado; configure seu proxy HTTPS antes do deploy externo.'
fi
