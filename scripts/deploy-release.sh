#!/bin/bash -p
# Deploy image-only, fail-closed. Executa apenas controles verificados do kit,
# sanitiza o ambiente do Compose e nunca compila source na VPS.
set -Eeuo pipefail
umask 077

_saved_deploy_dir="${KASSINAO_DEPLOY_DIR-}"
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
_inherited_docker_environment_name=''
for _inherited_name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$_inherited_name" >/dev/null 2>&1; then
    _inherited_docker_environment_name="$_inherited_name"
    break
  fi
done
[ -r "/proc/$$/environ" ] || { printf 'ERRO: /proc é obrigatório para limpar o ambiente do deploy.\n' >&2; exit 1; }
while IFS='=' read -r -d '' _inherited_name _inherited_value; do
  unset "$_inherited_name" 2>/dev/null || true
done < "/proc/$$/environ"
unset _inherited_name _inherited_value
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME=/root
LC_ALL=C
export PATH HOME LC_ALL
KASSINAO_DEPLOY_DIR="$_saved_deploy_dir"
export KASSINAO_DEPLOY_DIR
[ -z "$_inherited_docker_environment_name" ] || {
  printf 'ERRO: %s não pode vir do ambiente; produção usa somente o daemon local da VPS.\n' \
    "$_inherited_docker_environment_name" >&2
  exit 1
}

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) printf 'ERRO: caminho do deploy não é canônico.\n' >&2; exit 1 ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) printf 'ERRO: deploy precisa executar do kit selado.\n' >&2; exit 1 ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) printf 'ERRO: arquitetura sem runtime no-dump.\n' >&2; exit 1 ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/deploy-release.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || { printf 'ERRO: core limit do deploy não ficou selado.\n' >&2; exit 1; }
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || { printf 'ERRO: coredump_filter do deploy não ficou selado.\n' >&2; exit 1; }
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

ROOT_INPUT="${KASSINAO_DEPLOY_DIR:-$PROJECT_DIR}"
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
PREVIOUS_CORE_RESTART_GATES_PASSED=false
SNAPSHOT_ARCHIVE=''
DEPLOYED_IMAGE_TMP=''

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }
ulimit -c 0 2>/dev/null || die 'não foi possível desabilitar core dumps do deploy'
unset _inherited_docker_environment_name _saved_deploy_dir

seal_local_docker() {
  export DOCKER_HOST=unix:///var/run/docker.sock
  unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
}
seal_local_docker

# Nomes e saídas de `compose ps` são somente referências de descoberta. Toda
# mutação usa um ID Docker completo depois de provar nome e labels Compose.
managed_container_id() {
  local reference="$1" container="$2" expected_service="$3" candidate identity
  local actual_id actual_name actual_project actual_service extra
  candidate="$(docker inspect --format '{{.Id}}' "$reference" 2>/dev/null)" || return 1
  [[ "$candidate" =~ ^[0-9a-f]{64}$ ]] || return 2
  identity="$(
    docker inspect \
      --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
      "$candidate" 2>/dev/null
  )" || return 2
  IFS='|' read -r actual_id actual_name actual_project actual_service extra <<<"$identity"
  [ -z "$extra" ] && [ "$actual_id" = "$candidate" ] && [ "$actual_name" = "/$container" ] && \
    [ "$actual_project" = kassinao ] && [ "$actual_service" = "$expected_service" ] || return 2
  printf '%s\n' "$candidate"
}

cleanup() {
  [ -z "$TEMP_CONFIG" ] || rm -f -- "$TEMP_CONFIG"
  [ -z "$STRUCTURE_ENV" ] || rm -f -- "$STRUCTURE_ENV"
  [ -z "$ROLLBACK_ENV" ] || rm -f -- "$ROLLBACK_ENV"
  [ -z "$SNAPSHOT_STAGE" ] || rm -rf -- "$SNAPSHOT_STAGE"
  [ -z "$SNAPSHOT_ARCHIVE_TMP" ] || rm -f -- "$SNAPSHOT_ARCHIVE_TMP"
  [ -z "$DEPLOYED_IMAGE_TMP" ] || rm -f -- "$DEPLOYED_IMAGE_TMP"
}

stop_failed_deploy_containers() {
  local identity container expected_service cid lookup_status running confirmed
  for identity in \
    kassinao:kassinao \
    kassinao-router:kassinao-router \
    kassinao-public:kassinao-public \
    kassinao-tunnel:cloudflared; do
    container="${identity%%:*}"
    expected_service="${identity#*:}"
    if cid="$(managed_container_id "$container" "$container" "$expected_service")"; then
      :
    else
      lookup_status=$?
      if [ "$lookup_status" -eq 2 ]; then
        printf 'ERRO CRÍTICO: nome reservado ocupado por container alheio; contenção não o tocará: %s\n' "$container" >&2
      fi
      continue
    fi
    confirmed="$(managed_container_id "$cid" "$container" "$expected_service" 2>/dev/null || true)"
    if [ "$confirmed" != "$cid" ]; then
      printf 'ERRO CRÍTICO: identidade mudou antes da contenção; nenhuma mutação: %s\n' "$container" >&2
      continue
    fi
    if ! docker stop --timeout 30 "$cid" >/dev/null 2>&1; then
      # O kill interrompe um processo que não respeitou o timeout; um segundo
      # stop marca a parada como administrativa e impede a restart policy de
      # religá-lo imediatamente.
      docker kill "$cid" >/dev/null 2>&1 || true
      docker stop --timeout 10 "$cid" >/dev/null 2>&1 || true
    fi
    running="$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || true)"
    if [ "$running" = false ]; then
      printf 'Container da tentativa falha contido: %s\n' "$container" >&2
    else
      printf 'ERRO CRÍTICO: não foi possível provar o container parado: %s\n' "$container" >&2
    fi
  done
}

on_exit() {
  local status=$? confirmed_previous=''
  if [ "$status" -ne 0 ] && [ "$DEPLOY_STARTED" = true ] && [ "$DEPLOY_COMPLETE" = false ]; then
    stop_failed_deploy_containers
  fi
  if [ "$status" -ne 0 ] && [ "$RESTART_PREVIOUS_CORE" = true ] && [ -n "$PREVIOUS_CORE_ID" ]; then
    if [ "$PREVIOUS_CORE_RESTART_GATES_PASSED" != true ]; then
      printf 'ERRO CRÍTICO: core anterior permaneceu parado porque os gates fail-closed não foram aprovados.\n' >&2
    elif ! egress_ready; then
      printf 'ERRO CRÍTICO: core anterior permaneceu parado porque egress não está active e válido.\n' >&2
    elif [ "${host_scope:-dedicated}" = shared ] && \
         ! run_shared_audit --preflight --expected-existing-image "$PREVIOUS_IMAGE" >/dev/null; then
      printf 'ERRO CRÍTICO: core anterior permaneceu parado porque o contrato estático shared divergiu.\n' >&2
    elif confirmed_previous="$(managed_container_id "$PREVIOUS_CORE_ID" kassinao kassinao 2>/dev/null)" && \
         [ "$confirmed_previous" = "$PREVIOUS_CORE_ID" ] && \
         [ "$(docker inspect -f '{{.Config.Image}}' "$PREVIOUS_CORE_ID" 2>/dev/null || true)" = "$PREVIOUS_IMAGE" ] && \
         docker start "$PREVIOUS_CORE_ID" >/dev/null 2>&1; then
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
file_owner_group() { stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1" 2>/dev/null; }
file_link_count() { stat -c '%h' "$1" 2>/dev/null || stat -f '%l' "$1" 2>/dev/null; }

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

require_shared_secret_file() {
  local file="$1" mode
  case "$file" in /*) ;; *) die "segredo shared precisa usar caminho absoluto: $file" ;; esac
  [ -f "$file" ] && [ ! -L "$file" ] || die "segredo shared ausente ou symlink: $file"
  [ -O "$file" ] || die "segredo shared precisa pertencer ao usuário atual: $file"
  [ "$(readlink -f -- "$file")" = "$file" ] || die "segredo shared precisa ser canônico: $file"
  [ "$(file_link_count "$file")" = 1 ] || die "segredo shared não pode possuir hardlinks: $file"
  mode="$(file_mode "$file")"
  [ "$mode" = 440 ] || die "$file precisa de modo 0440 no adapter shared (atual: $mode)"
}

require_control_file() {
  local file="$1" mode
  [ -f "$file" ] && [ ! -L "$file" ] || die "controle ausente ou symlink: $file"
  [ -O "$file" ] || die "controle precisa pertencer ao usuário atual: $file"
  mode="$(file_mode "$file")"
  (( (8#$mode & 022) == 0 )) || die "$file não pode ser gravável por grupo/outros (atual: $mode)"
}

[[ "$ROOT_INPUT" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'KASSINAO_DEPLOY_DIR precisa ser caminho absoluto simples'
case "$ROOT_INPUT" in / | *//* | */./* | */../* | */. | */.. | */) die 'KASSINAO_DEPLOY_DIR precisa ser canônico e dedicado' ;; esac
require_private_directory "$ROOT_INPUT"
ROOT="$(cd -- "$ROOT_INPUT" && pwd -P)"
[ "$ROOT" = "$PROJECT_DIR" ] || die 'KASSINAO_DEPLOY_DIR precisa ser exatamente a raiz do kit selado'
cursor="$ROOT"
while :; do
  [ ! -e "$cursor/.git" ] || die "deploy precisa ficar fora de qualquer Git ($cursor/.git)"
  root_metadata="$(stat -c '%a:%u:%g' "$cursor" 2>/dev/null || true)"
  root_mode="${root_metadata%%:*}"
  [ "${root_metadata#*:}" = 0:0 ] && [[ "$root_mode" =~ ^[0-7]+$ ]] && (( (8#$root_mode & 022) == 0 )) ||
    die "release e pais precisam ser root-owned e não graváveis por terceiros: $cursor"
  parent="$(dirname "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done

DOCKER_CONFIG="$ROOT/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && \
  [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] || \
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] || \
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG

LOCK_FILE="$ROOT/.deploy.lock"
command -v flock >/dev/null 2>&1 || die 'flock não encontrado'
if [ ! -e "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ]; then
  (set -o noclobber; : > "$LOCK_FILE") 2>/dev/null || die 'não foi possível criar .deploy.lock sem colisão'
  chmod 600 "$LOCK_FILE"
fi
[ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] &&
  [ "$(readlink -f -- "$LOCK_FILE" 2>/dev/null || true)" = "$LOCK_FILE" ] &&
  [ "$(stat -c '%a:%u:%g:%h' "$LOCK_FILE" 2>/dev/null || true)" = 600:0:0:1 ] ||
  die '.deploy.lock precisa ser regular canônico 0600 root:root sem hardlink'
exec 9<>"$LOCK_FILE"
[ "$(stat -Lc '%a:%u:%g:%h' "/proc/$$/fd/9" 2>/dev/null || true)" = 600:0:0:1 ] &&
  [ "$(readlink -f -- "/proc/$$/fd/9" 2>/dev/null || true)" = "$LOCK_FILE" ] &&
  [ "$(stat -c '%d:%i' "$LOCK_FILE" 2>/dev/null || true)" = "$(stat -Lc '%d:%i' "/proc/$$/fd/9" 2>/dev/null || true)" ] ||
  die '.deploy.lock mudou durante a abertura'
flock -n 9 || die 'já existe outro deploy em andamento'

# O deploy, o backup consistente e o watchdog compartilham um único diretório
# provisionado pelo installer. Não há fallback por usuário: locks diferentes
# permitiriam ao watchdog religar o writer durante um snapshot.
RUNTIME_DIR=/run/lock/kassinao
[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] &&
  [ "$(readlink -f -- "$RUNTIME_DIR" 2>/dev/null || true)" = "$RUNTIME_DIR" ] &&
  [ "$(stat -c '%a:%u:%g' "$RUNTIME_DIR" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'diretório /run/lock/kassinao precisa ser canônico 0700 root:root'
MAINTENANCE_LOCK_FILE="$RUNTIME_DIR/maintenance.lock"
[ -f "$MAINTENANCE_LOCK_FILE" ] && [ ! -L "$MAINTENANCE_LOCK_FILE" ] &&
  [ "$(readlink -f -- "$MAINTENANCE_LOCK_FILE" 2>/dev/null || true)" = "$MAINTENANCE_LOCK_FILE" ] &&
  [ "$(stat -c '%a:%u:%g:%h' "$MAINTENANCE_LOCK_FILE" 2>/dev/null || true)" = 600:0:0:1 ] ||
  die 'maintenance.lock precisa preexistir como regular 0600 root:root sem hardlink'
exec 8<>"$MAINTENANCE_LOCK_FILE"
[ "$(stat -Lc '%a:%u:%g:%h' "/proc/$$/fd/8" 2>/dev/null || true)" = 600:0:0:1 ] &&
  [ "$(readlink -f -- "/proc/$$/fd/8" 2>/dev/null || true)" = "$MAINTENANCE_LOCK_FILE" ] &&
  [ "$(stat -c '%d:%i' "$MAINTENANCE_LOCK_FILE" 2>/dev/null || true)" = "$(stat -Lc '%d:%i' "/proc/$$/fd/8" 2>/dev/null || true)" ] ||
  die 'maintenance.lock mudou durante a abertura'
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
SHARED_COMPOSE_FILE="$ROOT/docker-compose.shared.yml"
COMPOSE_TEMPLATE="$ROOT/compose.env.example"
HARDENER="$ROOT/scripts/harden-docker-egress.sh"
DEDICATED_STORAGE_VERIFIER="$ROOT/scripts/verify-storage-encryption.sh"
SHARED_STORAGE_VERIFIER="$ROOT/scripts/verify-shared-luks-storage.sh"
SHARED_AUDITOR="$ROOT/scripts/audit-shared-vps-security.sh"
SHARED_ROLLBACK_CHECKER="$ROOT/scripts/check-shared-migration-rollback.sh"
STORAGE_VERIFIER="$DEDICATED_STORAGE_VERIFIER"
SYSTEMCTL="${SYSTEMCTL_BIN:-systemctl}"
require_private_file "$ENV_FILE"
require_control_file "$COMPOSE_FILE"
require_control_file "$SHARED_COMPOSE_FILE"
require_control_file "$COMPOSE_TEMPLATE"
require_control_file "$HARDENER"
require_control_file "$DEDICATED_STORAGE_VERIFIER"
require_control_file "$SHARED_STORAGE_VERIFIER"
require_control_file "$SHARED_AUDITOR"
require_control_file "$SHARED_ROLLBACK_CHECKER"
run_hardener() {
  local -a scope_args=()
  [ "${host_scope:-dedicated}" != shared ] || scope_args+=(--shared-host)
  env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" \
    "$HARDENER" "${scope_args[@]}" "$@"
}
egress_ready() {
  command -v "$SYSTEMCTL" >/dev/null 2>&1 || return 1
  "$SYSTEMCTL" is-active --quiet kassinao-docker-egress.service || return 1
  run_hardener --check >/dev/null
}
run_shared_audit() {
  env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" \
    "KASSINAO_ENV_FILE=$ENV_FILE" "$SHARED_AUDITOR" "$@"
}
run_shared_rollback_check() {
  env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" "KASSINAO_ENV_FILE=$ENV_FILE" \
    "$SHARED_ROLLBACK_CHECKER" >/dev/null
}

# Um profile removido pode deixar exatamente um container Compose conhecido e
# inerte. O audit autoriza apenas essa transição estreita; antes de removê-lo,
# relemos a identidade pelo ID imutável. Nunca removemos por nome, por label
# parcial, nem tocamos em rede/orphan de outro workload.
remove_disabled_shared_container() {
  local expected_name="$1" expected_service="$2" disabled_cid identity
  local actual_cid actual_name actual_project actual_service actual_running actual_restart extra
  if ! disabled_cid="$(docker inspect --format '{{.Id}}' "$expected_name" 2>/dev/null)"; then
    return 0
  fi
  [[ "$disabled_cid" =~ ^[0-9a-f]{64}$ ]] || \
    die "container desabilitado $expected_name retornou ID inválido"
  identity="$(docker inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}' "$disabled_cid" 2>/dev/null)" || \
    die "container desabilitado $expected_name mudou durante a revalidação"
  IFS='|' read -r actual_cid actual_name actual_project actual_service actual_running actual_restart extra <<<"$identity"
  [ -z "$extra" ] && [ "$actual_cid" = "$disabled_cid" ] && \
    [ "$actual_name" = "/$expected_name" ] && [ "$actual_project" = kassinao ] && \
    [ "$actual_service" = "$expected_service" ] && [ "$actual_running" = false ] && \
    [ "$actual_restart" = no ] || \
    die "container desabilitado $expected_name falhou na revalidação de identidade"
  docker rm "$disabled_cid" >/dev/null || \
    die "não foi possível remover o container desabilitado $expected_name"
  if docker inspect --format '{{.Id}}' "$disabled_cid" >/dev/null 2>&1; then
    die "container desabilitado $expected_name permaneceu após docker rm"
  fi
  if docker inspect --format '{{.Id}}' "$expected_name" >/dev/null 2>&1; then
    die "nome reservado $expected_name foi reocupado durante a transição"
  fi
  printf 'Container conhecido do profile desabilitado removido: %s\n' "$expected_name"
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
cloudflared_image="$(awk '
  /^  cloudflared:$/ { in_service=1; next }
  in_service && /^    image: / { sub(/^    image: /, ""); print; exit }
  in_service && /^  [A-Za-z0-9_.-]+:$/ { exit }
' "$COMPOSE_FILE")"
[[ "$cloudflared_image" =~ ^cloudflare/cloudflared:[0-9][0-9A-Za-z._-]*@sha256:[0-9a-f]{64}$ ]] || \
  die 'imagem cloudflared selada não pôde ser derivada do Compose'
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

mode="$(env_value KASSINAO_DEPLOYMENT_MODE "$ENV_FILE")"
[ "$mode" = split ] || die 'o kit operacional verificado aceita somente KASSINAO_DEPLOYMENT_MODE=split'
host_scope="$(env_value KASSINAO_HOST_SCOPE "$ENV_FILE")"
dedicated_host_ack="$(env_value KASSINAO_DEDICATED_DOCKER_HOST_ACK "$ENV_FILE")"
case "$host_scope" in
  dedicated)
    [ "$dedicated_host_ack" = I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO ] || \
      die 'o adapter dedicated exige KASSINAO_DEDICATED_DOCKER_HOST_ACK; seus pre-hooks controlam o docker.service inteiro'
    STORAGE_VERIFIER="$DEDICATED_STORAGE_VERIFIER"
    ;;
  shared)
    [ -z "$dedicated_host_ack" ] || \
      die 'o adapter shared exige KASSINAO_DEDICATED_DOCKER_HOST_ACK vazio'
    [ ! -e /etc/systemd/system/docker.service.d/kassinao-egress.conf ] || \
      die 'o drop-in dedicado do docker.service ainda existe; remova-o de forma auditada antes do adapter shared'
    STORAGE_VERIFIER="$SHARED_STORAGE_VERIFIER"
    ;;
  *) die 'KASSINAO_HOST_SCOPE aceita somente dedicated ou shared' ;;
esac

if [ "$host_scope" = shared ]; then
  APP_ENV="$(env_value KASSINAO_SHARED_APP_ENV_FILE "$ENV_FILE")"
  require_shared_secret_file "$APP_ENV"
else
  app_env_name="$(env_value KASSINAO_APP_ENV_FILE "$ENV_FILE")"
  app_env_name="${app_env_name:-app.env}"
  [[ "$app_env_name" =~ ^[A-Za-z0-9._-]+$ ]] || die 'KASSINAO_APP_ENV_FILE precisa ser um arquivo dentro do kit'
  APP_ENV="$ROOT/$app_env_name"
  require_private_file "$APP_ENV"
fi
[ -z "$(env_value BASE_URL "$APP_ENV")" ] || die 'BASE_URL legado precisa ficar vazio; use apenas APP_URL'
[ -z "$(env_value BASE_URL "$ENV_FILE")" ] || die 'BASE_URL não pode existir no ambiente do Compose'

profiles="$(env_value COMPOSE_PROFILES "$ENV_FILE")"
tunnel_token="$(env_value TUNNEL_TOKEN "$ENV_FILE")"
has_profile() { case ",$profiles," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
if [ "$host_scope" = shared ]; then
  [ -z "$tunnel_token" ] || die 'TUNNEL_TOKEN precisa permanecer vazio no adapter shared'
  tunnel_token_file="$(env_value KASSINAO_SHARED_TUNNEL_TOKEN_FILE "$ENV_FILE")"
  case "$tunnel_token_file" in /*) ;; *) die 'KASSINAO_SHARED_TUNNEL_TOKEN_FILE precisa ser absoluto' ;; esac
  [ -f "$tunnel_token_file" ] && [ ! -L "$tunnel_token_file" ] && \
    [ "$(readlink -f -- "$tunnel_token_file")" = "$tunnel_token_file" ] && \
    [ "$(file_link_count "$tunnel_token_file")" = 1 ] && \
    [ "$(file_mode "$tunnel_token_file")" = 444 ] || \
    die 'arquivo de token shared precisa ser regular, canônico, sem hardlinks e 0444'
  if has_profile tunnel; then [ -s "$tunnel_token_file" ] || die 'profile tunnel exige token-file shared não vazio';
  elif [ -s "$tunnel_token_file" ]; then die 'token-file shared preenchido sem profile tunnel'; fi
else
  if has_profile tunnel; then [ -n "$tunnel_token" ] || die 'profile tunnel exige TUNNEL_TOKEN';
  elif [ -n "$tunnel_token" ]; then die 'TUNNEL_TOKEN definido sem profile tunnel'; fi
fi

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
[ "$(env_value TRUST_PROXY_HOPS "$APP_ENV")" = 1 ] || \
  die 'TRUST_PROXY_HOPS precisa ser exatamente 1 no core atrás do router'
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
[ "$public_host" != "$app_host" ] && [ "$public_host" != "$mcp_host" ] && \
  [ "$docs_host" != "$app_host" ] && [ "$docs_host" != "$mcp_host" ] || \
  die 'landing/docs precisam ficar em hosts separados de app/MCP'
public_www_host=''
if [[ "$public_host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]+$ ]] && \
   [[ ! "$public_host" =~ ^[0-9.]+$ ]] && [[ "$public_host" != www.* ]]; then
  public_www_host="www.$public_host"
fi
[ -z "$public_www_host" ] || {
  [ "$public_www_host" != "$app_host" ] && \
    [ "$public_www_host" != "$mcp_host" ] && \
    [ "$public_www_host" != "$docs_host" ]
} || die 'o alias www da landing conflita com APP_URL, MCP_URL ou DOCS_URL'

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
if [ "$host_scope" = shared ]; then
  [ "$uid" -ge 61000 ] && [ "$uid" -le 61183 ] && [ "$gid" -ge 61000 ] && [ "$gid" -le 61183 ] ||
    die 'adapter shared exige KASSINAO_UID/GID explícitos na faixa privada 61000..61183'
  config_path="$data_root/config"
  [ "$APP_ENV" = "$config_path/app.env" ] && \
    [ "$tunnel_token_file" = "$config_path/cloudflared-token" ] || \
    die 'segredos shared precisam usar os caminhos exatos sob DATA_ROOT/config'
  caller_uid="$(id -u)"; caller_gid="$(id -g)"
  [ "$(file_mode "$APP_ENV"):$(file_owner_group "$APP_ENV")" = "440:$caller_uid:$gid" ] || \
    die "KASSINAO_SHARED_APP_ENV_FILE precisa ser 0440, owner do operador e grupo $gid"
  [ "$(file_mode "$tunnel_token_file"):$(file_owner_group "$tunnel_token_file")" = "444:$caller_uid:$caller_gid" ] || \
    die 'KASSINAO_SHARED_TUNNEL_TOKEN_FILE precisa ser 0444 e pertencer ao operador'
fi
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
if [ "$host_scope" = shared ]; then
  env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" "KASSINAO_ENV_FILE=$ENV_FILE" \
    "$STORAGE_VERIFIER" || \
    die 'active shared instance storage failed the file-container LUKS verification gate'
else
  env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" "$STORAGE_VERIFIER" \
    "$data_root" "$recordings_path" "$state_path" "$auth_path" "$cache_path" || \
    die 'active instance storage failed the dm-crypt/LUKS verification gate'
fi

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
  die 'produção exige Docker Engine >=28.0.0 e Docker Compose >=2.36.0'
import re
import sys

def version(raw):
    match = re.match(r'^v?(\d+)\.(\d+)\.(\d+)', raw)
    if not match:
        raise SystemExit(1)
    return tuple(map(int, match.groups()))

if version(sys.argv[1]) < (28, 0, 0) or version(sys.argv[2]) < (2, 36, 0):
    raise SystemExit(1)
PY
docker_env=(env -i "PATH=$PATH" "HOME=$HOME" "LC_ALL=$LC_ALL" "LD_PRELOAD=${LD_PRELOAD-}" \
  "DOCKER_HOST=$DOCKER_HOST" "DOCKER_CONFIG=$DOCKER_CONFIG")
if [ "$host_scope" = shared ]; then
  run_shared_audit --preflight || \
    die 'preflight shared recusou colisão ou privilégio perigoso em workload vizinho'
fi
compose=("${docker_env[@]}" docker compose --project-name kassinao --project-directory "$ROOT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
[ "$host_scope" != shared ] || compose+=(-f "$SHARED_COMPOSE_FILE")
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
[ "$host_scope" != shared ] || compose_structure+=(-f "$SHARED_COMPOSE_FILE")
for profile in "${profile_list[@]}"; do [ -z "$profile" ] || compose_structure+=(--profile "$profile"); done

"${compose[@]}" config --quiet
"${compose_structure[@]}" config --no-env-resolution --format json > "$TEMP_CONFIG"
python3 - "$TEMP_CONFIG" "$image" "$cloudflared_image" "$release_digest" "$deployment_fingerprint" "$mode" "$host_scope" "$data_root" "$recordings_path" "$state_path" "$auth_path" "$cache_path" "$APP_ENV" "${tunnel_token_file:-}" "$uid" "$gid" "$source_url" "$app_url" "$mcp_url" "$public_url" "$docs_url" <<'PY' || \
  die 'Compose normalizado viola o perfil de segurança do kit'
import json
import os
import sys

config_path, image, cloudflared_image, release_digest, deployment_fingerprint, mode, host_scope, data_root, recordings, state, auth, cache, app_env, tunnel_token_file, uid, gid, source_url, app_url, mcp_url, public_url, docs_url = sys.argv[1:]
with open(config_path, encoding='utf-8') as handle:
    config = json.load(handle)

services = config.get('services') or {}
expected_services = {'kassinao'}
if mode == 'split':
    expected_services.update({'kassinao-router', 'kassinao-public'})
profiles = os.environ.get('COMPOSE_PROFILES', '')
# O profile já foi aplicado pela CLI; serviço ausente/presente é a fonte de verdade.
if 'cloudflared' in services:
    expected_services.add('cloudflared')
if set(services) != expected_services:
    raise SystemExit(f'serviços inesperados: {sorted(set(services) ^ expected_services)}')

def network_names(service):
    value = service.get('networks') or {}
    return set(value if isinstance(value, dict) else value)

def network_options(service, name):
    value = service.get('networks') or {}
    if not isinstance(value, dict):
        return {}
    options = value.get(name) or {}
    return options if isinstance(options, dict) else {}

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
    if host_scope == 'shared' and str(service.get('restart') or 'no').lower() not in {'no', 'none'}:
        raise SystemExit(f'{name}: adapter shared exige restart desativado até o egress/storage serem revalidados')
    if host_scope == 'shared':
        memory = service.get('mem_limit')
        memory_swap = service.get('memswap_limit')
        if memory in (None, 0, '0', '') or memory_swap != memory:
            raise SystemExit(f'{name}: adapter shared exige MemorySwap igual ao limite positivo de memória')
        if service.get('mem_swappiness') != 0:
            raise SystemExit(f'{name}: adapter shared exige mem_swappiness=0')

def env_file_paths(service):
    paths = []
    for entry in service.get('env_file') or []:
        paths.append(entry.get('path') if isinstance(entry, dict) else entry)
    return {os.path.realpath(path) for path in paths if path}

def ports(service):
    value = service.get('ports') or []
    if not isinstance(value, list) or any(not isinstance(port, dict) for port in value):
        raise SystemExit('ports não normalizadas')
    return value

def port_hosts(service):
    return {str(port.get('host_ip') or '') for port in ports(service)}

core = services['kassinao']
assert_hardened('kassinao', core, require_user=True)
if core.get('image') != image or network_names(core) != {'core_link', 'core_egress'}:
    raise SystemExit('kassinao: imagem/rede divergente')
core_environment = core.get('environment') or {}
if core_environment.get('PORT') != '8082' or core_environment.get('WEB_BIND_ADDRESS') != '0.0.0.0':
    raise SystemExit('kassinao: listener interno divergente')
core_link = network_options(core, 'core_link')
core_egress = network_options(core, 'core_egress')
if core_link.get('interface_name') != 'core0' or 'kassinao-core' not in set(core_link.get('aliases') or []):
    raise SystemExit('kassinao: alias/interface do link privado divergente')
if core_egress.get('interface_name') != 'egress0' or core_egress.get('gw_priority') != 1:
    raise SystemExit('kassinao: egress/default gateway divergente')
if host_scope == 'shared':
    if env_file_paths(core):
        raise SystemExit('kassinao: env_file é proibido no adapter shared')
    expected_core_environment = {
        'PORT', 'WEB_BIND_ADDRESS', 'RECORDINGS_DIR', 'STATE_DIR', 'AUTH_STATE_DIR',
        'KASSINAO_RELEASE_DIGEST', 'KASSINAO_DEPLOYMENT_FINGERPRINT', 'TUNNEL_TOKEN',
        'XDG_CACHE_HOME', 'DOTENV_CONFIG_PATH'
    }
    if set(core_environment) != expected_core_environment:
        raise SystemExit('kassinao: ambiente shared saiu da allowlist positiva')
    if core_environment.get('DOTENV_CONFIG_PATH') != '/run/secrets/kassinao-app.env':
        raise SystemExit('kassinao: DOTENV_CONFIG_PATH divergente')
    if core_environment.get('TUNNEL_TOKEN'):
        raise SystemExit('kassinao: token do túnel não pode entrar em Config.Env')
elif env_file_paths(core) != {os.path.realpath(app_env)}:
    raise SystemExit('kassinao: env_file precisa apontar somente para app.env privado')
if port_hosts(core):
    raise SystemExit('kassinao: core privado não pode publicar porta no host')
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
if host_scope == 'shared':
    expected_mounts['/run/kassinao/storage-mounted'] = (
        'bind', os.path.realpath(os.path.join(data_root, '.kassinao-mounted'))
    )
    expected_mounts['/run/secrets/kassinao-app.env'] = ('bind', os.path.realpath(app_env))
actual_mounts = {}
for mount in core.get('volumes') or []:
    if not isinstance(mount, dict):
        raise SystemExit('kassinao: volume não normalizado')
    target = mount.get('target')
    source = mount.get('source')
    actual_mounts[target] = (mount.get('type'), os.path.realpath(source) if mount.get('type') == 'bind' else None)
    if target in {'/run/kassinao/storage-mounted', '/run/secrets/kassinao-app.env'}:
        if host_scope != 'shared' or not mount.get('read_only'):
            raise SystemExit('kassinao: arquivo shared de controle/segredo precisa ser bind read-only')
        bind_options = mount.get('bind') or {}
        if bind_options.get('create_host_path') is not False:
            raise SystemExit('kassinao: arquivo shared não pode ser criado pelo Compose')
    elif mount.get('read_only'):
        raise SystemExit(f'kassinao: volume de dados read-only em {target}')
if actual_mounts != expected_mounts:
    raise SystemExit('kassinao: fontes/destinos de volumes divergentes')

if mode == 'split':
    router = services['kassinao-router']
    assert_hardened('kassinao-router', router, require_user=True)
    if router.get('image') != image or network_names(router) != {'edge_ingress', 'core_link', 'public_link'}:
        raise SystemExit('kassinao-router: imagem/redes divergentes')
    if router.get('volumes') or router.get('env_file'):
        raise SystemExit('kassinao-router: volumes/env_file são proibidos')
    if router.get('command') != ['/usr/local/bin/node', 'dist/router.js']:
        raise SystemExit('kassinao-router: comando divergente')
    router_ports = ports(router)
    if len(router_ports) != 1 or port_hosts(router) != {'127.0.0.1'}:
        raise SystemExit('kassinao-router: única porta do host precisa ficar em loopback')
    router_port = router_ports[0]
    if router_port.get('target') != 8080 or str(router_port.get('published') or '') == '':
        raise SystemExit('kassinao-router: publish precisa apontar uma única porta loopback para 8080')
    router_environment = router.get('environment') or {}
    allowed_router_env = {
        'NODE_ENV', 'PORT', 'WEB_BIND_INTERFACE', 'APP_URL', 'MCP_URL', 'PUBLIC_URL', 'DOCS_URL',
        'KASSINAO_RELEASE_DIGEST', 'KASSINAO_DEPLOYMENT_FINGERPRINT'
    }
    if set(router_environment) != allowed_router_env:
        raise SystemExit('kassinao-router: ambiente saiu da allowlist positiva')
    expected_router_environment = {
        'NODE_ENV': 'production',
        'PORT': '8080',
        'WEB_BIND_INTERFACE': 'edge0',
        'KASSINAO_RELEASE_DIGEST': release_digest,
        'KASSINAO_DEPLOYMENT_FINGERPRINT': deployment_fingerprint,
    }
    for key, value in expected_router_environment.items():
        if router_environment.get(key) != value:
            raise SystemExit(f'kassinao-router: {key} divergente')
    expected_router_origins = {
        'APP_URL': app_url,
        'MCP_URL': mcp_url,
        'PUBLIC_URL': public_url,
        'DOCS_URL': docs_url,
    }
    for key, value in expected_router_origins.items():
        if router_environment.get(key) != value:
            raise SystemExit(f'kassinao-router: {key} diverge da origem privada canônica')
    edge = network_options(router, 'edge_ingress')
    router_core = network_options(router, 'core_link')
    router_public = network_options(router, 'public_link')
    if edge.get('interface_name') != 'edge0' or 'kassinao' not in set(edge.get('aliases') or []):
        raise SystemExit('kassinao-router: alias/interface de ingress divergente')
    if router_core.get('interface_name') != 'core0' or router_public.get('interface_name') != 'public0':
        raise SystemExit('kassinao-router: interfaces de upstream divergentes')

    public = services['kassinao-public']
    assert_hardened('kassinao-public', public, require_user=True)
    if public.get('image') != image or network_names(public) != {'public_link'}:
        raise SystemExit('kassinao-public: imagem/rede divergente')
    if public.get('volumes') or public.get('env_file'):
        raise SystemExit('kassinao-public: volumes/env_file são proibidos')
    if public.get('command') != ['/usr/local/bin/node', 'dist/public.js']:
        raise SystemExit('kassinao-public: comando divergente')
    if port_hosts(public):
        raise SystemExit('kassinao-public: processo público não pode publicar porta no host')
    if network_options(public, 'public_link').get('interface_name') != 'public0':
        raise SystemExit('kassinao-public: interface interna divergente')
    allowed_public_env = {
        'NODE_ENV', 'PORT', 'WEB_BIND_ADDRESS', 'PUBLIC_URL', 'DOCS_URL',
        'SOURCE_URL', 'KASSINAO_RELEASE_DIGEST', 'KASSINAO_DEPLOYMENT_FINGERPRINT',
        'TRUST_PROXY_HOPS', 'REPO_PUBLIC'
    }
    public_environment = public.get('environment') or {}
    if set(public_environment) != allowed_public_env:
        raise SystemExit('kassinao-public: ambiente saiu da allowlist positiva exata')
    expected_public_environment = {
        'NODE_ENV': 'production',
        'PORT': '8081',
        'WEB_BIND_ADDRESS': '0.0.0.0',
        'PUBLIC_URL': public_url,
        'DOCS_URL': docs_url,
        'SOURCE_URL': source_url,
        'KASSINAO_RELEASE_DIGEST': release_digest,
        'KASSINAO_DEPLOYMENT_FINGERPRINT': deployment_fingerprint,
        'TRUST_PROXY_HOPS': '1',
    }
    for key, value in expected_public_environment.items():
        if public_environment.get(key) != value:
            raise SystemExit(f'kassinao-public: {key} divergente')
    if public_environment.get('REPO_PUBLIC') not in {'true', 'false'}:
        raise SystemExit('kassinao-public: REPO_PUBLIC precisa ser booleano explícito')
    if public_environment.get('KASSINAO_RELEASE_DIGEST') != release_digest:
        raise SystemExit('kassinao-public: fingerprint de release divergente')
    if public_environment.get('KASSINAO_DEPLOYMENT_FINGERPRINT') != deployment_fingerprint:
        raise SystemExit('kassinao-public: fingerprint do deploy divergente')
    if public_environment.get('SOURCE_URL') != source_url:
        raise SystemExit('kassinao-public: SOURCE_URL diverge do app.env privado')
    if public_environment.get('TRUST_PROXY_HOPS') != '1':
        raise SystemExit('kassinao-public: precisa confiar exatamente no router interno')

networks = config.get('networks') or {}
expected_networks = {
    'edge_ingress': ('kas-edge0', True),
    'core_link': ('kas-core0', True),
    'public_link': ('kas-public0', True),
    'core_egress': ('kas-core-eg0', False),
}
if 'cloudflared' in services:
    expected_networks['tunnel_egress'] = ('kas-tunnel-eg0', False)
if set(networks) != set(expected_networks):
    raise SystemExit(f'redes inesperadas: {sorted(set(networks) ^ set(expected_networks))}')
for name, (bridge, internal) in expected_networks.items():
    network = networks.get(name) or {}
    options = network.get('driver_opts') or {}
    if options.get('com.docker.network.bridge.name') != bridge:
        raise SystemExit(f'{name}: bridge estável divergente')
    if internal:
        if network.get('internal') is not True:
            raise SystemExit(f'{name}: link precisa ser internal')
        if options.get('com.docker.network.bridge.gateway_mode_ipv4') != 'isolated':
            raise SystemExit(f'{name}: gateway IPv4 precisa ser isolated')
        if options.get('com.docker.network.bridge.gateway_mode_ipv6') != 'isolated':
            raise SystemExit(f'{name}: gateway IPv6 precisa ser isolated')
    else:
        if network.get('internal') is True:
            raise SystemExit(f'{name}: egress não pode ser internal')
        if options.get('com.docker.network.bridge.enable_icc') != 'false':
            raise SystemExit(f'{name}: comunicação lateral precisa ficar desativada')

if 'cloudflared' in services:
    tunnel = services['cloudflared']
    assert_hardened('cloudflared', tunnel)
    if tunnel.get('image') != cloudflared_image or network_names(tunnel) != {'edge_ingress', 'tunnel_egress'}:
        raise SystemExit('cloudflared: imagem/redes divergentes')
    tunnel_edge = network_options(tunnel, 'edge_ingress')
    tunnel_egress = network_options(tunnel, 'tunnel_egress')
    if tunnel_edge.get('interface_name') != 'edge0':
        raise SystemExit('cloudflared: interface de ingress divergente')
    if tunnel_egress.get('interface_name') != 'egress0' or tunnel_egress.get('gw_priority') != 1:
        raise SystemExit('cloudflared: egress/default gateway divergente')
    if host_scope == 'shared':
        if tunnel.get('environment'):
            raise SystemExit('cloudflared: environment é proibido no adapter shared')
        if tunnel.get('entrypoint') != ['/usr/local/bin/kassinao-no-dump', '--', '/usr/local/bin/cloudflared']:
            raise SystemExit('cloudflared: entrypoint no-dump divergente')
        if tunnel.get('command') != ['tunnel', '--no-autoupdate', 'run', '--token-file', '/run/secrets/kassinao-tunnel-token']:
            raise SystemExit('cloudflared: token-file/command divergente')
        volumes = tunnel.get('volumes') or []
        expected_tunnel_mounts = {
            '/usr/local/bin/kassinao-no-dump': os.path.realpath('/usr/local/libexec/kassinao/kassinao-no-dump'),
            '/run/secrets/kassinao-tunnel-token': os.path.realpath(tunnel_token_file),
        }
        actual_tunnel_mounts = {}
        for mount in volumes:
            target = mount.get('target')
            if (target not in expected_tunnel_mounts or target in actual_tunnel_mounts or
                    mount.get('type') != 'bind' or not mount.get('read_only') or
                    (mount.get('bind') or {}).get('create_host_path') is not False):
                raise SystemExit('cloudflared: mounts de launcher/token divergentes')
            actual_tunnel_mounts[target] = os.path.realpath(mount.get('source') or '')
        if actual_tunnel_mounts != expected_tunnel_mounts:
            raise SystemExit('cloudflared: mounts de launcher/token divergentes')
    elif tunnel.get('volumes'):
        raise SystemExit('cloudflared: volumes são proibidos no adapter dedicated')
PY

services="$("${compose[@]}" config --services)"
expected=(kassinao)
[ "$mode" = split ] && expected+=(kassinao-router kassinao-public)
has_profile tunnel && expected+=(cloudflared)
for service in $services; do
  case " ${expected[*]} " in *" $service "*) ;; *) die "serviço inesperado: $service" ;; esac
done
for service in "${expected[@]}"; do grep -Fqx "$service" <<< "$services" || die "serviço esperado ausente: $service"; done

app_image_count=0
while IFS= read -r configured_image; do
  case "$configured_image" in
    "$image") app_image_count=$((app_image_count + 1)) ;;
    "$cloudflared_image") ;;
    *) die "imagem não aprovada no Compose: $configured_image" ;;
  esac
done < <("${compose[@]}" config --images)
expected_app_images=1; [ "$mode" = split ] && expected_app_images=3
[ "$app_image_count" -eq "$expected_app_images" ] || \
  die 'core/router/público não resolveram exatamente para o digest aprovado'

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

# O rollback contem somente estado operacional e metadados de gravacao. O
# inventario usa openat/O_NOFOLLOW, mantem os descritores das fontes abertos
# durante a geracao canonica e compara identidade, metadata e hash antes/depois. Assim um
# rename, hardlink, mount aninhado ou troca de inode nao transforma auth/audio
# em conteudo de rollback por uma janela TOCTOU.
operational_snapshot_gate() {
  local action="$1" stage_path="${2:--}" archive_path="${3:--}" final_archive_path="${4:--}"
  local expected_archive_proof="${5:--}" python_bin findmnt_hint='-'
  if [ "$EUID" -eq 0 ]; then
    python_bin=/usr/bin/python3
  else
    python_bin="$(command -v python3 2>/dev/null || true)"
    findmnt_hint="$(command -v findmnt 2>/dev/null || true)"
  fi
  [ -n "$python_bin" ] && [ -x "$python_bin" ] && [ -f "$python_bin" ] || {
    printf 'gate de snapshot recusou: python3 confiável indisponível\n' >&2
    return 70
  }
  env -i "PATH=/usr/bin:/bin" "HOME=${HOME:-/root}" "$python_bin" - \
    "$action" "$data_root" "$stage_path" "$archive_path" "$final_archive_path" \
    "$expected_archive_proof" "$findmnt_hint" <<'PY'
import hashlib
import gzip
import json
import os
import stat
import subprocess
import sys
import tarfile
import re


class SnapshotError(Exception):
    pass


action, data_root, stage_path, archive_path, final_archive_path, expected_archive_proof, findmnt_hint = sys.argv[1:]
if action not in {'preflight', 'create', 'proof', 'remove'}:
    raise SystemExit(64)

O_CLOEXEC = getattr(os, 'O_CLOEXEC', 0)
O_NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
O_DIRECTORY = getattr(os, 'O_DIRECTORY', 0)
DIR_FLAGS = os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | O_NOFOLLOW | O_CLOEXEC
ARCHIVE_FLAGS = os.O_RDWR | O_NOFOLLOW | O_CLOEXEC
LEGACY_FILES = {
    'guildconfig.json',
    'autorecord.json',
    '.recording-admission.json',
    '.discord-surface-inventory.json',
}
ROOT_NAMES = ('recordings', 'state', 'auth', 'cache')
def close_fd(fd):
    try:
        os.close(fd)
    except OSError:
        pass


def fd_stat_signature(value):
    return (
        value.st_dev,
        value.st_ino,
        stat.S_IFMT(value.st_mode),
        stat.S_IMODE(value.st_mode),
        value.st_nlink,
        value.st_uid,
        value.st_gid,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def archive_stable_signature(value):
    # rename atualiza ctime; identidade, privacidade, tamanho, mtime e hash
    # precisam permanecer invariantes durante a publicacao atomica.
    return fd_stat_signature(value)[:9]


def hash_fd(fd):
    digest = hashlib.sha256()
    offset = 0
    while True:
        chunk = os.pread(fd, 1024 * 1024, offset)
        if not chunk:
            break
        digest.update(chunk)
        offset += len(chunk)
    return digest.hexdigest()


def same_identity(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def open_verified_directory(name, parent_fd, expected_dev):
    before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(before.st_mode):
        raise SnapshotError('a arvore operacional contem entrada que nao e diretorio regular')
    fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
    after = os.fstat(fd)
    if not same_identity(before, after) or after.st_dev != expected_dev:
        close_fd(fd)
        raise SnapshotError('diretorio mudou de identidade ou cruzou filesystem')
    return fd, after


def open_verified_regular(name, parent_fd, before, expected_dev, require_single_link):
    if not stat.S_ISREG(before.st_mode):
        raise SnapshotError('a arvore do snapshot contem symlink ou arquivo especial')
    fd = os.open(name, FILE_FLAGS, dir_fd=parent_fd)
    after = os.fstat(fd)
    if not same_identity(before, after) or not stat.S_ISREG(after.st_mode) or after.st_dev != expected_dev:
        close_fd(fd)
        raise SnapshotError('arquivo mudou de identidade ou cruzou filesystem')
    if require_single_link and after.st_nlink != 1:
        close_fd(fd)
        raise SnapshotError('fonte do snapshot possui hardlink')
    return fd, after


def find_mount_targets():
    if os.geteuid() == 0:
        findmnt = next((candidate for candidate in ('/usr/bin/findmnt', '/bin/findmnt') if os.path.isfile(candidate)), None)
    else:
        # Testes e execucao local nao privilegiada podem usar um fixture no
        # PATH. O caminho absoluto foi resolvido antes de limpar o ambiente; o
        # caminho privilegiado de producao nunca cai neste fallback.
        findmnt = findmnt_hint
    if not findmnt or not os.path.isabs(findmnt):
        raise SnapshotError('findmnt nao esta disponivel para provar ausencia de nested mounts')
    findmnt_stat = os.stat(findmnt, follow_symlinks=False)
    allowed_owners = {0} if os.geteuid() == 0 else {0, os.geteuid()}
    if (
        not stat.S_ISREG(findmnt_stat.st_mode)
        or findmnt_stat.st_uid not in allowed_owners
        or findmnt_stat.st_nlink != 1
        or stat.S_IMODE(findmnt_stat.st_mode) & 0o022
    ):
        raise SnapshotError('findmnt nao e um executavel confiavel')
    try:
        result = subprocess.run(
            [findmnt, '--json', '--output', 'TARGET'],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'},
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise SnapshotError('findmnt falhou durante o inventario') from error
    if len(result.stdout) > 4 * 1024 * 1024:
        raise SnapshotError('inventario de mounts excedeu o limite seguro')
    try:
        document = json.loads(result.stdout.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SnapshotError('findmnt retornou inventario invalido') from error
    targets = []

    def visit(items):
        if not isinstance(items, list):
            raise SnapshotError('findmnt retornou estrutura invalida')
        for item in items:
            if not isinstance(item, dict):
                raise SnapshotError('findmnt retornou estrutura invalida')
            target = item.get('target')
            if isinstance(target, str) and target.startswith('/'):
                targets.append(os.path.normpath(target))
            children = item.get('children', [])
            if children:
                visit(children)

    visit(document.get('filesystems', []))
    return targets


def assert_no_nested_mounts():
    roots = [os.path.join(data_root, name) for name in ROOT_NAMES]
    for target in find_mount_targets():
        for root in roots:
            if target == root or target.startswith(root + os.sep):
                raise SnapshotError('nested mount detectado dentro de volume operacional')


base_fd = -1
root_fds = {}


def scan_sources():
    selected = []
    excluded_identities = set()
    expected_directories = {'state', 'recording-meta', 'recordings-legacy'}
    safety_manifest = {
        f'{root_name}/': fd_stat_signature(os.fstat(root_fds[root_name]))
        for root_name in ROOT_NAMES
    }

    def remember(root_name, components, value, directory=False):
        key = '/'.join((root_name,) + tuple(components))
        safety_manifest[key + ('/' if directory else '')] = fd_stat_signature(value)

    def add_selected(root_name, components, archive_name, parent_fd, before, max_size=None):
        fd, current = open_verified_regular(components[-1], parent_fd, before, data_dev, True)
        if max_size is not None and current.st_size > max_size:
            close_fd(fd)
            raise SnapshotError('meta.json excede o limite de 1 MiB')
        remember(root_name, components, current)
        selected.append(
            {
                'root': root_name,
                'components': tuple(components),
                'archive': archive_name,
                'fd': fd,
                'stat': current,
                'signature': fd_stat_signature(current),
                'sha256': hash_fd(fd),
            }
        )

    def walk_state(directory_fd, components=()):
        for name in sorted(os.listdir(directory_fd)):
            before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            relative = components + (name,)
            if stat.S_ISDIR(before.st_mode):
                child_fd, current = open_verified_directory(name, directory_fd, data_dev)
                try:
                    remember('state', relative, current, True)
                    expected_directories.add('/'.join(('state',) + relative))
                    walk_state(child_fd, relative)
                finally:
                    close_fd(child_fd)
            elif stat.S_ISREG(before.st_mode):
                add_selected('state', relative, '/'.join(('state',) + relative), directory_fd, before)
            else:
                raise SnapshotError('state contem symlink, FIFO, socket ou device')

    def walk_recordings(directory_fd, components=()):
        for name in sorted(os.listdir(directory_fd)):
            before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            relative = components + (name,)
            if stat.S_ISDIR(before.st_mode):
                child_fd, current = open_verified_directory(name, directory_fd, data_dev)
                try:
                    remember('recordings', relative, current, True)
                    walk_recordings(child_fd, relative)
                finally:
                    close_fd(child_fd)
            elif stat.S_ISREG(before.st_mode):
                fd, current = open_verified_regular(name, directory_fd, before, data_dev, True)
                is_meta = len(relative) == 2 and relative[1] == 'meta.json'
                is_legacy = len(relative) == 1 and relative[0] in LEGACY_FILES
                if is_meta or is_legacy:
                    close_fd(fd)
                    if is_meta:
                        expected_directories.add('/'.join(('recording-meta', relative[0])))
                        archive_name = '/'.join(('recording-meta',) + relative)
                        add_selected('recordings', relative, archive_name, directory_fd, before, 1024 * 1024)
                    else:
                        archive_name = '/'.join(('recordings-legacy', relative[0]))
                        add_selected('recordings', relative, archive_name, directory_fd, before)
                else:
                    remember('recordings', relative, current)
                    excluded_identities.add((current.st_dev, current.st_ino))
                    close_fd(fd)
            else:
                raise SnapshotError('recordings contem symlink, FIFO, socket ou device')

    def walk_excluded(root_name, directory_fd, components=()):
        for name in sorted(os.listdir(directory_fd)):
            before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            relative = components + (name,)
            if stat.S_ISDIR(before.st_mode):
                child_fd, current = open_verified_directory(name, directory_fd, data_dev)
                try:
                    remember(root_name, relative, current, True)
                    walk_excluded(root_name, child_fd, relative)
                finally:
                    close_fd(child_fd)
            elif stat.S_ISREG(before.st_mode):
                fd, current = open_verified_regular(name, directory_fd, before, data_dev, False)
                remember(root_name, relative, current)
                excluded_identities.add((current.st_dev, current.st_ino))
                close_fd(fd)
            else:
                # auth/cache sao excluidos integralmente; links e sockets nao
                # sao seguidos nem copiados, mas sua identidade entra no
                # inventario para detectar troca durante a geracao.
                remember(root_name, relative, before)

    walk_state(root_fds['state'])
    walk_recordings(root_fds['recordings'])
    walk_excluded('auth', root_fds['auth'])
    walk_excluded('cache', root_fds['cache'])
    for item in selected:
        identity = (item['stat'].st_dev, item['stat'].st_ino)
        if identity in excluded_identities:
            raise SnapshotError('fonte do snapshot compartilha inode com auth, cache ou audio')
    selected.sort(key=lambda item: item['archive'])
    return selected, expected_directories, safety_manifest


def close_selected(items):
    for item in items:
        close_fd(item['fd'])


def make_stage_directory(stage_fd, relative):
    current_fd = os.dup(stage_fd)
    try:
        for component in relative.split('/'):
            try:
                os.mkdir(component, mode=0o700, dir_fd=current_fd)
            except FileExistsError:
                pass
            next_fd, _ = open_verified_directory(component, current_fd, data_dev)
            close_fd(current_fd)
            current_fd = next_fd
        return current_fd
    except Exception:
        close_fd(current_fd)
        raise


def copy_to_stage(stage_fd, item):
    archive_components = item['archive'].split('/')
    parent_fd = make_stage_directory(stage_fd, '/'.join(archive_components[:-1]))
    source_stat = item['stat']
    destination_fd = -1
    try:
        destination_fd = os.open(
            archive_components[-1],
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_NOFOLLOW | O_CLOEXEC,
            stat.S_IMODE(source_stat.st_mode),
            dir_fd=parent_fd,
        )
        offset = 0
        while True:
            chunk = os.pread(item['fd'], 1024 * 1024, offset)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                view = view[written:]
            offset += len(chunk)
        os.fchmod(destination_fd, stat.S_IMODE(source_stat.st_mode))
        try:
            os.fchown(destination_fd, source_stat.st_uid, source_stat.st_gid)
        except PermissionError as error:
            current = os.fstat(destination_fd)
            if current.st_uid != source_stat.st_uid or current.st_gid != source_stat.st_gid:
                raise SnapshotError('nao foi possivel preservar owner/group do snapshot') from error
        os.utime(destination_fd, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
        os.fsync(destination_fd)
    finally:
        if destination_fd >= 0:
            close_fd(destination_fd)
        close_fd(parent_fd)


def stage_manifest(stage_fd, expected_files, expected_directories):
    actual_files = {}
    actual_directories = set()

    def walk(directory_fd, components=()):
        for name in sorted(os.listdir(directory_fd)):
            before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            relative = components + (name,)
            archive_name = '/'.join(relative)
            if stat.S_ISDIR(before.st_mode):
                child_fd, _ = open_verified_directory(name, directory_fd, data_dev)
                actual_directories.add(archive_name)
                try:
                    walk(child_fd, relative)
                finally:
                    close_fd(child_fd)
            elif stat.S_ISREG(before.st_mode):
                fd, current = open_verified_regular(name, directory_fd, before, data_dev, True)
                actual_files[archive_name] = (fd_stat_signature(current), hash_fd(fd))
                close_fd(fd)
            else:
                raise SnapshotError('stage contem entrada irregular')

    walk(stage_fd)
    if actual_directories != expected_directories:
        raise SnapshotError('diretorios do stage divergiram da allowlist')
    if set(actual_files) != set(expected_files):
        raise SnapshotError('arquivos do stage divergiram da allowlist')
    for name, item in expected_files.items():
        signature, digest = actual_files[name]
        source = item['stat']
        expected_stage = (
            source.st_dev,
            signature[1],
            stat.S_IFREG,
            stat.S_IMODE(source.st_mode),
            1,
            source.st_uid,
            source.st_gid,
            source.st_size,
            source.st_mtime_ns,
            signature[9],
        )
        if signature[:1] != expected_stage[:1] or signature[2:9] != expected_stage[2:9] or digest != item['sha256']:
            raise SnapshotError('metadata ou hash do stage divergiu da fonte')


def normalize_tar_name(raw):
    while raw.startswith('./'):
        raw = raw[2:]
    raw = raw.rstrip('/')
    if raw in {'', '.'}:
        return ''
    if raw.startswith('/'):
        raise SnapshotError('archive contem nome absoluto')
    parts = raw.split('/')
    if any(part in {'', '.', '..'} for part in parts):
        raise SnapshotError('archive contem nome nao canonico')
    return '/'.join(parts)


class DigestingWriter:
    def __init__(self, raw):
        self.raw = raw
        self.digest = hashlib.sha256()
        self.count = 0

    def write(self, data):
        written = self.raw.write(data)
        if written is None:
            written = len(data)
        self.digest.update(memoryview(data)[:written])
        self.count += written
        return written

    def flush(self):
        self.raw.flush()

    def tell(self):
        return self.raw.tell()


def controlled_pax_headers(member):
    headers = dict(member.pax_headers)
    if not headers:
        return True
    # PAX e usado apenas quando o proprio tarfile precisa representar um nome
    # longo. Nenhuma outra chave pode carregar metadata ou payload oculto.
    return set(headers) == {'path'} and headers['path'].rstrip('/') == member.name.rstrip('/')


def create_canonical_archive(archive_fd, expected_files, expected_directories):
    os.ftruncate(archive_fd, 0)
    os.lseek(archive_fd, 0, os.SEEK_SET)
    raw = os.fdopen(os.dup(archive_fd), 'wb', closefd=True)
    writer = DigestingWriter(raw)
    try:
        with gzip.GzipFile(filename='', mode='wb', compresslevel=9, fileobj=writer, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                for directory in sorted(expected_directories, key=lambda value: (value.count('/'), value)):
                    member = tarfile.TarInfo(directory + '/')
                    member.type = tarfile.DIRTYPE
                    member.mode = 0o700
                    member.uid = os.geteuid()
                    member.gid = os.getegid()
                    member.uname = ''
                    member.gname = ''
                    member.linkname = ''
                    member.size = 0
                    member.mtime = 0
                    member.pax_headers = {}
                    archive.addfile(member)
                for name in sorted(expected_files):
                    expected = expected_files[name]
                    source = expected['stat']
                    member = tarfile.TarInfo(name)
                    member.type = tarfile.REGTYPE
                    member.mode = stat.S_IMODE(source.st_mode)
                    member.uid = source.st_uid
                    member.gid = source.st_gid
                    member.uname = ''
                    member.gname = ''
                    member.linkname = ''
                    member.size = source.st_size
                    member.mtime = source.st_mtime_ns // 1_000_000_000
                    member.pax_headers = {}
                    source_file = os.fdopen(os.dup(expected['fd']), 'rb', closefd=True)
                    try:
                        source_file.seek(0)
                        archive.addfile(member, source_file)
                    finally:
                        source_file.close()
        writer.flush()
    finally:
        raw.close()
    os.fsync(archive_fd)
    expected_digest = writer.digest.hexdigest()
    expected_size = writer.count
    current = os.fstat(archive_fd)
    if current.st_size != expected_size or hash_fd(archive_fd) != expected_digest:
        raise SnapshotError('archive recebeu bytes fora do gerador canonico')
    header = os.pread(archive_fd, 10, 0)
    if len(header) != 10 or header[:4] != b'\x1f\x8b\x08\x00' or header[4:8] != b'\x00\x00\x00\x00':
        raise SnapshotError('header gzip nao e canonico')
    return expected_digest, expected_size


def assert_private_archive(value):
    if (
        not stat.S_ISREG(value.st_mode)
        or value.st_nlink != 1
        or value.st_dev != data_dev
        or value.st_uid != os.geteuid()
        or value.st_gid != os.getegid()
        or stat.S_IMODE(value.st_mode) != 0o600
    ):
        raise SnapshotError('archive nao permaneceu privado, regular e single-link')


def archive_proof(fd):
    value = os.fstat(fd)
    assert_private_archive(value)
    return ':'.join(str(part) for part in fd_stat_signature(value)) + ':' + hash_fd(fd)


def validate_archive(path, guard_fd, expected_files, expected_directories, expected_digest, expected_size):
    archive_fd = os.open(path, FILE_FLAGS)
    try:
        before = os.fstat(archive_fd)
        guard_stat = os.fstat(guard_fd)
        assert_private_archive(before)
        if (
            not same_identity(before, guard_stat)
            or before.st_size != expected_size
            or hash_fd(archive_fd) != expected_digest
        ):
            raise SnapshotError('archive temporario divergiu do fluxo canonico')
    finally:
        close_fd(archive_fd)
    seen = set()
    seen_files = set()
    seen_directories = set()
    with tarfile.open(path, mode='r:gz') as archive:
        for member in archive.getmembers():
            name = normalize_tar_name(member.name)
            if name in seen:
                raise SnapshotError('archive contem membro duplicado')
            seen.add(name)
            if member.uname or member.gname or member.linkname or not controlled_pax_headers(member):
                raise SnapshotError('archive contem metadata textual ou PAX fora da allowlist')
            if member.isdir():
                if name:
                    seen_directories.add(name)
                if (
                    name not in expected_directories
                    or member.mode != 0o700
                    or member.uid != os.geteuid()
                    or member.gid != os.getegid()
                    or member.size != 0
                    or int(member.mtime) != 0
                ):
                    raise SnapshotError('metadata de diretorio divergiu do formato canonico')
                continue
            if not member.isfile() or name not in expected_files:
                raise SnapshotError('archive contem link, especial ou arquivo fora da allowlist')
            expected = expected_files[name]
            source = expected['stat']
            if (
                member.size != source.st_size
                or member.mode != stat.S_IMODE(source.st_mode)
                or member.uid != source.st_uid
                or member.gid != source.st_gid
                or int(member.mtime) != source.st_mtime_ns // 1_000_000_000
            ):
                raise SnapshotError('metadata do membro divergiu da fonte')
            extracted = archive.extractfile(member)
            if extracted is None:
                raise SnapshotError('membro regular nao pode ser lido')
            digest = hashlib.sha256()
            while True:
                chunk = extracted.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            if digest.hexdigest() != expected['sha256']:
                raise SnapshotError('hash do membro divergiu da fonte')
            seen_files.add(name)
    if seen_files != set(expected_files) or seen_directories != expected_directories:
        raise SnapshotError('archive divergiu da allowlist exata')
    archive_fd = os.open(path, FILE_FLAGS)
    try:
        after = os.fstat(archive_fd)
        assert_private_archive(after)
        if (
            fd_stat_signature(after) != fd_stat_signature(before)
            or after.st_size != expected_size
            or hash_fd(archive_fd) != expected_digest
        ):
            raise SnapshotError('archive mudou durante sua validacao')
    finally:
        close_fd(archive_fd)
    return archive_stable_signature(before)


def publish_archive(temporary, final, guard_fd, expected_signature, expected_digest):
    temporary_parent, temporary_name = os.path.split(temporary)
    final_parent, final_name = os.path.split(final)
    if temporary_parent != final_parent or not temporary_name or not final_name:
        raise SnapshotError('archive final precisa usar o mesmo diretorio privado do temporario')
    parent_fd = os.open(temporary_parent, DIR_FLAGS)
    try:
        parent_stat = os.fstat(parent_fd)
        if parent_stat.st_dev != data_dev or stat.S_IMODE(parent_stat.st_mode) != 0o700:
            raise SnapshotError('diretorio de rollback mudou antes da publicacao')
        temporary_stat = os.stat(temporary_name, dir_fd=parent_fd, follow_symlinks=False)
        guard_stat = os.fstat(guard_fd)
        assert_private_archive(temporary_stat)
        assert_private_archive(guard_stat)
        os.fsync(guard_fd)
        guard_stat = os.fstat(guard_fd)
        if (
            not same_identity(temporary_stat, guard_stat)
            or archive_stable_signature(guard_stat) != expected_signature
            or hash_fd(guard_fd) != expected_digest
        ):
            raise SnapshotError('archive temporario mudou antes do rename')
        try:
            os.stat(final_name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise SnapshotError('destino final do snapshot ja existe')
        os.rename(temporary_name, final_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        published_fd = os.open(final_name, FILE_FLAGS, dir_fd=parent_fd)
        try:
            published_stat = os.fstat(published_fd)
            assert_private_archive(published_stat)
            if (
                not same_identity(published_stat, guard_stat)
                or archive_stable_signature(published_stat) != expected_signature
                or hash_fd(published_fd) != expected_digest
            ):
                raise SnapshotError('archive final divergiu depois do rename')
        finally:
            close_fd(published_fd)
        os.fsync(parent_fd)
    finally:
        close_fd(parent_fd)


def source_manifest(items):
    return {
        item['archive']: (item['signature'], item['sha256'])
        for item in items
    }


try:
    if data_root != os.path.normpath(data_root) or not os.path.isabs(data_root):
        raise SnapshotError('DATA_ROOT nao e canonico')
    assert_no_nested_mounts()
    base_fd = os.open(data_root, DIR_FLAGS)
    base_stat = os.fstat(base_fd)
    if not stat.S_ISDIR(base_stat.st_mode):
        raise SnapshotError('DATA_ROOT nao e diretorio')
    data_dev = base_stat.st_dev
    if action in {'proof', 'remove'}:
        rollback_path = os.path.join(data_root, 'rollback')
        archive_name = os.path.basename(final_archive_path)
        if (
            os.path.dirname(final_archive_path) != rollback_path
            or not re.fullmatch(r'operational-state-[0-9]{8}-[0-9]{6}-[A-Za-z0-9]{6}\.tar\.gz', archive_name)
        ):
            raise SnapshotError('caminho do snapshot final nao e canonico')
        rollback_fd, _ = open_verified_directory('rollback', base_fd, data_dev)
        try:
            snapshot_fd = os.open(archive_name, FILE_FLAGS, dir_fd=rollback_fd)
            try:
                proof = archive_proof(snapshot_fd)
                path_stat = os.stat(archive_name, dir_fd=rollback_fd, follow_symlinks=False)
                if not same_identity(path_stat, os.fstat(snapshot_fd)):
                    raise SnapshotError('snapshot mudou durante a prova final')
                if action == 'proof':
                    print(proof)
                    raise SystemExit(0)
                if expected_archive_proof == '-' or proof != expected_archive_proof:
                    raise SnapshotError('snapshot divergiu da prova criada antes do start')
                os.unlink(archive_name, dir_fd=rollback_fd)
                os.fsync(rollback_fd)
                try:
                    os.stat(archive_name, dir_fd=rollback_fd, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    raise SnapshotError('snapshot permaneceu depois do unlink')
                raise SystemExit(0)
            finally:
                close_fd(snapshot_fd)
        finally:
            close_fd(rollback_fd)
    for root_name in ROOT_NAMES:
        root_fd, _ = open_verified_directory(root_name, base_fd, data_dev)
        root_fds[root_name] = root_fd
    initial, expected_directories, initial_safety_manifest = scan_sources()
    try:
        initial_manifest = source_manifest(initial)
        if action == 'preflight':
            raise SystemExit(0)
        if stage_path == '-' or archive_path == '-' or final_archive_path == '-':
            raise SnapshotError('destinos do snapshot nao foram informados')
        stage_fd = os.open(stage_path, DIR_FLAGS)
        try:
            stage_stat = os.fstat(stage_fd)
            if stage_stat.st_dev != data_dev or stage_stat.st_uid != os.geteuid() or stat.S_IMODE(stage_stat.st_mode) != 0o700:
                raise SnapshotError('stage nao e privado ou saiu do filesystem de dados')
            if os.listdir(stage_fd):
                raise SnapshotError('stage precisa iniciar vazio')
            for directory in sorted(expected_directories, key=lambda value: (value.count('/'), value)):
                created_fd = make_stage_directory(stage_fd, directory)
                close_fd(created_fd)
            for item in initial:
                copy_to_stage(stage_fd, item)
            expected_files = {item['archive']: item for item in initial}
            stage_manifest(stage_fd, expected_files, expected_directories)

            archive_guard_fd = os.open(archive_path, ARCHIVE_FLAGS)
            try:
                archive_before = os.fstat(archive_guard_fd)
                assert_private_archive(archive_before)
                if (
                    archive_before.st_size != 0
                ):
                    raise SnapshotError('arquivo temporario do archive nao e privado e vazio')
                archive_digest, archive_size = create_canonical_archive(
                    archive_guard_fd, expected_files, expected_directories
                )
                archive_after = os.fstat(archive_guard_fd)
                archive_path_stat = os.stat(archive_path, follow_symlinks=False)
                assert_private_archive(archive_after)
                assert_private_archive(archive_path_stat)
                if (
                    not same_identity(archive_after, archive_path_stat)
                    or archive_after.st_size != archive_size
                    or hash_fd(archive_guard_fd) != archive_digest
                ):
                    raise SnapshotError('arquivo temporario foi trocado durante a geracao canonica')

                # Mantemos os descritores originais abertos e tambem reabrimos toda
                # a allowlist por nome. Isso detecta escrita, rename, adicao e troca
                # de inode durante a criacao do tar.
                for item in initial:
                    if fd_stat_signature(os.fstat(item['fd'])) != item['signature'] or hash_fd(item['fd']) != item['sha256']:
                        raise SnapshotError('fonte aberta mudou durante a geracao do archive')
                assert_no_nested_mounts()
                current, current_directories, current_safety_manifest = scan_sources()
                try:
                    if (
                        current_directories != expected_directories
                        or current_safety_manifest != initial_safety_manifest
                        or source_manifest(current) != initial_manifest
                    ):
                        raise SnapshotError('inventario mudou durante a geracao do archive')
                finally:
                    close_selected(current)
                stage_manifest(stage_fd, expected_files, expected_directories)
                archive_signature = validate_archive(
                    archive_path,
                    archive_guard_fd,
                    expected_files,
                    expected_directories,
                    archive_digest,
                    archive_size,
                )
                publish_archive(
                    archive_path,
                    final_archive_path,
                    archive_guard_fd,
                    archive_signature,
                    archive_digest,
                )
            finally:
                close_fd(archive_guard_fd)
        finally:
            close_fd(stage_fd)
    finally:
        close_selected(initial)
except SnapshotError as error:
    print(f'gate de snapshot recusou: {error}', file=sys.stderr)
    raise SystemExit(70)
finally:
    for root_fd in root_fds.values():
        close_fd(root_fd)
    if base_fd >= 0:
        close_fd(base_fd)
PY
}

# DNS, SNI, certificado e handshake das quatro origens precisam estar válidos
# antes de parar o runtime existente. O status HTTP pode vir do deploy anterior
# e não é interpretado aqui; conteúdo/fingerprint pertencem ao smoke pós-start.
command -v curl >/dev/null 2>&1 || die 'curl é obrigatório para preflight e smoke externo'
declare -A checked_origins=()
for origin in "$app_url" "$mcp_url" "$public_url" "$docs_url"; do
  [ -z "${checked_origins[$origin]+x}" ] || continue
  checked_origins["$origin"]=1
  curl --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 5 --max-time 15 --retry 2 --retry-all-errors \
    --head --output /dev/null "$origin/health" ||
    die "DNS/TLS externo indisponível antes do deploy: $(origin_host "$origin"); nenhum container foi parado"
done
unset checked_origins

# Esta prova acontece antes de qualquer stop/recreate. Anomalias estaticas de
# state/metadata (incluindo hardlink auth->state) falham sem mutar containers.
operational_snapshot_gate preflight || \
  die 'fontes do snapshot operacional falharam no inventario seguro; nenhum container foi parado'

current_cid="$("${compose[@]}" ps -q kassinao 2>/dev/null || true)"
if [ -n "$current_cid" ]; then
  validated_current_cid="$(managed_container_id "$current_cid" kassinao kassinao)" || \
    die 'compose ps retornou core com ID ou identidade divergente'
  [ "$validated_current_cid" = "$current_cid" ] || \
    die 'compose ps retornou um ID diferente da identidade revalidada do core'
  PREVIOUS_CORE_ID="$validated_current_cid"
  PREVIOUS_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$current_cid" 2>/dev/null || true)"
  assert_recordings_idle || die 'deploy recusado: não foi possível provar que o core está ocioso'
  [ "$(managed_container_id "$current_cid" kassinao kassinao 2>/dev/null || true)" = "$current_cid" ] || \
    die 'identidade do core mudou antes do stop; nenhuma mutação executada'
  RESTART_PREVIOUS_CORE=true
  docker stop --timeout 60 "$current_cid" >/dev/null || die 'não foi possível parar o core anterior com segurança'
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
if [ "$host_scope" = shared ]; then
  run_shared_rollback_check || \
    die 'rollback plaintext inválido ou expirado; core continuará parado'
fi
PREVIOUS_CORE_RESTART_GATES_PASSED=true

rollback_dir="$data_root/rollback"
[ ! -L "$rollback_dir" ] || die 'diretório de rollback não pode ser symlink'
install -d -m 700 "$rollback_dir"
require_private_directory "$rollback_dir"
# Stage e tar parcial ficam dentro do diretório coberto por tmpfiles. Assim um
# SIGKILL ou reboot não deixa cópias órfãs fora da janela de retenção.
SNAPSHOT_STAGE="$(mktemp -d "$rollback_dir/.snapshot.XXXXXX")"
stamp="$(date -u +%Y%m%d-%H%M%S)"
SNAPSHOT_ARCHIVE_TMP="$(mktemp "$rollback_dir/.operational-state-$stamp.XXXXXX")"
snapshot_suffix="${SNAPSHOT_ARCHIVE_TMP##*.}"
[[ "$snapshot_suffix" =~ ^[A-Za-z0-9]{6}$ ]] || die 'mktemp gerou sufixo inesperado para o snapshot'
SNAPSHOT_ARCHIVE="$rollback_dir/operational-state-$stamp-$snapshot_suffix.tar.gz"
operational_snapshot_gate create "$SNAPSHOT_STAGE" "$SNAPSHOT_ARCHIVE_TMP" "$SNAPSHOT_ARCHIVE" || \
  die 'snapshot operacional falhou na cópia/geração/validação fd-safe; core continuará parado'
rm -rf -- "$SNAPSHOT_STAGE"; SNAPSHOT_STAGE=''
SNAPSHOT_ARCHIVE_TMP=''
SNAPSHOT_ARCHIVE_PROOF="$(operational_snapshot_gate proof - - "$SNAPSHOT_ARCHIVE")" || \
  die 'snapshot publicado não pôde ser provado antes do start; core continuará parado'
[[ "$SNAPSHOT_ARCHIVE_PROOF" =~ ^[0-9:]+:[0-9a-f]{64}$ ]] || \
  die 'prova do snapshot publicado retornou formato inesperado; core continuará parado'
printf 'Snapshot operacional pré-deploy: %s\n' "$SNAPSHOT_ARCHIVE"

# O snapshot pode ser grande. Refaça a prova imediatamente antes da única
# operação que cria/inicia containers, em vez de confiar no precheck antigo.
PREVIOUS_CORE_RESTART_GATES_PASSED=false
egress_ready || die 'egress deixou de estar active/válido antes do start; core continuará parado'
if [ "$host_scope" = shared ]; then
  run_shared_rollback_check || \
    die 'rollback plaintext inválido ou expirado; core continuará parado'
fi
PREVIOUS_CORE_RESTART_GATES_PASSED=true
if [ "$host_scope" = shared ] && ! has_profile tunnel; then
  remove_disabled_shared_container kassinao-tunnel cloudflared
fi
DEPLOY_STARTED=true
# A partir deste ponto o Compose pode substituir o container antigo. Um
# rollback automático seria inseguro para migrações de estado; falhamos aberto
# apenas no sentido operacional, preservando snapshot e imagem anterior.
RESTART_PREVIOUS_CORE=false
if [ "$host_scope" = shared ]; then
  # Em host compartilhado, um label Compose alheio nunca pode autorizar remoção.
  # O audit final exige o conjunto exato depois que os serviços conhecidos sobem.
  "${compose[@]}" up -d --no-build --force-recreate
else
  "${compose[@]}" up -d --no-build --force-recreate --remove-orphans
fi

deadline=$((SECONDS + 240))
while [ "$SECONDS" -lt "$deadline" ]; do
  all_ready=true
  summary=()
  for service in "${expected[@]}"; do
    cid="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
    [ -n "$cid" ] || { all_ready=false; summary+=("$service=ausente"); continue; }
    case "$service" in
      kassinao) expected_container_name=kassinao ;;
      kassinao-router) expected_container_name=kassinao-router ;;
      kassinao-public) expected_container_name=kassinao-public ;;
      cloudflared) expected_container_name=kassinao-tunnel ;;
      *) die "serviço inesperado durante a prova de identidade: $service" ;;
    esac
    validated_cid="$(managed_container_id "$cid" "$expected_container_name" "$service")" || \
      die "$service retornou ID ou identidade Compose divergente"
    [ "$validated_cid" = "$cid" ] || die "$service mudou de ID durante a prova de identidade"
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
    summary+=("$service=${status:-ausente}")
    if [ "$host_scope" = shared ]; then
      IFS='|' read -r runtime_memory runtime_memory_swap runtime_swappiness runtime_restart < <(
        docker inspect --format '{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{json .HostConfig.MemorySwappiness}}|{{.HostConfig.RestartPolicy.Name}}' "$cid"
      )
      runtime_swappiness_safe=false
      case "$runtime_swappiness" in
        0 | null) runtime_swappiness_safe=true ;;
      esac
      [[ "$runtime_memory" =~ ^[1-9][0-9]*$ ]] && \
        [ "$runtime_memory_swap" = "$runtime_memory" ] && \
        [ "$runtime_swappiness_safe" = true ] && \
        [ "$runtime_restart" = no ] || \
        die "$service violou o gate shared de memória sem swap/restart fail-closed"
    fi
    if [ "$service" = kassinao ] || [ "$service" = kassinao-router ] || [ "$service" = kassinao-public ]; then
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
if [ "$host_scope" = shared ]; then
  run_shared_audit || \
    die 'audit final shared recusou o runtime; a tentativa será contida antes do smoke externo'
fi

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
    for privacy_path in /privacy /en/privacy; do
      code="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
        -D "$smoke_body" -o /dev/null -w '%{http_code}' "$origin$privacy_path")"
      [ "$code" = 308 ] || die "host público não redirecionou política $privacy_path: $(origin_host "$origin")"
      python3 - "$smoke_body" "$app_url$privacy_path" <<'PY' || \
        die "redirect de política diverge em $(origin_host "$origin")$privacy_path"
import sys

raw = open(sys.argv[1], 'rb').read().replace(b'\r\n', b'\n')
blocks = [block for block in raw.split(b'\n\n') if block.strip()]
if len(blocks) != 1:
    raise SystemExit(1)
lines = blocks[0].split(b'\n')
if not lines or not lines[0].startswith(b'HTTP/'):
    raise SystemExit(1)
locations = []
for line in lines[1:]:
    if not line:
        continue
    if line[:1] in (b' ', b'\t') or b':' not in line:
        raise SystemExit(1)
    name, value = line.split(b':', 1)
    if name.lower() == b'location':
        locations.append(value.strip().decode('ascii', 'strict'))
if locations != [sys.argv[2]]:
    raise SystemExit(1)
PY
    done
    for private_path in /app /auth/login /api/meetings /mcp; do
      code="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 -o /dev/null -w '%{http_code}' "$origin$private_path")"
      [ "$code" = 404 ] || die "host público aceitou rota privada $private_path: $(origin_host "$origin")"
    done
  done
fi
rm -f -- "$smoke_body"

publish_deployed_image_marker() {
  local temporary="$1" final="$2" expected="$3" python_bin
  if [ "$EUID" -eq 0 ]; then
    python_bin=/usr/bin/python3
  else
    python_bin="$(command -v python3 2>/dev/null || true)"
  fi
  [ -n "$python_bin" ] && [ -x "$python_bin" ] && [ -f "$python_bin" ] || return 70
  env -i 'PATH=/usr/bin:/bin' "$python_bin" - "$temporary" "$final" "$expected" <<'PY'
import os
import stat
import sys

temporary, final, expected = sys.argv[1:]
parent, temporary_name = os.path.split(temporary)
final_parent, final_name = os.path.split(final)
if parent != final_parent or not temporary_name or not final_name:
    raise SystemExit(70)
flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
dir_flags = flags | getattr(os, 'O_DIRECTORY', 0)
parent_fd = os.open(parent, dir_flags)
try:
    temporary_fd = os.open(temporary_name, flags, dir_fd=parent_fd)
    try:
        before = os.fstat(temporary_fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_uid != os.geteuid()
            or before.st_gid != os.getegid()
            or stat.S_IMODE(before.st_mode) != 0o600
        ):
            raise SystemExit(70)
        with os.fdopen(os.dup(temporary_fd), 'rb', closefd=True) as handle:
            if handle.read() != (expected + '\n').encode('utf-8'):
                raise SystemExit(70)
        os.fsync(temporary_fd)
        try:
            existing = os.stat(final_name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            if (
                not stat.S_ISREG(existing.st_mode)
                or existing.st_nlink != 1
                or existing.st_uid != os.geteuid()
                or existing.st_gid != os.getegid()
                or stat.S_IMODE(existing.st_mode) != 0o600
            ):
                raise SystemExit(70)
        os.replace(temporary_name, final_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        published_fd = os.open(final_name, flags, dir_fd=parent_fd)
        try:
            published = os.fstat(published_fd)
            if published.st_dev != before.st_dev or published.st_ino != before.st_ino:
                raise SystemExit(70)
            with os.fdopen(os.dup(published_fd), 'rb', closefd=True) as handle:
                if handle.read() != (expected + '\n').encode('utf-8'):
                    raise SystemExit(70)
        finally:
            os.close(published_fd)
        os.fsync(parent_fd)
    finally:
        os.close(temporary_fd)
finally:
    os.close(parent_fd)
PY
}

# O commit durável vem antes do cleanup. Se qualquer etapa anterior falhar, o
# snapshot permanece restaurável; depois do commit, uma falha de limpeza apenas
# deixa o timer remover o snapshot, sem derrubar uma release já validada.
current_snapshot_proof="$(operational_snapshot_gate proof - - "$SNAPSHOT_ARCHIVE")" || \
  die 'snapshot operacional sumiu ou ficou irregular antes do commit final'
[ "$current_snapshot_proof" = "$SNAPSHOT_ARCHIVE_PROOF" ] || \
  die 'snapshot operacional divergiu antes do commit final'
DEPLOYED_IMAGE_TMP="$(mktemp "$ROOT/.deployed-image.XXXXXX")"
printf '%s\n' "$image" > "$DEPLOYED_IMAGE_TMP"
chmod 600 "$DEPLOYED_IMAGE_TMP"
publish_deployed_image_marker "$DEPLOYED_IMAGE_TMP" "$ROOT/.deployed-image" "$image" || \
  die 'marcador da release validada não pôde ser publicado com fsync'
DEPLOYED_IMAGE_TMP=''
DEPLOY_COMPLETE=true
if operational_snapshot_gate remove - - "$SNAPSHOT_ARCHIVE" "$SNAPSHOT_ARCHIVE_PROOF"; then
  SNAPSHOT_ARCHIVE=''
else
  printf 'AVISO: deploy validado; snapshot não foi removido e ficará para o timer de retenção.\n' >&2
fi
printf 'Deploy concluído: %s digest=%s\n' "${summary[*]}" "$digest"
